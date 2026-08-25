import { describe, expect, it } from "vitest";
import {
  approximateRouteDurationMinutes,
  defaultCategoryVisibility,
  formatRouteDistance,
  formatRouteDuration,
  geometryDistanceKm,
  routeColorExpression,
  routeHighlightFeatureCollection,
  routeHoverFromFeature,
  routeHitLayerIds,
  routeHoverCoreLayerIds,
  routeHoverHaloLayerIds,
  routeHoverLayerIds,
  routeLayerIds,
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
    expect(routeHoverFromFeature({ id: 42, properties: { id: "edge-stable", dayNumber: 2 } })).toEqual({ id: "edge-stable", dayNumber: 2 });
    expect(routeHoverFromFeature({ properties: { id: "route-0", dayNumber: 0 } })).toBeNull();
  });

  it("uses the dashed layer only for flights and ferries", () => {
    expect(routeLayerForMode("flight")).toBe("dashed");
    expect(routeLayerForMode("ferry")).toBe("dashed");
    expect(["drive", "walk", "rail", "transit"].map(routeLayerForMode)).toEqual(["solid", "solid", "solid", "solid"]);
  });

  it("keeps route drawing, hit testing, and hover overlays on independent layers", () => {
    expect(routeLayerIds).toEqual(["travel-routes-solid", "travel-routes-dashed"]);
    expect(routeHitLayerIds).toEqual(["travel-route-hit-solid", "travel-route-hit-dashed"]);
    expect(routeHoverHaloLayerIds).toEqual(["travel-route-hover-solid-halo", "travel-route-hover-dashed-halo"]);
    expect(routeHoverCoreLayerIds).toEqual(["travel-route-hover-solid-core", "travel-route-hover-dashed-core"]);
    expect(routeHoverLayerIds).toEqual([...routeHoverHaloLayerIds, ...routeHoverCoreLayerIds]);
    expect(new Set([...routeLayerIds, ...routeHitLayerIds, ...routeHoverLayerIds]).size).toBe(8);
  });

  it("builds highlight data with one complete route and clears it to an empty collection", () => {
    const feature = { type: "Feature" as const, id: "edge-3", geometry: { type: "LineString" as const, coordinates: [[0, 0], [1, 1]] }, properties: { id: "edge-3", mode: "walk", dayNumber: 3 } };
    expect(routeHighlightFeatureCollection(feature)).toEqual({ type: "FeatureCollection", features: [feature] });
    expect(routeHighlightFeatureCollection(null)).toEqual({ type: "FeatureCollection", features: [] });
  });

  it("uses a literal fallback until route color matches are available", () => {
    expect(routeColorExpression("dayNumber", [])).toBe("#64748b");
    expect(routeColorExpression("dayNumber", [[3, "#16a34a"]])).toEqual(["match", ["get", "dayNumber"], 3, "#16a34a", "#64748b"]);
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
