import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiTaskMonitorV3 } from "./ai-task-monitor-v3.js";
import type { LoadedPromptRegistryV3 } from "./prompt-registry-v3.js";
import { TravelPlannerRuntimeV3 } from "./planner-runtime-v3.js";
import { installRuntimeInvariantsV3 } from "./runtime-invariants-v3.js";
import type { StagedAiHandle, StagedTravelAiV3 } from "./staged-ai-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";
import type { PlaceResolverV2 } from "./place-resolver-v2.js";
import { placeGeoFingerprint } from "./place-resolver-v2.js";
import type { DayRouteServiceV2 } from "./day-route-v2.js";
import { TravelPlanDocumentSchema } from "./contracts-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function store() {
  const root = mkdtempSync(path.join(tmpdir(), "planner-runtime-v3-"));
  roots.push(root);
  const filename = path.join(root, "travel-v3.sqlite3");
  const db = new TravelStoreV3(filename);
  installRuntimeInvariantsV3(filename);
  return db;
}
function handle<T>(value: T, id = `thread-${Math.random()}`): StagedAiHandle<T> { return { threadId: () => id, result: Promise.resolve(value), interrupt: async () => undefined, turnId: () => "turn-1" }; }
async function waitFor(check: () => boolean) { for (let i = 0; i < 80; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("condition timeout"); }

function promptRegistry(): LoadedPromptRegistryV3 {
  const compose = (id: any) => ({ id, relativePath: `${id}.md`, content: `# ${id}`, hash: `hash:${id}`, version: "v1" });
  return { prompts: new Map(), get: ((id: any) => compose(id)) as any, compose: compose as any };
}

function dialogueParameters(changes: Record<string, unknown>) {
  return {
    request: "把节奏改轻松一点",
    candidateId: null,
    candidateIds: [],
    preference: null,
    dayId: null,
    dayIds: [],
    stopId: null,
    targetDayId: null,
    targetIndex: null,
    index: null,
    anchor: null,
    placeId: null,
    label: null,
    notes: null,
    activity: null,
    fields: [],
    changes,
    placeChanges: null,
    candidateChanges: null,
    allowWeb: null,
  };
}

function runtime(input: {
  store: TravelStoreV3;
  dialogue: () => StagedAiHandle<any>;
  web?: () => StagedAiHandle<any>;
  googleMapsLinks?: { preview(url: string): Promise<any> };
}) {
  const tasks = new AiTaskMonitorV3(input.store, () => undefined);
  const ai = {
    startDialogue: async () => input.dialogue(),
    startWebDialogue: async () => input.web?.() ?? handle({ schemaVersion: 1, assistantMessage: "已核验", verification: { status: "verified", checkedAt: new Date().toISOString() } }),
    startAction: async () => { throw new Error("AI action should not run in this test"); },
  } as unknown as StagedTravelAiV3;
  const resolver = { resolve: async () => { throw new Error("not expected"); }, resolveMany: async () => [], searchCandidates: async () => [] } as unknown as PlaceResolverV2;
  const routes = { workspaceRouteState: () => [] } as unknown as DayRouteServiceV2;
  return new TravelPlannerRuntimeV3({ store: input.store, ai, prompts: promptRegistry(), tasks, resolver, routes, googleMapsLinks: input.googleMapsLinks as any, emit: () => undefined });
}

describe("TravelPlannerRuntimeV3", () => {
  it("keeps the Chinese place name when a Google Maps link is saved", async () => {
    const db = store();
    const trip = db.createTrip();
    const plan = TravelPlanDocumentSchema.parse({ ...trip.plan, places: [{ id: "place-1", nameZh: "原中文名", nameLocal: null, nameEn: "Original", kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: false }], candidates: [{ id: "candidate-1", placeId: "place-1", planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 60, tags: [] }] });
    db.writePlan(trip.id, plan, 0, { source: "test", summary: "fixture" });
    const rt = runtime({ store: db, dialogue: () => handle({}), googleMapsLinks: { preview: async () => ({ name: "Google name", latitude: 35, longitude: 135, address: "京都", city: "京都", region: "京都府", country: "日本", countryCode: "JP", warning: null }) } });
    await rt.applyGoogleMapsLink(trip.id, "place-1", { expectedGeneration: 1, url: "https://www.google.com/maps/?q=35,135", changes: { nameZh: "伪造覆盖", city: "京都" } });
    expect(db.requireTrip(trip.id).plan.places[0]).toMatchObject({ nameZh: "原中文名", city: "京都" });
    db.close();
  });

  it("applies a requirements dialogue action without a second confirmation", async () => {
    const db = store();
    const trip = db.createTrip();
    const rt = runtime({ store: db, dialogue: () => handle({ schemaVersion: 1, result: { type: "action", assistantMessage: "可以把节奏改轻松。", actionType: "requirements.update", parameters: dialogueParameters({ pace: "轻松" }), targetIds: [], impactSummary: "更新旅行节奏" } }) });
    rt.startConversation(trip.id, "requirements", { message: "节奏轻松一点", selection: { type: "trip", id: null } });
    await waitFor(() => db.listActions(trip.id, "requirements")[0]?.status === "applied");
    const action = db.listActions(trip.id, "requirements")[0];
    expect(action.status).toBe("applied");
    expect(db.requireTrip(trip.id).plan.trip.pace).toBe("轻松");
    db.close();
  });

  it("rejects destination generation while travel requirements are empty", () => {
    const db = store();
    const trip = db.createTrip();
    const rt = runtime({ store: db, dialogue: () => handle({ schemaVersion: 1, result: { type: "reply", assistantMessage: "ok" } }) });
    expect(() => rt.createCtaAction({ tripId: trip.id, stage: "destinations", actionType: "destination.generate", parameters: {}, targetIds: [], requestKey: "empty-requirements" })).toThrow("请先填写旅行需求");
    expect(db.listActions(trip.id, "destinations")).toHaveLength(0);
    db.close();
  });

  it("discards a dialogue result when canonical generation changes while the model is running", async () => {
    const db = store();
    const trip = db.createTrip();
    let resolveDialogue!: (value: any) => void;
    const delayed: StagedAiHandle<any> = {
      threadId: () => "thread-stale",
      result: new Promise((resolve) => { resolveDialogue = resolve; }),
      interrupt: async () => undefined,
      turnId: () => "turn-stale",
    };
    const rt = runtime({ store: db, dialogue: () => delayed });
    const turn = rt.startConversation(trip.id, "requirements", { message: "清空限制", selection: { type: "trip", id: null } });
    await waitFor(() => db.listMessages(trip.id, "requirements")[0]?.turn?.status === "active");
    const mutation = rt.createCtaAction({ tripId: trip.id, stage: "requirements", actionType: "requirements.update", parameters: { changes: { pace: "舒缓" } }, targetIds: [], requestKey: "concurrent-edit" });
    await waitFor(() => db.getAction(mutation.action.id)?.status === "applied");
    expect(db.requireTrip(trip.id).contentGeneration).toBe(1);
    resolveDialogue({ schemaVersion: 1, result: { type: "action", assistantMessage: "可以清空限制。", actionType: "requirements.clear", parameters: { ...dialogueParameters({}), fields: ["constraints"] }, targetIds: [], impactSummary: "清空限制" } });
    await waitFor(() => db.listMessages(trip.id, "requirements").find((message) => message.id === turn.messageId)?.turn?.status === "failed");
    const actions = db.listActions(trip.id, "requirements");
    expect(actions).toHaveLength(1);
    expect(actions[0].origin).toBe("cta");
    expect(db.listAiTasks(trip.id).find((task) => task.agent === "dialogue")?.status).toBe("cancelled_by_generation");
    db.close();
  });

  it("deterministic CTA is idempotent and never starts an AI action model", async () => {
    const db = store();
    const trip = db.createTrip();
    const rt = runtime({ store: db, dialogue: () => handle({ schemaVersion: 1, result: { type: "reply", assistantMessage: "ok" } }) });
    const first = rt.createCtaAction({ tripId: trip.id, stage: "requirements", actionType: "requirements.update", parameters: { changes: { pace: "舒缓" } }, targetIds: [], requestKey: "cta-1" });
    const second = rt.createCtaAction({ tripId: trip.id, stage: "requirements", actionType: "requirements.update", parameters: { changes: { pace: "舒缓" } }, targetIds: [], requestKey: "cta-1" });
    expect(second.action.id).toBe(first.action.id);
    await waitFor(() => db.getAction(first.action.id)?.status === "applied");
    expect(db.requireTrip(trip.id).contentGeneration).toBe(1);
    expect(db.requireTrip(trip.id).plan.trip.pace).toBe("舒缓");
    db.close();
  });

  it("treats a null stop index as append rather than index zero", async () => {
    const db = store();
    const created = db.createTrip();
    const plan = TravelPlanDocumentSchema.parse({
      ...created.plan,
      stage: "itinerary_planning",
      places: [
        { id: "place-a", nameZh: "A", nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: false },
        { id: "place-b", nameZh: "B", nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: false },
        { id: "place-c", nameZh: "C", nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: false },
      ],
      candidates: ["a", "b", "c"].map((id) => ({ id: `candidate-${id}`, placeId: `place-${id}`, planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 60, tags: [] })),
      days: [{ id: "day-1", dayNumber: 1, date: null, title: "Day 1", detailLevel: "planned", detailStatus: null, startAnchor: { id: "start-1", placeId: null, label: null, notes: null }, stops: [
        { id: "stop-a", candidateId: "candidate-a", placeId: "place-a", activity: "A", period: null, startTime: null, endTime: null, durationMinutes: 60, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null },
        { id: "stop-b", candidateId: "candidate-b", placeId: "place-b", activity: "B", period: null, startTime: null, endTime: null, durationMinutes: 60, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null },
      ], endAnchor: { id: "end-1", placeId: null, label: null, notes: null } }],
    });
    const written = db.writePlan(created.id, plan, 0, { source: "test", summary: "fixture" });
    for (const [index, place] of written.trip.plan.places.entries()) {
      db.upsertPlaceResolution(created.id, {
        tripId: created.id,
        placeId: place.id,
        geoFingerprint: placeGeoFingerprint(place),
        status: "resolved",
        method: "manual_coordinates",
        provider: null,
        providerPlaceId: null,
        latitude: 35 + index,
        longitude: 135 + index,
        address: null,
        confidence: null,
        resolvedAt: new Date().toISOString(),
        errorMessage: null,
      }, written.generation);
    }
    const rt = runtime({ store: db, dialogue: () => handle({ schemaVersion: 1, result: { type: "reply", assistantMessage: "ok" } }) });
    const action = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.stop.add", parameters: { dayId: "day-1", candidateId: "candidate-c", index: null }, targetIds: [], requestKey: "append-stop" });
    await waitFor(() => db.getAction(action.action.id)?.status === "applied");
    expect(db.requireTrip(created.id).plan.days[0].stops.map((stop) => stop.candidateId)).toEqual(["candidate-a", "candidate-b", "candidate-c"]);
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
