import { describe, expect, it } from "vitest";
import { computePlaceScore } from "./place-score-v3.js";

describe("computePlaceScore", () => {
  it("rewards a world-class strength without requiring every dimension to be high", () => {
    expect(computePlaceScore({
      uniqueness: 97,
      scenery: 100,
      culture: 28,
      experience: 95,
      representativeness: 96,
    })).toBe(93);
  });

  it("does not let one excellent dimension alone make a weak place top-tier", () => {
    expect(computePlaceScore({
      uniqueness: 50,
      scenery: 98,
      culture: 20,
      experience: 40,
      representativeness: 30,
    })).toBe(65);
  });
});
