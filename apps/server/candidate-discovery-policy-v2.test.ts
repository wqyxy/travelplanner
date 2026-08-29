import { describe, expect, it } from "vitest";
import { emptyTravelPlan, type MicroCandidateDiscoveryOutput, type TravelPlanDocument } from "./contracts-v2.js";
import {
  buildFixedMicroDiscoveryTargets,
  discoveryShortfalls,
  microTourismPlaceRejection,
  microTourismProviderRejection,
  recommendedMicroMinimum,
  splitMicroDiscoveryTargets,
  validateMicroCandidateDiscovery,
} from "./candidate-discovery-policy-v2.js";

function planWithAreas(): TravelPlanDocument {
  const plan = emptyTravelPlan();
  plan.places.push(
    { id: "place-a", nameZh: "大城市", nameLocal: null, nameEn: "Large City", kind: "city", city: "Large City", region: "North", country: "Test", countryCode: "TT", approximate: false },
    { id: "place-b", nameZh: "小型停留点", nameLocal: null, nameEn: "Small Stop", kind: "city", city: "Small Stop", region: "South", country: "Test", countryCode: "TT", approximate: false },
  );
  plan.candidates.push(
    { id: "area-a", placeId: "place-a", planningAreaCandidateId: null, preference: "must_go", source: "ai", aiReason: null, aiScore: 90, suggestedDurationMinutes: 4320, tags: [] },
    { id: "area-b", placeId: "place-b", planningAreaCandidateId: null, preference: "want_to_go", source: "ai", aiReason: null, aiScore: 80, suggestedDurationMinutes: 1440, tags: [] },
  );
  return plan;
}

function microOutput(): MicroCandidateDiscoveryOutput {
  return {
    schemaVersion: 1,
    baseGeneration: 0,
    assistantMessage: "已按固定目标筛选观光点。",
    areaTargets: [{ planningAreaCandidateId: "area-a", targetCount: 3, reason: "服务端固定目标" }],
    places: [
      { id: "p-a1", nameZh: "A1 地标", nameLocal: null, nameEn: "A1 Landmark", kind: "attraction", city: "Large City", region: "North", country: "Test", countryCode: "TT", approximate: false },
      { id: "p-a2", nameZh: "A2 观景台", nameLocal: null, nameEn: "A2 Viewpoint", kind: "attraction", city: "Large City", region: "North", country: "Test", countryCode: "TT", approximate: false },
      { id: "p-a3", nameZh: "A3 博物馆", nameLocal: null, nameEn: "A3 Museum", kind: "attraction", city: "Large City", region: "North", country: "Test", countryCode: "TT", approximate: false },
    ],
    candidates: [
      { temporaryId: "c-a1", placeTemporaryId: "p-a1", planningAreaCandidateId: "area-a", aiReason: "A1", aiScore: 95, suggestedDurationMinutes: 60, tags: [], defaultPreference: "optional", prominence: "iconic", experienceTypes: ["landmark", "photo"], visitPointType: "landmark", researchBasis: ["multi_guide_consensus"] },
      { temporaryId: "c-a2", placeTemporaryId: "p-a2", planningAreaCandidateId: "area-a", aiReason: "A2", aiScore: 90, suggestedDurationMinutes: 60, tags: [], defaultPreference: "optional", prominence: "supporting", experienceTypes: ["viewpoint", "photo"], visitPointType: "viewpoint", researchBasis: ["multi_guide_consensus"] },
      { temporaryId: "c-a3", placeTemporaryId: "p-a3", planningAreaCandidateId: "area-a", aiReason: "A3", aiScore: 85, suggestedDurationMinutes: 60, tags: [], defaultPreference: "optional", prominence: "major", experienceTypes: ["museum_culture"], visitPointType: "venue", researchBasis: ["multi_guide_consensus", "official_status_verified"] },
    ],
  };
}

