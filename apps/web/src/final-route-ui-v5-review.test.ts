import { describe, expect, it } from "vitest";
import type { DayStop, FinalRouteNode, RouteState, TravelPlanDocument } from "./v2-types";
import { finalRouteTransportConnectionsV4, transportFromModeV3 } from "./final-route-ui-v3";

function routeNode(id: string, placeId: string, endsDay = false): FinalRouteNode {
  return {
    id,
    placeId,
    status: "normal",
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
  };
}

function stop(id: string, placeId: string): DayStop {
  return {
    id,
    candidateId: null,
    placeId,
    activity: placeId,
    period: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    transportFromPrevious: transportFromModeV3("drive"),
    scheduleVerification: null,
    costNote: null,
    costVerification: null,
    notes: null,
  };
}

function basePlan(nodes: FinalRouteNode[]): TravelPlanDocument {
  return {
    schemaVersion: 2,
    stage: "itinerary_planning",
    trip: {
      title: "review",
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
    places: [
      { id: "place-a", nameZh: "A", nameLocal: null, nameEn: null, kind: "city", city: null, region: null, country: null, countryCode: null, approximate: false },
      { id: "place-b", nameZh: "B", nameLocal: null, nameEn: null, kind: "city", city: null, region: null, country: null, countryCode: null, approximate: false },
    ],
    candidates: [],
    finalRoute: { version: 1, nodes },
    days: [],
    warnings: [],
  };
}

function twoPlacePlan(): TravelPlanDocument {
  const a = routeNode("node-a", "place-a");
  const b = routeNode("node-b", "place-b", true);
  b.transportFromPrevious = transportFromModeV3("drive");
  const plan = basePlan([a, b]);
  plan.days = [{
    id: "node-b",
    dayNumber: 1,
    date: null,
    title: "B",
    transferMode: "none",
    endTransportFromPrevious: b.transportFromPrevious,
    detailLevel: "planned",
    detailStatus: null,
    startAnchor: { id: "route-start-node-b", placeId: "place-a", label: null, notes: null },
    stops: [],
    endAnchor: { id: "route-end-node-b", placeId: "place-b", label: null, notes: null },
  }];
  return plan;
}

describe("Phase 5 route connection review", () => {
  it("labels provider attention without a matching leg as unavailable and exposes no stale facts", () => {
    const plan = twoPlacePlan();
    const states: RouteState[] = [{
      dayId: "node-b",
      dirty: false,
      route: {
        tripId: "trip-1",
        dayId: "node-b",
        version: 1,
        inputFingerprint: "fp",
        status: "attention",
        distanceKm: 999,
        durationMinutes: 999,
        geometry: null,
        legs: [],
        warnings: ["provider unavailable"],
        calculatedAt: null,
      },
    }];

    const [connection] = finalRouteTransportConnectionsV4(plan, states);
    expect(connection).toMatchObject({
      state: "unavailable",
      mode: "drive",
      distanceKm: null,
      durationMinutes: null,
      warning: "provider unavailable",
    });
  });

  it("matches repeated A-to-B occurrences by derived Day node ids instead of taking the first Place-id match", () => {
    const a1 = routeNode("node-a1", "place-a");
    const b1 = routeNode("node-b1", "place-b");
    const a2 = routeNode("node-a2", "place-a");
    const b2 = routeNode("node-b2", "place-b", true);
    for (const node of [b1, a2, b2]) node.transportFromPrevious = transportFromModeV3("drive");
    const plan = basePlan([a1, b1, a2, b2]);
    plan.days = [{
      id: "node-b2",
      dayNumber: 1,
      date: null,
      title: "loop",
      transferMode: "none",
      endTransportFromPrevious: b2.transportFromPrevious,
      detailLevel: "planned",
      detailStatus: null,
      startAnchor: { id: "start-day", placeId: "place-a", label: null, notes: null },
      stops: [stop("node-b1", "place-b"), stop("node-a2", "place-a")],
      endAnchor: { id: "end-day", placeId: "place-b", label: null, notes: null },
    }];
    const states: RouteState[] = [{
      dayId: "node-b2",
      dirty: false,
      route: {
        tripId: "trip-1",
        dayId: "node-b2",
        version: 1,
        inputFingerprint: "fp",
        status: "ready",
        distanceKm: 60,
        durationMinutes: 90,
        geometry: null,
        warnings: [],
        calculatedAt: null,
        legs: [
          { id: "leg-1", fromNodeId: "start-day", toNodeId: "node-b1", fromPlaceId: "place-a", toPlaceId: "place-b", mode: "drive", status: "ready", distanceKm: 10, durationMinutes: 15, geometry: null, warning: null },
          { id: "leg-2", fromNodeId: "node-b1", toNodeId: "node-a2", fromPlaceId: "place-b", toPlaceId: "place-a", mode: "drive", status: "ready", distanceKm: 20, durationMinutes: 30, geometry: null, warning: null },
          { id: "leg-3", fromNodeId: "node-a2", toNodeId: "end-day", fromPlaceId: "place-a", toPlaceId: "place-b", mode: "drive", status: "ready", distanceKm: 30, durationMinutes: 45, geometry: null, warning: null },
        ],
      },
    }];

    const connections = finalRouteTransportConnectionsV4(plan, states);
    expect(connections.map((connection) => [connection.fromNodeId, connection.toNodeId, connection.distanceKm])).toEqual([
      ["node-a1", "node-b1", 10],
      ["node-b1", "node-a2", 20],
      ["node-a2", "node-b2", 30],
    ]);
  });
});
