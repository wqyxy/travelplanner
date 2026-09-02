import { describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema, emptyTravelPlan, type PlaceResolution, type TravelPlanDocument } from "./contracts-v2.js";
import { buildDetailPlanningContextV3, detailPlanningReadinessV3 } from "./planning-context-v3.js";
import { computeMacroDependencyFingerprintV3 } from "./planning-state-v3.js";
import { placeGeoFingerprint } from "./place-resolver-v2.js";

function plan(): TravelPlanDocument {
  const base = TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    stage: "itinerary_refinement",
    trip: { ...emptyTravelPlan().trip, title: "两地测试", originPlaceId: "city-a", dates: { start: null, end: null, requestedDurationDays: 2 }, pace: "轻松" },
    places: [
      { id: "city-a", nameZh: "甲城", nameLocal: null, nameEn: "A", kind: "city", city: null, region: null, country: "测试", countryCode: "NZ", approximate: false },
      { id: "city-b", nameZh: "乙城", nameLocal: null, nameEn: "B", kind: "city", city: null, region: null, country: "测试", countryCode: "NZ", approximate: false },
      { id: "core-a-place", nameZh: "甲核心", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "测试", countryCode: "NZ", approximate: false },
      { id: "detail-a-place", nameZh: "甲必去", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "测试", countryCode: "NZ", approximate: false },
      { id: "core-b-place", nameZh: "乙核心", nameLocal: null, nameEn: null, kind: "attraction", city: "乙城", region: null, country: "测试", countryCode: "NZ", approximate: false },
      { id: "want-b-place", nameZh: "乙想去核心", nameLocal: null, nameEn: null, kind: "attraction", city: "乙城", region: null, country: "测试", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "area-a", placeId: "city-a", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "area-b", placeId: "city-b", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "core-a", placeId: "core-a-place", planningAreaCandidateId: "area-a", planningRole: "core_visit", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 180, tags: [] },
      { id: "detail-a", placeId: "detail-a-place", planningAreaCandidateId: "area-a", planningRole: "detail_interest", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 90, tags: [] },
      { id: "core-b", placeId: "core-b-place", planningAreaCandidateId: "area-b", planningRole: "core_visit", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 180, tags: [] },
      { id: "want-b", placeId: "want-b-place", planningAreaCandidateId: "area-b", planningRole: "core_visit", preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 120, tags: [] },
    ],
    days: [
      { id: "day-a", dayNumber: 1, date: null, title: "甲城", stayBlockId: "block-a", transferMode: "none", detailLevel: "detailed", detailStatus: "ready", startAnchor: { id: "start-a", placeId: "city-a", label: null, notes: null }, stops: [{ id: "sticky-a", candidateId: "core-a", placeId: "core-a-place", activity: "甲核心", period: "morning", startTime: "09:00", endTime: "12:00", durationMinutes: 180, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: "用户已有安排" }], endAnchor: { id: "end-a", placeId: "city-a", label: null, notes: null } },
      { id: "day-b", dayNumber: 2, date: null, title: "前往乙城", stayBlockId: "block-b", transferMode: "rail", detailLevel: "planned", detailStatus: null, startAnchor: { id: "start-b", placeId: "city-a", label: null, notes: null }, stops: [], endAnchor: { id: "end-b", placeId: "city-b", label: null, notes: null } },
    ],
  });
  return TravelPlanDocumentSchema.parse({ ...base, planningState: { macroBasisVersion: 1, macroBasisFingerprint: computeMacroDependencyFingerprintV3(base) } });
}

function resolved(planValue: TravelPlanDocument, placeId: string): PlaceResolution {
  const place = planValue.places.find((item) => item.id === placeId)!;
  return { tripId: "trip", placeId, geoFingerprint: placeGeoFingerprint(place), status: "resolved", method: "manual_coordinates", provider: null, providerPlaceId: null, latitude: 1, longitude: 2, address: null, confidence: null, resolvedAt: "2026-09-02T00:00:00Z", errorMessage: null };
}

describe("Phase 5 detail planning context", () => {
  it("scopes unresolved anchors and must-go blockers to the requested Day window", () => {
    const source = plan();
    const resolutions = [resolved(source, "city-a"), resolved(source, "core-a-place"), resolved(source, "detail-a-place")];
    const dayA = detailPlanningReadinessV3(source, resolutions, ["day-a"]);
    expect(dayA.ready).toBe(true);
    expect(dayA.blockingIssues).toEqual([]);

    const dayB = detailPlanningReadinessV3(source, resolutions, ["day-b"]);
    expect(dayB.ready).toBe(false);
    expect(dayB.blockingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "anchor_unresolved", dayIds: ["day-b"], placeId: "city-b" }),
      expect.objectContaining({ type: "must_go_unresolved", candidateId: "core-b", planningRole: "core_visit" }),
    ]));
    expect(dayB.blockingIssues.some((issue) => issue.candidateId === "want-b")).toBe(false);
  });

  it("builds role-aware sticky context and marks unresolved non-must Core as unavailable instead of blocking", () => {
    const source = plan();
    const resolutions = [resolved(source, "city-a"), resolved(source, "city-b"), resolved(source, "core-a-place"), resolved(source, "detail-a-place"), resolved(source, "core-b-place")];
    const context = buildDetailPlanningContextV3(source, resolutions, ["day-a", "day-b"]);
    expect(context.days.find((day) => day.id === "day-a")?.stickyBaseline.map((stop) => stop.id)).toEqual(["sticky-a"]);
    expect(context.candidates.map((candidate) => [candidate.id, candidate.planningRole])).toEqual(expect.arrayContaining([
      ["core-a", "core_visit"],
      ["detail-a", "detail_interest"],
      ["core-b", "core_visit"],
      ["want-b", "core_visit"],
    ]));
    expect(context.requiredMustGoCandidateIds).toEqual(expect.arrayContaining(["core-a", "detail-a", "core-b"]));
    expect(context.priorityCoreCandidateIds).toContain("want-b");
    expect(context.unavailableCandidateIds).toContain("want-b");
    expect(context.detailReadiness.blockingIssues).toEqual([]);
  });

  it("requires the skeleton workflow when the saved Macro basis becomes dirty", () => {
    const current = plan();
    const dirty = TravelPlanDocumentSchema.parse({ ...current, trip: { ...current.trip, pace: "更慢" } });
    const readiness = detailPlanningReadinessV3(dirty, [resolved(dirty, "city-a")], ["day-a"]);
    expect(readiness.macroBasisState).toBe("dirty");
    expect(readiness.requiresWorkflowStep).toBe("skeleton");
    expect(readiness.ready).toBe(false);
  });
});
