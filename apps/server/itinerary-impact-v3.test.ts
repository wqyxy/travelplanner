import { describe, expect, it } from "vitest";
import { emptyTravelPlan, TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import { analyzeItineraryImpactV3 } from "./itinerary-impact-v3.js";

const place = (id: string, nameZh: string, kind: "city" | "attraction") => ({
  id, nameZh, nameLocal: null, nameEn: null, kind, city: kind === "city" ? null : "甲城", region: null, country: "测试国", countryCode: "NZ", approximate: false,
});

const candidate = (
  id: string,
  placeId: string,
  preference: "must_go" | "want_to_go" | "optional" | "excluded",
  planningAreaCandidateId: string | null,
  planningRole?: "planning_area" | "core_visit" | "detail_interest",
) => ({
  id, placeId, planningAreaCandidateId, ...(planningRole ? { planningRole } : {}), preference, source: "user" as const, aiReason: null, aiScore: null, suggestedDurationMinutes: planningAreaCandidateId ? 120 : null, tags: [],
});

function basePlan(detailed = true): TravelPlanDocument {
  return TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    stage: detailed ? "itinerary_refinement" : "itinerary_planning",
    places: [place("city-a", "甲城", "city"), place("poi-a", "甲景点", "attraction")],
    candidates: [
      candidate("macro-a", "city-a", "must_go", null, "planning_area"),
      candidate("micro-a", "poi-a", "optional", "macro-a", "detail_interest"),
    ],
    days: [{
      id: "day-1", dayNumber: 1, date: null, title: "甲城", stayBlockId: "block-a", transferMode: "none", detailLevel: detailed ? "detailed" : "planned", detailStatus: detailed ? "ready" : null,
      startAnchor: { id: "start-1", placeId: "city-a", label: null, notes: null },
      stops: detailed ? [{ id: "stop-a", candidateId: "micro-a", placeId: "poi-a", activity: "参观", period: "morning", startTime: "09:00", endTime: "11:00", durationMinutes: 120, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }] : [],
      endAnchor: { id: "end-1", placeId: "city-a", label: null, notes: null },
    }],
  });
}

describe("role-aware incremental itinerary impact", () => {
  it("keeps Macro and Detail ready for an ordinary new optional Detail Interest", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({
      ...before,
      places: [...before.places, place("poi-b", "乙景点", "attraction")],
      candidates: [...before.candidates, candidate("micro-b", "poi-b", "optional", "macro-a", "detail_interest")],
    });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("ready");
    expect(impact.detail.status).toBe("ready");
    expect(impact.detail.newOptionCandidateIds).toEqual(["micro-b"]);
  });

  it("marks only the parent Planning Area days for a new must-go Detail Interest", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({
      ...before,
      places: [...before.places, place("poi-b", "乙景点", "attraction")],
      candidates: [...before.candidates, candidate("micro-b", "poi-b", "must_go", "macro-a", "detail_interest")],
    });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("ready");
    expect(impact.detail.status).toBe("needs_update");
    expect(impact.detail.affectedDayIds).toEqual(["day-1"]);
  });

  it("does not invalidate Detail when an unused Detail Interest is deleted", () => {
    const before = basePlan();
    const extra = TravelPlanDocumentSchema.parse({
      ...before,
      places: [...before.places, place("poi-unused", "未使用", "attraction")],
      candidates: [...before.candidates, candidate("micro-unused", "poi-unused", "optional", "macro-a", "detail_interest")],
    });
    const impact = analyzeItineraryImpactV3(extra, before);
    expect(impact.macro.status).toBe("ready");
    expect(impact.detail.status).toBe("ready");
    expect(impact.detail.affectedDayIds).toEqual([]);
  });

  it("limits exclusion of a scheduled Detail Interest to the Day that used it", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({
      ...before,
      candidates: before.candidates.map((item) => item.id === "micro-a" ? { ...item, preference: "excluded" as const } : item),
      days: before.days.map((day) => ({ ...day, stops: [], detailStatus: "needs_review" as const })),
    });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("ready");
    expect(impact.detail.status).toBe("needs_update");
    expect(impact.detail.affectedDayIds).toEqual(["day-1"]);
  });

  it("makes a Core Visit change Macro-dirty without immediately invalidating Detail", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({
      ...before,
      places: [...before.places, place("core-a", "重要峡湾", "attraction")],
      candidates: [...before.candidates, candidate("core-a-candidate", "core-a", "must_go", "macro-a", "core_visit")],
    });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("needs_update");
    expect(impact.macro.affectedDayIds).toEqual(["day-1"]);
    expect(impact.detail.status).toBe("ready");
    expect(impact.detail.affectedDayIds).toEqual([]);
  });

  it("refreshes the used Detail Route when a scheduled Core Visit route identity changes", () => {
    const base = basePlan();
    const corePlace = place("core-a", "重要峡湾", "attraction");
    const coreCandidate = candidate("core-a-candidate", "core-a", "must_go", "macro-a", "core_visit");
    const before = TravelPlanDocumentSchema.parse({
      ...base,
      places: [...base.places, corePlace],
      candidates: [...base.candidates, coreCandidate],
      days: base.days.map((day) => ({
        ...day,
        stops: [{
          id: "stop-core-a",
          candidateId: "core-a-candidate",
          placeId: "core-a",
          activity: "游览重要峡湾",
          period: "morning" as const,
          startTime: "09:00",
          endTime: "11:00",
          durationMinutes: 120,
          transportFromPrevious: null,
          scheduleVerification: { status: "estimated" as const, checkedAt: null },
          costNote: null,
          costVerification: null,
          notes: null,
        }],
      })),
    });
    const after = TravelPlanDocumentSchema.parse({
      ...before,
      places: before.places.map((item) => item.id === "core-a" ? { ...item, approximate: true } : item),
    });

    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("ready");
    expect(impact.detail.status).toBe("ready");
    expect(impact.detail.affectedDayIds).toEqual([]);
    expect(impact.routes.detailDayIds).toEqual(["day-1"]);
  });

  it("makes Planning Area preference changes Macro-dirty", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({
      ...before,
      candidates: before.candidates.map((item) => item.id === "macro-a" ? { ...item, preference: "want_to_go" as const } : item),
    });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("needs_update");
    expect(impact.macro.affectedDayIds).toEqual(["day-1"]);
  });

  it("makes important TripFacts changes Macro-dirty and scopes them to the current trip", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({ ...before, trip: { ...before.trip, pace: "更慢一些" } });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("needs_update");
    expect(impact.macro.affectedDayIds).toEqual(["day-1"]);
    expect(impact.detail.status).toBe("ready");
  });

  it("keeps display-name changes outside the Macro fingerprint", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({ ...before, places: before.places.map((item) => item.id === "city-a" ? { ...item, nameZh: "甲城市区" } : item) });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("ready");
    expect(impact.detail.status).toBe("ready");
    expect(impact.routes.macroDayIds).toEqual([]);
  });

  it("refreshes Macro Route for route-identity changes without making the Skeleton dirty", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({ ...before, places: before.places.map((item) => item.id === "city-a" ? { ...item, approximate: true } : item) });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("ready");
    expect(impact.routes.macroDayIds).toEqual(["day-1"]);
  });
});
