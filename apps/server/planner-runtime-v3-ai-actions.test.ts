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
import { placeGeoFingerprint } from "./place-resolver-v2.js";
import type { DayRouteServiceV2 } from "./day-route-v2.js";
import { TravelPlanDocumentSchema, type Day, type PlaceResolution, type TravelPlanDocument } from "./contracts-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function db() {
  const root = mkdtempSync(path.join(tmpdir(), "planner-runtime-ai-v3-")); roots.push(root);
  const filename = path.join(root, "travel-v3.sqlite3");
  const store = new TravelStoreV3(filename); installRuntimeInvariantsV3(filename); return store;
}
async function waitFor(check: () => boolean) { for (let i = 0; i < 100; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("condition timeout"); }
function prompts(): LoadedPromptRegistryV3 {
  const compose = (id: any) => ({ id, relativePath: `${id}.md`, content: `# ${id}`, hash: `hash:${id}`, version: "v1" });
  return { prompts: new Map(), get: ((id: any) => compose(id)) as any, compose: compose as any };
}
function runtime(store: TravelStoreV3, startAction: (input: any) => Promise<any>, resolverOverride?: PlaceResolverV2) {
  const ai = { startAction, startDialogue: async () => { throw new Error("dialogue not expected"); }, startWebDialogue: async () => { throw new Error("web dialogue not expected"); } } as unknown as StagedTravelAiV3;
  const resolver = resolverOverride ?? ({ resolve: async () => ({ resolution: null, candidates: [] }), resolveMany: async () => [], searchCandidates: async () => [] } as unknown as PlaceResolverV2);
  const routes = { workspaceRouteState: () => [], workspaceMacroRouteState: () => [], recalculate: async () => null, recalculateMacro: async () => null } as unknown as DayRouteServiceV2;
  return new TravelPlannerRuntimeV3({ store, ai, prompts: prompts(), tasks: new AiTaskMonitorV3(store, () => undefined), resolver, routes, emit: () => undefined });
}
function run(value: unknown, interrupt: () => Promise<void> = async () => undefined) {
  return { threadId: `action-${Math.random()}`, result: Promise.resolve(value), interrupt, turnId: () => "turn-action" };
}

function macroPlan(base: TravelPlanDocument) {
  return TravelPlanDocumentSchema.parse({
    ...base,
    trip: { ...base.trip, dates: { ...base.trip.dates, requestedDurationDays: 2 } },
    places: [
      { id: "place-m1", nameZh: "目的地一", nameLocal: null, nameEn: "Macro One", kind: "city", city: "Macro One", region: null, country: "Test", countryCode: "TT", approximate: false },
      { id: "place-m2", nameZh: "目的地二", nameLocal: null, nameEn: "Macro Two", kind: "city", city: "Macro Two", region: null, country: "Test", countryCode: "TT", approximate: false },
    ],
    candidates: [
      { id: "macro-1", placeId: "place-m1", planningAreaCandidateId: null, preference: "must_go", source: "ai", aiReason: null, aiScore: 80, suggestedDurationMinutes: 1440, tags: [] },
      { id: "macro-2", placeId: "place-m2", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: null, aiScore: 80, suggestedDurationMinutes: 1440, tags: [] },
    ],
  });
}

function itineraryPlan(base: TravelPlanDocument, dayCount: number, includeThird = false) {
  const places = [
    { id: "place-a", nameZh: "地点 A", nameLocal: null, nameEn: "A", kind: "attraction" as const, city: "Test", region: null, country: "Test", countryCode: "TT", approximate: false },
    { id: "place-b", nameZh: "地点 B", nameLocal: null, nameEn: "B", kind: "attraction" as const, city: "Test", region: null, country: "Test", countryCode: "TT", approximate: false },
    ...(includeThird ? [{ id: "place-c", nameZh: "未定位 C", nameLocal: null, nameEn: "C", kind: "attraction" as const, city: "Test", region: null, country: "Test", countryCode: "TT", approximate: false }] : []),
  ];
  const candidates = places.map((place, index) => ({ id: `candidate-${String.fromCharCode(97 + index)}`, placeId: place.id, planningAreaCandidateId: null, preference: "optional" as const, source: "user" as const, aiReason: null, aiScore: null, suggestedDurationMinutes: 60, tags: [] }));
  const days: Day[] = Array.from({ length: dayCount }, (_, index) => ({
    id: `day-${index + 1}`,
    dayNumber: index + 1,
    date: null,
    title: `Day ${index + 1}`,
    transferMode: "none",
    detailLevel: "planned",
    detailStatus: null,
    startAnchor: { id: `start-${index + 1}`, placeId: null, label: null, notes: null },
    stops: [
      { id: `stop-a-${index + 1}`, candidateId: "candidate-a", placeId: "place-a", activity: "A", period: null, startTime: null, endTime: null, durationMinutes: 60, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null },
      { id: `stop-b-${index + 1}`, candidateId: "candidate-b", placeId: "place-b", activity: "B", period: null, startTime: null, endTime: null, durationMinutes: 60, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null },
    ],
    endAnchor: { id: `end-${index + 1}`, placeId: null, label: null, notes: null },
  }));
  return TravelPlanDocumentSchema.parse({ ...base, stage: "itinerary_planning", places, candidates, days });
}

function resolveAB(store: TravelStoreV3, tripId: string, generation: number) {
  const trip = store.requireTrip(tripId);
  for (const [index, id] of ["place-a", "place-b"].entries()) {
    const place = trip.plan.places.find((item) => item.id === id)!;
    store.upsertPlaceResolution(tripId, { tripId, placeId: id, geoFingerprint: placeGeoFingerprint(place), status: "resolved", method: "manual_coordinates", provider: null, providerPlaceId: null, latitude: 35 + index, longitude: 135 + index, address: null, confidence: null, resolvedAt: new Date().toISOString(), errorMessage: null }, generation);
  }
}

describe("TravelPlannerRuntimeV3 AI action regressions", () => {
  it("runs interest discovery exactly once per Macro and stop interrupts the current child run", async () => {
    const store = db(); const trip = store.createTrip(); store.writePlan(trip.id, macroPlan(trip.plan), 0, { source: "test", summary: "macro fixture" });
    const calls: any[] = []; let rejectSecond!: (error: Error) => void; let interrupted = 0;
    const rt = runtime(store, async (input) => {
      calls.push(input.state);
      const targetId = input.state.targetMacroCandidate.id;
      if (calls.length === 1) return run({ schemaVersion: 1, baseGeneration: 1, assistantMessage: "无新增", areaTargets: [{ planningAreaCandidateId: targetId, targetCount: 0, reason: "本轮无需新增" }], places: [], candidates: [] });
      const result = new Promise((_, reject) => { rejectSecond = reject; });
      return { threadId: "child-2", result, turnId: () => "turn-2", interrupt: async () => { interrupted += 1; rejectSecond(new Error("AI 任务已停止。")); } };
    });
    const started = rt.createCtaAction({ tripId: trip.id, stage: "interests", actionType: "interest.discover", parameters: {}, targetIds: ["macro-1", "macro-2"], requestKey: "discover-two" });
    await waitFor(() => calls.length === 2);
    expect(calls.map((state) => state.targetMacroCandidate.id)).toEqual(["macro-1", "macro-2"]);
    rt.stopTask(trip.id, started.taskId!);
    await waitFor(() => store.getAiTask(started.taskId!)?.status === "stopped");
    expect(interrupted).toBe(1);
    store.close();
  });

  it("updates only two affected Days in a 20-day Detailed Itinerary", async () => {
    const store = db(); const created = store.createTrip(); store.writePlan(created.id, itineraryPlan(created.plan, 20), 0, { source: "test", summary: "20-day fixture" }); resolveAB(store, created.id, 1);
    const affectedDayIds = ["day-1", "day-20"];
    const dayUpdates = affectedDayIds.map((dayId) => ({ dayId, stops: [
      { candidateId: "candidate-b", activity: "B", period: "morning", startTime: "09:00", endTime: "10:00", durationMinutes: 60, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null },
      { candidateId: "candidate-a", activity: "A", period: "morning", startTime: "10:30", endTime: "11:30", durationMinutes: 60, transportFromPrevious: { mode: "walk", durationMinutes: null, note: null, verification: { status: "estimated", checkedAt: null } }, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null },
    ] }));
    const rt = runtime(store, async () => run({ schemaVersion: 1, baseGeneration: 1, result: { type: "success", assistantMessage: "只更新两天", title: "局部更新", explanation: "其余日期保持不变", affectedDayIds, dayUpdates } }));
    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.detail.update", parameters: { dayIds: affectedDayIds }, targetIds: affectedDayIds, requestKey: "detail-update-2-of-20" });
    await waitFor(() => store.getAction(started.action.id)?.status === "awaiting_apply");
    const action = store.getAction(started.action.id)!; const proposal = store.getProposal(action.proposalId!)!;
    expect(proposal.diff.affectedDayIds).toEqual(affectedDayIds);
    expect(proposal.commands.length).toBeLessThan(20);
    expect(proposal.commands.every((command) => !JSON.stringify(command).match(/day-(?:[2-9]|1[0-9])\b/) || JSON.stringify(command).includes("day-20"))).toBe(true);
    store.close();
  });

  it("rejects Detailed generation that introduces an unresolved concrete Place", async () => {
    const store = db(); const created = store.createTrip(); store.writePlan(created.id, itineraryPlan(created.plan, 1, true), 0, { source: "test", summary: "resolution fixture" }); resolveAB(store, created.id, 1);
    const rt = runtime(store, async () => run({ schemaVersion: 1, baseGeneration: 1, result: { type: "success", assistantMessage: "加入 C", dayUpdates: [{ dayId: "day-1", stops: [{ candidateId: "candidate-c", activity: "C", period: "morning", startTime: "09:00", endTime: "10:00", durationMinutes: 60, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }] }], unscheduledCandidates: [] } }));
    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.detail.generate", parameters: {}, targetIds: [], requestKey: "detail-unresolved" });
    await waitFor(() => store.getAction(started.action.id)?.status === "failed");
    expect(store.listProposals(created.id)).toHaveLength(0);
    expect(store.getAction(started.action.id)?.errorSummary).toMatch(/未定位地点不得进入行程/);
    store.close();
  });

  it("clears needs_review when a scoped Detail update requires no content commands", async () => {
    const store = db(); const created = store.createTrip();
    const source = itineraryPlan(created.plan, 1);
    source.days[0] = {
      ...source.days[0], detailLevel: "detailed", detailStatus: "needs_review",
      stops: source.days[0].stops.map((stop, index) => ({
        ...stop, period: "morning", startTime: index ? "10:30" : "09:00", endTime: index ? "11:30" : "10:00", durationMinutes: 60,
        transportFromPrevious: index ? { mode: "walk", durationMinutes: null, note: null, verification: { status: "estimated", checkedAt: null } } : null,
        scheduleVerification: { status: "estimated", checkedAt: null },
      })),
    };
    store.writePlan(created.id, source, 0, { source: "test", summary: "needs review fixture" }); resolveAB(store, created.id, 1);
    const day = store.requireTrip(created.id).plan.days[0];
    const rt = runtime(store, async () => run({ schemaVersion: 1, baseGeneration: 1, result: {
      type: "success", assistantMessage: "无需调整", title: "确认本日", explanation: "现有内容仍然有效", affectedDayIds: [day.id],
      dayUpdates: [{ dayId: day.id, stops: day.stops.map(({ candidateId, activity, period, startTime, endTime, durationMinutes, transportFromPrevious, scheduleVerification, costNote, costVerification, notes }) => ({ candidateId, activity, period, startTime, endTime, durationMinutes, transportFromPrevious, scheduleVerification, costNote, costVerification, notes })) }],
    } }));
    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.detail.update", parameters: { dayIds: [day.id] }, targetIds: [day.id], requestKey: "detail-no-content-change" });
    await waitFor(() => store.getAction(started.action.id)?.status === "completed");
    expect(store.requireTrip(created.id).plan.days[0].detailStatus).toBe("ready");
    expect(store.listProposals(created.id)).toEqual([]);
    store.close();
  });

  it("resolves every generated Macro mapping best-effort before destination generation completes", async () => {
    const store = db(); const created = store.createTrip(); const resolvedIds: string[] = [];
    store.writePlan(created.id, { ...created.plan, trip: { ...created.plan.trip, brief: { ...created.plan.trip.brief, destination: "Test" }, preferences: ["自然风景"] } }, 0, { source: "test", summary: "requirements fixture" });
    const resolver = {
      resolve: async () => ({ resolution: null, candidates: [] }),
      resolveMany: async (tripId: string, placeIds: string[], generation: number, _signal?: AbortSignal, onProgress?: (event: any) => void) => {
        const results: Array<{ resolution: PlaceResolution; candidates: [] }> = [];
        for (const [index, placeId] of placeIds.entries()) {
          const trip = store.requireTrip(tripId); const place = trip.plan.places.find((item) => item.id === placeId)!;
          const resolving: PlaceResolution = { tripId, placeId, geoFingerprint: placeGeoFingerprint(place), status: "resolving", method: "provider_match", provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: null };
          store.upsertPlaceResolution(tripId, resolving, generation);
          onProgress?.({ placeId, status: "resolving", completed: index, total: placeIds.length, resolution: resolving });
          const resolution: PlaceResolution = { ...resolving, status: "resolved", method: "manual_coordinates", latitude: 40 + index, longitude: 170 + index, resolvedAt: new Date().toISOString() };
          store.upsertPlaceResolution(tripId, resolution, generation);
          resolvedIds.push(placeId);
          onProgress?.({ placeId, status: "resolved", completed: index + 1, total: placeIds.length, resolution });
          results.push({ resolution, candidates: [] });
        }
        return results;
      },
      searchCandidates: async () => [],
    } as unknown as PlaceResolverV2;
    const rt = runtime(store, async () => run({
      schemaVersion: 1,
      baseGeneration: 1,
      assistantMessage: "生成目的地",
      places: [
        { id: "tmp-place-1", nameZh: "目的地一", nameLocal: null, nameEn: "Macro One", kind: "city", city: "Macro One", region: null, country: "Test", countryCode: "TT", approximate: false },
        { id: "tmp-place-2", nameZh: "目的地二", nameLocal: null, nameEn: "Macro Two", kind: "city", city: "Macro Two", region: null, country: "Test", countryCode: "TT", approximate: false },
      ],
      candidates: [
        { temporaryId: "tmp-candidate-1", placeTemporaryId: "tmp-place-1", planningAreaCandidateId: null, aiReason: "适合", aiScore: 90, suggestedDurationMinutes: 1440, tags: [], defaultPreference: "optional" },
        { temporaryId: "tmp-candidate-2", placeTemporaryId: "tmp-place-2", planningAreaCandidateId: null, aiReason: "适合", aiScore: 88, suggestedDurationMinutes: 1440, tags: [], defaultPreference: "optional" },
      ],
    }), resolver);
    const started = rt.createCtaAction({ tripId: created.id, stage: "destinations", actionType: "destination.generate", parameters: {}, targetIds: [], requestKey: "destination-resolve" });
    await waitFor(() => store.getAction(started.action.id)?.status === "completed");
    expect(resolvedIds).toHaveLength(2);
    expect(store.listPlaceResolutions(created.id).filter((item) => item.status === "resolved")).toHaveLength(2);
    expect(store.getAction(started.action.id)?.resultRef).toMatch(/resolved:2\/2/);
    store.close();
  });

  it("rejects generated destinations outside the saved United Kingdom scope", async () => {
    const store = db(); const created = store.createTrip();
    store.writePlan(created.id, { ...created.plan, trip: { ...created.plan.trip, brief: { ...created.plan.trip.brief, destination: "英国", additionalRequirements: "每天驾驶不超过 3 小时" } } }, 0, { source: "test", summary: "United Kingdom scope" });
    const actionStates: any[] = [];
    const rt = runtime(store, async (input) => { actionStates.push(input.state); return run({ schemaVersion: 1, baseGeneration: 1, assistantMessage: "错误结果", places: [{ id: "tmp-place-fr", nameZh: "巴黎", nameLocal: null, nameEn: "Paris", kind: "city", city: "Paris", region: null, country: "France", countryCode: "FR", approximate: false }], candidates: [{ temporaryId: "tmp-candidate-fr", placeTemporaryId: "tmp-place-fr", planningAreaCandidateId: null, aiReason: "错误", aiScore: 50, suggestedDurationMinutes: 1440, tags: [], defaultPreference: "optional" }] }); });
    const started = rt.createCtaAction({ tripId: created.id, stage: "destinations", actionType: "destination.generate", parameters: {}, targetIds: [], requestKey: "reject-outside-uk" });
    await waitFor(() => store.getAction(started.action.id)?.status === "failed");
    expect(store.getAction(started.action.id)?.errorSummary).toMatch(/范围外地点/);
    expect(actionStates[0].tripFacts.brief.additionalRequirements).toBe("每天驾驶不超过 3 小时");
    expect(store.requireTrip(created.id).plan.candidates).toEqual([]);
    store.close();
  });

  it("exposes current resolving and unresolved records through the V3 workspace", () => {
    const store = db(); const created = store.createTrip(); const written = store.writePlan(created.id, macroPlan(created.plan), 0, { source: "test", summary: "resolution visibility fixture" });
    const trip = store.requireTrip(created.id);
    const p1 = trip.plan.places.find((place) => place.id === "place-m1")!;
    const p2 = trip.plan.places.find((place) => place.id === "place-m2")!;
    store.upsertPlaceResolution(created.id, { tripId: created.id, placeId: p1.id, geoFingerprint: placeGeoFingerprint(p1), status: "resolving", method: "provider_match", provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: null }, written.generation);
    store.upsertPlaceResolution(created.id, { tripId: created.id, placeId: p2.id, geoFingerprint: placeGeoFingerprint(p2), status: "unresolved", method: "provider_match", provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: "需要人工确认地图实体。" }, written.generation);
    const rt = runtime(store, async () => run({}));
    const workspace = rt.workspace(created.id);
    expect(workspace.resolutions.map((resolution) => [resolution.placeId, resolution.status])).toEqual(expect.arrayContaining([[p1.id, "resolving"], [p2.id, "unresolved"]]));
    expect(workspace.resolutions.find((resolution) => resolution.placeId === p2.id)?.errorMessage).toBe("需要人工确认地图实体。");
    store.close();
  });

  it("allows unresolved Macro destinations while leaving their Route pending", async () => {
    const store = db(); const created = store.createTrip(); store.writePlan(created.id, macroPlan(created.plan), 0, { source: "test", summary: "macro itinerary fixture" });
    const rt = runtime(store, async () => run({
      schemaVersion: 2,
      baseGeneration: 1,
      result: {
        type: "success",
        assistantMessage: "生成两天骨架",
        destinations: [
          { destinationCandidateId: "macro-1", stayDays: 1, transferMode: "none" },
          { destinationCandidateId: "macro-2", stayDays: 1, transferMode: "rail" },
        ],
      },
    }));
    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.generate", parameters: {}, targetIds: [], requestKey: "generate-unresolved-macro" });
    await waitFor(() => store.getAction(started.action.id)?.status === "completed");
    expect(store.requireTrip(created.id).plan.days).toHaveLength(2);
    expect(store.getAction(started.action.id)?.errorSummary).toBeNull();
    store.close();
  });

  it("creates and applies a refine Proposal without exposing Anchor or identity fields to the model", async () => {
    const store = db(); const created = store.createTrip(); store.writePlan(created.id, itineraryPlan(created.plan, 1), 0, { source: "test", summary: "refine fixture" }); resolveAB(store, created.id, 1);
    const before = structuredClone(store.requireTrip(created.id).plan.days[0]);
    const rt = runtime(store, async () => run({
      schemaVersion: 1,
      baseGeneration: 1,
      result: {
        type: "success",
        assistantMessage: "已细化",
        title: "Day 1 细化",
        explanation: "补充时间与核验状态",
        dayIds: ["day-1"],
        dayUpdates: [{
          dayId: "day-1",
          stops: [
            { stopId: "stop-a-1", activity: "上午游览 A", period: "morning", startTime: "09:00", endTime: "10:00", durationMinutes: 60, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: "预留入场时间" },
            { stopId: "stop-b-1", activity: "上午游览 B", period: "morning", startTime: "10:30", endTime: "11:30", durationMinutes: 60, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null },
          ],
        }],
      },
    }));
    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.refine", parameters: { dayIds: ["day-1"] }, targetIds: ["day-1"], requestKey: "refine-day-1" });
    await waitFor(() => store.getAction(started.action.id)?.status === "awaiting_apply");
    const action = store.getAction(started.action.id)!; const proposal = store.getProposal(action.proposalId!)!;
    expect(proposal.commands.length).toBe(2);
    expect(proposal.commands.every((command) => command.type === "update_day_stop")).toBe(true);
    await rt.applyProposal(created.id, proposal.id);
    const after = store.requireTrip(created.id).plan.days[0];
    expect(after.startAnchor).toEqual(before.startAnchor);
    expect(after.endAnchor).toEqual(before.endAnchor);
    expect(after.stops.map((stop) => [stop.id, stop.candidateId, stop.placeId])).toEqual(before.stops.map((stop) => [stop.id, stop.candidateId, stop.placeId]));
    expect(after.detailLevel).toBe("detailed");
    expect(after.detailStatus).toBe("ready");
    expect(store.getProposal(proposal.id)?.status).toBe("applied");
    store.close();
  });
});
