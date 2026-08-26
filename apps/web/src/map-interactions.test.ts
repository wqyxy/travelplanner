import { describe, expect, it } from "vitest";
import {
  approximateRouteDurationMinutes,
  defaultCategoryVisibility,
  drivingMetricsForItinerary,
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
  routeTravelMetrics,
  visibleCategories,
} from "./map-interactions";
import type { Itinerary, MapState } from "./types";

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

  it("prefers provider driving metrics and falls back to old route geometry", () => {
    const provider = routeTravelMetrics({ edgeId: "edge-1", routeKey: "r1", geometry: null, distanceKm: 12.5, durationMinutes: 24, status: "ready", warning: null }, "drive", null);
    expect(provider).toEqual({ distanceKm: 12.5, durationMinutes: 24, estimated: false, pending: false });
    const legacy = routeTravelMetrics({ edgeId: "edge-2", routeKey: "r2", geometry: { type: "LineString", coordinates: [[116.397, 39.908], [116.407, 39.908]] }, status: "ready", warning: null }, "drive", 15);
    expect(legacy.distanceKm).toBeCloseTo(.85, 1); expect(legacy.durationMinutes).toBe(15); expect(legacy.estimated).toBe(true); expect(legacy.pending).toBe(false);
  });

  it("aggregates only complete driving edges by Day and marks missing routes pending", () => {
    const itinerary = {
      schemaVersion: 1, stage: "draft", trip: { title: "路线", originPlaceId: null, destinationPlaceIds: [], dates: { start: null, end: null, requestedDurationDays: 1 }, travelers: { summary: "", adults: null, children: null }, budget: { amount: null, currency: null, note: null }, pace: null, themes: [], preferences: [], constraints: [], assumptions: [] }, places: [], warnings: [],
      days: [{ id: "day-1", dayNumber: 1, date: null, title: "驾驶日", detailLevel: "draft", stops: [
        { id: "stop-1", role: "start", placeId: "p1", activity: "出发", period: "morning", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: null, costNote: null, costVerification: null, notes: null },
        { id: "stop-2", role: "visit", placeId: "p2", activity: "抵达", period: "afternoon", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: { mode: "drive", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } }, costNote: null, costVerification: null, notes: null },
        { id: "stop-3", role: "end", placeId: "p3", activity: "结束", period: "evening", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: { mode: "walk", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } }, costNote: null, costVerification: null, notes: null },
      ] }],
    } as Itinerary;
    const state = { generation: 1, resolvedPlaces: [], status: "ready", warnings: [], updatedAt: "2026-08-25T00:00:00Z", map: { visits: [{ id: "v1", dayId: "day-1", dayNumber: 1, stopId: "stop-1", placeId: "p1", order: 0 }, { id: "v2", dayId: "day-1", dayNumber: 1, stopId: "stop-2", placeId: "p2", order: 1 }], edges: [{ id: "edge-1", dayId: "day-1", fromVisitId: "v1", toVisitId: "v2", mode: "drive", order: 0 }], routes: [{ edgeId: "edge-1", routeKey: "r1", geometry: null, distanceKm: 88, durationMinutes: 95, status: "ready", warning: null }] } } as MapState;
    expect(drivingMetricsForItinerary(itinerary, state).byDayId.get("day-1")).toMatchObject({ routeCount: 1, distanceKm: 88, durationMinutes: 95, estimated: false, pending: false });
    expect(drivingMetricsForItinerary(itinerary, { ...state, map: { ...state.map!, routes: [] } }).byDayId.get("day-1")).toMatchObject({ routeCount: 1, distanceKm: null, durationMinutes: null, pending: true });
    expect(drivingMetricsForItinerary(itinerary, state, 2).byDayId.get("day-1")).toMatchObject({ distanceKm: null, durationMinutes: null, pending: true });
  });

  it("skips ignored driving Stops and attributes their bridged edge to the next retained Stop", () => {
    const itinerary = {
      schemaVersion: 1, stage: "draft", trip: { title: "路线", originPlaceId: null, destinationPlaceIds: [], dates: { start: null, end: null, requestedDurationDays: 1 }, travelers: { summary: "", adults: null, children: null }, budget: { amount: null, currency: null, note: null }, pace: null, themes: [], preferences: [], constraints: [], assumptions: [] }, places: [], warnings: [],
      days: [{ id: "day-1", dayNumber: 1, date: null, title: "驾驶日", detailLevel: "draft", stops: [
        { id: "stop-1", role: "start", placeId: "p1", activity: "出发", period: "morning", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: null, costNote: null, costVerification: null, notes: null },
        { id: "stop-2", role: "visit", placeId: "p2", activity: "忽略点", period: "afternoon", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: { mode: "drive", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } }, costNote: null, costVerification: null, notes: null },
        { id: "stop-3", role: "end", placeId: "p3", activity: "抵达", period: "evening", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: { mode: "drive", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } }, costNote: null, costVerification: null, notes: null },
      ] }],
    } as Itinerary;
    const state = { generation: 1, resolvedPlaces: [{ placeId: "p2", geoFingerprint: "ignored", provider: "ai-web", providerPlaceId: null, lat: null, lng: null, timezone: null, resolution: "ignored", confidence: null, resolvedAt: null, decisionReason: "没有唯一身份。" }], status: "attention", warnings: [], updatedAt: "2026-08-25T00:00:00Z", map: { visits: [{ id: "v1", dayId: "day-1", dayNumber: 1, stopId: "stop-1", placeId: "p1", order: 0 }, { id: "v2", dayId: "day-1", dayNumber: 1, stopId: "stop-2", placeId: "p2", order: 1 }, { id: "v3", dayId: "day-1", dayNumber: 1, stopId: "stop-3", placeId: "p3", order: 2 }], edges: [{ id: "edge-1", dayId: "day-1", fromVisitId: "v1", toVisitId: "v3", mode: "drive", order: 0, viaIgnoredVisitIds: ["v2"] }], routes: [{ edgeId: "edge-1", routeKey: "r1", geometry: null, distanceKm: 120, durationMinutes: 130, status: "ready", warning: null }] } } as MapState;
    const metrics = drivingMetricsForItinerary(itinerary, state);
    expect(metrics.byStopId.has("stop-2")).toBe(false); expect(metrics.byStopId.get("stop-3")).toMatchObject({ distanceKm: 120, durationMinutes: 130, pending: false }); expect(metrics.byDayId.get("day-1")).toMatchObject({ routeCount: 1, distanceKm: 120, durationMinutes: 130, pending: false });
  });
});
