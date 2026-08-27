import { describe, expect, it } from "vitest";
import type { PlaceResolution, PlanGenerationOutput, TravelPlanDocument } from "./contracts-v2.js";
import { optimizeGeneratedSightseeingOrder } from "./plan-route-order-v2.js";

const places = [
  { id: "city", nameZh: "测试城", nameLocal: "Test City", nameEn: "Test City", kind: "city", city: "Test City", region: null, country: "测试国", countryCode: "TC", approximate: true },
  { id: "a", nameZh: "A景点", nameLocal: null, nameEn: null, kind: "attraction", city: "Test City", region: null, country: "测试国", countryCode: "TC", approximate: false },
  { id: "b", nameZh: "B景点", nameLocal: null, nameEn: null, kind: "attraction", city: "Test City", region: null, country: "测试国", countryCode: "TC", approximate: false },
  { id: "c", nameZh: "C景点", nameLocal: null, nameEn: null, kind: "attraction", city: "Test City", region: null, country: "测试国", countryCode: "TC", approximate: false },
] as TravelPlanDocument["places"];

const candidates = [
  { id: "city-c", placeId: "city", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: "城市", aiScore: 80, suggestedDurationMinutes: null, tags: [] },
  { id: "a-c", placeId: "a", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: "A", aiScore: 80, suggestedDurationMinutes: 60, tags: [] },
  { id: "b-c", placeId: "b", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: "B", aiScore: 80, suggestedDurationMinutes: 60, tags: [] },
  { id: "c-c", placeId: "c", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: "C", aiScore: 80, suggestedDurationMinutes: 60, tags: [] },
] as TravelPlanDocument["candidates"];

const trip = {
  schemaVersion: 2,
  stage: "place_selection",
  trip: {
    title: "测试",
    originPlaceId: null,
    destinationPlaceIds: [],
    dates: { start: null, end: null, requestedDurationDays: 1 },
    travelers: { summary: "", adults: null, children: null },
    budget: { amount: null, currency: null, note: null },
    pace: null,
    themes: [],
    preferences: [],
    constraints: [],
    assumptions: [],
  },
  places,
  candidates,
  days: [],
  warnings: [],
} as TravelPlanDocument;

const stop = (id: string, candidateId: string, placeId: string) => ({
  id,
  candidateId,
  placeId,
  activity: placeId,
  period: null,
  startTime: null,
  endTime: null,
  durationMinutes: 60,
  transportFromPrevious: { mode: "walk" as const, durationMinutes: 999, note: null, verification: { status: "estimated" as const, checkedAt: null } },
  scheduleVerification: null,
  costNote: null,
  costVerification: null,
  notes: null,
});

const output: PlanGenerationOutput = {
  schemaVersion: 1,
  baseGeneration: 0,
  assistantMessage: "完成",
  newPlaces: [],
  days: [{
    id: "day-1",
    dayNumber: 1,
    date: null,
    title: "测试城",
    detailLevel: "planned",
    detailStatus: null,
    startAnchor: { id: "start", placeId: null, label: null, notes: null },
    stops: [stop("stop-a", "a-c", "a"), stop("stop-b", "b-c", "b"), stop("stop-c", "c-c", "c")],
    endAnchor: { id: "end", placeId: null, label: null, notes: null },
  }],
  unscheduledCandidates: [{ candidateId: "city-c", reason: "城市由具体景点满足" }],
};

const resolution = (placeId: string, longitude: number): PlaceResolution => ({
  tripId: "trip",
  placeId,
  geoFingerprint: placeId,
  status: "resolved",
  method: "manual_coordinates",
  provider: null,
  providerPlaceId: null,
  latitude: 0,
  longitude,
  address: null,
  confidence: 1,
  resolvedAt: "2026-08-27T00:00:00Z",
  errorMessage: null,
});

describe("local sightseeing route order", () => {
  it("keeps the first sightseeing stop and then chooses nearby points to reduce obvious backtracking", () => {
    const optimized = optimizeGeneratedSightseeingOrder(trip, output, [resolution("a", 0), resolution("b", 10), resolution("c", 1)]);
    expect(optimized.days[0].stops.map((item) => item.candidateId)).toEqual(["a-c", "c-c", "b-c"]);
    expect(optimized.days[0].stops[1].transportFromPrevious?.durationMinutes).toBeNull();
    expect(optimized.days[0].stops[1].transportFromPrevious?.verification.status).toBe("unverified");
  });
});
