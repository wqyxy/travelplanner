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

function routePlan() {
  const base = emptyTravelPlan();
  return TravelPlanDocumentSchema.parse({
    ...base,
    trip: { ...base.trip, originPlaceId: "a" },
    places: [place("a"), place("x"), place("b")],
    finalRoute: {
      version: 1,
      nodes: [node("x-node", "x"), node("b-node", "b", { endsDay: true })],
    },
  });
}

describe("TravelStoreV3 final-route storage", () => {
  it("stores the final route and rebuilds Days from it instead of trusting submitted Day edits", () => {
    const store = new TravelStoreV3(databasePath());
    const created = store.createTrip();
    const plan = routePlan();
    const deliberatelyStale = TravelPlanDocumentSchema.parse({ ...plan, days: [] });

    const written = store.writePlan(created.id, deliberatelyStale, 0, { source: "test", summary: "route write" });

    expect(written.trip.plan.finalRoute.nodes.map((item) => item.id)).toEqual(["x-node", "b-node"]);
    expect(written.trip.plan.days).toHaveLength(1);
    expect(written.trip.plan.days[0].startAnchor.placeId).toBe("a");
    expect(written.trip.plan.days[0].endAnchor.placeId).toBe("b");
    store.close();
  });

  it("keeps Revision / restore for new-format plans only", () => {
    const store = new TravelStoreV3(databasePath());
    const created = store.createTrip();
    const first = store.writePlan(created.id, routePlan(), 0, { source: "test", summary: "route v1" });
    const next = structuredClone(first.trip.plan);
    next.finalRoute.nodes[0].status = "tentative";
    const second = store.writePlan(created.id, next, first.generation, { source: "test", summary: "route v2" });

    expect(store.getRevision(created.id, first.version)?.plan.finalRoute.nodes[0].status).toBe("normal");
    const restored = store.restoreRevision(created.id, first.version);
    expect(restored.trip.plan.finalRoute.nodes[0].status).toBe("normal");
    expect(restored.generation).toBe(second.generation + 1);
    store.close();
  });

  it("rejects old-format plan JSON instead of deriving a final route from it", () => {
    const filename = databasePath();
    let store = new TravelStoreV3(filename);
    const created = store.createTrip();
    store.close();

    const raw = new DatabaseSync(filename);
    const row = raw.prepare("SELECT current_plan_json FROM trips WHERE id=?").get(created.id) as { current_plan_json: string };
    const oldPlan = JSON.parse(row.current_plan_json) as Record<string, any>;
    oldPlan.places = [place("old-place")];
    oldPlan.candidates = [{
      id: "old-candidate",
      placeId: "old-place",
      planningAreaCandidateId: null,
      preference: "want_to_go",
      source: "user",
      aiReason: null,
      aiScore: null,
      suggestedDurationMinutes: null,
      tags: [],
    }];
    delete oldPlan.finalRoute;
    raw.prepare("UPDATE trips SET current_plan_json=? WHERE id=?").run(JSON.stringify(oldPlan), created.id);
    raw.close();

    store = new TravelStoreV3(filename);
    expect(() => store.requireTrip(created.id)).toThrow(/OLD_TEST_PLAN_UNSUPPORTED/);
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
      finalRoute: { version: 1, nodes: [node("x-node", "x", { status: "tentative" }), node("b-node", "b")] },
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