import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyTravelPlan, TravelPlanDocumentSchema, type FinalRouteNode } from "./contracts-v2.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
const roots: string[] = [];

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function databasePath() {
  const root = mkdtempSync(path.join(tmpdir(), "travel-store-final-route-v3-"));
  roots.push(root);
  return path.join(root, "travel.sqlite3");
}

const place = (id: string) => ({
  id,
  nameZh: id.toUpperCase(),
  nameLocal: null,
  nameEn: null,
  kind: "attraction" as const,
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

function legacyDayPlan() {
  const base = emptyTravelPlan();
  return TravelPlanDocumentSchema.parse({
    ...base,
    trip: { ...base.trip, originPlaceId: "a" },
    places: [place("a"), place("x"), place("b")],
    candidates: [{ id: "cx", placeId: "x", planningAreaCandidateId: null, preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] }],
    finalRoute: { version: 0, nodes: [] },
    days: [{
      id: "legacy-day", dayNumber: 1, date: null, title: "旧行程", transferMode: "drive", detailLevel: "detailed", detailStatus: "ready",
      startAnchor: { id: "legacy-start", placeId: "a", label: null, notes: null },
      stops: [{ id: "legacy-stop", candidateId: "cx", placeId: "x", activity: "X", period: null, scheduleText: null, startTime: null, endTime: null, durationMinutes: null, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null }],
      endAnchor: { id: "legacy-end", placeId: "b", label: null, notes: null },
    }],
  });
}

describe("TravelStoreV3 final-route compatibility", () => {
  it("keeps an intentionally empty new final route empty even when old Candidate data remains", () => {
    const store = new TravelStoreV3(databasePath());
    const created = store.createTrip();
    const base = emptyTravelPlan();
    const plan = TravelPlanDocumentSchema.parse({
      ...base,
      places: [place("x")],
      candidates: [{ id: "cx", placeId: "x", planningAreaCandidateId: null, preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] }],
      finalRoute: { version: 1, nodes: [] },
    });
    const written = store.writePlan(created.id, plan, 0, { source: "test", summary: "intentional empty route" });
    expect(written.trip.plan.finalRoute).toEqual({ version: 1, nodes: [] });
    expect(store.requireTrip(created.id).plan.finalRoute).toEqual({ version: 1, nodes: [] });
    store.close();
  });
  it("derives final route from old current JSON and old revision JSON, then restores without rewriting history", () => {
    const filename = databasePath();
    let store = new TravelStoreV3(filename);
    const created = store.createTrip();
    const seeded = store.writePlan(created.id, legacyDayPlan(), 0, { source: "test", summary: "legacy fixture" });
    expect(seeded.trip.plan.finalRoute.nodes.map((item) => item.id)).toEqual(["legacy-stop", "legacy-end"]);
    store.close();

    const raw = new DatabaseSync(filename);
    const stripFinalRoute = (json: string) => {
      const value = JSON.parse(json) as Record<string, unknown>;
      delete value.finalRoute;
      return JSON.stringify(value);
    };
    const current = raw.prepare("SELECT current_plan_json FROM trips WHERE id=?").get(created.id) as { current_plan_json: string };
    raw.prepare("UPDATE trips SET current_plan_json=? WHERE id=?").run(stripFinalRoute(current.current_plan_json), created.id);
    const revision = raw.prepare("SELECT plan_json FROM plan_revisions WHERE trip_id=? AND version=2").get(created.id) as { plan_json: string };
    raw.prepare("UPDATE plan_revisions SET plan_json=? WHERE trip_id=? AND version=2").run(stripFinalRoute(revision.plan_json), created.id);
    raw.close();

    store = new TravelStoreV3(filename);
    expect(store.requireTrip(created.id).plan.finalRoute.nodes.map((item) => item.id)).toEqual(["legacy-stop", "legacy-end"]);
    expect(store.getRevision(created.id, 2)?.plan.finalRoute.nodes.map((item) => item.id)).toEqual(["legacy-stop", "legacy-end"]);

    const restored = store.restoreRevision(created.id, 2);
    expect(restored.trip.plan.finalRoute.nodes.map((item) => item.id)).toEqual(["legacy-stop", "legacy-end"]);
    expect(restored.generation).toBe(2);
    store.close();

    const check = new DatabaseSync(filename);
    const oldRevision = check.prepare("SELECT plan_json FROM plan_revisions WHERE trip_id=? AND version=2").get(created.id) as { plan_json: string };
    expect(Object.hasOwn(JSON.parse(oldRevision.plan_json), "finalRoute")).toBe(false);
    const newRevision = check.prepare("SELECT plan_json FROM plan_revisions WHERE trip_id=? AND version=3").get(created.id) as { plan_json: string };
    expect(Object.hasOwn(JSON.parse(newRevision.plan_json), "finalRoute")).toBe(true);
    check.close();
  });

  it("keeps the final route synchronized while legacy Day editors still write during the transition", () => {
    const store = new TravelStoreV3(databasePath());
    const created = store.createTrip();
    const seeded = store.writePlan(created.id, legacyDayPlan(), 0, { source: "test", summary: "seed legacy day" });
    expect(seeded.trip.plan.finalRoute.nodes.map((item) => item.placeId)).toEqual(["x", "b"]);

    const edited = structuredClone(seeded.trip.plan);
    edited.places.push(place("y"));
    edited.days[0].stops.push({
      id: "legacy-stop-y", candidateId: null, placeId: "y", activity: "Y", period: null, scheduleText: null,
      startTime: null, endTime: null, durationMinutes: null, transportFromPrevious: null, scheduleVerification: null,
      costNote: null, costVerification: null, notes: null,
    });
    const written = store.writePlan(created.id, edited, seeded.generation, { source: "test", summary: "legacy detail edit" });

    expect(written.trip.plan.finalRoute.nodes.map((item) => item.placeId)).toEqual(["x", "y", "b"]);
    expect(written.trip.plan.finalRoute.nodes.map((item) => item.id)).toEqual(["legacy-stop", "legacy-stop-y", "legacy-end"]);
    store.close();
  });

  it("supersedes a trip-wide pending proposal on a route-only status change even when Days stay identical", () => {
    const store = new TravelStoreV3(databasePath());
    const created = store.createTrip();
    const base = emptyTravelPlan();
    const plan = TravelPlanDocumentSchema.parse({
      ...base,
      trip: { ...base.trip, originPlaceId: "a" },
      places: [place("a"), place("x"), place("b")],
      finalRoute: { nodes: [node("x-node", "x", { status: "tentative" }), node("b-node", "b")] },
    });
    const seeded = store.writePlan(created.id, plan, 0, { source: "test", summary: "route fixture" });
    const timestamp = new Date().toISOString();
    store.createProposal({
      id: "trip-proposal", tripId: created.id, baseGeneration: seeded.generation, scope: { type: "trip", id: null }, status: "pending",
      title: "整趟建议", explanation: "测试线路节点冲突", commands: [{ type: "update_place", placeId: "b", changes: { nameZh: "B2" } }],
      diff: { summary: "测试", commandSummaries: ["测试"], affectedCandidateIds: [], affectedPlaceIds: ["b"], affectedDayIds: [] },
      createdAt: timestamp, updatedAt: timestamp, appliedRevisionVersion: null,
    });

    const before = store.requireTrip(created.id).plan;
    const next = structuredClone(before);
    next.finalRoute.nodes.find((item) => item.id === "x-node")!.status = "no_go";
    expect(JSON.stringify(next.days)).toBe(JSON.stringify(before.days));
    store.writePlan(created.id, next, seeded.generation, { source: "test", summary: "route-only status" });

    expect(store.getProposal("trip-proposal")?.status).toBe("superseded");
    store.close();
  });
});
