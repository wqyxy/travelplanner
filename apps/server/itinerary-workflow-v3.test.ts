import { describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema, emptyTravelPlan, type TravelPlanDocument } from "./contracts-v2.js";
import { buildMacroDaysV3, deriveItineraryUpdateStateV3 } from "./itinerary-workflow-v3.js";
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
