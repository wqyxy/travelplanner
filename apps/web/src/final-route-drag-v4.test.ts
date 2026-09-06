import { describe, expect, it } from "vitest";
import { finalRouteMoveTargetIndexV4 } from "./final-route-drag-v4";

describe("finalRouteMoveTargetIndexV4", () => {
  it("moves a card downward using the post-removal target index expected by the server", () => {
    expect(finalRouteMoveTargetIndexV4(0, 2, "after", 4)).toBe(2);
    expect(finalRouteMoveTargetIndexV4(1, 2, "after", 4)).toBe(2);
  });

  it("moves a card upward before or after the hovered card", () => {
    expect(finalRouteMoveTargetIndexV4(3, 1, "before", 4)).toBe(1);
    expect(finalRouteMoveTargetIndexV4(3, 1, "after", 4)).toBe(2);
  });

  it("returns null for a drop that keeps the card in the same position", () => {
    expect(finalRouteMoveTargetIndexV4(1, 1, "before", 4)).toBeNull();
    expect(finalRouteMoveTargetIndexV4(1, 1, "after", 4)).toBeNull();
    expect(finalRouteMoveTargetIndexV4(1, 2, "before", 4)).toBeNull();
  });

  it("supports first and last insertion slots without exceeding the server range", () => {
    expect(finalRouteMoveTargetIndexV4(3, 0, "before", 4)).toBe(0);
    expect(finalRouteMoveTargetIndexV4(0, 3, "after", 4)).toBe(3);
  });
});
