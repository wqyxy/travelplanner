import { describe, expect, it } from "vitest";
import { buildMapPresentation } from "./MapPanel";
import type { Itinerary, MapState } from "./types";

const itinerary: Itinerary = {
  schemaVersion: 1,
  stage: "draft",
  trip: { title: "东京", originPlaceId: null, destinationPlaceIds: ["tokyo"], dates: { start: null, end: null, requestedDurationDays: 2 }, travelers: { summary: "", adults: null, children: null }, budget: { amount: null, currency: null, note: null }, pace: null, themes: [], preferences: [], constraints: [], assumptions: [] },
  places: [
    { id: "tokyo", kind: "city", nameZh: "东京", nameEn: "Tokyo", nameLocal: "東京", city: "Tokyo", region: null, country: "Japan", countryCode: "JP", approximate: false },
    { id: "museum", kind: "attraction", nameZh: "博物馆", nameEn: "Museum", nameLocal: null, city: "Tokyo", region: null, country: "Japan", countryCode: "JP", approximate: false },
  ],
  days: [], warnings: [],
};
const state: MapState = {
  generation: 4, status: "attention", warnings: [], updatedAt: "2026-08-24T00:00:00.000Z",
  resolvedPlaces: [
    { placeId: "tokyo", geoFingerprint: "t", provider: "test", providerPlaceId: "1", lat: 35.68, lng: 139.76, timezone: "Asia/Tokyo", resolution: "exact", confidence: 1, resolvedAt: "2026-08-24T00:00:00.000Z" },
    { placeId: "museum", geoFingerprint: "m", provider: "test", providerPlaceId: null, lat: null, lng: null, timezone: null, resolution: "unresolved", confidence: null, resolvedAt: null },
  ],
  map: {
    visits: [
      { id: "v1", dayId: "d1", dayNumber: 1, stopId: "s1", placeId: "tokyo", order: 0 },
      { id: "v1-repeat", dayId: "d1", dayNumber: 1, stopId: "s1-repeat", placeId: "tokyo", order: 1 },
      { id: "v2", dayId: "d1", dayNumber: 1, stopId: "s2", placeId: "museum", order: 1 },
      { id: "v3", dayId: "d2", dayNumber: 2, stopId: "s3", placeId: "tokyo", order: 0 },
    ],
    edges: [
      { id: "e1", dayId: "d1", fromVisitId: "v1", toVisitId: "v2", mode: "transit", order: 0 },
      { id: "e2", dayId: "d2", fromVisitId: "v3", toVisitId: "v3", mode: "walk", order: 0 },
    ],
    routes: [
      { edgeId: "e1", routeKey: "r1", geometry: { type: "LineString", coordinates: [[139.76, 35.68], [139.77, 35.69]] }, status: "ready", warning: null },
      { edgeId: "e2", routeKey: "r2", geometry: { type: "LineString", coordinates: [[139.76, 35.68], [139.76, 35.68]] }, status: "ready", warning: null },
    ],
  },
};

