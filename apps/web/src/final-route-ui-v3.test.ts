import { describe, expect, it } from "vitest";
import type { Day, FinalRouteNode, RouteState, TravelPlanDocument } from "./v2-types";
import {
  finalRouteDayCountV3,
  finalRouteDayViewsV4,
  finalRouteDisplayRowsV3,
  finalRouteTransportConnectionsV4,
  newFinalRoutePlaceCommandsV3,
  transportFromModeV3,
} from "./final-route-ui-v3";

const node = (id: string, status: FinalRouteNode["status"], endsDay = false): FinalRouteNode => ({
  id,
  placeId: `place-${id}`,
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

function plan(nodes: FinalRouteNode[]): TravelPlanDocument {
  return {
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
    places: nodes.map((item) => ({ id: item.placeId, nameZh: item.id.toUpperCase(), nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: false })),
    candidates: [],
    finalRoute: { version: 1, nodes },
    days: [],
    warnings: [],
  };
}

function day(id: string, dayNumber: number, startPlaceId: string, endPlaceId: string, stops: Day["stops"] = []): Day {
  return {
    id,
    dayNumber,
    date: null,
    title: `Day ${dayNumber}`,
    transferMode: "drive",
    detailLevel: "planned",
    detailStatus: null,
    startAnchor: { id: `start-${id}`, placeId: startPlaceId, label: null, notes: null },
    stops,
    endAnchor: { id: `end-${id}`, placeId: endPlaceId, label: null, notes: null },
  };
}

function routeState(dayId: string, input: { dirty?: boolean; status?: "ready" | "attention"; fromPlaceId: string; toPlaceId: string; distanceKm?: number; durationMinutes?: number }): RouteState {
  return {
    dayId,
    dirty: input.dirty ?? false,
    route: {
      tripId: "trip-1",
      dayId,
      version: 1,
      inputFingerprint: "fp",
      status: input.status ?? "ready",
      distanceKm: input.distanceKm ?? 20,
      durationMinutes: input.durationMinutes ?? 30,
      geometry: null,
      legs: [{
        id: `leg-${dayId}`,
        fromNodeId: `from-${dayId}`,
        toNodeId: `to-${dayId}`,
        fromPlaceId: input.fromPlaceId,
        toPlaceId: input.toPlaceId,
        mode: "drive",
        status: input.status === "attention" ? "attention" : "ready",
        distanceKm: input.distanceKm ?? 20,
        durationMinutes: input.durationMinutes ?? 30,
        geometry: null,
        warning: input.status === "attention" ? "route warning" : null,
      }],
      warnings: input.status === "attention" ? ["route warning"] : [],
      calculatedAt: null,
    },
  };
}

describe("final route UI helpers", () => {
  it("assigns display Day numbers only from active boundaries", () => {
    const source = plan([
      node("a", "normal"),
      node("x", "tentative", true),
      node("b", "normal", true),
      node("y", "no_go", true),
      node("c", "normal"),
    ]);
    expect(finalRouteDisplayRowsV3(source).map((row) => [row.node.id, row.dayNumber])).toEqual([
      ["a", 1],
      ["x", 1],
      ["b", 1],
      ["y", 2],
      ["c", 2],
    ]);
    expect(finalRouteDayCountV3(source)).toBe(2);
  });

  it("does not create an extra Day merely because a non-boundary node exists before the last boundary", () => {
    expect(finalRouteDayCountV3(plan([node("a", "normal"), node("b", "normal", true)]))).toBe(1);
    expect(finalRouteDayCountV3(plan([node("a", "normal", true), node("b", "normal")]))).toBe(2);
  });

  it("connects current active places while skipping tentative rows", () => {
    const a = node("a", "normal");
    const x = node("x", "tentative");
    const b = node("b", "normal", true);
    b.transportFromPrevious = transportFromModeV3("drive");
    const source = plan([a, x, b]);
    source.days = [day("day-1", 1, a.placeId, b.placeId)];
    const connections = finalRouteTransportConnectionsV4(source, [routeState("day-1", {
      fromPlaceId: a.placeId,
      toPlaceId: b.placeId,
      distanceKm: 72,
      durationMinutes: 58,
    })]);

    expect(connections).toEqual([expect.objectContaining({
      fromNodeId: "a",
      toNodeId: "b",
      mode: "drive",
      distanceKm: 72,
      durationMinutes: 58,
      state: "ready",
      skippedInactiveCount: 1,
    })]);
  });

  it("does not expose stale provider facts while a Day route is dirty", () => {
    const a = node("a", "normal");
    const b = node("b", "normal", true);
    b.transportFromPrevious = transportFromModeV3("drive");
    const source = plan([a, b]);
    source.days = [day("day-1", 1, a.placeId, b.placeId)];
    const [connection] = finalRouteTransportConnectionsV4(source, [routeState("day-1", {
      dirty: true,
      fromPlaceId: a.placeId,
      toPlaceId: b.placeId,
      distanceKm: 999,
      durationMinutes: 999,
    })]);
    expect(connection.state).toBe("dirty");
    expect(connection.distanceKm).toBeNull();
    expect(connection.durationMinutes).toBeNull();
  });

  it("derives Day summaries from current route state without creating a second Day model", () => {
    const a = node("a", "normal", true);
    const source = plan([a]);
    source.days = [day("day-1", 1, a.placeId, a.placeId)];
    expect(finalRouteDayViewsV4(source, [routeState("day-1", {
      fromPlaceId: a.placeId,
      toPlaceId: a.placeId,
      distanceKm: 12,
      durationMinutes: 18,
    })])).toEqual([expect.objectContaining({
      dayId: "day-1",
      dayNumber: 1,
      routeState: "ready",
      distanceKm: 12,
      durationMinutes: 18,
      emptyDetail: true,
    })]);
  });

  it("creates one batch that adds the Place/internal detail anchor and its route occurrence", () => {
    const commands = newFinalRoutePlaceCommandsV3({
      index: 2,
      temporaryPlaceId: "tmp-place",
      temporaryCandidateId: "tmp-candidate",
      temporaryNodeId: "tmp-node",
      nameZh: "Hobbiton",
      kind: "attraction",
    });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ type: "add_candidate", place: { id: "tmp-place", nameZh: "Hobbiton" }, candidate: { id: "tmp-candidate", placeId: "tmp-place", planningRole: "planning_area" } });
    expect(commands[1]).toMatchObject({ type: "add_final_route_node", index: 2, node: { id: "tmp-node", placeId: "tmp-place", status: "normal", endsDay: false } });
  });

  it("builds arrival transport without inventing provider facts", () => {
    expect(transportFromModeV3("drive")).toEqual({
      mode: "drive",
      durationMinutes: null,
      note: null,
      verification: { status: "unverified", checkedAt: null },
    });
    expect(transportFromModeV3("")).toBeNull();
    expect(transportFromModeV3("none")).toBeNull();
  });
});
