import { describe, expect, it } from "vitest";
import type { TripFacts } from "./v2-types";
import { hasTravelRequirements } from "./requirements-readiness-v3";

function emptyFacts(): TripFacts {
  return {
    title: "未命名旅行",
    brief: { destination: "", origin: "", departureTime: "", duration: "", travelers: "", transport: "", additionalRequirements: "" },
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

  it("requires a saved destination before destination generation is enabled", () => {
    expect(hasTravelRequirements({ ...emptyFacts(), preferences: ["自然风景"] })).toBe(false);
    expect(hasTravelRequirements({ ...emptyFacts(), brief: { ...emptyFacts().brief, destination: "英国" } })).toBe(true);
  });
});
