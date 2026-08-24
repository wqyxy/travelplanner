import { describe, expect, it } from "vitest";
import {
  approximateRouteDurationMinutes,
  defaultCategoryVisibility,
  formatRouteDistance,
  formatRouteDuration,
  geometryDistanceKm,
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

  it("calculates and formats approximate route metrics for the hover tooltip", () => {
    const distance = geometryDistanceKm({ type: "LineString", coordinates: [[116.397, 39.908], [116.407, 39.908]] });
    expect(distance).toBeCloseTo(0.85, 1);
    expect(formatRouteDistance(distance)).toBe("0.85 km");
    expect(formatRouteDistance(10.2)).toBe("10 km");
    expect(approximateRouteDurationMinutes("walk", distance, null)).toBe(10);
    expect(formatRouteDuration(approximateRouteDurationMinutes("walk", distance, null))).toBe("10 分钟");
    expect(formatRouteDuration(approximateRouteDurationMinutes("rail", distance, 85))).toBe("1 小时 25 分钟");
  });

  it("uses the short antimeridian crossing when measuring a route", () => {
    const distance = geometryDistanceKm({ type: "LineString", coordinates: [[179.9, 0], [180.1, 0]] });
    expect(distance).toBeCloseTo(22.24, 1);
  });
});
