import { describe, expect, it } from "vitest";
import { dayPlacesAreTerminal } from "./map-service.js";

describe("map route readiness", () => {
  it("waits for AI decisions before routing", () => {
    expect(dayPlacesAreTerminal(["resolved", "ambiguous"])).toBe(false);
    expect(dayPlacesAreTerminal(["resolved", "unresolved"])).toBe(false);
  });

  it("allows partial routing after every place reaches a terminal state", () => {
    expect(dayPlacesAreTerminal(["resolved", "approximate", "unlocated"])).toBe(true);
  });
});
