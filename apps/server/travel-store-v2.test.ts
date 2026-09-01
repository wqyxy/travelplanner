import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema, emptyTravelPlan, type AiProposal, type DayRoute, type PlaceResolution, type TravelPlanDocument } from "./contracts-v2.js";
import { TravelStoreV2 } from "./travel-store-v2.js";

type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
const roots: string[] = [];

function databasePath() {
  const root = mkdtempSync(path.join(tmpdir(), "travel-store-v2-"));
  roots.push(root);
  return path.join(root, "travel.sqlite3");
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function plannedDocument(): TravelPlanDocument {
  const plan = emptyTravelPlan();
  plan.stage = "itinerary_planning";
  plan.trip.title = "京都两日游";
  plan.places.push({ id: "place-1", nameZh: "清水寺", nameLocal: null, nameEn: "Kiyomizu-dera", kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false });
  plan.candidates.push({ id: "candidate-1", placeId: "place-1", planningAreaCandidateId: null, preference: "want_to_go", source: "ai", aiReason: "京都代表景点", aiScore: 90, suggestedDurationMinutes: 90, tags: ["寺院"] });
  plan.days.push({
    id: "day-1",
    dayNumber: 1,
    date: null,
    title: "京都东山",
    transferMode: "none",
    detailLevel: "planned",
    detailStatus: null,
    startAnchor: { id: "anchor-start-1", placeId: null, label: "住宿待定", notes: null },
    stops: [{ id: "stop-1", candidateId: "candidate-1", placeId: "place-1", activity: "参观清水寺", period: "morning", startTime: null, endTime: null, durationMinutes: 90, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null }],
    endAnchor: { id: "anchor-end-1", placeId: null, label: "住宿待定", notes: null },
  });
  return TravelPlanDocumentSchema.parse(plan);
}

function proposal(tripId: string, generation: number): AiProposal {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    tripId,
    baseGeneration: generation,
    scope: { type: "day", id: "day-1" },
    status: "pending",
    title: "放松 Day 1",
    explanation: "减少当天活动强度。",
    commands: [{ type: "update_day", dayId: "day-1", changes: { title: "轻松京都东山" } }],
    diff: { summary: "调整 Day 1 标题", commandSummaries: ["更新 Day 1"], affectedCandidateIds: [], affectedPlaceIds: [], affectedDayIds: ["day-1"] },
    createdAt: timestamp,
    updatedAt: timestamp,
    appliedRevisionVersion: null,
  };
}

