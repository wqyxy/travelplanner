import { describe, expect, it } from "vitest";
import { emptyTravelPlan, type Day } from "./contracts-v2.js";
import { buildStageContext, STAGE_CONTEXT_MAX_BYTES } from "./stage-context-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

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
  return { id: "trip-large", title: plan.trip.title, state: "active", updatedAt: new Date().toISOString(), planLanguage: "bilingual", contentGeneration: 7, plan };
}

describe("stage context itinerary windowing", () => {
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
