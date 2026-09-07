import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
} from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function databasePath() {
  const root = mkdtempSync(path.join(tmpdir(), "canonical-travel-store-v3-"));
  roots.push(root);
  return path.join(root, "travel.sqlite3");
}

const place = (id: string): Place => ({
  id,
  nameZh: id.toUpperCase(),
  nameLocal: null,
  nameEn: null,
  kind: "attraction",
  city: null,
  region: null,
  country: "新西兰",
  countryCode: "NZ",
  approximate: false,
});

const node = (id: string, placeId: string, patch: Partial<FinalRouteNode> = {}): FinalRouteNode => ({
  id,
  placeId,
  status: "normal",
  endsDay: false,
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
  ...patch,
});

function canonicalPlan() {
  const base = TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    trip: { ...emptyTravelPlan().trip, originPlaceId: "origin" },
    places: [place("origin"), place("x"), place("end"), place("other")],
    finalRoute: {
      version: 1,
      nodes: [node("stop-x", "x"), node("day-end", "end", { endsDay: true })],
    },
  });
  return rebuildFinalRouteDaysV3(base);
}

describe("native TravelStoreV3 canonical plan boundary", () => {
  it("canonicalizes legacy Day route writes and preserves generation CAS", () => {
    const store = new TravelStoreV3(databasePath());
    const created = store.createTrip();
    const seeded = store.writePlan(created.id, canonicalPlan(), created.contentGeneration, {
      source: "test",
      summary: "seed canonical route",
    });

    const incoming = structuredClone(seeded.trip.plan);
    incoming.days[0].endAnchor.placeId = "other";
    const written = store.writePlan(created.id, incoming, seeded.generation, {
      source: "test",
      summary: "legacy anchor edit",
    });

    expect(written.trip.plan.finalRoute.nodes.find((item) => item.id === "day-end")?.placeId).toBe("other");
    expect(written.trip.plan.days[0].endAnchor.placeId).toBe("other");
    expect(written.generation).toBe(seeded.generation + 1);
    expect(() => store.writePlan(created.id, incoming, seeded.generation, {
      source: "test",
      summary: "stale write",
    })).toThrow("CONTENT_GENERATION_SUPERSEDED");
    store.close();
  });

  it("persists explicit Day title/date metadata without turning Day into a route model", () => {
    const store = new TravelStoreV3(databasePath());
    const created = store.createTrip();
    const seeded = store.writePlan(created.id, canonicalPlan(), created.contentGeneration, {
      source: "test",
      summary: "seed canonical route",
    });
    const incoming = structuredClone(seeded.trip.plan);
    incoming.days[0].title = "用户自定义标题";
    incoming.days[0].date = "2026-10-05";

    const written = store.writePlan(created.id, incoming, seeded.generation, {
      source: "test",
      summary: "edit Day metadata",
    });
    expect(written.trip.plan.days[0].title).toBe("用户自定义标题");
    expect(written.trip.plan.days[0].date).toBe("2026-10-05");
    expect(written.trip.plan.finalRoute.nodes).toEqual(seeded.trip.plan.finalRoute.nodes);
    store.close();
  });

  it("rejects direct Stop structure writes when finalRoute is already canonical", () => {
    const store = new TravelStoreV3(databasePath());
    const created = store.createTrip();
    const seeded = store.writePlan(created.id, canonicalPlan(), created.contentGeneration, {
      source: "test",
      summary: "seed canonical route",
    });
    const incoming = structuredClone(seeded.trip.plan);
    incoming.days[0].stops[0].activity = "绕过 finalRoute 的修改";

    expect(() => store.writePlan(created.id, incoming, seeded.generation, {
      source: "test",
      summary: "invalid direct Day Stop write",
    })).toThrow("DERIVED_DAY_ROUTE_WRITE_UNSUPPORTED");
    store.close();
  });
});