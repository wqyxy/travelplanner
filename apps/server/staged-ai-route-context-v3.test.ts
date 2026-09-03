import { describe, expect, it } from "vitest";
import { compactActionStateForAiV3 } from "./staged-ai-v3.js";

function largeRoute() {
  const coordinates = Array.from({ length: 80_000 }, (_, index) => [174 + index / 1_000_000, -41 - index / 1_000_000]);
  return {
    tripId: "trip-1",
    dayId: "macro:day-1",
    version: 3,
    inputFingerprint: "provider-fingerprint-that-ai-does-not-need",
    status: "ready",
    distanceKm: 287.4,
    durationMinutes: 241,
    geometry: {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { legId: "leg-1", mode: "drive" },
        geometry: { type: "LineString", coordinates },
      }],
    },
    legs: [{
      id: "leg-1",
      fromNodeId: "anchor-a",
      toNodeId: "anchor-b",
      fromPlaceId: "place-a",
      toPlaceId: "place-b",
      mode: "drive",
      status: "ready",
      distanceKm: 287.4,
      durationMinutes: 241,
      geometry: { type: "LineString", coordinates },
      warning: null,
    }],
    warnings: [],
    calculatedAt: "2026-09-03T00:00:00.000Z",
  };
}

describe("itinerary AI route context compaction", () => {
  it("removes provider geometry while preserving scheduling-useful route facts", () => {
    const state = {
      targetDayIds: ["day-1"],
      routeStates: [{ dayId: "day-1", dirty: false, route: largeRoute() }],
      macroRouteStates: [{ dayId: "day-1", routeId: "macro:day-1", required: true, dirty: false, route: largeRoute() }],
    };
    const beforeBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    const compacted = compactActionStateForAiV3("itinerary.detail.generate", state) as any;
    const afterText = JSON.stringify(compacted);
    const afterBytes = Buffer.byteLength(afterText, "utf8");

    expect(beforeBytes).toBeGreaterThan(1_048_576);
    expect(afterBytes).toBeLessThan(50_000);
    expect(afterText).not.toContain("geometry");
    expect(afterText).not.toContain("inputFingerprint");
    expect(afterText).not.toContain("calculatedAt");
    expect(compacted.macroRouteStates[0]).toMatchObject({
      dayId: "day-1",
      routeId: "macro:day-1",
      required: true,
      dirty: false,
      route: {
        status: "ready",
        distanceKm: 287.4,
        durationMinutes: 241,
        legs: [{
          fromPlaceId: "place-a",
          toPlaceId: "place-b",
          mode: "drive",
          status: "ready",
          distanceKm: 287.4,
          durationMinutes: 241,
          warning: null,
        }],
      },
    });
  });

  it("does not alter non-itinerary action state", () => {
    const state = { routeStates: [{ route: largeRoute() }] };
    expect(compactActionStateForAiV3("destination.generate", state)).toBe(state);
  });
});
