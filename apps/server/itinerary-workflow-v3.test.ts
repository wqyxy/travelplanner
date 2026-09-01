import { describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema, emptyTravelPlan, type TravelPlanDocument } from "./contracts-v2.js";
import { applyDetailedUpdatesV3, buildMacroDaysV3, deriveItineraryUpdateStateV3, macroReplacementCommandsV3 } from "./itinerary-workflow-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

function plan(): TravelPlanDocument {
  return TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    trip: {
      ...emptyTravelPlan().trip,
      title: "5 天测试旅行",
      originPlaceId: "city-a",
      destinationPlaceIds: ["city-a", "city-b"],
      dates: { start: null, end: null, requestedDurationDays: 5 },
    },
    places: [
      { id: "city-a", nameZh: "甲城", nameLocal: null, nameEn: null, kind: "city", city: null, region: null, country: "测试国", countryCode: "NZ", approximate: false },
      { id: "city-b", nameZh: "乙城", nameLocal: null, nameEn: null, kind: "city", city: null, region: null, country: "测试国", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "macro-a", placeId: "city-a", planningAreaCandidateId: null, preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "macro-b", placeId: "city-b", planningAreaCandidateId: null, preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
    ],
  });
}

function tripDetail(planValue: TravelPlanDocument): TripDetailV3 {
  return {
    id: "trip-1",
    title: "5 天测试旅行",
    state: "active",
    planLanguage: "zh",
    contentGeneration: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    plan: planValue,
  } as TripDetailV3;
}

describe("itinerary macro/detail workflow", () => {
  it("counts the transfer day as the arrival destination first day", () => {
    const source = plan();
    const days = buildMacroDaysV3(tripDetail(source), [
      { destinationCandidateId: "macro-a", stayDays: 2, transferMode: "none" },
      { destinationCandidateId: "macro-b", stayDays: 3, transferMode: "drive" },
    ]);

    expect(days).toHaveLength(5);
    expect(days[0].startAnchor.placeId).toBe("city-a");
    expect(days[0].endAnchor.placeId).toBe("city-a");
    expect(days[1].endAnchor.placeId).toBe("city-a");
    expect(days[2].startAnchor.placeId).toBe("city-a");
    expect(days[2].endAnchor.placeId).toBe("city-b");
    expect(days[2].transferMode).toBe("drive");
    expect(days.slice(2).every((day) => day.endAnchor.placeId === "city-b")).toBe(true);
  });

  it("rejects macro outputs whose stay days do not equal trip duration", () => {
    expect(() => buildMacroDaysV3(tripDetail(plan()), [
      { destinationCandidateId: "macro-a", stayDays: 2, transferMode: "none" },
      { destinationCandidateId: "macro-b", stayDays: 2, transferMode: "drive" },
    ])).toThrow(/5 天/);
  });

  it("reuses stable Day IDs and affects only structurally moved or changed Days", () => {
    const source = plan();
    const days = buildMacroDaysV3(tripDetail(source), [
      { destinationCandidateId: "macro-a", stayDays: 2, transferMode: "none" },
      { destinationCandidateId: "macro-b", stayDays: 3, transferMode: "drive" },
    ]);
    const withDays = TravelPlanDocumentSchema.parse({ ...source, stage: "itinerary_planning", days });
    const unchanged = macroReplacementCommandsV3(tripDetail(withDays), [
      { destinationCandidateId: "macro-a", stayDays: 2, transferMode: "none" },
      { destinationCandidateId: "macro-b", stayDays: 3, transferMode: "drive" },
    ]);
    expect(unchanged.commands).toEqual([]);
    expect(unchanged.affectedDayIds).toEqual([]);

    const changed = macroReplacementCommandsV3(tripDetail(withDays), [
      { destinationCandidateId: "macro-a", stayDays: 1, transferMode: "none" },
      { destinationCandidateId: "macro-b", stayDays: 4, transferMode: "drive" },
    ]);
    expect(changed.affectedDayIds).not.toContain(days[0].id);
    expect(new Set(changed.affectedDayIds)).toEqual(new Set(days.slice(1).map((day) => day.id)));
  });

  it("keeps Macro anchors stable during Detail generation and enforces must_go only there", () => {
    const source = plan();
    const poi = { id: "poi-a", nameZh: "必去景点", nameLocal: null, nameEn: null, kind: "attraction" as const, city: "甲城", region: null, country: "测试国", countryCode: "NZ", approximate: false };
    const micro = { id: "micro-a", placeId: poi.id, planningAreaCandidateId: "macro-a", preference: "must_go" as const, source: "user" as const, aiReason: null, aiScore: null, suggestedDurationMinutes: 60, tags: [] };
    const macroDays = buildMacroDaysV3(tripDetail(source), [
      { destinationCandidateId: "macro-a", stayDays: 2, transferMode: "none" },
      { destinationCandidateId: "macro-b", stayDays: 3, transferMode: "drive" },
    ]);
    const macroPlan = TravelPlanDocumentSchema.parse({ ...source, stage: "itinerary_planning", places: [...source.places, poi], candidates: [...source.candidates, micro], days: macroDays });
    const macroTrip = tripDetail(macroPlan);
    const emptyUpdates = macroDays.map((day) => ({ dayId: day.id, stops: [] }));
    expect(() => applyDetailedUpdatesV3(macroTrip, emptyUpdates, true)).toThrow(/必去/);

    const updates = emptyUpdates.map((update, index) => index === 0 ? { ...update, stops: [{ candidateId: micro.id, activity: "参观", period: "morning" as const, startTime: "09:00", endTime: "10:00", durationMinutes: 60, transportFromPrevious: null, scheduleVerification: { status: "estimated" as const, checkedAt: null }, costNote: null, costVerification: null, notes: null }] } : update);
    const detailed = applyDetailedUpdatesV3(macroTrip, updates, true);
    expect(detailed.days.every((day) => day.detailLevel === "detailed" && day.detailStatus === "ready")).toBe(true);
    expect(detailed.days.map((day) => [day.id, day.startAnchor, day.endAnchor])).toEqual(macroDays.map((day) => [day.id, day.startAnchor, day.endAnchor]));
  });

  it("marks macro itinerary for update when a day points to no active destination", () => {
    const source = plan();
    const days = buildMacroDaysV3(tripDetail(source), [
      { destinationCandidateId: "macro-a", stayDays: 2, transferMode: "none" },
      { destinationCandidateId: "macro-b", stayDays: 3, transferMode: "drive" },
    ]);
    const afterRemoval = TravelPlanDocumentSchema.parse({
      ...source,
      stage: "itinerary_planning",
      candidates: source.candidates.filter((candidate) => candidate.id !== "macro-b"),
      places: source.places.filter((place) => place.id !== "city-b"),
      trip: { ...source.trip, destinationPlaceIds: ["city-a"] },
      days: days.map((day) => day.endAnchor.placeId === "city-b"
        ? { ...day, startAnchor: day.startAnchor.placeId === "city-b" ? { ...day.startAnchor, placeId: null, label: null } : day.startAnchor, endAnchor: { ...day.endAnchor, placeId: null, label: null }, detailStatus: "needs_review" }
        : day),
    });

    expect(deriveItineraryUpdateStateV3(afterRemoval).macro.status).toBe("needs_update");
  });
});
