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
import { computeMacroDependencyFingerprintV3 } from "./planning-state-v3.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function db() {
  const root = mkdtempSync(path.join(tmpdir(), "interest-stop-after-save-v3-"));
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
  const ai = {
    startAction,
    startDialogue: async () => { throw new Error("dialogue not expected"); },
    startWebDialogue: async () => { throw new Error("web dialogue not expected"); },
  } as unknown as StagedTravelAiV3;
  const resolver = {
    resolve: async () => ({ resolution: null, candidates: [] }),
    resolveMany: async () => [],
    searchCandidates: async () => [],
  } as unknown as PlaceResolverV2;
  const routes = {
    workspaceRouteState: () => [],
    workspaceMacroRouteState: () => [],
    recalculate: async () => { throw new Error("route not expected"); },
  } as unknown as DayRouteServiceV2;
  return new TravelPlannerRuntimeV3({
    store,
    ai,
    prompts: prompts(),
    tasks: new AiTaskMonitorV3(store, () => undefined),
    resolver,
    routes,
    emit: () => undefined,
  });
}

function macroPlan(base: TravelPlanDocument, count: number) {
  const places = Array.from({ length: count }, (_, index) => ({
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
  }));
  const candidates = Array.from({ length: count }, (_, index) => ({
    id: `macro-${index + 1}`,
    placeId: `place-m${index + 1}`,
    planningAreaCandidateId: null,
    planningRole: "planning_area" as const,
    preference: "optional" as const,
    source: "ai" as const,
    aiReason: null,
    aiScore: 80,
    suggestedDurationMinutes: 1440,
    tags: [],
  }));
  const days = Array.from({ length: count }, (_, index) => ({
    id: `day-${index + 1}`,
    dayNumber: index + 1,
    date: null,
    title: `目的地${index + 1}`,
    stayBlockId: `block-${index + 1}`,
    transferMode: "none" as const,
    detailLevel: "planned" as const,
    detailStatus: null,
    startAnchor: { id: `start-${index + 1}`, placeId: `place-m${index + 1}`, label: null, notes: null },
    stops: [],
    endAnchor: { id: `end-${index + 1}`, placeId: `place-m${index + 1}`, label: null, notes: null },
  }));
  const prepared = TravelPlanDocumentSchema.parse({ ...base, stage: "itinerary_planning", places, candidates, days });
  return TravelPlanDocumentSchema.parse({
    ...prepared,
    planningState: { macroBasisVersion: 1, macroBasisFingerprint: computeMacroDependencyFingerprintV3(prepared) },
  });
}

function output(targetId: string, index: number) {
  return {
    schemaVersion: 1,
    baseGeneration: 1,
    assistantMessage: `完成 ${targetId}`,
    areaTargets: [{ planningAreaCandidateId: targetId, targetCount: 1, reason: "本轮新增 1 个" }],
    places: [{
      id: `tmp-place-${index}`,
      nameZh: `景点${index}`,
      nameLocal: null,
      nameEn: `Attraction ${index}`,
      kind: "attraction",
      city: `Macro ${index}`,
      region: null,
      country: "Test",
      countryCode: "TT",
      approximate: false,
    }],
    candidates: [{
      temporaryId: `tmp-candidate-${index}`,
      placeTemporaryId: `tmp-place-${index}`,
      planningAreaCandidateId: targetId,
      aiReason: "值得参观",
      aiScore: 90,
      suggestedDurationMinutes: 60,
      tags: [],
      defaultPreference: "optional",
      prominence: "major",
      experienceTypes: ["landmark"],
      visitPointType: "landmark",
      researchBasis: ["multi_guide_consensus"],
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

describe("interest discovery stop-after-first-save regression", () => {
  it("keeps the first committed area, interrupts all four active workers, ignores their late successes, and never starts macro-6", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, macroPlan(created.plan, 6), 0, { source: "test", summary: "macro fixture" });

    const gates = new Map<string, ReturnType<typeof deferred<any>>>();
    const calls: string[] = [];
    const interrupted: string[] = [];
    const rt = runtime(store, async (input) => {
      const targetId = String(input.state.targetMacroCandidate.id);
      const gate = deferred<any>();
      gates.set(targetId, gate);
      calls.push(targetId);
      return {
        threadId: `thread-${targetId}`,
        result: gate.promise.then((value) => input.validateResult ? input.validateResult(value) : value),
        turnId: () => `turn-${targetId}`,
        // Deliberately do not reject result here. This simulates an upstream run that reports
        // interrupt success but still returns a late successful payload afterwards.
        interrupt: async () => { interrupted.push(targetId); },
      };
    });

    const started = rt.createCtaAction({
      tripId: created.id,
      stage: "interests",
      actionType: "interest.discover",
      parameters: {},
      targetIds: Array.from({ length: 6 }, (_, index) => `macro-${index + 1}`),
      requestKey: "stop-after-first-save-late-success",
    });

    await waitFor(() => calls.length === 4);
    gates.get("macro-1")!.resolve(output("macro-1", 1));
    await waitFor(() => store.requireTrip(created.id).contentGeneration === 2);
    await waitFor(() => calls.length === 5);

    const beforeStop = store.requireTrip(created.id);
    expect(beforeStop.plan.candidates.some((candidate) => candidate.planningAreaCandidateId === "macro-1" && candidate.id !== "macro-1")).toBe(true);
    expect(calls).toContain("macro-5");
    expect(calls).not.toContain("macro-6");

    rt.stopTask(created.id, started.taskId!);
    await waitFor(() => interrupted.length === 4);
    expect([...interrupted].sort()).toEqual(["macro-2", "macro-3", "macro-4", "macro-5"]);

    // All four interrupted workers still return valid successful outputs after Stop.
    // Runtime must ignore all of them before canonical merge / writePlan.
    for (const index of [2, 3, 4, 5]) gates.get(`macro-${index}`)!.resolve(output(`macro-${index}`, index));

    await waitFor(() => store.getAiTask(started.taskId!)?.status === "stopped");

    const trip = store.requireTrip(created.id);
    const action = store.getAction(started.action.id)!;
    expect(trip.contentGeneration).toBe(2);
    expect(trip.plan.candidates.some((candidate) => candidate.planningAreaCandidateId === "macro-1" && candidate.id !== "macro-1")).toBe(true);
    for (const targetId of ["macro-2", "macro-3", "macro-4", "macro-5"]) {
      expect(trip.plan.candidates.some((candidate) => candidate.planningAreaCandidateId === targetId && candidate.id !== targetId)).toBe(false);
    }
    expect(calls).toHaveLength(5);
    expect(calls).not.toContain("macro-6");
    expect(action.status).toBe("failed");
    expect(action.status).not.toBe("completed");
    expect(action.errorSummary).toBe("AI 任务已停止。");
    store.close();
  });
});