import { describe, expect, it } from "vitest";
import { emptyTravelPlan, TravelPlanDocumentSchema } from "./contracts-v2.js";
import { analyzeItineraryImpactV3 } from "./itinerary-impact-v3.js";

function plan(role: "detail_interest" | "core_visit") {
  const base = emptyTravelPlan();
  return TravelPlanDocumentSchema.parse({
    ...base,
    stage: "itinerary_refinement",
    places: [
      { id: "area-place", nameZh: "蒂阿瑙", nameLocal: null, nameEn: "Te Anau", kind: "city", city: "Te Anau", region: null, country: "New Zealand", countryCode: "NZ", approximate: false },
      { id: "visit-place", nameZh: "萤火虫洞", nameLocal: null, nameEn: "Glowworm Caves", kind: "attraction", city: "Te Anau", region: null, country: "New Zealand", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "area", placeId: "area-place", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "visit", placeId: "visit-place", planningAreaCandidateId: "area", planningRole: role, preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: role === "core_visit" ? 480 : 90, tags: [] },
    ],
    days: [{
      id: "day-1", dayNumber: 1, date: null, title: "蒂阿瑙", stayBlockId: "block-area", transferMode: "none", detailLevel: "detailed", detailStatus: "ready",
      startAnchor: { id: "start", placeId: "area-place", label: null, notes: null },
      stops: [{ id: "stop", candidateId: "visit", placeId: "visit-place", activity: "游览", period: "morning", startTime: "09:00", endTime: "10:30", durationMinutes: 90, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }],
      endAnchor: { id: "end", placeId: "area-place", label: null, notes: null },
    }],
  });
}

describe("Detail/Core role impact", () => {
  it("marks the parent Macro and related Detail day when a normal interest becomes a Core Visit", () => {
    const impact = analyzeItineraryImpactV3(plan("detail_interest"), plan("core_visit"));
    expect(impact.macro).toMatchObject({ status: "needs_update", affectedDayIds: ["day-1"] });
    expect(impact.detail).toMatchObject({ status: "needs_update", affectedDayIds: ["day-1"] });
    expect(impact.detail.reasons.join(" ")).toMatch(/重要程度变化/);
  });
});