describe("map snapshot presentation", () => {
  it("deduplicates Place markers while preserving every visible visit", () => {
    const result = buildMapPresentation(itinerary, state, { scope: "all" }, ["city", "attraction", "lodging", "meal", "stop", "waypoint"]);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].visits.map((visit) => visit.id)).toEqual(["v1", "v1-repeat", "v3"]);
    expect(result.markers[0].dayLabel).toBe("D1/D2");
    expect(result.visibleVisits).toHaveLength(4);
    expect(result.unresolvedPlaceIds).toEqual(["museum"]);
  });

  it("uses day selection to scope both visits and routes", () => {
    const result = buildMapPresentation(itinerary, state, { scope: "day", dayNumber: 2 }, ["city"]);
    expect(result.visibleVisits.map((visit) => visit.id)).toEqual(["v3"]);
    expect(result.routes.map((route) => route.edgeIds)).toEqual([["e2"]]);
  });

  it("keeps ignored canonical visits auditable but hides their marker and exposes straight fallback routes", () => {
    const ignoredState: MapState = { ...state, resolvedPlaces: [
      state.resolvedPlaces[0],
      { ...state.resolvedPlaces[1], resolution: "ignored", decisionReason: "这是没有唯一身份的途中休息安排。" },
    ], map: {
      ...state.map!, visualComplete: true,
      routes: [{ ...state.map!.routes[0], geometrySource: "straight", status: "attention", warning: "路线服务暂时不可用，以直线示意。" }],
    } };
    const result = buildMapPresentation(itinerary, ignoredState, { scope: "all" }, ["city", "attraction"]);
    expect(result.visibleVisits.map((visit) => visit.placeId)).toContain("museum");
    expect(result.ignoredPlaceIds).toEqual(["museum"]); expect(result.markers.map((marker) => marker.id)).toEqual(["tokyo"]);
    expect(result.routes[0]).toMatchObject({ geometrySource: "straight", status: "attention" });
  });

  it("does not merge provider geometry with a contiguous straight fallback", () => {
    const splitState: MapState = { ...state, map: {
      visits: [
        { id: "sv1", dayId: "d1", dayNumber: 1, stopId: "ss1", placeId: "tokyo", order: 0 },
        { id: "sv2", dayId: "d1", dayNumber: 1, stopId: "ss2", placeId: "tokyo", order: 1 },
        { id: "sv3", dayId: "d1", dayNumber: 1, stopId: "ss3", placeId: "tokyo", order: 2 },
      ],
      edges: [
        { id: "se1", dayId: "d1", fromVisitId: "sv1", toVisitId: "sv2", mode: "drive", order: 0 },
        { id: "se2", dayId: "d1", fromVisitId: "sv2", toVisitId: "sv3", mode: "drive", order: 1 },
      ],
      routes: [
        { edgeId: "se1", routeKey: "sr1", geometry: { type: "LineString", coordinates: [[0, 0], [1, 0]] }, geometrySource: "provider", status: "ready", warning: null },
        { edgeId: "se2", routeKey: "sr2", geometry: { type: "LineString", coordinates: [[1, 0], [2, 0]] }, geometrySource: "straight", status: "attention", warning: "直线示意" },
      ],
    } };
    const result = buildMapPresentation(itinerary, splitState, { scope: "all" }, ["city"]);
    expect(result.routes.map((route) => [route.edgeIds, route.geometrySource])).toEqual([[["se1"], "provider"], [["se2"], "straight"]]);
  });

  it("groups only contiguous same-day same-mode route legs and aggregates their presentation", () => {
    const visits = [
      { id: "g1", dayId: "d1", dayNumber: 1, stopId: "gs1", placeId: "p1", order: 0 },
      { id: "g2", dayId: "d1", dayNumber: 1, stopId: "gs2", placeId: "p2", order: 1 },
      { id: "g3", dayId: "d1", dayNumber: 1, stopId: "gs3", placeId: "p3", order: 2 },
      { id: "g4", dayId: "d1", dayNumber: 1, stopId: "gs4", placeId: "p4", order: 3 },
      { id: "g5", dayId: "d1", dayNumber: 1, stopId: "gs5", placeId: "p5", order: 4 },
      { id: "g6", dayId: "d1", dayNumber: 1, stopId: "gs6", placeId: "p6", order: 5 },
      { id: "g7", dayId: "d2", dayNumber: 2, stopId: "gs7", placeId: "p7", order: 0 },
      { id: "g8", dayId: "d2", dayNumber: 2, stopId: "gs8", placeId: "p8", order: 1 },
    ];
    const groupedState: MapState = { ...state, map: {
      visits,
      edges: [
        { id: "ge1", dayId: "d1", fromVisitId: "g1", toVisitId: "g2", mode: "drive", order: 0 },
        { id: "ge2", dayId: "d1", fromVisitId: "g2", toVisitId: "g3", mode: "drive", order: 1 },
        { id: "ge3", dayId: "d1", fromVisitId: "g3", toVisitId: "g4", mode: "walk", order: 2 },
        { id: "ge4", dayId: "d1", fromVisitId: "g4", toVisitId: "g5", mode: "drive", order: 3 },
        { id: "ge5", dayId: "d1", fromVisitId: "g5", toVisitId: "g6", mode: "drive", order: 4 },
        { id: "ge6", dayId: "d2", fromVisitId: "g7", toVisitId: "g8", mode: "drive", order: 0 },
      ],
      routes: [
        { edgeId: "ge5", routeKey: "gr5", geometry: { type: "LineString", coordinates: [[4, 0], [5, 0]] }, distanceKm: 5, durationMinutes: 10, status: "ready", warning: null },
        { edgeId: "ge2", routeKey: "gr2", geometry: { type: "LineString", coordinates: [[1, 0], [2, 0]] }, distanceKm: 15, durationMinutes: 25, status: "attention", warning: "同一提醒" },
        { edgeId: "ge1", routeKey: "gr1", geometry: { type: "LineString", coordinates: [[0, 0], [1, 0]] }, distanceKm: 10, durationMinutes: 20, status: "attention", warning: "同一提醒" },
        { edgeId: "ge3", routeKey: "gr3", geometry: { type: "LineString", coordinates: [[2, 0], [3, 0]] }, distanceKm: 1, durationMinutes: 12, status: "ready", warning: null },
        { edgeId: "ge4", routeKey: "gr4", geometry: null, distanceKm: null, durationMinutes: null, status: "attention", warning: "路线缺失" },
        { edgeId: "ge6", routeKey: "gr6", geometry: { type: "LineString", coordinates: [[0, 1], [1, 1]] }, distanceKm: 8, durationMinutes: 16, status: "ready", warning: null },
      ],
    } };
    const result = buildMapPresentation(itinerary, groupedState, { scope: "all" }, ["city"]);
    expect(result.routes.map((route) => route.edgeIds)).toEqual([["ge1", "ge2"], ["ge3"], ["ge5"], ["ge6"]]);
    expect(result.routes[0]).toMatchObject({ id: "route-group:ge1", dayNumber: 1, mode: "drive", distanceKm: 25, durationMinutes: 45, estimated: false, status: "attention", warning: "同一提醒" });
    expect(result.routes[0].geometry).toEqual({ type: "MultiLineString", coordinates: [[[0, 0], [1, 0]], [[1, 0], [2, 0]]] });
    expect(buildMapPresentation(itinerary, groupedState, { scope: "day", dayNumber: 2 }, ["city"]).routes.map((route) => route.edgeIds)).toEqual([["ge6"]]);
  });
});
