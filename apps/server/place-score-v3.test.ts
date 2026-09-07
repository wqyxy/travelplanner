import { describe, expect, it } from "vitest";
import { computePlaceScore } from "./place-score-v3.js";

describe("computePlaceScore", () => {
  it("keeps an average place at 50", () => {
    expect(computePlaceScore({
      uniqueness: 50,
      scenery: 50,
      culture: 50,
    })).toBe(50);
  });

  it("lets a strongly specialized place score highly", () => {
    expect(computePlaceScore({
      uniqueness: 95,
      scenery: 100,
      culture: 20,
    })).toBe(91);
  });

  it("sorts dimensions by strength and rounds upward", () => {
    expect(computePlaceScore({
      uniqueness: 63,
      scenery: 81,
      culture: 42,
    })).toBe(74);
  });
});
