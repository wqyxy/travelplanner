import { describe, expect, it } from "vitest";
import {
  AdjustmentProposalOutputJsonSchema,
  CandidateDiscoveryOutputJsonSchema,
  ConversationOutputJsonSchema,
  MapResolutionAssistOutputJsonSchema,
  PlanGenerationOutputJsonSchema,
  PlaceResolutionSchema,
  TravelPlanDocumentSchema,
  emptyTravelPlan,
} from "./contracts-v2.js";

const place = (id: string) => ({ id, nameZh: id, nameLocal: null, nameEn: null, kind: "attraction" as const, city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false });
const candidate = (id: string, placeId: string, preference: "must_go" | "want_to_go" | "optional" | "excluded" = "optional") => ({ id, placeId, preference, source: "ai" as const, aiReason: "推荐", aiScore: 80, suggestedDurationMinutes: 90, tags: [] });

function containsForbiddenCoordinateKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenCoordinateKey);
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["lat", "lng", "latitude", "longitude", "coordinates"].includes(key)) return true;
    if (containsForbiddenCoordinateKey(item)) return true;
  }
  return false;
}

describe("TravelPlanDocument v2", () => {
  it("creates an empty candidate-first plan", () => {
    expect(emptyTravelPlan()).toMatchObject({ schemaVersion: 2, stage: "place_selection", candidates: [], days: [] });
  });

  it("rejects duplicate candidates for the same Place", () => {
    const value = emptyTravelPlan();
    value.places.push(place("p1"));
    value.candidates.push(candidate("c1", "p1"), candidate("c2", "p1"));
    expect(TravelPlanDocumentSchema.safeParse(value).success).toBe(false);
  });

  it("rejects an excluded Candidate in a Day", () => {
    const value = emptyTravelPlan();
    value.stage = "itinerary_planning";
    value.places.push(place("p1"));
    value.candidates.push(candidate("c1", "p1", "excluded"));
    value.days.push({
      id: "d1", dayNumber: 1, date: null, title: "京都", detailLevel: "planned", detailStatus: null,
      startAnchor: { id: "a1", placeId: null, label: null, notes: null },
      stops: [{ id: "s1", candidateId: "c1", placeId: "p1", activity: "参观", period: "morning", startTime: null, endTime: null, durationMinutes: 90, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null }],
      endAnchor: { id: "a2", placeId: null, label: null, notes: null },
    });
    expect(TravelPlanDocumentSchema.safeParse(value).success).toBe(false);
  });

  it("requires every must_go Candidate after plan generation", () => {
    const value = emptyTravelPlan();
    value.stage = "itinerary_planning";
    value.places.push(place("p1"));
    value.candidates.push(candidate("c1", "p1", "must_go"));
    value.days.push({ id: "d1", dayNumber: 1, date: null, title: "京都", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a1", placeId: null, label: null, notes: null }, stops: [], endAnchor: { id: "a2", placeId: null, label: null, notes: null } });
    expect(TravelPlanDocumentSchema.safeParse(value).success).toBe(false);
  });

  it("does not require adjacent Day anchors to match", () => {
    const value = emptyTravelPlan();
    value.stage = "itinerary_planning";
    value.places.push(place("hotel-osaka"), place("hotel-kyoto"));
    value.days.push(
      { id: "d1", dayNumber: 1, date: null, title: "大阪", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a1", placeId: "hotel-osaka", label: null, notes: null }, stops: [], endAnchor: { id: "a2", placeId: "hotel-osaka", label: null, notes: null } },
      { id: "d2", dayNumber: 2, date: null, title: "京都", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a3", placeId: "hotel-kyoto", label: null, notes: null }, stops: [], endAnchor: { id: "a4", placeId: "hotel-kyoto", label: null, notes: null } },
    );
    expect(TravelPlanDocumentSchema.safeParse(value).success).toBe(true);
  });
});

describe("controlled resolution and AI contracts", () => {
  it("requires coordinates only for resolved PlaceResolution", () => {
    expect(PlaceResolutionSchema.safeParse({ tripId: "t", placeId: "p", geoFingerprint: "v1|p", status: "resolved", method: "manual_coordinates", provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: null }).success).toBe(false);
    expect(PlaceResolutionSchema.safeParse({ tripId: "t", placeId: "p", geoFingerprint: "v1|p", status: "unresolved", method: "provider_match", provider: null, providerPlaceId: null, latitude: 1, longitude: 2, address: null, confidence: null, resolvedAt: null, errorMessage: "not found" }).success).toBe(false);
  });

  it("keeps every AI output JSON Schema free of coordinate fields", () => {
    for (const schema of [ConversationOutputJsonSchema, CandidateDiscoveryOutputJsonSchema, PlanGenerationOutputJsonSchema, AdjustmentProposalOutputJsonSchema, MapResolutionAssistOutputJsonSchema]) {
      expect(containsForbiddenCoordinateKey(schema)).toBe(false);
    }
  });
});
