import { describe, expect, it } from "vitest";
import {
  defaultCategoryVisibility,
  routeHoverFromFeature,
  routeLayerForMode,
  visibleCategories,
} from "./map-interactions";

describe("map interactions", () => {
  it("starts with every place category visible and excludes unchecked categories", () => {
    const visibility = defaultCategoryVisibility();
    visibility.meal = false;
    visibility.waypoint = false;
    expect(visibleCategories(visibility)).toEqual([
      "city", "attraction", "lodging", "stop",
    ]);
  });

  it("derives a valid route hover payload for the Day tooltip", () => {
    expect(routeHoverFromFeature({ id: "route-3", properties: { dayNumber: "3" } })).toEqual({ id: "route-3", dayNumber: 3 });
    expect(routeHoverFromFeature({ properties: { id: "route-0", dayNumber: 0 } })).toBeNull();
  });

  it("uses the dashed layer only for flights and ferries", () => {
    expect(routeLayerForMode("flight")).toBe("dashed");
    expect(routeLayerForMode("ferry")).toBe("dashed");
    expect(["drive", "walk", "rail", "transit"].map(routeLayerForMode)).toEqual(["solid", "solid", "solid", "solid"]);
  });
});
