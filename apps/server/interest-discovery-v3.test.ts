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

function runtime(store: TravelStoreV3, startAction: (input: any) => Promise<any>, resolverOverride?: PlaceResolverV2) {
  const ai = { startAction, startDialogue: async () => { throw new Error("dialogue not expected"); }, startWebDialogue: async () => { throw new Error("web dialogue not expected"); } } as unknown as StagedTravelAiV3;
  const resolver = resolverOverride ?? ({ resolve: async () => ({ resolution: null, candidates: [] }), resolveMany: async () => [], searchCandidates: async () => [] } as unknown as PlaceResolverV2);
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

function planWithExistingInterest(base: TravelPlanDocument, macroCount = 1) {
  const plan = macroPlan(base, macroCount);
  return TravelPlanDocumentSchema.parse({
    ...plan,
    places: [
      ...plan.places,
      { id: "existing-place", nameZh: "景点1", nameLocal: null, nameEn: "Attraction 1", kind: "attraction", city: "Macro 1", region: null, country: "Test", countryCode: "TT", approximate: false },
    ],
    candidates: [
      ...plan.candidates,
      { id: "existing-candidate", placeId: "existing-place", planningAreaCandidateId: "macro-1", preference: "optional", source: "ai", aiReason: "值得参观", aiScore: 90, suggestedDurationMinutes: 60, tags: [] },
    ],
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

function mixedDuplicateOutput() {
  return {
    schemaVersion: 1,
    baseGeneration: 1,
    assistantMessage: "一个复用、一个新增",
    areaTargets: [{ planningAreaCandidateId: "macro-1", targetCount: 2, reason: "本轮建议 2 个" }],
    places: [
      { id: "tmp-place-existing", nameZh: "景点1", nameLocal: null, nameEn: "Attraction 1", kind: "attraction", city: "Macro 1", region: null, country: "Test", countryCode: "TT", approximate: false },
      { id: "tmp-place-new", nameZh: "新景点", nameLocal: null, nameEn: "New Attraction", kind: "attraction", city: "Macro 1", region: null, country: "Test", countryCode: "TT", approximate: false },
    ],
    candidates: [
      { temporaryId: "tmp-candidate-existing", placeTemporaryId: "tmp-place-existing", planningAreaCandidateId: "macro-1", aiReason: "值得参观", aiScore: 90, suggestedDurationMinutes: 60, tags: [], defaultPreference: "optional", prominence: "major", experienceTypes: ["landmark"], visitPointType: "landmark", researchBasis: ["multi_guide_consensus"] },
      { temporaryId: "tmp-candidate-new", placeTemporaryId: "tmp-place-new", planningAreaCandidateId: "macro-1", aiReason: "新增价值高", aiScore: 88, suggestedDurationMinutes: 45, tags: [], defaultPreference: "optional", prominence: "supporting", experienceTypes: ["photo"], visitPointType: "photo_spot", researchBasis: ["user_theme_match"] },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

function immediateRun(value: unknown) {
  return { threadId: `thread-${Math.random()}`, result: Promise.resolve(value), turnId: () => "turn", interrupt: async () => undefined };
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
    expect(store.requireTrip(created.id).plan.candidates.some((candidate) => candidate.planningAreaCandidateId === "macro-1" && candidate.id !== "macro-1")).toBe(true);
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

  it("interrupts a child that finishes startAction only after Stop was requested", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, macroPlan(created.plan, 1), 0, { source: "test", summary: "macro fixture" });
    const startGate = deferred<void>();
    const resultGate = deferred<any>();
    let startEntered = false;
    let interrupted = 0;
    const rt = runtime(store, async () => {
      startEntered = true;
      await startGate.promise;
      return {
        threadId: "late-start",
        result: resultGate.promise,
        turnId: () => "late-turn",
        interrupt: async () => { interrupted += 1; resultGate.reject(new Error("AI 任务已停止。")); },
      };
    });

    const started = rt.createCtaAction({ tripId: created.id, stage: "interests", actionType: "interest.discover", parameters: {}, targetIds: ["macro-1"], requestKey: "stop-during-start" });
    await waitFor(() => startEntered);
    rt.stopTask(created.id, started.taskId!);
    startGate.resolve();
    await waitFor(() => store.getAiTask(started.taskId!)?.status === "stopped");
    expect(interrupted).toBe(1);
    expect(store.requireTrip(created.id).contentGeneration).toBe(1);
    store.close();
  });

  it("aborts Resolver after a successful area was already saved and preserves that saved result", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, macroPlan(created.plan, 1), 0, { source: "test", summary: "macro fixture" });
    let resolverStarted = false;
    let resolverAborted = false;
    const resolver = {
      resolve: async () => ({ resolution: null, candidates: [] }),
      resolveMany: async (_tripId: string, _placeIds: string[], _generation: number, signal?: AbortSignal) => {
        resolverStarted = true;
        return new Promise<never>((_resolve, reject) => {
          const abort = () => { resolverAborted = true; reject(new Error("AI 任务已停止。")); };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
      searchCandidates: async () => [],
    } as unknown as PlaceResolverV2;
    const rt = runtime(store, async (input) => immediateRun(input.validateResult(output("macro-1", 1))), resolver);

    const started = rt.createCtaAction({ tripId: created.id, stage: "interests", actionType: "interest.discover", parameters: {}, targetIds: ["macro-1"], requestKey: "stop-during-resolver" });
    await waitFor(() => resolverStarted);
    expect(store.requireTrip(created.id).contentGeneration).toBe(2);
    const savedCandidate = store.requireTrip(created.id).plan.candidates.find((candidate) => candidate.planningAreaCandidateId === "macro-1" && candidate.id !== "macro-1");
    expect(savedCandidate).toBeTruthy();

    rt.stopTask(created.id, started.taskId!);
    await waitFor(() => store.getAiTask(started.taskId!)?.status === "stopped");
    expect(resolverAborted).toBe(true);
    expect(store.requireTrip(created.id).contentGeneration).toBe(2);
    expect(store.requireTrip(created.id).plan.candidates.some((candidate) => candidate.id === savedCandidate!.id)).toBe(true);
    expect(store.getAction(started.action.id)?.status).not.toBe("completed");
    store.close();
  });

  it("keeps a fatal global failure fatal when another child returns late from startAction", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, macroPlan(created.plan, 2), 0, { source: "test", summary: "macro fixture" });
    const lateStartGate = deferred<void>();
    let lateStartEntered = false;
    let lateInterrupted = 0;
    const rt = runtime(store, async (input) => {
      const targetId = String(input.state.targetMacroCandidate.id);
      if (targetId === "macro-1") {
        return { threadId: "fatal", result: Promise.reject(new Error("authentication failed")), turnId: () => "fatal-turn", interrupt: async () => undefined };
      }
      lateStartEntered = true;
      await lateStartGate.promise;
      const resultGate = deferred<any>();
      return {
        threadId: "late-after-fatal",
        result: resultGate.promise,
        turnId: () => "late-after-fatal-turn",
        interrupt: async () => { lateInterrupted += 1; resultGate.reject(new Error("AI 任务已停止。")); },
      };
    });

    const started = rt.createCtaAction({ tripId: created.id, stage: "interests", actionType: "interest.discover", parameters: {}, targetIds: ["macro-1", "macro-2"], requestKey: "fatal-late-start" });
    await waitFor(() => lateStartEntered);
    await waitFor(() => store.getAiTask(started.taskId!)?.status === "running");
    lateStartGate.resolve();
    await waitFor(() => store.getAiTask(started.taskId!)?.status === "failed");
    expect(lateInterrupted).toBe(1);
    expect(store.getAction(started.action.id)?.errorSummary).toMatch(/authentication failed/i);
    expect(store.requireTrip(created.id).contentGeneration).toBe(1);
    store.close();
  });

  it("fails the whole Action only when every area fails", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, macroPlan(created.plan, 2), 0, { source: "test", summary: "macro fixture" });
    const rt = runtime(store, async (input) => ({
      threadId: `failed-${input.state.targetMacroCandidate.id}`,
      result: Promise.reject(new Error("AI 结构化请求超时。")),
      turnId: () => "failed-turn",
      interrupt: async () => undefined,
    }));

    const started = rt.createCtaAction({ tripId: created.id, stage: "interests", actionType: "interest.discover", parameters: {}, targetIds: ["macro-1", "macro-2"], requestKey: "all-failed" });
    await waitFor(() => store.getAction(started.action.id)?.status === "failed");
    expect(store.getAction(started.action.id)?.errorSummary).toMatch(/所有兴趣点研究区域均失败/);
    expect(store.requireTrip(created.id).contentGeneration).toBe(1);
    store.close();
  });

  it("treats a canonical duplicate no-op as success without bumping generation", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, planWithExistingInterest(created.plan), 0, { source: "test", summary: "duplicate fixture" });
    const rt = runtime(store, async (input) => immediateRun(input.validateResult(output("macro-1", 1))));

    const started = rt.createCtaAction({ tripId: created.id, stage: "interests", actionType: "interest.supplement", parameters: {}, targetIds: ["macro-1"], requestKey: "duplicate-noop" });
    await waitFor(() => store.getAction(started.action.id)?.status === "completed");
    expect(store.requireTrip(created.id).contentGeneration).toBe(1);
    expect(store.getAction(started.action.id)?.resultRef).toMatch(/areas=1\/1;failed=0/);
    expect(store.getAction(started.action.id)?.resultRef).toMatch(/added=0;merged=1/);
    store.close();
  });

  it("rejects a duplicate Place already owned by another Macro without reparenting it", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, planWithExistingInterest(created.plan, 2), 0, { source: "test", summary: "cross-macro fixture" });
    const crossMacro = output("macro-2", 1);
    crossMacro.places[0].city = "Macro 1";
    const rt = runtime(store, async (input) => immediateRun(input.validateResult(crossMacro)));

    const started = rt.createCtaAction({ tripId: created.id, stage: "interests", actionType: "interest.supplement", parameters: {}, targetIds: ["macro-2"], requestKey: "cross-macro-duplicate" });
    await waitFor(() => store.getAction(started.action.id)?.status === "failed");
    expect(store.getAction(started.action.id)?.errorSummary).toMatch(/所有兴趣点研究区域均失败/);
    expect(store.requireTrip(created.id).plan.candidates.find((candidate) => candidate.id === "existing-candidate")?.planningAreaCandidateId).toBe("macro-1");
    expect(store.requireTrip(created.id).contentGeneration).toBe(1);
    store.close();
  });

  it("keeps UI option A semantics: added counts only new Candidates while location denominator covers all canonical mappings", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, planWithExistingInterest(created.plan), 0, { source: "test", summary: "mixed duplicate fixture" });
    const rt = runtime(store, async (input) => immediateRun(input.validateResult(mixedDuplicateOutput())));

    const started = rt.createCtaAction({ tripId: created.id, stage: "interests", actionType: "interest.supplement", parameters: {}, targetIds: ["macro-1"], requestKey: "option-a-stats" });
    await waitFor(() => store.getAction(started.action.id)?.status === "completed");
    const resultRef = store.getAction(started.action.id)?.resultRef ?? "";
    expect(resultRef).toMatch(/added=1/);
    expect(resultRef).toMatch(/merged=1/);
    expect(resultRef).toMatch(/resolved=0;pending=2/);
    expect(store.requireTrip(created.id).contentGeneration).toBe(2);
    store.close();
  });
});
