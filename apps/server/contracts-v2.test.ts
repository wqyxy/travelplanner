import { describe, expect, it } from "vitest";
import {
  AdjustmentProposalOutputJsonSchema,
  MacroCandidateDiscoveryOutputJsonSchema,
  MicroCandidateDiscoveryOutputJsonSchema,
  ConversationOutputJsonSchema,
  MapResolutionAssistOutputJsonSchema,
  PlanGenerationOutputJsonSchema,
  PlaceResolutionSchema,
  TravelPlanDocumentSchema,
  emptyTravelPlan,
} from "./contracts-v2.js";

const place = (id: string) => ({ id, nameZh: id, nameLocal: null, nameEn: null, kind: "attraction" as const, city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false });
const city = (id: string) => ({ id, nameZh: id, nameLocal: null, nameEn: null, kind: "city" as const, city: id, region: null, country: "日本", countryCode: "JP", approximate: false });
const candidate = (id: string, placeId: string, preference: "must_go" | "want_to_go" | "optional" | "excluded" = "optional", planningAreaCandidateId: string | null = null) => ({ id, placeId, planningAreaCandidateId, preference, source: "ai" as const, aiReason: "推荐", aiScore: 80, suggestedDurationMinutes: 90, tags: [] });

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

  it("allows an excluded Candidate in a Day", () => {
    const value = emptyTravelPlan();
    value.stage = "itinerary_planning";
    value.places.push(place("p1"));
    value.candidates.push(candidate("c1", "p1", "excluded"));
    value.days.push({
      id: "d1", dayNumber: 1, date: null, title: "京都", transferMode: "none", detailLevel: "planned", detailStatus: null,
      startAnchor: { id: "a1", placeId: null, label: null, notes: null },
      stops: [{ id: "s1", candidateId: "c1", placeId: "p1", activity: "参观", period: "morning", startTime: null, endTime: null, durationMinutes: 90, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null }],
      endAnchor: { id: "a2", placeId: null, label: null, notes: null },
    });
    expect(TravelPlanDocumentSchema.safeParse(value).success).toBe(true);
  });

  it("allows must_go POIs to remain unscheduled in the Macro stage", () => {
    const value = emptyTravelPlan();
    value.stage = "itinerary_planning";
    value.places.push(place("p1"));
    value.candidates.push(candidate("c1", "p1", "must_go"));
    value.days.push({ id: "d1", dayNumber: 1, date: null, title: "京都", transferMode: "none", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a1", placeId: null, label: null, notes: null }, stops: [], endAnchor: { id: "a2", placeId: null, label: null, notes: null } });
    expect(TravelPlanDocumentSchema.safeParse(value).success).toBe(true);
  });

  it("does not require adjacent Day anchors to match", () => {
    const value = emptyTravelPlan();
    value.stage = "itinerary_planning";
    value.places.push(place("hotel-osaka"), place("hotel-kyoto"));
    value.days.push(
      { id: "d1", dayNumber: 1, date: null, title: "大阪", transferMode: "none", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a1", placeId: "hotel-osaka", label: null, notes: null }, stops: [], endAnchor: { id: "a2", placeId: "hotel-osaka", label: null, notes: null } },
      { id: "d2", dayNumber: 2, date: null, title: "京都", transferMode: "none", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a3", placeId: "hotel-kyoto", label: null, notes: null }, stops: [], endAnchor: { id: "a4", placeId: "hotel-kyoto", label: null, notes: null } },
    );
    expect(TravelPlanDocumentSchema.safeParse(value).success).toBe(true);
  });

  it("keeps legacy Candidate and Day documents readable without new optional fields", () => {
    const value = emptyTravelPlan();
    value.places.push(city("area-1"), place("poi-1"));
    value.candidates.push(candidate("area-candidate", "area-1"), candidate("poi-candidate", "poi-1", "optional", "area-candidate"));
    expect(TravelPlanDocumentSchema.safeParse(value).success).toBe(true);
    expect(value.candidates[0]).not.toHaveProperty("planningRole");
    expect(value).not.toHaveProperty("planningState");
  });

  it("accepts explicit planning roles with valid parent semantics", () => {
    const value = emptyTravelPlan();
    value.places.push(city("area-1"), place("core-1"), { ...place("detail-1"), nameZh: "detail-1" });
    value.candidates.push(
      { ...candidate("area-candidate", "area-1"), planningRole: "planning_area" },
      { ...candidate("core-candidate", "core-1", "must_go", "area-candidate"), planningRole: "core_visit" },
      { ...candidate("detail-candidate", "detail-1", "optional", "area-candidate"), planningRole: "detail_interest" },
    );
    expect(TravelPlanDocumentSchema.safeParse(value).success).toBe(true);
  });

  it("allows nontraditional explicit roles and missing parents", () => {
    const areaAsAttraction = emptyTravelPlan();
    areaAsAttraction.places.push(place("p1"));
    areaAsAttraction.candidates.push({ ...candidate("c1", "p1"), planningRole: "planning_area" });
    expect(TravelPlanDocumentSchema.safeParse(areaAsAttraction).success).toBe(true);

    const coreWithoutParent = emptyTravelPlan();
    coreWithoutParent.places.push(place("p1"));
    coreWithoutParent.candidates.push({ ...candidate("c1", "p1"), planningRole: "core_visit" });
    expect(TravelPlanDocumentSchema.safeParse(coreWithoutParent).success).toBe(true);

    const detailOnCity = emptyTravelPlan();
    detailOnCity.places.push(city("p1"));
    detailOnCity.candidates.push({ ...candidate("c1", "p1"), planningRole: "detail_interest" });
    expect(TravelPlanDocumentSchema.safeParse(detailOnCity).success).toBe(true);
  });

  it("keeps stayBlockId optional and accepts it when present", () => {
    const value = emptyTravelPlan();
    value.stage = "itinerary_planning";
    value.days.push({ id: "d1", dayNumber: 1, date: null, title: "Day 1", stayBlockId: "stay-1", transferMode: "none", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a1", placeId: null, label: null, notes: null }, stops: [], endAnchor: { id: "a2", placeId: null, label: null, notes: null } });
    expect(TravelPlanDocumentSchema.safeParse(value).success).toBe(true);
  });

  it("persists only the macro basis fingerprint and rejects macroDirty", () => {
    const valid = { ...emptyTravelPlan(), planningState: { macroBasisVersion: 1 as const, macroBasisFingerprint: "fingerprint-v1" } };
    expect(TravelPlanDocumentSchema.safeParse(valid).success).toBe(true);
    expect(TravelPlanDocumentSchema.safeParse({ ...valid, planningState: { ...valid.planningState, macroDirty: true } }).success).toBe(false);
  });
});

describe("controlled resolution and AI contracts", () => {
  it("requires coordinates only for resolved PlaceResolution", () => {
    expect(PlaceResolutionSchema.safeParse({ tripId: "t", placeId: "p", geoFingerprint: "v1|p", status: "resolved", method: "manual_coordinates", provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: null }).success).toBe(false);
    expect(PlaceResolutionSchema.safeParse({ tripId: "t", placeId: "p", geoFingerprint: "v1|p", status: "unresolved", method: "provider_match", provider: null, providerPlaceId: null, latitude: 1, longitude: 2, address: null, confidence: null, resolvedAt: null, errorMessage: "not found" }).success).toBe(false);
  });

  it("keeps every AI output JSON Schema free of coordinate fields", () => {
    for (const schema of [ConversationOutputJsonSchema, MacroCandidateDiscoveryOutputJsonSchema, MicroCandidateDiscoveryOutputJsonSchema, PlanGenerationOutputJsonSchema, AdjustmentProposalOutputJsonSchema, MapResolutionAssistOutputJsonSchema]) {
      expect(containsForbiddenCoordinateKey(schema)).toBe(false);
    }
  });
});