describe("candidate discovery quality policy", () => {
  it("maps Macro stay duration to deterministic 3/5/7/9 minimums and deducts reliable existing points", () => {
    expect([null, 1440, 2880, 4320, 5760].map(recommendedMicroMinimum)).toEqual([3, 3, 5, 7, 9]);
    const plan = planWithAreas();
    plan.places.push({ id: "existing", nameZh: "现有博物馆", nameLocal: null, nameEn: "Existing Museum", kind: "attraction", city: "Large City", region: "North", country: "Test", countryCode: "TT", approximate: false });
    plan.candidates.push({ id: "existing-candidate", placeId: "existing", planningAreaCandidateId: "area-a", preference: "optional", source: "ai", aiReason: null, aiScore: 80, suggestedDurationMinutes: 60, tags: [] });
    expect(buildFixedMicroDiscoveryTargets(plan, ["area-a", "area-b"], new Set(["existing"]))).toEqual([
      { planningAreaCandidateId: "area-a", targetCount: 6 },
      { planningAreaCandidateId: "area-b", targetCount: 3 },
    ]);
  });

  it("requires fixed targets, multi-guide evidence, core prominence and experience diversity", () => {
    const output = microOutput();
    const fixed = [{ planningAreaCandidateId: "area-a", targetCount: 3 }];
    expect(validateMicroCandidateDiscovery(output, ["area-a"], fixed)).toBe(output);

    const lowered = structuredClone(output);
    lowered.areaTargets[0].targetCount = 2;
    lowered.candidates.splice(2, 1);
    expect(() => validateMicroCandidateDiscovery(lowered, ["area-a"], fixed)).toThrow(/不得降低固定目标/);

    const missingResearch = structuredClone(output);
    missingResearch.candidates[0].researchBasis = ["official_status_verified"];
    expect(() => validateMicroCandidateDiscovery(missingResearch, ["area-a"], fixed)).toThrow(/多份攻略共识/);

    const leakedSource = structuredClone(output);
    leakedSource.assistantMessage = "来源：https://example.com/guide";
    expect(() => validateMicroCandidateDiscovery(leakedSource, ["area-a"], fixed)).toThrow(/来源链接不得写入/);

    const noCore = structuredClone(output);
    noCore.candidates.filter((candidate) => candidate.planningAreaCandidateId === "area-a").forEach((candidate) => { candidate.prominence = "supporting"; });
    expect(() => validateMicroCandidateDiscovery(noCore, ["area-a"], fixed)).toThrow(/iconic 或 major/);

    const noDiversity = structuredClone(output);
    noDiversity.candidates.filter((candidate) => candidate.planningAreaCandidateId === "area-a").forEach((candidate) => { candidate.experienceTypes = ["landmark"]; });
    expect(() => validateMicroCandidateDiscovery(noDiversity, ["area-a"], fixed)).toThrow(/至少需要覆盖 2 类体验/);
  });

  it("computes map shortfalls and splits every destination into an independent request", () => {
    const output = microOutput();
    const accepted = output.candidates.filter((candidate) => candidate.temporaryId === "c-a1");
    expect(discoveryShortfalls(output, accepted)).toEqual([{ planningAreaCandidateId: "area-a", targetCount: 2 }]);
    const targets = Array.from({ length: 9 }, (_, index) => ({ planningAreaCandidateId: `area-${index}`, targetCount: index % 2 ? 5 : 7 }));
    const batches = splitMicroDiscoveryTargets(targets);
    expect(batches.every((batch) => batch.length === 1 && batch[0].targetCount <= 9)).toBe(true);
    expect(batches.flat()).toEqual(targets);
  });

  it("rejects facilities, broad geography and cross-city provider matches", () => {
    const attraction = { id: "p", nameZh: "城市观景台", nameLocal: null, nameEn: "City Viewpoint", kind: "attraction" as const, city: "City", region: "North", country: "Test", countryCode: "TT", approximate: false };
    expect(microTourismPlaceRejection(attraction)).toBeNull();
    expect(microTourismPlaceRejection({ ...attraction, nameZh: "城市游客中心" })).toMatch(/游客服务/);
    expect(microTourismPlaceRejection({ ...attraction, nameZh: "瓦卡蒂普湖", nameEn: "Lake Wakatipu" })).toMatch(/泛称地理实体/);
    expect(microTourismPlaceRejection({ ...attraction, kind: "airport" })).toMatch(/只接受观光景点/);
    expect(microTourismProviderRejection({ category: "tourism", placeType: "viewpoint", countryCode: "tt", city: "City", region: "North" }, attraction)).toBeNull();
    expect(microTourismProviderRejection({ category: "railway", placeType: "station", countryCode: "tt", city: "City", region: "North" }, attraction)).toMatch(/公开地图/);
    expect(microTourismProviderRejection({ category: "tourism", placeType: "viewpoint", countryCode: "tt", city: "Other City", region: "North" }, attraction)).toMatch(/其他城市/);
  });
});
