import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DayRouteServiceV2, routeIsDirty } from "./day-route-v2.js";
import { TravelStoreV2 } from "./travel-store-v2.js";

const place = (id: string) => ({ id, nameZh: id, nameLocal: null, nameEn: null, kind: "attraction" as const, city: null, region: null, country: null, countryCode: null, approximate: false });
const resolution = (tripId: string, placeId: string, latitude: number, longitude: number) => ({ tripId, placeId, geoFingerprint: "", status: "resolved" as const, method: "manual_coordinates" as const, provider: null, providerPlaceId: null, latitude, longitude, address: null, confidence: .8, resolvedAt: new Date().toISOString(), errorMessage: null });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-v2-"));
  const store = new TravelStoreV2(path.join(root, "travel.sqlite3"));
  const created = store.createTrip();
  const plan = structuredClone(created.plan);
  plan.stage = "itinerary_planning";
  plan.places = [place("p1"), place("p2")];
  plan.days = [{ id: "d1", dayNumber: 1, date: null, title: "Day", transferMode: "drive", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a1", placeId: "p1", label: null, notes: null }, stops: [{ id: "s1", candidateId: null, placeId: "p2", activity: "visit", period: null, startTime: null, endTime: null, durationMinutes: null, transportFromPrevious: { mode: "drive", durationMinutes: null, note: null, verification: { status: "estimated", checkedAt: null } }, scheduleVerification: null, costNote: null, costVerification: null, notes: null }], endAnchor: { id: "a2", placeId: "p2", label: null, notes: null } }];
  const written = store.writePlan(created.id, plan, 0);
  for (const item of [resolution(created.id, "p1", 1, 2), resolution(created.id, "p2", 3, 4)]) {
    const current = plan.places.find((p) => p.id === item.placeId)!;
    const { placeGeoFingerprint } = await import("./place-resolver-v2.js");
    item.geoFingerprint = placeGeoFingerprint(current);
    store.upsertPlaceResolution(created.id, item, written.generation);
  }
  return { store, trip: written.trip };
}

describe("DayRouteServiceV2", () => {
  it("derives dirty state and stores a route", async () => {
    const { store, trip } = await setup();
    const service = new DayRouteServiceV2({ store, maps: { route: async () => ({ geometry: { type: "LineString", coordinates: [[2, 1], [4, 3]] }, distanceKm: 5, durationMinutes: 10, warning: null }) } });
    expect(service.workspaceRouteState(trip.id)[0].dirty).toBe(true);
    const route = await service.recalculate(trip.id, "d1", trip.contentGeneration);
    expect(route.status).toBe("ready");
    const state = service.workspaceRouteState(trip.id)[0];
    expect(state.dirty).toBe(false);
    const changed = structuredClone(trip.plan.days[0]);
    changed.stops[0].transportFromPrevious = { mode: "bike", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } };
    expect(routeIsDirty(changed, route, new Map(trip.plan.places.map((p) => [p.id, p])), store.listPlaceResolutions(trip.id))).toBe(true);
    store.close();
  });

  it("keeps Macro and Detail routes isolated and dirties both on coordinate-only changes", async () => {
    const { store, trip } = await setup();
    const service = new DayRouteServiceV2({ store, maps: { route: async () => ({ geometry: { type: "LineString", coordinates: [[2, 1], [4, 3]] }, distanceKm: 5, durationMinutes: 10, warning: null }) } });
    const macro = await service.recalculateMacro(trip.id, "d1", trip.contentGeneration);
    expect(macro?.dayId).toBe("macro:d1");
    const detail = await service.recalculate(trip.id, "d1", trip.contentGeneration);
    expect(detail.dayId).toBe("d1");
    expect(store.getDayRoute(trip.id, "macro:d1")?.dayId).toBe("macro:d1");
    expect(store.getDayRoute(trip.id, "d1")?.dayId).toBe("d1");

    await service.recalculateMacro(trip.id, "d1", trip.contentGeneration);
    expect(store.getDayRoute(trip.id, "d1")?.version).toBe(1);
    await service.recalculate(trip.id, "d1", trip.contentGeneration);
    expect(store.getDayRoute(trip.id, "macro:d1")?.version).toBe(2);

    const changed = { ...store.listPlaceResolutions(trip.id).find((item) => item.placeId === "p2")!, latitude: 9, longitude: 10 };
    store.upsertPlaceResolution(trip.id, changed, trip.contentGeneration);
    expect(service.workspaceMacroRouteState(trip.id)[0].dirty).toBe(true);
    expect(service.workspaceRouteState(trip.id)[0].dirty).toBe(true);
    store.close();
  });

  it("treats equal Macro anchors as a stay day without a route", async () => {
    const { store, trip } = await setup();
    const next = structuredClone(trip.plan);
    next.days[0].endAnchor.placeId = "p1";
    const written = store.writePlan(trip.id, next, trip.contentGeneration);
    const service = new DayRouteServiceV2({ store, maps: { route: async () => { throw new Error("provider must not run for a stay day"); } } });
    expect(service.workspaceMacroRouteState(trip.id)[0]).toMatchObject({ required: false, dirty: false, route: null });
    await expect(service.recalculateMacro(trip.id, "d1", written.generation)).resolves.toBeNull();
    store.close();
  });
});
