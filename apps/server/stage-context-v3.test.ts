import { describe, expect, it } from "vitest";
import { emptyTravelPlan, TravelPlanDocumentSchema, type Day } from "./contracts-v2.js";
import { buildStageContext, STAGE_CONTEXT_MAX_BYTES, validateSelectionForStage } from "./stage-context-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

function workflowTrip(): TripDetailV3 {
  const plan = TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    stage: "itinerary_planning",
    trip: {
      ...emptyTravelPlan().trip,
      originPlaceId: "city-a",
      dates: { start: null, end: null, requestedDurationDays: 1 },
    },
    places: [
      { id: "city-a", nameZh: "停留城", nameLocal: null, nameEn: null, kind: "city", city: null, region: null, country: "测试国", countryCode: "NZ", approximate: false },
      { id: "core-place", nameZh: "重要游览地", nameLocal: null, nameEn: null, kind: "attraction", city: "停留城", region: null, country: "测试国", countryCode: "NZ", approximate: false },
      { id: "detail-place", nameZh: "普通景点", nameLocal: null, nameEn: null, kind: "attraction", city: "停留城", region: null, country: "测试国", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "area-a", placeId: "city-a", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "core-a", placeId: "core-place", planningAreaCandidateId: "area-a", planningRole: "core_visit", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 360, tags: [] },
      { id: "detail-a", placeId: "detail-place", planningAreaCandidateId: "area-a", planningRole: "detail_interest", preference: "optional", source: "ai", aiReason: "可选", aiScore: 70, suggestedDurationMinutes: 60, tags: [] },
    ],
    days: [{
      id: "day-1", dayNumber: 1, date: null, title: "停留城", stayBlockId: "block-a", transferMode: "none", detailLevel: "planned", detailStatus: null,
      startAnchor: { id: "start-1", placeId: "city-a", label: null, notes: null }, stops: [], endAnchor: { id: "end-1", placeId: "city-a", label: null, notes: null },
    }],
  });
  return { id: "trip-workflow", title: plan.trip.title, state: "active", updatedAt: new Date().toISOString(), planLanguage: "zh", contentGeneration: 3, plan } as TripDetailV3;
}

function largeTrip(): TripDetailV3 {
  const plan = emptyTravelPlan();
  const place = { id: "place-a", nameZh: "测试地点", nameLocal: null, nameEn: "Test Place", kind: "attraction" as const, city: "测试城", region: null, country: "测试国", countryCode: "TT", approximate: false };
  plan.places.push(place);
  plan.candidates.push({ id: "candidate-a", placeId: place.id, planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 60, tags: [] });
  plan.stage = "itinerary_planning";
  plan.days = Array.from({ length: 20 }, (_, dayIndex): Day => ({
    id: `day-${dayIndex + 1}`,
    dayNumber: dayIndex + 1,
    date: null,
    title: `Day ${dayIndex + 1}`,
    stayBlockId: `block-${Math.floor(dayIndex / 2) + 1}`,
    transferMode: "none",
    detailLevel: "planned",
    detailStatus: null,
    startAnchor: { id: `start-${dayIndex + 1}`, placeId: null, label: null, notes: null },
    stops: Array.from({ length: 5 }, (_, stopIndex) => ({
      id: `stop-${dayIndex + 1}-${stopIndex + 1}`,
      candidateId: "candidate-a",
      placeId: "place-a",
      activity: `活动 ${dayIndex + 1}-${stopIndex + 1}`,
      period: null,
      startTime: null,
      endTime: null,
      durationMinutes: 60,
      transportFromPrevious: null,
      scheduleVerification: null,
      costNote: null,
      costVerification: null,
      notes: "长说明".repeat(450),
    })),
    endAnchor: { id: `end-${dayIndex + 1}`, placeId: null, label: null, notes: null },
  }));
  return { id: "trip-large", title: plan.trip.title, state: "active", updatedAt: new Date().toISOString(), planLanguage: "bilingual", contentGeneration: 7, plan } as TripDetailV3;
}

describe("Phase 2 stage context consumers", () => {
  it("shows Planning Areas, Core Visits and current Stay Blocks in destinations context without leaking the general Detail pool", () => {
    const trip = workflowTrip();
    const result = buildStageContext({ trip, stage: "destinations", selection: { type: "trip", id: null }, resolutions: [] });
    const state = result.state as any;

    expect(state.planningAreas.map((item: any) => item.id)).toEqual(["area-a"]);
    expect(state.coreVisits.map((item: any) => item.id)).toEqual(["core-a"]);
    expect(state.destinations.map((item: any) => item.id)).toEqual(["area-a", "core-a"]);
    expect(state.destinations.some((item: any) => item.id === "detail-a")).toBe(false);
    expect(state.selectedCandidate).toBeNull();
    expect(state.currentStays).toEqual([expect.objectContaining({ planningAreaCandidateId: "area-a", stayBlockId: "block-a", stayDays: 1 })]);
  });

  it("allows a selected Detail Interest to be carried into destinations only as the explicit cross-step promotion target", () => {
    const trip = workflowTrip();
    expect(validateSelectionForStage(trip, "destinations", { type: "candidate", id: "area-a" })).toEqual({ type: "candidate", id: "area-a" });
    expect(validateSelectionForStage(trip, "destinations", { type: "candidate", id: "core-a" })).toEqual({ type: "candidate", id: "core-a" });
    expect(validateSelectionForStage(trip, "destinations", { type: "candidate", id: "detail-a" })).toEqual({ type: "candidate", id: "detail-a" });
    const state = buildStageContext({ trip, stage: "destinations", selection: { type: "candidate", id: "detail-a" }, resolutions: [] }).state as any;
    expect(state.destinations.map((item: any) => item.id)).toEqual(["area-a", "core-a"]);
    expect(state.selectedCandidate).toMatchObject({ id: "detail-a", planningRole: "detail_interest", planningAreaCandidateId: "area-a" });
  });

  it("includes stayBlockId and planningState-compatible fields in itinerary context", () => {
    const trip = workflowTrip();
    const result = buildStageContext({ trip, stage: "itinerary", selection: { type: "day", id: "day-1" }, resolutions: [], routeStates: [] });
    const state = result.state as any;
    expect(state.dayIndex[0].stayBlockId).toBe("block-a");
    expect(state.days[0].stayBlockId).toBe("block-a");
    expect("planningState" in state).toBe(true);
  });

  it("keeps a large 20-day itinerary below the dialogue byte budget by prioritizing the selected day", () => {
    const trip = largeTrip();
    const result = buildStageContext({ trip, stage: "itinerary", selection: { type: "day", id: "day-10" }, resolutions: [], routeStates: [] });
    const state = result.state as any;
    expect(result.inputBytes).toBeLessThanOrEqual(STAGE_CONTEXT_MAX_BYTES);
    expect(state.dayIndex).toHaveLength(20);
    expect(state.days.length).toBeLessThanOrEqual(3);
    expect(state.days.some((day: Day) => day.id === "day-10")).toBe(true);
    expect(state.days.some((day: Day) => day.id === "day-1")).toBe(false);
  });
});