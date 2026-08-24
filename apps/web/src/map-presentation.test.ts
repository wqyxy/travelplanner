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
    expect(result.routes.map((route) => route.edge.id)).toEqual(["e2"]);
  });
});
