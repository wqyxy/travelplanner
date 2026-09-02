import { describe, expect, it } from "vitest";
import { emptyTravelPlan } from "./contracts-v2.js";
import { normalizeRequirementsCtaParametersV3, requestedDurationDaysFromBriefV3 } from "./requirements-duration-v3.js";

describe("Phase 6 requirements duration normalization", () => {
  it("understands common simple duration text used by the Step 1 form", () => {
    expect(requestedDurationDaysFromBriefV3("20天")).toBe(20);
    expect(requestedDurationDaysFromBriefV3("10 天左右")).toBe(10);
    expect(requestedDurationDaysFromBriefV3("2周")).toBe(14);
    expect(requestedDurationDaysFromBriefV3("7 days")).toBe(7);
    expect(requestedDurationDaysFromBriefV3("")).toBeNull();
    expect(requestedDurationDaysFromBriefV3("大概两周")).toBeUndefined();
  });

  it("preserves existing structured dates while synchronizing requested duration", () => {
    const plan = emptyTravelPlan();
    plan.trip.dates = { start: "2026-10-01", end: "2026-10-20", requestedDurationDays: 20 };
    expect(normalizeRequirementsCtaParametersV3(plan, "requirements.update", { changes: { brief: { duration: "14 天" } } })).toEqual({
      changes: {
        brief: { duration: "14 天" },
        dates: { start: "2026-10-01", end: "2026-10-20", requestedDurationDays: 14 },
      },
    });
  });

  it("does not override an explicit dates update or unrelated actions", () => {
    const plan = emptyTravelPlan();
    const explicit = { changes: { brief: { duration: "14 天" }, dates: { start: null, end: null, requestedDurationDays: 12 } } };
    expect(normalizeRequirementsCtaParametersV3(plan, "requirements.update", explicit)).toBe(explicit);
    const destination = { allowWeb: true };
    expect(normalizeRequirementsCtaParametersV3(plan, "destination.generate", destination)).toBe(destination);
  });
});
