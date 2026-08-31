import { describe, expect, it } from "vitest";
import type { TripFacts } from "./v2-types";
import { hasTravelRequirements } from "./requirements-readiness-v3";

function emptyFacts(): TripFacts {
  return {
    title: "未命名旅行",
    originPlaceId: null,
    destinationPlaceIds: [],
    dates: { start: null, end: null, requestedDurationDays: null },
    travelers: { summary: "", adults: null, children: null },
    budget: { amount: null, currency: null, note: null },
    pace: null,
    themes: [],
    preferences: [],
    constraints: [],
    assumptions: [],
  };
}

describe("requirements readiness", () => {
  it("keeps destination generation disabled for a new empty trip", () => {
    expect(hasTravelRequirements(emptyFacts())).toBe(false);
  });

  it("allows destination generation after any travel requirement is recorded", () => {
    expect(hasTravelRequirements({ ...emptyFacts(), preferences: ["自然风景"] })).toBe(true);
  });
});
