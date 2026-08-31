import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiTaskMonitorV3 } from "./ai-task-monitor-v3.js";
import { TravelPlannerRuntimeV3 } from "./planner-runtime-v3.js";
import { installRuntimeInvariantsV3 } from "./runtime-invariants-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";
import type { StagedTravelAiV3 } from "./staged-ai-v3.js";
import type { LoadedPromptRegistryV3 } from "./prompt-registry-v3.js";
import type { PlaceResolverV2 } from "./place-resolver-v2.js";
import type { DayRouteServiceV2 } from "./day-route-v2.js";
import { TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function db() {
  const root = mkdtempSync(path.join(tmpdir(), "interest-discovery-v3-"));
  roots.push(root);
  const filename = path.join(root, "travel-v3.sqlite3");
  const store = new TravelStoreV3(filename);
  installRuntimeInvariantsV3(filename);
  return store;
}

async function waitFor(check: () => boolean) {
  for (let index = 0; index < 200; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timeout");
}

function prompts(): LoadedPromptRegistryV3 {
  const compose = (id: any) => ({ id, relativePath: `${id}.md`, content: `# ${id}`, hash: `hash:${id}`, version: "v1" });
  return { prompts: new Map(), get: ((id: any) => compose(id)) as any, compose: compose as any };
}

function runtime(store: TravelStoreV3, startAction: (input: any) => Promise<any>) {
  const ai = { startAction, startDialogue: async () => { throw new Error("dialogue not expected"); }, startWebDialogue: async () => { throw new Error("web dialogue not expected"); } } as unknown as StagedTravelAiV3;
  const resolver = { resolve: async () => ({ resolution: null, candidates: [] }), resolveMany: async () => [], searchCandidates: async () => [] } as unknown as PlaceResolverV2;
  const routes = { workspaceRouteState: () => [], recalculate: async () => { throw new Error("route not expected"); } } as unknown as DayRouteServiceV2;
  return new TravelPlannerRuntimeV3({ store, ai, prompts: prompts(), tasks: new AiTaskMonitorV3(store, () => undefined), resolver, routes, emit: () => undefined });
}

function macroPlan(base: TravelPlanDocument, count: number) {
  return TravelPlanDocumentSchema.parse({
    ...base,
    places: Array.from({ length: count }, (_, index) => ({
      id: `place-m${index + 1}`,
      nameZh: `目的地${index + 1}`,
      nameLocal: null,
      nameEn: `Macro ${index + 1}`,
      kind: "city" as const,
      city: `Macro ${index + 1}`,
      region: null,
      country: "Test",
      countryCode: "TT",
      approximate: false,
    })),
    candidates: Array.from({ length: count }, (_, index) => ({
      id: `macro-${index + 1}`,
      placeId: `place-m${index + 1}`,
      planningAreaCandidateId: null,
      preference: "optional" as const,
      source: "ai" as const,
      aiReason: null,
      aiScore: 80,
      suggestedDurationMinutes: 1440,
      tags: [],
    })),
  });
}

function output(targetId: string, index: number) {
  return {
    schemaVersion: 1,
    baseGeneration: 1,
    assistantMessage: `完成 ${targetId}`,
    areaTargets: [{ planningAreaCandidateId: targetId, targetCount: 1, reason: "本轮新增 1 个" }],
    places: [{ id: `tmp-place-${index}`, nameZh: `景点${index}`, nameLocal: null, nameEn: `Attraction ${index}`, kind: "attraction", city: `Macro ${index}`, region: null, country: "Test", countryCode: "TT", approximate: false }],
    candidates: [{ temporaryId: `tmp-candidate-${index}`, placeTemporaryId: `tmp-place-${index}`, planningAreaCandidateId: targetId, aiReason: "值得参观", aiScore: 90, suggestedDurationMinutes: 60, tags: [], defaultPreference: "optional", prominence: "major", experienceTypes: ["landmark"], visitPointType: "landmark", researchBasis: ["multi_guide_consensus"] }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

describe("interest discovery v3 orchestration", () => {
  it("caps research at four concurrent areas, persists successes immediately and completes with partial failures", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, macroPlan(created.plan, 6), 0, { source: "test", summary: "macro fixture" });

    const gates = new Map<string, ReturnType<typeof deferred<any>>>();
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    const rt = runtime(store, async (input) => {
      const targetId = String(input.state.targetMacroCandidate.id);
      const index = Number(targetId.split("-")[1]);
      const gate = deferred<any>();
      gates.set(targetId, gate);
      calls.push(targetId);
      active += 1;
      peak = Math.max(peak, active);
      const result = gate.promise.then((value) => {
        if (targetId === "macro-3") throw new Error("AI 结构化请求超时。");
        return input.validateResult ? input.validateResult(value) : value;
      }).finally(() => { active -= 1; });
      return { threadId: `thread-${targetId}`, result, turnId: () => `turn-${targetId}`, interrupt: async () => gate.reject(new Error("AI 任务已停止。")) };
    });

    const started = rt.createCtaAction({ tripId: created.id, stage: "interests", actionType: "interest.discover", parameters: {}, targetIds: Array.from({ length: 6 }, (_, index) => `macro-${index + 1}`), requestKey: "parallel-partial" });
    await waitFor(() => calls.length === 4);
    expect(calls).toHaveLength(4);
    expect(peak).toBe(4);

    gates.get("macro-1")!.resolve(output("macro-1", 1));
    await waitFor(() => store.requireTrip(created.id).contentGeneration === 2);
    expect(store.requireTrip(created.id).plan.candidates.some((candidate) => candidate.planningAreaCandidateId === "macro-1")).toBe(true);
    await waitFor(() => calls.length === 5);

    gates.get("macro-2")!.resolve(output("macro-2", 2));
    await waitFor(() => calls.length === 6);
    gates.get("macro-3")!.resolve(output("macro-3", 3));
    gates.get("macro-4")!.resolve(output("macro-4", 4));
    gates.get("macro-5")!.resolve(output("macro-5", 5));
    gates.get("macro-6")!.resolve(output("macro-6", 6));

    await waitFor(() => store.getAction(started.action.id)?.status === "completed");
    const action = store.getAction(started.action.id)!;
    expect(action.resultRef).toMatch(/interest:v1;areas=5\/6;failed=1/);
    expect(action.resultRef).toMatch(/added=5/);
    expect(store.requireTrip(created.id).contentGeneration).toBe(6);
    const task = store.getAiTask(started.taskId!)!;
    expect((task.metadata.interestDiscovery as any).peakConcurrency).toBe(4);
    expect((task.metadata.interestDiscovery as any).failedAreas).toHaveLength(1);
    store.close();
  });

  it("stops all currently active interest workers and does not start more areas", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, macroPlan(created.plan, 6), 0, { source: "test", summary: "macro fixture" });

    const calls: string[] = [];
    let interrupted = 0;
    const rt = runtime(store, async (input) => {
      const targetId = String(input.state.targetMacroCandidate.id);
      calls.push(targetId);
      const gate = deferred<any>();
      return {
        threadId: `thread-${targetId}`,
        result: gate.promise,
        turnId: () => `turn-${targetId}`,
        interrupt: async () => { interrupted += 1; gate.reject(new Error("AI 任务已停止。")); },
      };
    });

    const started = rt.createCtaAction({ tripId: created.id, stage: "interests", actionType: "interest.discover", parameters: {}, targetIds: Array.from({ length: 6 }, (_, index) => `macro-${index + 1}`), requestKey: "parallel-stop" });
    await waitFor(() => calls.length === 4);
    rt.stopTask(created.id, started.taskId!);
    await waitFor(() => store.getAiTask(started.taskId!)?.status === "stopped");
    expect(interrupted).toBe(4);
    expect(calls).toHaveLength(4);
    expect(store.requireTrip(created.id).contentGeneration).toBe(1);
    store.close();
  });
});
