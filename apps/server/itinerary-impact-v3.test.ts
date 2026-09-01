import { describe, expect, it } from "vitest";
import { emptyTravelPlan, TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import { analyzeItineraryImpactV3 } from "./itinerary-impact-v3.js";

const place = (id: string, nameZh: string, kind: "city" | "attraction") => ({
  id, nameZh, nameLocal: null, nameEn: null, kind, city: kind === "city" ? null : "甲城", region: null, country: "测试国", countryCode: "NZ", approximate: false,
});

const candidate = (id: string, placeId: string, preference: "must_go" | "want_to_go" | "optional" | "excluded", planningAreaCandidateId: string | null) => ({
  id, placeId, planningAreaCandidateId, preference, source: "user" as const, aiReason: null, aiScore: null, suggestedDurationMinutes: planningAreaCandidateId ? 120 : null, tags: [],
});

function basePlan(detailed = true): TravelPlanDocument {
  return TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    stage: detailed ? "itinerary_refinement" : "itinerary_planning",
    places: [place("city-a", "甲城", "city"), place("poi-a", "甲景点", "attraction")],
    candidates: [candidate("macro-a", "city-a", "must_go", null), candidate("micro-a", "poi-a", "optional", "macro-a")],
    days: [{
      id: "day-1", dayNumber: 1, date: null, title: "甲城", transferMode: "none", detailLevel: detailed ? "detailed" : "planned", detailStatus: detailed ? "ready" : null,
      startAnchor: { id: "start-1", placeId: "city-a", label: null, notes: null },
      stops: detailed ? [{ id: "stop-a", candidateId: "micro-a", placeId: "poi-a", activity: "参观", period: "morning", startTime: "09:00", endTime: "11:00", durationMinutes: 120, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }] : [],
      endAnchor: { id: "end-1", placeId: "city-a", label: null, notes: null },
    }],
  });
}

describe("incremental itinerary impact", () => {
  it("keeps Macro and Detail ready for an ordinary new optional POI", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({ ...before, places: [...before.places, place("poi-b", "乙景点", "attraction")], candidates: [...before.candidates, candidate("micro-b", "poi-b", "optional", "macro-a")] });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("ready");
    expect(impact.detail.status).toBe("ready");
    expect(impact.detail.newOptionCandidateIds).toEqual(["micro-b"]);
  });

  it("marks only destination days for a new must-go POI", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({ ...before, places: [...before.places, place("poi-b", "乙景点", "attraction")], candidates: [...before.candidates, candidate("micro-b", "poi-b", "must_go", "macro-a")] });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("ready");
    expect(impact.detail.status).toBe("needs_update");
    expect(impact.detail.affectedDayIds).toEqual(["day-1"]);
  });

  it("does not invalidate Detail when an unused POI is deleted", () => {
    const before = basePlan();
    const extra = TravelPlanDocumentSchema.parse({ ...before, places: [...before.places, place("poi-unused", "未使用", "attraction")], candidates: [...before.candidates, candidate("micro-unused", "poi-unused", "optional", "macro-a")] });
    const impact = analyzeItineraryImpactV3(extra, before);
    expect(impact.macro.status).toBe("ready");
    expect(impact.detail.status).toBe("ready");
    expect(impact.detail.affectedDayIds).toEqual([]);
  });

  it("limits exclusion of a scheduled POI to the Day that used it", () => {
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
    expect(after.days[0].stops).toEqual([]);
  });

  it("defers Detail invalidation until a destination change is applied to Macro Days", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({ ...before, places: [...before.places, place("city-b", "乙城", "city")], candidates: [...before.candidates, candidate("macro-b", "city-b", "want_to_go", null)] });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("needs_update");
    expect(impact.detail.status).toBe("ready");
    expect(impact.detail.affectedDayIds).toEqual([]);
  });

  it("marks Macro needs_update when a removed destination leaves an invalid Day", () => {
    const before = basePlan(false);
    const after = TravelPlanDocumentSchema.parse({
      ...before,
      candidates: before.candidates.filter((item) => item.id !== "macro-a" && item.planningAreaCandidateId !== "macro-a"),
      places: [],
      days: before.days.map((day) => ({ ...day, startAnchor: { ...day.startAnchor, placeId: null }, endAnchor: { ...day.endAnchor, placeId: null } })),
    });
    expect(analyzeItineraryImpactV3(before, after).macro.status).toBe("needs_update");
  });

  it("does not replan Macro for a display-name-only Place change", () => {
    const before = basePlan();
    const after = TravelPlanDocumentSchema.parse({ ...before, places: before.places.map((item) => item.id === "city-a" ? { ...item, nameZh: "皇后镇" } : item) });
    const impact = analyzeItineraryImpactV3(before, after);
    expect(impact.macro.status).toBe("ready");
    expect(impact.detail.status).toBe("ready");
  });
});
