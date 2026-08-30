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
import { TravelPlanDocumentSchema, type Day, type TravelPlanDocument } from "./contracts-v2.js";

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
function runtime(store: TravelStoreV3, startAction: (input: any) => Promise<any>) {
  const ai = { startAction, startDialogue: async () => { throw new Error("dialogue not expected"); }, startWebDialogue: async () => { throw new Error("web dialogue not expected"); } } as unknown as StagedTravelAiV3;
  const resolver = { resolve: async () => ({ resolution: null, candidates: [] }), resolveMany: async () => [], searchCandidates: async () => [] } as unknown as PlaceResolverV2;
  const routes = { workspaceRouteState: () => [], recalculate: async () => { throw new Error("route not expected"); } } as unknown as DayRouteServiceV2;
  return new TravelPlannerRuntimeV3({ store, ai, prompts: prompts(), tasks: new AiTaskMonitorV3(store, () => undefined), resolver, routes, emit: () => undefined });
}
function run(value: unknown, interrupt: () => Promise<void> = async () => undefined) {
  return { threadId: `action-${Math.random()}`, result: Promise.resolve(value), interrupt, turnId: () => "turn-action" };
}

function macroPlan(base: TravelPlanDocument) {
  return TravelPlanDocumentSchema.parse({
    ...base,
    places: [
      { id: "place-m1", nameZh: "目的地一", nameLocal: null, nameEn: "Macro One", kind: "city", city: "Macro One", region: null, country: "Test", countryCode: "TT", approximate: false },
      { id: "place-m2", nameZh: "目的地二", nameLocal: null, nameEn: "Macro Two", kind: "city", city: "Macro Two", region: null, country: "Test", countryCode: "TT", approximate: false },
    ],
    candidates: [
      { id: "macro-1", placeId: "place-m1", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: null, aiScore: 80, suggestedDurationMinutes: 1440, tags: [] },
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

  it("replans a 20-day two-stop itinerary without mechanically producing 120 commands", async () => {
    const store = db(); const created = store.createTrip(); store.writePlan(created.id, itineraryPlan(created.plan, 20), 0, { source: "test", summary: "20-day fixture" }); resolveAB(store, created.id, 1);
    const source = structuredClone(store.requireTrip(created.id).plan.days);
    for (const day of source) day.stops.reverse();
    const rt = runtime(store, async () => run({ schemaVersion: 1, baseGeneration: 1, result: { type: "success", assistantMessage: "已重新排序", title: "20 天重排", explanation: "复用现有地点", days: source } }));
    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.replan", parameters: {}, targetIds: [], requestKey: "replan-20" });
    await waitFor(() => store.getAction(started.action.id)?.status === "awaiting_apply");
    const action = store.getAction(started.action.id)!; const proposal = store.getProposal(action.proposalId!)!;
    expect(proposal.commands.length).toBe(20);
    expect(proposal.commands.every((command) => command.type === "move_day_stop")).toBe(true);
    store.close();
  });

  it("rejects a replan that introduces an unresolved concrete Place", async () => {
    const store = db(); const created = store.createTrip(); store.writePlan(created.id, itineraryPlan(created.plan, 1, true), 0, { source: "test", summary: "resolution fixture" }); resolveAB(store, created.id, 1);
    const source = structuredClone(store.requireTrip(created.id).plan.days);
    source[0].stops.push({ id: "ai-stop-c", candidateId: "candidate-c", placeId: "place-c", activity: "C", period: null, startTime: null, endTime: null, durationMinutes: 60, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null });
    const rt = runtime(store, async () => run({ schemaVersion: 1, baseGeneration: 1, result: { type: "success", assistantMessage: "加入 C", title: "加入 C", explanation: "测试未定位", days: source } }));
    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.replan", parameters: {}, targetIds: [], requestKey: "replan-unresolved" });
    await waitFor(() => store.getAction(started.action.id)?.status === "failed");
    expect(store.listProposals(created.id)).toHaveLength(0);
    expect(store.getAction(started.action.id)?.errorSummary).toMatch(/未定位地点不得进入行程/);
    store.close();
  });
});
