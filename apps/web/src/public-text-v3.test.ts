import { describe, expect, it } from "vitest";
import { containsEngineeringTextV3, publicSafeTextV3 } from "./public-text-v3";

describe("Phase 6 public text boundary", () => {
  it("blocks engineering implementation terms used by proposals, errors, and tasks", () => {
    for (const value of [
      "Macro fingerprint 已变化",
      "affectedDayIds mismatch",
      "targetIds 超出 scope",
      "executor failed",
      "Candidate ID missing",
      "Stop ID missing",
      "CONTENT_GENERATION_SUPERSEDED",
      "itinerary.detail.generate failed",
    ]) expect(containsEngineeringTextV3(value)).toBe(true);
  });

  it("keeps normal user-facing travel language", () => {
    expect(publicSafeTextV3("路线和天数需要重新确认", "fallback")).toBe("路线和天数需要重新确认");
    expect(publicSafeTextV3("Macro fingerprint 已变化", "请重新确认路线和天数")).toBe("请重新确认路线和天数");
  });
});
