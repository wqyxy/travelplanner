import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiTaskMonitorV3 } from "./ai-task-monitor-v3.js";
import type { LoadedPromptRegistryV3 } from "./prompt-registry-v3.js";
import { TravelPlannerRuntimeV3 } from "./planner-runtime-v3.js";
import type { StagedAiHandle, StagedTravelAiV3 } from "./staged-ai-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";
import type { PlaceResolverV2 } from "./place-resolver-v2.js";
import type { DayRouteServiceV2 } from "./day-route-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function store() { const root = mkdtempSync(path.join(tmpdir(), "planner-runtime-v3-")); roots.push(root); return new TravelStoreV3(path.join(root, "travel-v3.sqlite3")); }
function handle<T>(value: T, id = `thread-${Math.random()}`): StagedAiHandle<T> { return { threadId: () => id, result: Promise.resolve(value), interrupt: async () => undefined, turnId: () => "turn-1" }; }
async function waitFor(check: () => boolean) { for (let i = 0; i < 50; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("condition timeout"); }

function promptRegistry(): LoadedPromptRegistryV3 {
  const compose = (id: any) => ({ id, relativePath: `${id}.md`, content: `# ${id}`, hash: `hash:${id}`, version: "v1" });
  return { prompts: new Map(), get: ((id: any) => compose(id)) as any, compose: compose as any };
}

function runtime(input: {
  store: TravelStoreV3;
  dialogue: () => StagedAiHandle<any>;
  web?: () => StagedAiHandle<any>;
}) {
  const tasks = new AiTaskMonitorV3(input.store, () => undefined);
  const ai = {
    startDialogue: async () => input.dialogue(),
    startWebDialogue: async () => input.web?.() ?? handle({ schemaVersion: 1, assistantMessage: "已核验", verification: { status: "verified", checkedAt: new Date().toISOString() } }),
    startAction: async () => { throw new Error("AI action should not run in this test"); },
  } as unknown as StagedTravelAiV3;
  const resolver = { resolve: async () => { throw new Error("not expected"); }, resolveMany: async () => [], searchCandidates: async () => [] } as unknown as PlaceResolverV2;
  const routes = { workspaceRouteState: () => [] } as unknown as DayRouteServiceV2;
  return new TravelPlannerRuntimeV3({ store: input.store, ai, prompts: promptRegistry(), tasks, resolver, routes, emit: () => undefined });
}

describe("TravelPlannerRuntimeV3", () => {
  it("dialogue-detected action stays pending and does not mutate canonical until confirm", async () => {
    const db = store();
    const trip = db.createTrip();
    const rt = runtime({ store: db, dialogue: () => handle({ schemaVersion: 1, result: { type: "action", assistantMessage: "可以把节奏改轻松。", actionType: "requirements.update", parameters: { field: "pace", value: "轻松" }, targetIds: [], impactSummary: "更新旅行节奏" } }) });
    rt.startConversation(trip.id, "requirements", { message: "节奏轻松一点", selection: { type: "trip", id: null } });
    await waitFor(() => db.listMessages(trip.id, "requirements").some((message) => message.role === "assistant"));
    const action = db.listActions(trip.id, "requirements")[0];
    expect(action.status).toBe("pending_confirmation");
    expect(db.requireTrip(trip.id).plan.trip.pace).toBeNull();
    rt.confirmAction(trip.id, action.id, { expectedGeneration: 0 });
    await waitFor(() => db.getAction(action.id)?.status === "completed");
    expect(db.requireTrip(trip.id).plan.trip.pace).toBe("轻松");
    db.close();
  });

  it("deterministic CTA is idempotent and never starts an AI action model", async () => {
    const db = store();
    const trip = db.createTrip();
    const rt = runtime({ store: db, dialogue: () => handle({ schemaVersion: 1, result: { type: "reply", assistantMessage: "ok" } }) });
    const first = rt.createCtaAction({ tripId: trip.id, stage: "requirements", actionType: "requirements.update", parameters: { field: "pace", value: "舒缓" }, targetIds: [], requestKey: "cta-1" });
    const second = rt.createCtaAction({ tripId: trip.id, stage: "requirements", actionType: "requirements.update", parameters: { field: "pace", value: "舒缓" }, targetIds: [], requestKey: "cta-1" });
    expect(second.action.id).toBe(first.action.id);
    await waitFor(() => db.getAction(first.action.id)?.status === "completed");
    expect(db.requireTrip(trip.id).contentGeneration).toBe(1);
    expect(db.requireTrip(trip.id).plan.trip.pace).toBe("舒缓");
    db.close();
  });

  it("web_required performs a second web turn before persisting the final answer", async () => {
    const db = store();
    const trip = db.createTrip();
    let webCalls = 0;
    const rt = runtime({
      store: db,
      dialogue: () => handle({ schemaVersion: 1, result: { type: "web_required", queryIntent: "核验当前渡轮时刻", reason: "交通时刻会变化" } }, "thread-a"),
      web: () => { webCalls += 1; return handle({ schemaVersion: 1, assistantMessage: "已核验当前渡轮信息。", verification: { status: "verified", checkedAt: new Date().toISOString() } }, "thread-a"); },
    });
    rt.startConversation(trip.id, "requirements", { message: "现在渡轮几点？", selection: { type: "trip", id: null } });
    await waitFor(() => db.listMessages(trip.id, "requirements").some((message) => message.role === "assistant"));
    const assistant = db.listMessages(trip.id, "requirements").find((message) => message.role === "assistant");
    expect(webCalls).toBe(1);
    expect(assistant?.content).toContain("已核验");
    expect(db.getStageThread(trip.id, "requirements")?.turnCount).toBe(2);
    db.close();
  });
});