describe("TravelStoreV2", () => {
  it("creates only a fresh v2 database and records the initial revision", () => {
    const filename = databasePath();
    const store = new TravelStoreV2(filename);
    const trip = store.createTrip();
    expect(trip.plan).toMatchObject({ schemaVersion: 2, stage: "place_selection" });
    expect(trip.contentGeneration).toBe(0);
    expect(store.listRevisions(trip.id)).toHaveLength(1);
    store.close();

    const db = new DatabaseSync(filename);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    const routeColumns = (db.prepare("PRAGMA table_info(day_routes)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(routeColumns).not.toContain("route_dirty");
    db.close();
  });

  it("rejects legacy or unknown non-empty databases instead of migrating them", () => {
    const filename = databasePath();
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE legacy_trips(id TEXT PRIMARY KEY); PRAGMA user_version=1;");
    db.close();
    expect(() => new TravelStoreV2(filename)).toThrow(/旧行程和旧数据库不受支持/);
  });

  it("uses expectedGeneration CAS and keeps title plus revisions atomic", () => {
    const store = new TravelStoreV2(databasePath());
    const trip = store.createTrip();
    const plan = plannedDocument();
    const written = store.writePlan(trip.id, plan, 0, { source: "test", summary: "生成计划" });
    expect(written.generation).toBe(1);
    expect(written.trip.title).toBe("京都两日游");
    expect(store.listRevisions(trip.id)).toHaveLength(2);
    expect(() => store.writePlan(trip.id, plan, 0)).toThrow("CONTENT_GENERATION_SUPERSEDED");
    expect(store.requireTrip(trip.id).contentGeneration).toBe(1);
    store.close();
  });

  it("stores resolutions and routes as generation-guarded derived state", () => {
    const store = new TravelStoreV2(databasePath());
    const created = store.createTrip();
    const written = store.writePlan(created.id, plannedDocument(), 0);
    const resolution: PlaceResolution = {
      tripId: created.id,
      placeId: "place-1",
      geoFingerprint: "v1|kiyomizu",
      status: "resolved",
      method: "provider_match",
      provider: "nominatim",
      providerPlaceId: "123",
      latitude: 34.9948,
      longitude: 135.785,
      address: "京都府京都市",
      confidence: 0.95,
      resolvedAt: new Date().toISOString(),
      errorMessage: null,
    };
    store.upsertPlaceResolution(created.id, resolution, written.generation);
    expect(store.getPlaceResolution(created.id, "place-1")?.status).toBe("resolved");
    expect(() => store.upsertPlaceResolution(created.id, { ...resolution, placeId: "missing" }, written.generation)).toThrow(/当前旅行中的 Place/);

    const route: DayRoute = {
      tripId: created.id,
      dayId: "day-1",
      version: 1,
      inputFingerprint: "route-v1",
      status: "ready",
      distanceKm: 2,
      durationMinutes: 20,
      geometry: { type: "LineString", coordinates: [] },
      legs: [],
      warnings: [],
      calculatedAt: new Date().toISOString(),
    };
    store.setDayRoute(created.id, route, written.generation);
    expect(store.getDayRoute(created.id, "day-1")?.inputFingerprint).toBe("route-v1");
    expect(() => store.setDayRoute(created.id, { ...route, version: 3 }, written.generation)).toThrow(/version 必须为 2/);
    expect(() => store.setDayRoute(created.id, { ...route, version: 2 }, 0)).toThrow("CONTENT_GENERATION_SUPERSEDED");
    store.close();
  });

  it("applies and undoes a Proposal atomically through revision history", () => {
    const store = new TravelStoreV2(databasePath());
    const created = store.createTrip();
    const planned = store.writePlan(created.id, plannedDocument(), 0);
    const pending = store.createProposal(proposal(created.id, planned.generation));
    const next = structuredClone(planned.trip.plan);
    next.days[0].title = "轻松京都东山";
    const applied = store.applyProposalPlan(pending.id, next);
    expect(applied.trip.plan.days[0].title).toBe("轻松京都东山");
    expect(applied.proposal.status).toBe("applied");
    expect(applied.proposal.appliedRevisionVersion).toBe(3);

    const undone = store.undoProposal(pending.id);
    expect(undone.trip.plan.days[0].title).toBe("京都东山");
    expect(undone.proposal.status).toBe("undone");
    expect(store.listRevisions(created.id)).toHaveLength(4);
    store.close();
  });

  it("supersedes pending Proposals after an unrelated canonical write", () => {
    const store = new TravelStoreV2(databasePath());
    const created = store.createTrip();
    const planned = store.writePlan(created.id, plannedDocument(), 0);
    const pending = store.createProposal(proposal(created.id, planned.generation));
    const next = structuredClone(planned.trip.plan);
    next.trip.title = "京都慢游";
    store.writePlan(created.id, next, planned.generation);
    expect(store.getProposal(pending.id)?.status).toBe("superseded");
    store.close();
  });

  it("cleans derived rows whose Place or Day was removed from canonical plan", () => {
    const store = new TravelStoreV2(databasePath());
    const created = store.createTrip();
    const planned = store.writePlan(created.id, plannedDocument(), 0);
    const resolution: PlaceResolution = { tripId: created.id, placeId: "place-1", geoFingerprint: "v1", status: "unresolved", method: "provider_match", provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: "not found" };
    store.upsertPlaceResolution(created.id, resolution, planned.generation);
    const route: DayRoute = { tripId: created.id, dayId: "day-1", version: 1, inputFingerprint: "v1", status: "idle", distanceKm: null, durationMinutes: null, geometry: null, legs: [], warnings: [], calculatedAt: null };
    store.setDayRoute(created.id, route, planned.generation);
    const empty = emptyTravelPlan();
    empty.trip.title = "重新选择地点";
    store.writePlan(created.id, empty, planned.generation);
    expect(store.listPlaceResolutions(created.id)).toEqual([]);
    expect(store.listDayRoutes(created.id)).toEqual([]);
    store.close();
  });
});
