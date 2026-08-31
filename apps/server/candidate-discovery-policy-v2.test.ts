import { describe, expect, it } from "vitest";
import { emptyTravelPlan, type MicroCandidateDiscoveryOutput, type TravelPlanDocument } from "./contracts-v2.js";
import {
  CANDIDATE_DISCOVERY_BATCH_LIMIT,
  buildFixedMicroDiscoveryTargets,
  containsForbiddenResearchLink,
  discoveryShortfalls,
  microTourismPlaceRejection,
  microTourismProviderRejection,
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
    assistantMessage: "已按本轮目标研究具体地点。",
    areaTargets: [{ planningAreaCandidateId: "area-a", targetCount: 3, reason: "AI 判断本轮建议 3 个" }],
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

describe("candidate discovery resource policy", () => {
  it("uses a 0-9 AI-selected budget instead of deterministic 3/5/7/9 minimums", () => {
    const plan = planWithAreas();
    plan.places.push({ id: "existing", nameZh: "现有博物馆", nameLocal: null, nameEn: "Existing Museum", kind: "attraction", city: "Large City", region: "North", country: "Test", countryCode: "TT", approximate: false });
    plan.candidates.push({ id: "existing-candidate", placeId: "existing", planningAreaCandidateId: "area-a", preference: "optional", source: "ai", aiReason: null, aiScore: 80, suggestedDurationMinutes: 60, tags: [] });
    expect(buildFixedMicroDiscoveryTargets(plan, ["area-a", "area-b"], new Set(["existing"]))).toEqual([
      { planningAreaCandidateId: "area-a", targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT },
      { planningAreaCandidateId: "area-b", targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT },
    ]);
  });

  it("accepts AI-selected counts when count, places and candidates agree", () => {
    const output = microOutput();
    expect(validateMicroCandidateDiscovery(output, ["area-a"], [{ planningAreaCandidateId: "area-a", targetCount: 9 }])).toBe(output);
    const lowered = structuredClone(output);
    lowered.areaTargets[0].targetCount = 2;
    lowered.places.splice(2, 1);
    lowered.candidates.splice(2, 1);
    expect(validateMicroCandidateDiscovery(lowered, ["area-a"], [{ planningAreaCandidateId: "area-a", targetCount: 9 }])).toBe(lowered);
    const mismatched = structuredClone(output);
    mismatched.areaTargets[0].targetCount = 2;
    expect(() => validateMicroCandidateDiscovery(mismatched, ["area-a"], [{ planningAreaCandidateId: "area-a", targetCount: 9 }])).toThrow(/targetCount/);
  });

  it("rejects source URLs, Markdown links, bare domains and explicit reference lists", () => {
    const variants = [
      "来源：https://example.com/guide",
      "[官网](www.example.com)",
      "[来源](//example.com/path)",
      "参考 www.example.com",
      "参考 example.com/reference",
      "Sources: official tourism board",
      "参考资料：官方旅游局、旅行指南",
    ];
    for (const text of variants) {
      const leaked = structuredClone(microOutput());
      leaked.assistantMessage = text;
      expect(containsForbiddenResearchLink(leaked), text).toBe(true);
      expect(() => validateMicroCandidateDiscovery(leaked, ["area-a"], [{ planningAreaCandidateId: "area-a", targetCount: 9 }]), text).toThrow(/来源链接或引用列表不得写入/);
    }
    const clean = structuredClone(microOutput());
    clean.assistantMessage = "已综合实时网页研究核验地点价值，但最终结构化结果不携带来源或链接。";
    expect(containsForbiddenResearchLink(clean)).toBe(false);
  });

  it("splits every Macro into an independent request and never creates map replenishment shortfalls", () => {
    const output = microOutput();
    const accepted = output.candidates.filter((candidate) => candidate.temporaryId === "c-a1");
    expect(discoveryShortfalls(output, accepted)).toEqual([]);
    const targets = Array.from({ length: 9 }, (_, index) => ({ planningAreaCandidateId: `area-${index}`, targetCount: 9 }));
    const batches = splitMicroDiscoveryTargets(targets);
    expect(batches.every((batch) => batch.length === 1 && batch[0].targetCount <= 9)).toBe(true);
    expect(batches.flat()).toEqual(targets);
    expect(() => validateMicroCandidateDiscovery(output, ["area-a", "area-b"], targets.slice(0, 2))).toThrow(/必须且只能处理 1 个目的地/);
  });

  it("does not apply business-category, geography or provider-category rejection filters", () => {
    expect(microTourismPlaceRejection()).toBeNull();
    expect(microTourismProviderRejection()).toBeNull();
  });
});
