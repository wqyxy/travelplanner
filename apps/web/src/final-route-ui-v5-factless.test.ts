import { describe, expect, it } from "vitest";
import type { FinalRouteNode, RouteState, TravelPlanDocument } from "./v2-types";
import { finalRouteTransportConnectionsV4, transportFromModeV3 } from "./final-route-ui-v3";

const node = (id: string, placeId: string, endsDay = false): FinalRouteNode => ({
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
});

describe("Phase 5 factless provider route", () => {
  it("treats an attention leg with no distance or duration as unavailable", () => {
    const a = node("a", "place-a");
    const b = node("b", "place-b", true);
    b.transportFromPrevious = transportFromModeV3("transit");
    const plan: TravelPlanDocument = {
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
        id: "b",
        dayNumber: 1,
        date: null,
        title: "B",
        transferMode: "none",
        endTransportFromPrevious: b.transportFromPrevious,
        detailLevel: "planned",
        detailStatus: null,
        startAnchor: { id: "start-b", placeId: "place-a", label: null, notes: null },
        stops: [],
        endAnchor: { id: "end-b", placeId: "place-b", label: null, notes: null },
      }],
      warnings: [],
    };
    const states: RouteState[] = [{
      dayId: "b",
      dirty: false,
      route: {
        tripId: "trip",
        dayId: "b",
        version: 1,
        inputFingerprint: "fp",
        status: "attention",
        distanceKm: null,
        durationMinutes: null,
        geometry: null,
        warnings: ["transit 暂不由当前路线服务计算。"],
        calculatedAt: null,
        legs: [{
          id: "leg",
          fromNodeId: "start-b",
          toNodeId: "end-b",
          fromPlaceId: "place-a",
          toPlaceId: "place-b",
          mode: "transit",
          status: "attention",
          distanceKm: null,
          durationMinutes: null,
          geometry: null,
          warning: "transit 暂不由当前路线服务计算。",
        }],
      },
    }];

    expect(finalRouteTransportConnectionsV4(plan, states)[0]).toMatchObject({
      state: "unavailable",
      mode: "transit",
      distanceKm: null,
      durationMinutes: null,
    });
  });
});
