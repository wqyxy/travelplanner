import { describe, expect, it } from "vitest";
import { placeScoreBreakdownFromTagsV3, placeScoreTooltipV3 } from "./place-score-presentation-v3";

const tags = [
  "museum",
  "__place_score:uniqueness=91",
  "__place_score:scenery=82",
  "__place_score:culture=96",
  "__place_score:experience=78",
  "__place_score:representativeness=89",
];

describe("place score presentation", () => {
  it("reads the complete five-dimensional score persisted on a candidate", () => {
    expect(placeScoreBreakdownFromTagsV3(tags)).toEqual({ uniqueness: 91, scenery: 82, culture: 96, experience: 78, representativeness: 89 });
    expect(placeScoreTooltipV3(tags)).toContain("独特性：91");
  });

  it("does not render a partial or invalid score breakdown", () => {
    expect(placeScoreBreakdownFromTagsV3(tags.slice(0, -1))).toBeNull();
    expect(placeScoreBreakdownFromTagsV3([...tags.slice(0, -1), "__place_score:representativeness=101"])).toBeNull();
  });
});
