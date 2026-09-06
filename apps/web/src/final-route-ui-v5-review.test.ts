import { describe, expect, it } from "vitest";
import type { FinalRouteNode, RouteState, TravelPlanDocument } from "./v2-types";
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

function twoPlacePlan(): TravelPlanDocument {
  const a = routeNode("node-a", "place-a");
  const b = routeNode("node-b", "place-b", true);
  b.transportFromPrevious = transportFromModeV3("drive");
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
    finalRoute: { version: 1, nodes: [a, b] },
    days: [{
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
    }],
    warnings: [],
  };
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
});
