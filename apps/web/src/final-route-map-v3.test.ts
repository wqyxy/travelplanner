import { describe, expect, it } from "vitest";
import type { WorkspaceV3 } from "./v3-types";
import { finalRouteMapPointFeaturesV3, finalRouteMapRouteGeometryFeaturesV3 } from "./final-route-map-v3";

function workspace(): WorkspaceV3 {
  const node = (id: string, placeId: string, status: "normal" | "tentative" | "no_go", endsDay = false) => ({
    id,
    placeId,
    status,
    endsDay,
    transportFromPrevious: null,
    activity: null,
    period: null,
    scheduleText: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    scheduleVerification: null,
    costNote: null,
    costVerification: null,
    notes: null,
  });
  const place = (id: string) => ({ id, nameZh: id.toUpperCase(), nameLocal: null, nameEn: null, kind: "attraction" as const, city: null, region: null, country: null, countryCode: null, approximate: false });
  return {
    trip: {
      id: "trip",
      title: "test",
      state: "active",
      updatedAt: "2026-09-05T00:00:00Z",
      planLanguage: "zh",
      contentGeneration: 1,
      plan: {
        schemaVersion: 2,
        stage: "itinerary_planning",
        trip: {
          title: "test",
          brief: { destination: "", origin: "", departureTime: "", duration: "", travelers: "", transport: "", additionalRequirements: "" },
          originPlaceId: null,
          destinationPlaceIds: [],
          dates: { start: null, end: null, requestedDurationDays: null },
          travelers: { summary: "", adults: null, children: null },
          budget: { amount: null, currency: null, note: null },
          pace: null,
          themes: [],
          preferences: [],
          constraints: [],
          assumptions: [],
        },
        places: [place("a"), place("x"), place("y")],
        candidates: [],
        finalRoute: { version: 1, nodes: [node("node-a", "a", "normal"), node("node-x", "x", "tentative", true), node("node-y", "y", "no_go")] },
        days: [],
        warnings: [],
      },
    },
    resolutions: [
      { tripId: "trip", placeId: "a", geoFingerprint: "a", status: "resolved", method: "manual_coordinates", provider: null, providerPlaceId: null, latitude: 1, longitude: 2, address: "A addr", confidence: null, resolvedAt: "2026-09-05T00:00:00Z", errorMessage: null },
      { tripId: "trip", placeId: "x", geoFingerprint: "x", status: "resolved", method: "manual_coordinates", provider: null, providerPlaceId: null, latitude: 3, longitude: 4, address: null, confidence: null, resolvedAt: "2026-09-05T00:00:00Z", errorMessage: null },
      { tripId: "trip", placeId: "y", geoFingerprint: "y", status: "resolved", method: "manual_coordinates", provider: null, providerPlaceId: null, latitude: 5, longitude: 6, address: null, confidence: null, resolvedAt: "2026-09-05T00:00:00Z", errorMessage: null },
    ],
    routes: [], proposals: [], actions: [], routeStates: [], macroRouteStates: [], itineraryUpdateState: { macro: { status: "ready" }, detail: { status: "ready", affectedDayIds: [] } },
    messages: { requirements: [], destinations: [], interests: [], itinerary: [] }, tasks: [], revisions: [], coverage: [], advisories: [],
  };
}

describe("final route map presentation", () => {
  it("shows normal, tentative and no-go route nodes when they have real coordinates", () => {
    const points = finalRouteMapPointFeaturesV3(workspace());
    expect(points.map((point) => [point.properties.routeNodeId, point.properties.status])).toEqual([
      ["node-a", "normal"],
      ["node-x", "tentative"],
      ["node-y", "no_go"],
    ]);
    expect(points[1].properties.mark).toContain("?");
    expect(points[1].properties.mark).toContain("住");
    expect(points[2].properties.mark).toContain("×");
  });

  it("hides dirty provider legs that no longer match the current active Day topology", () => {
    const value = workspace();
    const y = value.trip.plan.finalRoute!.nodes.find((item) => item.id === "node-y")!;
    y.status = "normal";
    value.trip.plan.days = [{
      id: "day-1",
      dayNumber: 1,
      date: null,
      title: "A 到 Y",
      transferMode: "none",
      detailLevel: "planned",
      detailStatus: null,
      startAnchor: { id: "start", placeId: "a", label: null, notes: null },
      stops: [],
      endAnchor: { id: "end", placeId: "y", label: null, notes: null },
    }];
    const leg = (id: string, fromNodeId: string, fromPlaceId: string, toNodeId: string, toPlaceId: string) => ({
      id,
      fromNodeId,
      toNodeId,
      fromPlaceId,
      toPlaceId,
      mode: "drive" as const,
      status: "ready" as const,
      distanceKm: 10,
      durationMinutes: 20,
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      warning: null,
    });
    value.routeStates = [{
      dayId: "day-1",
      dirty: true,
      route: {
        tripId: "trip",
        dayId: "day-1",
        version: 1,
        inputFingerprint: "old",
        status: "ready",
        distanceKm: 30,
        durationMinutes: 60,
        geometry: null,
        legs: [
          leg("old-a-x", "start", "a", "node-x", "x"),
          leg("old-x-y", "node-x", "x", "end", "y"),
          leg("current-a-y", "start", "a", "end", "y"),
        ],
        warnings: [],
        calculatedAt: "2026-09-05T00:00:00Z",
      },
    }];

    const routes = finalRouteMapRouteGeometryFeaturesV3(value);
    expect(routes.map((item) => item.id)).toEqual(["route-leg:day-1:current-a-y"]);
    expect(routes[0].properties.dirty).toBe(true);
  });
});
