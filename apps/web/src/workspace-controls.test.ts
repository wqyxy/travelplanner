import { describe, expect, it } from "vitest";
import { shouldActivateSelectionKey, shouldApplyMapLayout, shouldRequestFullscreenLayout } from "./workspace-controls";

describe("workspace controls", () => {
  it("does not activate the all-itinerary selector for a nested fullscreen button keypress", () => {
    expect(shouldActivateSelectionKey("Enter", false)).toBe(false);
    expect(shouldActivateSelectionKey(" ", false)).toBe(false);
    expect(shouldActivateSelectionKey("Enter", true)).toBe(true);
  });

  it("only applies a map layout for the latest live layout request with points", () => {
    expect(shouldApplyMapLayout(2, 1, true, 1)).toBe(false);
    expect(shouldApplyMapLayout(2, 2, false, 1)).toBe(false);
    expect(shouldApplyMapLayout(2, 2, true, 0)).toBe(false);
    expect(shouldApplyMapLayout(2, 2, true, 1)).toBe(true);
  });

  it("requests a fullscreen layout only when the fullscreen state changes", () => {
    expect(shouldRequestFullscreenLayout(null, false)).toBe(false);
    expect(shouldRequestFullscreenLayout(false, false)).toBe(false);
    expect(shouldRequestFullscreenLayout(false, true)).toBe(true);
    expect(shouldRequestFullscreenLayout(true, false)).toBe(true);
  });
});
