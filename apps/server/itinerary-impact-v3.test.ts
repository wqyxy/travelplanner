import test from "node:test";
import assert from "node:assert/strict";
import { emptyTravelPlan, TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import { analyzeItineraryImpactV3 } from "./itinerary-impact-v3.js";

function basePlan(): TravelPlanDocument {
  return TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    places: [
      { id: "city-a", nameZh: "甲城", nameLocal: null, nameEn: null, kind: "city", city: null, region: null, country: "测试国", countryCode: "NZ", approximate: false },
      { id: "poi-a", nameZh: "甲景点", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "测试国", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "macro-a", placeId: "city-a", planningAreaCandidateId: null, preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "micro-a", placeId: "poi-a", planningAreaCandidateId: "macro-a", preference: "optional", source: "ai", aiReason: "候选", aiScore: 80, suggestedDurationMinutes: 120, tags: [] },
    ],
    days: [
      {
        id: "day-1", dayNumber: 1, date: null, title: "甲城", detailLevel: "planned", detailStatus: null,
        startAnchor: { id: "start-1", placeId: "city-a", label: null, notes: null },
        stops: [],
        endAnchor: { id: "end-1", placeId: "city-a", label: null, notes: null },
      },
    ],
  });
}

test("ordinary new POI is a new option, not needs_update", () => {
  const before = basePlan();
  const after = TravelPlanDocumentSchema.parse({
    ...before,
    places: [...before.places, { id: "poi-b", nameZh: "乙景点", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "测试国", countryCode: "NZ", approximate: false }],
    candidates: [...before.candidates, { id: "micro-b", placeId: "poi-b", planningAreaCandidateId: "macro-a", preference: "optional", source: "ai", aiReason: "新候选", aiScore: 70, suggestedDurationMinutes: 90, tags: [] }],
  });
  const impact = analyzeItineraryImpactV3(before, after);
  assert.equal(impact.macro.status, "ready");
  assert.equal(impact.detail.status, "ready");
  assert.deepEqual(impact.detail.newOptionCandidateIds, ["micro-b"]);
});

test("new must-go POI marks only destination days for update", () => {
  const before = basePlan();
  const after = TravelPlanDocumentSchema.parse({
    ...before,
    places: [...before.places, { id: "poi-b", nameZh: "乙景点", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "测试国", countryCode: "NZ", approximate: false }],
    candidates: [...before.candidates, { id: "micro-b", placeId: "poi-b", planningAreaCandidateId: "macro-a", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 90, tags: [] }],
  });
  const impact = analyzeItineraryImpactV3(before, after);
  assert.equal(impact.detail.status, "needs_update");
  assert.deepEqual(impact.detail.affectedDayIds, ["day-1"]);
});

test("destination addition marks macro and downstream detail update", () => {
  const before = basePlan();
  const after = TravelPlanDocumentSchema.parse({
    ...before,
    places: [...before.places, { id: "city-b", nameZh: "乙城", nameLocal: null, nameEn: null, kind: "city", city: null, region: null, country: "测试国", countryCode: "NZ", approximate: false }],
    candidates: [...before.candidates, { id: "macro-b", placeId: "city-b", planningAreaCandidateId: null, preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] }],
  });
  const impact = analyzeItineraryImpactV3(before, after);
  assert.equal(impact.macro.status, "needs_update");
  assert.equal(impact.detail.status, "needs_update");
});
