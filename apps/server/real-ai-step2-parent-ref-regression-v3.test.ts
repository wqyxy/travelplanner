import { describe, expect, it } from "vitest";
import { DestinationGenerateOutputSchema } from "./ai-action-contracts-v3.js";

function output(parentCandidateRef: unknown) {
  return {
    schemaVersion: 2,
    baseGeneration: 0,
    assistantMessage: "加入奥克兰和一个重要游览地。",
    places: [
      { id: "place-auckland", nameZh: "奥克兰", nameLocal: null, nameEn: "Auckland", kind: "city", city: "Auckland", region: "Auckland", country: "New Zealand", countryCode: "NZ", approximate: false },
      { id: "place-core", nameZh: "怀托摩萤火虫洞", nameLocal: null, nameEn: "Waitomo Glowworm Caves", kind: "attraction", city: "Waitomo", region: "Waikato", country: "New Zealand", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { temporaryId: "candidate-auckland", placeTemporaryId: "place-auckland", planningRole: "planning_area", parentCandidateRef: null, aiReason: "起点与住宿基地", aiScore: 98, suggestedDurationMinutes: null, tags: ["城市"], defaultPreference: "optional" },
      { temporaryId: "candidate-core", placeTemporaryId: "place-core", planningRole: "core_visit", parentCandidateRef, aiReason: "需要单独预留时间", aiScore: 90, suggestedDurationMinutes: 240, tags: ["自然"], defaultPreference: "optional" },
    ],
  };
}

describe("real AI Step 2 parent reference regression", () => {
  it("rejects a same-batch Planning Area temporaryId mislabeled as an existing parent", () => {
    expect(() => DestinationGenerateOutputSchema.parse(output({ type: "existing", candidateId: "candidate-auckland" })))
      .toThrow(/existing parent 不得引用本轮 temporaryId/);
  });

  it("accepts the same parent when it is correctly declared as generated", () => {
    const parsed = DestinationGenerateOutputSchema.parse(output({ type: "generated", temporaryCandidateId: "candidate-auckland" }));
    expect(parsed.candidates[1].parentCandidateRef).toEqual({ type: "generated", temporaryCandidateId: "candidate-auckland" });
  });
});
