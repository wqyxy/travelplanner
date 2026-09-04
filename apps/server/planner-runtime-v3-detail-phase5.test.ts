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
import { TravelPlanDocumentSchema, type PlaceResolution, type TravelPlanDocument } from "./contracts-v2.js";
import { computeMacroDependencyFingerprintV3 } from "./planning-state-v3.js";
import { placeGeoFingerprint } from "./place-resolver-v2.js";
import { derivePlanningAdvisoriesV3 } from "./planning-advisories-v3.js";

const roots: string[] = [];
const stores = new Set<TravelStoreV3>();
afterEach(() => {
  for (const store of [...stores]) store.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function trackStore(store: TravelStoreV3) {
  const close = store.close.bind(store);
  store.close = () => { if (stores.delete(store)) close(); };
  stores.add(store);
  return store;
}

function db() {
  const root = mkdtempSync(path.join(tmpdir(), "planner-runtime-detail-phase5-"));
  roots.push(root);
  const filename = path.join(root, "travel-v3.sqlite3");
  const store = trackStore(new TravelStoreV3(filename));
  installRuntimeInvariantsV3(filename);
  return store;
}

async function waitFor(check: () => boolean) {
  for (let index = 0; index < 160; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timeout");
}

async function waitForMapTasks(store: TravelStoreV3, tripId: string) {
  const terminal = new Set(["completed", "failed", "stopped", "cancelled_by_generation"]);
  await waitFor(() => {
    const tasks = store.listAiTasks(tripId).filter((task) => task.agent === "map");
    return tasks.length > 0 && tasks.every((task) => terminal.has(task.status));
  });
}

function prompts(): LoadedPromptRegistryV3 {
  const compose = (id: any) => ({ id, relativePath: `${id}.md`, content: `# ${id}`, hash: `hash:${id}`, version: "v1" });
  return { prompts: new Map(), get: ((id: any) => compose(id)) as any, compose: compose as any };
}

function run(value: unknown) {
  return { threadId: `detail-${Math.random()}`, result: Promise.resolve(value), turnId: () => "turn-detail", interrupt: async () => undefined };
}

function runtime(store: TravelStoreV3, startAction: (input: any) => Promise<any>) {
  const ai = { startAction, startDialogue: async () => { throw new Error("dialogue not expected"); }, startWebDialogue: async () => { throw new Error("web dialogue not expected"); } } as unknown as StagedTravelAiV3;
  const resolver = { resolve: async () => ({ resolution: null, candidates: [] }), resolveMany: async () => [], searchCandidates: async () => [] } as unknown as PlaceResolverV2;
  const routes = {
    workspaceRouteState: () => [],
    workspaceMacroRouteState: () => [],
    recalculate: async (_tripId: string, dayId: string) => ({ tripId: "trip", dayId, version: 1, inputFingerprint: "test", status: "ready", distanceKm: null, durationMinutes: null, geometry: null, legs: [], warnings: [], calculatedAt: null }),
    recalculateMacro: async () => null,
  } as unknown as DayRouteServiceV2;
  return new TravelPlannerRuntimeV3({ store, ai, prompts: prompts(), tasks: new AiTaskMonitorV3(store, () => undefined), resolver, routes, emit: () => undefined });
}

function oneAreaPlan(base: TravelPlanDocument, detailed = false) {
  const staged = TravelPlanDocumentSchema.parse({
    ...base,
    stage: detailed ? "itinerary_refinement" : "itinerary_planning",
    places: [
      { id: "city-a", nameZh: "甲城", nameLocal: null, nameEn: "A", kind: "city", city: null, region: null, country: "Test", countryCode: "NZ", approximate: false },
      { id: "core-a-place", nameZh: "甲核心", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "Test", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "area-a", placeId: "city-a", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "core-a", placeId: "core-a-place", planningAreaCandidateId: "area-a", planningRole: "core_visit", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 120, tags: [] },
    ],
    days: [{
      id: "day-a", stayBlockId: "block-a", dayNumber: 1, date: null, title: "甲城", transferMode: "none",
      detailLevel: detailed ? "detailed" : "planned", detailStatus: detailed ? "needs_review" : null,
      startAnchor: { id: "start-a", placeId: "city-a", label: "甲城", notes: null },
      stops: detailed ? [{ id: "stop-core-a", candidateId: "core-a", placeId: "core-a-place", activity: "甲核心", period: "morning", startTime: "09:00", endTime: "11:00", durationMinutes: 120, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }] : [],
      endAnchor: { id: "end-a", placeId: "city-a", label: "甲城", notes: null },
    }],
    planningState: { macroBasisVersion: 1, macroBasisFingerprint: null },
  });
  return TravelPlanDocumentSchema.parse({ ...staged, planningState: { macroBasisVersion: 1, macroBasisFingerprint: computeMacroDependencyFingerprintV3(staged) } });
}

function twoAreaPlan(base: TravelPlanDocument) {
  const staged = TravelPlanDocumentSchema.parse({
    ...base,
    stage: "itinerary_refinement",
    places: [
      { id: "city-a", nameZh: "甲城", nameLocal: null, nameEn: "A", kind: "city", city: null, region: null, country: "Test", countryCode: "NZ", approximate: false },
      { id: "city-b", nameZh: "乙城", nameLocal: null, nameEn: "B", kind: "city", city: null, region: null, country: "Test", countryCode: "NZ", approximate: false },
      { id: "core-a-place", nameZh: "甲核心", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "Test", countryCode: "NZ", approximate: false },
      { id: "core-b-place", nameZh: "乙核心", nameLocal: null, nameEn: null, kind: "attraction", city: "乙城", region: null, country: "Test", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "area-a", placeId: "city-a", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "area-b", placeId: "city-b", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "core-a", placeId: "core-a-place", planningAreaCandidateId: "area-a", planningRole: "core_visit", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 120, tags: [] },
      { id: "core-b", placeId: "core-b-place", planningAreaCandidateId: "area-b", planningRole: "core_visit", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 120, tags: [] },
    ],
    days: [
      { id: "day-a", stayBlockId: "block-a", dayNumber: 1, date: null, title: "甲城", transferMode: "none", detailLevel: "detailed", detailStatus: "needs_review", startAnchor: { id: "start-a", placeId: "city-a", label: "甲城", notes: null }, stops: [{ id: "stop-core-a", candidateId: "core-a", placeId: "core-a-place", activity: "甲核心", period: "morning", startTime: "09:00", endTime: "11:00", durationMinutes: 120, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }], endAnchor: { id: "end-a", placeId: "city-a", label: "甲城", notes: null } },
      { id: "day-b", stayBlockId: "block-b", dayNumber: 2, date: null, title: "乙城", transferMode: "rail", detailLevel: "planned", detailStatus: null, startAnchor: { id: "start-b", placeId: "city-a", label: "甲城", notes: null }, stops: [], endAnchor: { id: "end-b", placeId: "city-b", label: "乙城", notes: null } },
    ],
    planningState: { macroBasisVersion: 1, macroBasisFingerprint: null },
  });
  return TravelPlanDocumentSchema.parse({ ...staged, planningState: { macroBasisVersion: 1, macroBasisFingerprint: computeMacroDependencyFingerprintV3(staged) } });
}

function resolved(tripId: string, plan: TravelPlanDocument, placeId: string, index: number): PlaceResolution {
  const place = plan.places.find((item) => item.id === placeId)!;
  return { tripId, placeId, geoFingerprint: placeGeoFingerprint(place), status: "resolved", method: "manual_coordinates", provider: null, providerPlaceId: null, latitude: 35 + index, longitude: 135 + index, address: null, confidence: null, resolvedAt: "2026-09-02T00:00:00Z", errorMessage: null };
}

function saveResolved(store: TravelStoreV3, tripId: string, generation: number, placeIds: string[]) {
  const plan = store.requireTrip(tripId).plan;
  placeIds.forEach((placeId, index) => store.upsertPlaceResolution(tripId, resolved(tripId, plan, placeId, index), generation));
}

const coreDraft = { candidateId: "core-a", activity: "甲核心", period: "morning", startTime: "09:00", endTime: "11:00", durationMinutes: 120, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null } as const;

describe("Phase 5 detailed itinerary runtime", () => {
  it("generates Step 5 directly from a resolved Core Visit even when Step 4 added no Detail Interests", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, oneAreaPlan(created.plan), 0, { source: "test", summary: "core-only skeleton" });
    saveResolved(store, created.id, 1, ["city-a", "core-a-place"]);
    const states: any[] = [];
    const rt = runtime(store, async (input) => {
      states.push(input.state);
      return run({ schemaVersion: 1, baseGeneration: 1, result: { type: "success", assistantMessage: "生成核心行程", dayUpdates: [{ dayId: "day-a", stops: [coreDraft] }], unscheduledCandidates: [] } });
    });

    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.detail.generate", parameters: {}, targetIds: [], requestKey: "core-only-detail" });
    await waitFor(() => store.getAction(started.action.id)?.status === "completed");
    const after = store.requireTrip(created.id).plan;
    expect(states).toHaveLength(1);
    expect(states[0].candidates.map((candidate: any) => [candidate.id, candidate.planningRole])).toEqual([["core-a", "core_visit"]]);
    expect(states[0].preferredMustGoCandidateIds).toEqual(["core-a"]);
    expect(states[0].requiredMustGoCandidateIds).toEqual([]);
    expect(after.days[0].stops.map((stop) => stop.candidateId)).toEqual(["core-a"]);
    expect(after.days[0].detailStatus).toBe("ready");
    expect(after.days[0].startAnchor.placeId).toBe("city-a");
    expect(after.days[0].endAnchor.placeId).toBe("city-a");
    await waitForMapTasks(store, created.id);
    store.close();
  });

  it("updates one affected area while an unrelated Planning Area and must-go Core remain unresolved", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, twoAreaPlan(created.plan), 0, { source: "test", summary: "scoped unresolved fixture" });
    saveResolved(store, created.id, 1, ["city-a", "core-a-place"]);
    const states: any[] = [];
    const rt = runtime(store, async (input) => {
      states.push(input.state);
      return run({ schemaVersion: 1, baseGeneration: 1, result: { type: "success", assistantMessage: "甲城无需修改", title: "确认甲城", explanation: "保持现有安排", affectedDayIds: ["day-a"], dayUpdates: [{ dayId: "day-a", stops: [coreDraft] }], unscheduledCandidates: [] } });
    });

    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.detail.update", parameters: { dayIds: ["day-a"] }, targetIds: ["day-a"], requestKey: "scoped-day-a" });
    await waitFor(() => store.getAction(started.action.id)?.status === "completed");
    expect(states).toHaveLength(1);
    expect(states[0].targetDayIds).toEqual(["day-a"]);
    expect(states[0].candidates.map((candidate: any) => candidate.id)).toEqual(["core-a"]);
    const after = store.requireTrip(created.id).plan;
    expect(after.days.find((day) => day.id === "day-a")?.detailStatus).toBe("ready");
    expect(after.days.find((day) => day.id === "day-b")?.detailLevel).toBe("planned");
    expect(store.listProposals(created.id)).toEqual([]);
    store.close();
  });

  it("continues a related unresolved Anchor and must-go through Proposal and Apply", async () => {
    const store = db();
    const created = store.createTrip();
    store.writePlan(created.id, twoAreaPlan(created.plan), 0, { source: "test", summary: "related unresolved fixture" });
    saveResolved(store, created.id, 1, ["city-a", "core-a-place"]);
    const states: any[] = [];
    const rt = runtime(store, async (input) => {
      states.push(input.state);
      return run({ schemaVersion: 1, baseGeneration: 1, result: {
        type: "success", assistantMessage: "安排乙核心", title: "更新乙城", explanation: "保留未定位地点并等待地图能力恢复", affectedDayIds: ["day-b"],
        dayUpdates: [{ dayId: "day-b", stops: [{ candidateId: "core-b", activity: "乙核心", period: "afternoon", startTime: null, endTime: null, durationMinutes: 120, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null }] }],
        unscheduledCandidates: [],
      } });
    });

    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.detail.update", parameters: { dayIds: ["day-b"] }, targetIds: ["day-b"], requestKey: "blocked-day-b" });
    await waitFor(() => store.getAction(started.action.id)?.status === "awaiting_apply");
    expect(states).toHaveLength(1);
    expect(states[0].detailReadiness.blockingIssues).toEqual([]);
    expect(states[0].detailReadiness.advisoryIssues.map((item: any) => item.type)).toEqual(expect.arrayContaining(["anchor_unresolved", "must_go_unresolved"]));
    expect(states[0].unresolvedCandidateIds).toContain("core-b");
    expect(states[0].unavailableCandidateIds).toEqual([]);
    const proposal = store.getProposal(store.getAction(started.action.id)!.proposalId!)!;
    await rt.applyProposal(created.id, proposal.id);
    const trip = store.requireTrip(created.id);
    expect(trip.plan.days.find((day) => day.id === "day-b")?.stops).toEqual([expect.objectContaining({ candidateId: "core-b", placeId: "core-b-place" })]);
    expect(store.listPlaceResolutions(created.id).filter((item) => ["city-b", "core-b-place"].includes(item.placeId))).toEqual([]);
    const advisories = derivePlanningAdvisoriesV3(trip.plan, store.listPlaceResolutions(created.id));
    expect(advisories.some((item) => item.code === "PLACE_UNRESOLVED" && item.objectRefs.some((ref) => ref.id === "core-b-place"))).toBe(true);
    expect(advisories.some((item) => item.code === "MUST_GO_NOT_SCHEDULED" && item.objectRefs.some((ref) => ref.id === "core-b"))).toBe(false);
    await waitForMapTasks(store, created.id);
    store.close();
  });

  it("continues Detailed generation on a dirty Macro basis while keeping stale state visible", async () => {
    const store = db();
    const created = store.createTrip();
    const current = oneAreaPlan(created.plan);
    const dirty = TravelPlanDocumentSchema.parse({ ...current, trip: { ...current.trip, pace: "更慢" } });
    store.writePlan(created.id, dirty, 0, { source: "test", summary: "dirty detail fixture" });
    saveResolved(store, created.id, 1, ["city-a", "core-a-place"]);
    const states: any[] = [];
    const rt = runtime(store, async (input) => {
      states.push(input.state);
      return run({ schemaVersion: 1, baseGeneration: 1, result: { type: "success", assistantMessage: "继续生成每日行程", dayUpdates: [{ dayId: "day-a", stops: [coreDraft] }], unscheduledCandidates: [] } });
    });

    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.detail.generate", parameters: {}, targetIds: [], requestKey: "dirty-to-skeleton" });
    await waitFor(() => store.getAction(started.action.id)?.status === "completed");
    expect(states[0].detailReadiness.macroBasisState).toBe("dirty");
    expect(states[0].detailReadiness.requiresWorkflowStep).toBeNull();
    expect(store.getAction(started.action.id)?.resultRef).toMatch(/^generation:2;/);
    expect(store.requireTrip(created.id).contentGeneration).toBe(2);
    expect(store.requireTrip(created.id).plan.days[0].stops).toEqual([expect.objectContaining({ candidateId: "core-a" })]);
    expect(rt.workspace(created.id).itineraryUpdateState.macro.status).toBe("needs_update");
    await waitForMapTasks(store, created.id);
    store.close();
  });

  it("keeps every requested affectedDayId in the Proposal even when one Day is sticky no-content", async () => {
    const store = db();
    const created = store.createTrip();
    const source = twoAreaPlan(created.plan);
    source.days[1] = { ...source.days[1], detailLevel: "detailed", detailStatus: "needs_review", stops: [{ id: "stop-core-b", candidateId: "core-b", placeId: "core-b-place", activity: "乙核心", period: "morning", startTime: "09:00", endTime: "11:00", durationMinutes: 120, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }] };
    store.writePlan(created.id, source, 0, { source: "test", summary: "two affected days" });
    saveResolved(store, created.id, 1, ["city-a", "city-b", "core-a-place", "core-b-place"]);
    const rt = runtime(store, async () => run({
      schemaVersion: 1,
      baseGeneration: 1,
      result: {
        type: "success", assistantMessage: "只调整甲城时间", title: "两天局部更新", explanation: "乙城保持不变", affectedDayIds: ["day-a", "day-b"],
        dayUpdates: [
          { dayId: "day-a", stops: [{ ...coreDraft, startTime: "10:00", endTime: "12:00" }] },
          { dayId: "day-b", stops: [{ candidateId: "core-b", activity: "乙核心", period: "morning", startTime: "09:00", endTime: "11:00", durationMinutes: 120, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }] },
        ],
        unscheduledCandidates: [],
      },
    }));

    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.detail.update", parameters: { dayIds: ["day-a", "day-b"] }, targetIds: ["day-a", "day-b"], requestKey: "two-day-sticky-patch" });
    await waitFor(() => store.getAction(started.action.id)?.status === "awaiting_apply");
    const proposal = store.getProposal(store.getAction(started.action.id)!.proposalId!)!;
    expect(proposal.diff.affectedDayIds).toEqual(["day-a", "day-b"]);
    expect(proposal.commands).toHaveLength(1);
    expect(proposal.commands[0].type).toBe("update_day_stop");
    await rt.applyProposal(created.id, proposal.id);
    const after = store.requireTrip(created.id).plan;
    expect(after.days.find((day) => day.id === "day-a")?.detailStatus).toBe("ready");
    expect(after.days.find((day) => day.id === "day-b")?.detailStatus).toBe("ready");
    expect(after.days.find((day) => day.id === "day-b")?.stops[0].id).toBe("stop-core-b");
    await waitForMapTasks(store, created.id);
    store.close();
  });
});
