import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  MapAgentOutputJsonSchema,
  MapAgentOutputSchema,
  normalizeMapAgentOutput,
  MapResolutionOutputJsonSchema,
  MapResolutionOutputSchema,
  TravelAgentOutputJsonSchema,
  TravelAgentOutputSchema,
} from "./contracts.js";
import { loadAgentPrompts } from "./prompt-contract.js";
import { TravelStore } from "./travel-store.js";
import { normalizeGeneratedPlaceName } from "./travel-store.js";
import { MapService } from "./map-service.js";

type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as SqliteModule;

const folders: string[] = [];
async function makeStore() {
  const folder = await mkdtemp(path.join(tmpdir(), "travelplanner-test-"));
  folders.push(folder);
  return new TravelStore(path.join(folder, "travel.sqlite3"));
}

const plan = (name = "京都春日漫游") => ({
  tripName: name,
  travelerSummary: "两位成人",
  pace: "舒缓",
  themes: ["美食", "古迹"],
  timezone: "Asia/Tokyo",
  budgetNote: "预算待确认",
  warnings: ["营业时间请在出发前核验"],
  days: [
    {
      dayNumber: 1,
      date: "2026-04-10",
      title: "抵达京都",
      activities: [
        {
          id: "d1-a1",
          startTime: "10:00",
          endTime: "12:00",
          placeName: "清水寺",
          activity: "参观寺院与周边街区",
          durationMinutes: 120,
          transportMode: "walk",
          transportMinutes: 15,
          costNote: "门票以现场为准",
        },
      ],
    },
  ],
  generatedBy: "codex" as const,
});
const output = (name?: string) =>
  TravelAgentOutputSchema.parse({
    schemaVersion: 1,
    replyType: "plan_updated",
    assistantMessage: "已整理为可执行的第一版行程。",
    requirements: {
      destinations: [{ city: "京都", country: "日本", timezone: "Asia/Tokyo" }],
      dates: { durationDays: 1 },
      travelers: { summary: "两位成人", adults: 2 },
      budget: { note: "预算待确认" },
      pace: "舒缓",
      themes: ["美食", "古迹"],
      preferences: [],
      assumptions: [],
      openQuestions: [],
    },
    plan: plan(name),
    assumptions: [],
    verificationNotes: ["开放时间待核验"],
  });

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe("TravelStore revisions", () => {
  it("normalizes only generated geographic functional suffixes", () => {
    expect(normalizeGeneratedPlaceName("罗托鲁瓦市区")).toBe("罗托鲁瓦 市区");
    expect(normalizeGeneratedPlaceName("奥克兰住宿")).toBe("奥克兰 住宿");
    expect(normalizeGeneratedPlaceName("东京迪士尼乐园")).toBe("东京迪士尼乐园");
  });

  it("normalizes redundant day-path endpoints before strict map validation", () => {
    const normalized = normalizeMapAgentOutput({
      dayPaths: [{ entityIds: ["overnight", "spot"], startEntityId: "wrong", endEntityId: "wrong", overnightEntityId: "spot" }],
    }) as { dayPaths: Array<{ startEntityId: string; endEntityId: string; overnightEntityId: string }> };
    expect(normalized.dayPaths[0]).toMatchObject({ startEntityId: "overnight", endEntityId: "spot", overnightEntityId: "spot" });
  });

  it("exports a strict Codex output schema with every object property required", () => {
    const missing: string[] = [];
    const visit = (value: unknown, path = "$") => {
      if (Array.isArray(value))
        return value.forEach((item, index) => visit(item, `${path}[${index}]`));
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (
        record.properties &&
        typeof record.properties === "object" &&
        !Array.isArray(record.properties)
      ) {
        const required = new Set(
          Array.isArray(record.required) ? record.required : [],
        );
        for (const key of Object.keys(record.properties))
          if (!required.has(key)) missing.push(`${path}.${key}`);
      }
      for (const [key, item] of Object.entries(record))
        visit(item, `${path}.${key}`);
    };
    visit(TravelAgentOutputJsonSchema);
    expect(missing).toEqual([]);
    expect(TravelAgentOutputJsonSchema).not.toHaveProperty("$schema");
    missing.length = 0;
    visit(MapAgentOutputJsonSchema);
    expect(missing).toEqual([]);
    expect(MapAgentOutputJsonSchema).not.toHaveProperty("$schema");
    missing.length = 0;
    visit(MapResolutionOutputJsonSchema);
    expect(missing).toEqual([]);
    expect(MapResolutionOutputJsonSchema).not.toHaveProperty("$schema");
  });

  it("loads two distinct versioned UTF-8 agent prompts", async () => {
    const prompts = await loadAgentPrompts(path.resolve(process.cwd()));
    expect(prompts.travel.relativePath).not.toBe(prompts.map.relativePath);
    expect(prompts.travel.sha256).not.toBe(prompts.map.sha256);
  });

  it("adds v4 storage without rewriting legacy map data", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "travelplanner-test-"));
    folders.push(folder);
    const filename = path.join(folder, "travel.sqlite3");
    const database = new DatabaseSync(filename);
    database.exec(
      "CREATE TABLE map_manifests(trip_id TEXT NOT NULL,itinerary_version INTEGER NOT NULL,map_version INTEGER NOT NULL,base_map_version INTEGER NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL,warnings_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(trip_id,itinerary_version),UNIQUE(trip_id,map_version)); CREATE TABLE map_entities(trip_id TEXT NOT NULL,itinerary_version INTEGER NOT NULL,entity_id TEXT NOT NULL,data_json TEXT NOT NULL,status TEXT NOT NULL,candidate_json TEXT,candidates_json TEXT NOT NULL,warning TEXT,PRIMARY KEY(trip_id,itinerary_version,entity_id)); PRAGMA user_version=2;",
    );
    database.prepare("INSERT INTO map_manifests VALUES(?,?,?,?,?,?,?,?,?)").run("legacy-trip", 1, 1, 0, "ready", "旧地图", "[]", "2026-01-01", "2026-01-01");
    database.close();
    const store = new TravelStore(filename);
    store.close();
    const migrated = new DatabaseSync(filename, { readOnly: true });
    expect(
      (
        migrated.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(6);
    expect(
      migrated
        .prepare("PRAGMA table_info(map_manifests)")
        .all()
        .some(
          (column) =>
            String((column as { name: string }).name) === "contract_version",
        ),
    ).toBe(true);
    expect(
      migrated.prepare("SELECT contract_version FROM map_manifests WHERE trip_id=?").get("legacy-trip"),
    ).toEqual({ contract_version: 1 });
    expect(
      (migrated.prepare("SELECT COUNT(*) AS count FROM map_visits").get() as { count: number }).count,
    ).toBe(0);
    migrated.close();
  });

  it("creates an immediate version for an AI plan and restores by creating another version", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    const message = store.createUserMessage(trip.id, "安排京都一日游");
    expect(store.applyAgentOutput(trip.id, message, output()).version).toBe(1);
    const secondMessage = store.createUserMessage(trip.id, "想多安排咖啡店");
    expect(
      store.applyAgentOutput(trip.id, secondMessage, output("京都咖啡漫游"))
        .version,
    ).toBe(2);
    const restored = store.restoreRevision(trip.id, 1);
    expect(restored.version).toBe(3);
    expect(restored.trip.activeRevision?.plan.tripName).toBe("京都春日漫游");
    store.close();
  });

  it("keeps the duplicated itinerary bound to the new trip's requirement revision", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    const message = store.createUserMessage(trip.id, "安排京都一日游");
    store.applyAgentOutput(trip.id, message, output());
    const duplicate = store.duplicate(trip.id);
    expect(
      store.getRevision(duplicate.id, 1)?.requirements.destinations[0]?.city,
    ).toBe("京都");
    store.close();
  });

  it("copies the current map snapshot with stable entity and route ids", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    const message = store.createUserMessage(trip.id, "安排京都一日游");
    store.applyAgentOutput(trip.id, message, output());
    const manifest = store.prepareMapManifest(trip.id, 1, []);
    const entity = { id: "copied-place", activityId: "d1-a1", dayNumber: 1, order: 1, kind: "attraction" as const, name: "清水寺", query: "清水寺", city: "京都", detail: "参观", importance: "primary" as const, startTime: "10:00", endTime: "11:00", durationMinutes: 60, transportMode: "walk" as const, costNote: "", notes: "", approximateLodgingArea: false };
    const hotel = { ...entity, id: "copied-hotel", activityId: null, order: 2, kind: "lodging" as const, name: "京都住宿", query: "京都住宿" };
    const route = { id: "copied-route", dayNumber: 1, order: 1, fromEntityId: entity.id, toEntityId: hotel.id, mode: "walk" as const };
    store.applyMapPatch(trip.id, 1, manifest.baseMapVersion, MapAgentOutputSchema.parse({ schemaVersion: 3, baseItineraryVersion: 1, baseMapVersion: manifest.baseMapVersion, upsertEntities: [entity, hotel], removeEntityIds: [], upsertRoutes: [route], removeRouteIds: [], dayPaths: [{ dayNumber: 1, entityIds: [entity.id, hotel.id], startEntityId: entity.id, endEntityId: hotel.id, overnightEntityId: hotel.id }], warnings: [] }));
    store.updateMapRoute(trip.id, 1, route.id, "resolved", { type: "LineString", coordinates: [[135, 35], [135.1, 35.1]] }, null);
    store.setMapStatus(trip.id, 1, "resolving", "正在解析");
    const partial = store.duplicate(trip.id);
    expect(store.getMapSnapshot(partial.id)?.status).toBe("partial");
    store.setMapStatus(trip.id, 1, "ready", "完成");
    const copied = store.duplicate(trip.id);
    const snapshot = store.getMapSnapshot(copied.id);
    expect(snapshot?.mapVersion).toBe(1);
    expect(snapshot?.status).toBe("ready");
    expect(snapshot?.entities.map((item) => item.id)).toEqual([entity.id, hotel.id]);
    expect(snapshot?.routes[0]).toMatchObject({ id: route.id, geometry: { type: "LineString" } });
    expect(snapshot?.dayPaths[0]?.entityIds).toEqual([entity.id, hotel.id]);
    store.close();
  });

  it("downgrades an in-progress copied map and leaves a mapless copy idle", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    const message = store.createUserMessage(trip.id, "安排京都一日游");
    store.applyAgentOutput(trip.id, message, output());
    const manifest = store.prepareMapManifest(trip.id, 1, []);
    store.setMapStatus(trip.id, 1, "resolving", "正在解析");
    expect(store.duplicate(trip.id).activeRevision?.version).toBe(1);
    const copied = store.listTrips().find((item) => item.title.includes("副本"))!;
    expect(store.getMapSnapshot(copied.id)?.status).toBe("idle");
    const emptyTrip = store.createTrip();
    expect(store.duplicate(emptyTrip.id).activeRevision).toBeNull();
    expect(manifest.mapVersion).toBe(1);
    store.close();
  });

  it("rejects a plan update without a complete plan before storage", () => {
    expect(() =>
      TravelAgentOutputSchema.parse({
        schemaVersion: 1,
        replyType: "plan_updated",
        assistantMessage: "没有行程",
        requirements: {},
        assumptions: [],
        verificationNotes: [],
      }),
    ).toThrow();
  });

  it("stores map patches by version, reuses unchanged entities, and rejects stale baselines", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    const firstMessage = store.createUserMessage(trip.id, "安排京都一日游");
    store.applyAgentOutput(trip.id, firstMessage, output());
    const first = store.prepareMapManifest(trip.id, 1, []);
    const entity = {
      id: "place:d1-a1",
      activityId: "d1-a1",
      dayNumber: 1,
      order: 1,
      kind: "attraction" as const,
      name: "清水寺",
      query: "清水寺, 京都, 日本",
      city: "京都",
      detail: "参观寺院与周边街区",
      importance: "primary" as const,
      startTime: "10:00",
      endTime: "12:00",
      durationMinutes: 120,
      transportMode: "walk" as const,
      costNote: "门票以现场为准",
      notes: "",
    };
    const patch = MapAgentOutputSchema.parse({
      schemaVersion: 3,
      baseItineraryVersion: 1,
      baseMapVersion: 0,
      upsertEntities: [entity],
      removeEntityIds: [],
      upsertRoutes: [],
      removeRouteIds: [],
      dayPaths: [
        {
          dayNumber: 1,
          entityIds: [entity.id],
          startEntityId: entity.id,
          endEntityId: entity.id,
          overnightEntityId: entity.id,
        },
      ],
      warnings: [],
    });
    store.applyMapPatch(trip.id, 1, first.baseMapVersion, patch);
    const candidate = {
      providerPlaceId: "1",
      displayName: "清水寺, 京都市",
      latitude: 34.9948,
      longitude: 135.785,
      category: "tourism",
      sourceUrl: "https://www.openstreetmap.org",
      sourceType: "nominatim" as const,
      evidenceUrl: null,
      confidence: "high" as const,
      decisionNote: null,
    };
    store.updateMapEntity(
      trip.id,
      1,
      entity.id,
      "resolved",
      candidate,
      [candidate],
      null,
    );
    expect(store.getMapSnapshot(trip.id)?.entities[0]?.location?.latitude).toBe(
      34.9948,
    );
    const secondMessage = store.createUserMessage(trip.id, "只改行程名称");
    store.applyAgentOutput(trip.id, secondMessage, output("京都一日慢游"));
    const second = store.prepareMapManifest(trip.id, 2, ["d1-a1"]);
    expect(store.getMapSnapshot(trip.id)?.entities[0]?.id).toBe(entity.id);
    const stale = { ...patch, baseItineraryVersion: 2 };
    expect(() =>
      store.applyMapPatch(trip.id, 2, second.baseMapVersion + 1, stale),
    ).toThrow("基线已经过期");
    store.close();
  });

  it("stores repeated visits while drawing one canonical place marker", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    store.applyAgentOutput(trip.id, store.createUserMessage(trip.id, "安排京都一日游"), output());
    const manifest = store.prepareMapManifest(trip.id, 1, []);
    const base = { activityId: "d1-a1", dayNumber: 1, kind: "attraction" as const, city: "京都", region: "京都府", country: "日本", detail: "到访", importance: "primary" as const, startTime: "", endTime: "", durationMinutes: 30, transportMode: "walk" as const, costNote: "", notes: "", approximateLodgingArea: false };
    const first = { ...base, id: "visit-a-1", order: 1, name: "京都站", displayName: "京都站", canonicalKey: "京都站|京都|京都府|日本", query: "京都站, 京都府, 日本" };
    const middle = { ...base, id: "visit-b", order: 2, name: "清水寺", displayName: "清水寺", canonicalKey: "清水寺|京都|京都府|日本", query: "清水寺, 京都府, 日本" };
    const again = { ...base, id: "visit-a-2", order: 3, name: "京都站", displayName: "京都站", canonicalKey: "ai-supplied-key-must-not-control-dedup", query: "京都站, 京都府, 日本" };
    store.applyMapPatch(trip.id, 1, manifest.baseMapVersion, MapAgentOutputSchema.parse({ schemaVersion: 3, baseItineraryVersion: 1, baseMapVersion: manifest.baseMapVersion, upsertEntities: [first, middle, again], removeEntityIds: [], upsertRoutes: [], removeRouteIds: [], dayPaths: [{ dayNumber: 1, entityIds: [first.id, middle.id, again.id], startEntityId: first.id, endEntityId: again.id, overnightEntityId: again.id }], warnings: [] }));
    const snapshot = store.getMapSnapshot(trip.id)!;
    expect(snapshot.places.map((place) => place.displayName)).toEqual(["京都站", "清水寺"]);
    expect(snapshot.visits.map((visit) => visit.placeId)).toEqual([first.id, middle.id, first.id]);
    expect(snapshot.dayPaths[0].entityIds).toEqual([first.id, middle.id, first.id]);
    expect(snapshot.routes.map((route) => [route.id, route.edgeOrder])).toEqual([["d1-r1", 1], ["d1-r2", 2]]);
    store.close();
  });

  it("merges aliases after the provider confirms the same physical place", async () => {
    const store = await makeStore(); const trip = store.createTrip();
    store.applyAgentOutput(trip.id, store.createUserMessage(trip.id, "安排京都一日游"), output());
    const manifest = store.prepareMapManifest(trip.id, 1, []);
    const base = { activityId: "d1-a1", dayNumber: 1, kind: "attraction" as const, city: "京都", detail: "到访", importance: "primary" as const, startTime: "", endTime: "", durationMinutes: 30, transportMode: "walk" as const, costNote: "", notes: "", approximateLodgingArea: false };
    const first = { ...base, id: "station-cn", order: 1, name: "京都站", query: "京都站, 日本", canonicalKey: "京都站|京都||日本" };
    const alias = { ...base, id: "station-en", order: 2, name: "Kyoto Station", query: "Kyoto Station, Japan", canonicalKey: "kyoto station|京都||日本" };
    store.applyMapPatch(trip.id, 1, manifest.baseMapVersion, MapAgentOutputSchema.parse({ schemaVersion: 3, baseItineraryVersion: 1, baseMapVersion: manifest.baseMapVersion, upsertEntities: [first, alias], removeEntityIds: [], upsertRoutes: [], removeRouteIds: [], dayPaths: [{ dayNumber: 1, entityIds: [first.id, alias.id], startEntityId: first.id, endEntityId: alias.id, overnightEntityId: alias.id }], warnings: [] }));
    const candidate = { providerPlaceId: "osm:kyoto-station", displayName: "京都駅", latitude: 34.9858, longitude: 135.7588, category: "railway", sourceUrl: "https://www.openstreetmap.org", sourceType: "nominatim" as const, evidenceUrl: null, confidence: "high" as const, decisionNote: null };
    store.selectMapCandidate(trip.id, 1, first.id, candidate);
    const merged = store.selectMapCandidate(trip.id, 1, alias.id, candidate);
    expect(merged).toEqual({ entityId: first.id, removedEntityIds: [alias.id], affectedDayNumbers: [1] });
    expect(store.getMapSnapshot(trip.id)?.places).toHaveLength(1);
    expect(store.getMapSnapshot(trip.id)?.visits.map((visit) => visit.placeId)).toEqual([first.id, first.id]);
    store.close();
  });

  it("forces an existing v1 map manifest onto contract v2 without changing the itinerary version", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    const message = store.createUserMessage(trip.id, "安排京都一日游");
    store.applyAgentOutput(trip.id, message, output());
    const first = store.prepareMapManifest(trip.id, 1, []);
    const rebuilt = store.prepareMapManifest(trip.id, 1, [], true);
    expect(rebuilt.mapVersion).toBe(first.mapVersion + 1);
    expect(rebuilt.baseMapVersion).toBe(first.mapVersion);
    expect(store.requireTrip(trip.id).activeRevision?.version).toBe(1);
    store.close();
  });

  it("keeps an overnight lodging as the next day's start in a DayPath", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    const message = store.createUserMessage(trip.id, "安排京都一日游");
    const twoDayOutput = output();
    twoDayOutput.plan!.days.push({ dayNumber: 2, date: "2026-04-11", title: "京都续游", activities: [{ id: "d2-a1", startTime: "10:00", endTime: "12:00", placeName: "金阁寺", activity: "参观", durationMinutes: 120, transportMode: "walk", transportMinutes: 15, costNote: "门票以现场为准" }] });
    store.applyAgentOutput(trip.id, message, twoDayOutput);
    const manifest = store.prepareMapManifest(trip.id, 1, []);
    const base = {
      activityId: null,
      city: "京都",
      detail: "行程地点",
      importance: "primary" as const,
      startTime: "",
      endTime: "",
      durationMinutes: 0,
      transportMode: "walk" as const,
      costNote: "",
      notes: "",
      approximateLodgingArea: false,
    };
    const hotel = {
      ...base,
      id: "hotel",
      dayNumber: 1,
      order: 2,
      kind: "lodging" as const,
      name: "京都住宿",
      query: "京都住宿",
    };
    const first = {
      ...base,
      id: "first",
      dayNumber: 1,
      order: 1,
      kind: "attraction" as const,
      name: "清水寺",
      query: "清水寺",
    };
    const second = {
      ...base,
      id: "second",
      dayNumber: 2,
      order: 2,
      kind: "attraction" as const,
      name: "金阁寺",
      query: "金阁寺",
    };
    const patch = MapAgentOutputSchema.parse({
      schemaVersion: 3,
      baseItineraryVersion: 1,
      baseMapVersion: manifest.baseMapVersion,
      upsertEntities: [first, hotel, second],
      removeEntityIds: [],
      upsertRoutes: [
        {
          id: "r1",
          dayNumber: 1,
          order: 1,
          fromEntityId: "first",
          toEntityId: "hotel",
          mode: "walk",
        },
        {
          id: "r2",
          dayNumber: 2,
          order: 1,
          fromEntityId: "hotel",
          toEntityId: "second",
          mode: "walk",
        },
      ],
      removeRouteIds: [],
      dayPaths: [
        {
          dayNumber: 1,
          entityIds: ["first", "hotel"],
          startEntityId: "first",
          endEntityId: "hotel",
          overnightEntityId: "hotel",
        },
        {
          dayNumber: 2,
          entityIds: ["hotel", "second"],
          startEntityId: "hotel",
          endEntityId: "second",
          overnightEntityId: "second",
        },
      ],
      warnings: [],
    });
    store.applyMapPatch(trip.id, 1, manifest.baseMapVersion, patch);
    const dayTwo = store.getMapSnapshot(trip.id, "day", 2);
    expect(dayTwo?.entities.map((entity) => entity.id)).toEqual([
      "hotel",
      "second",
    ]);
    expect(dayTwo?.dayPaths[0]?.startEntityId).toBe("hotel");
    store.close();
  });

  it("draws flights as direct geometry without road routing", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "travelplanner-test-"));
    folders.push(folder);
    const store = new TravelStore(path.join(folder, "travel.sqlite3"));
    const maps = new MapService(path.join(folder, "cache.sqlite3"), store);
    const geometry = (maps as any).flightGeometry(
      { longitude: 139.7, latitude: 35.6 },
      { longitude: 121.5, latitude: 31.2 },
    );
    expect(geometry).toEqual({
      type: "LineString",
      coordinates: [
        [139.7, 35.6],
        [121.5, 31.2],
      ],
    });
    maps.close();
    store.close();
  });

  it("finishes a map and bridges across unlocated day-path entities", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "travelplanner-test-"));
    folders.push(folder);
    const store = new TravelStore(path.join(folder, "travel.sqlite3"));
    const maps = new MapService(path.join(folder, "cache.sqlite3"), store);
    const trip = store.createTrip();
    store.applyAgentOutput(trip.id, store.createUserMessage(trip.id, "安排京都一日游"), output());
    const manifest = store.prepareMapManifest(trip.id, 1, []);
    const base = { activityId: "d1-a1", dayNumber: 1, kind: "attraction" as const, city: "京都", detail: "地点", importance: "primary" as const, startTime: "", endTime: "", durationMinutes: 0, transportMode: "flight" as const, costNote: "", notes: "", approximateLodgingArea: false };
    const first = { ...base, id: "first", order: 1, name: "第一站", query: "第一站" };
    const missing = { ...base, id: "missing", order: 2, name: "未定位地点", query: "未定位地点" };
    const last = { ...base, id: "last", order: 3, name: "末站", query: "末站" };
    store.applyMapPatch(trip.id, 1, manifest.baseMapVersion, MapAgentOutputSchema.parse({ schemaVersion: 3, baseItineraryVersion: 1, baseMapVersion: manifest.baseMapVersion, upsertEntities: [first, missing, last], removeEntityIds: [], upsertRoutes: [{ id: "r1", dayNumber: 1, order: 1, fromEntityId: "first", toEntityId: "missing", mode: "flight" }, { id: "r2", dayNumber: 1, order: 2, fromEntityId: "missing", toEntityId: "last", mode: "flight" }], removeRouteIds: [], dayPaths: [{ dayNumber: 1, entityIds: ["first", "missing", "last"], startEntityId: "first", endEntityId: "last", overnightEntityId: "last" }], warnings: [] }));
    const candidate = (id: string, longitude: number) => ({ providerPlaceId: id, displayName: id, latitude: 35, longitude, category: "tourism", sourceUrl: "https://example.com", sourceType: "manual" as const, evidenceUrl: null, confidence: "high" as const, decisionNote: null });
    store.selectMapCandidate(trip.id, 1, "first", candidate("first", 135));
    store.updateMapEntity(trip.id, 1, "missing", "unlocated", null, [], "无法定位");
    store.selectMapCandidate(trip.id, 1, "last", candidate("last", 136));
    await maps.resolveRoutes(trip.id, 1, manifest.mapVersion);
    const snapshot = maps.finalize(trip.id, 1, manifest.mapVersion)!;
    expect(snapshot.status).toBe("partial");
    expect(snapshot.summary).toContain("未定位");
    expect(snapshot.routes.find((route) => route.id === "r1")).toMatchObject({ status: "resolved", geometry: { type: "LineString" } });
    expect(snapshot.routes.find((route) => route.id === "r2")).toMatchObject({ status: "resolved", geometry: null });
    maps.close();
    store.close();
  });

  it("splits flights at the correct antimeridian in both shortest directions", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "travelplanner-test-"));
    folders.push(folder);
    const store = new TravelStore(path.join(folder, "travel.sqlite3"));
    const maps = new MapService(path.join(folder, "cache.sqlite3"), store);
    expect(
      (maps as any).flightGeometry(
        { longitude: 170, latitude: 10 },
        { longitude: -170, latitude: 20 },
      ),
    ).toMatchObject({
      type: "MultiLineString",
      coordinates: [
        [
          [170, 10],
          [180, 15],
        ],
        [
          [-180, 15],
          [-170, 20],
        ],
      ],
    });
    expect(
      (maps as any).flightGeometry(
        { longitude: -170, latitude: 10 },
        { longitude: 170, latitude: 20 },
      ),
    ).toMatchObject({
      type: "MultiLineString",
      coordinates: [
        [
          [-170, 10],
          [-180, 15],
        ],
        [
          [180, 15],
          [170, 20],
        ],
      ],
    });
    maps.close();
    store.close();
  });

  it("validates AI candidate selection and coordinate provenance contracts", () => {
    const valid = MapResolutionOutputSchema.parse({
      schemaVersion: 1,
      baseItineraryVersion: 1,
      baseMapVersion: 2,
      selections: [
        {
          entityId: "parliament",
          providerPlaceId: "123",
          decisionNote: "与堪培拉国会区匹配",
        },
      ],
      coordinates: [
        {
          entityId: "lake",
          displayName: "Lake Burley Griffin",
          latitude: -35.29,
          longitude: 149.13,
          sourceType: "ai_web",
          evidenceUrl: "https://example.com/lake",
          confidence: "high",
          decisionNote: "公开资料坐标",
        },
      ],
      unresolved: [],
    });
    expect(valid.coordinates[0].sourceType).toBe("ai_web");
    expect(() =>
      MapResolutionOutputSchema.parse({
        ...valid,
        coordinates: [{ ...valid.coordinates[0], evidenceUrl: null }],
      }),
    ).toThrow("网页坐标必须提供证据链接");
    expect(() =>
      MapResolutionOutputSchema.parse({
        ...valid,
        unresolved: [{ entityId: "lake", reason: "重复" }],
      }),
    ).toThrow("地点决策重复");
  });

  it("applies only whitelisted AI map resolutions and keeps invalid batches atomic", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "travelplanner-test-"));
    folders.push(folder);
    const store = new TravelStore(path.join(folder, "travel.sqlite3"));
    const maps = new MapService(path.join(folder, "cache.sqlite3"), store);
    const trip = store.createTrip();
    const message = store.createUserMessage(trip.id, "安排京都一日游");
    store.applyAgentOutput(trip.id, message, output());
    const manifest = store.prepareMapManifest(trip.id, 1, []);
    const base = {
      activityId: "d1-a1",
      dayNumber: 1,
      kind: "attraction" as const,
      city: "京都",
      detail: "地点",
      importance: "primary" as const,
      startTime: "10:00",
      endTime: "11:00",
      durationMinutes: 60,
      transportMode: "walk" as const,
      costNote: "",
      notes: "",
      approximateLodgingArea: false,
    };
    const first = {
      ...base,
      id: "first",
      order: 1,
      name: "候选地点",
      query: "候选地点 京都",
    };
    const second = {
      ...base,
      id: "second",
      order: 2,
      name: "缺失地点",
      query: "缺失地点 京都",
    };
    const patch = MapAgentOutputSchema.parse({
      schemaVersion: 3,
      baseItineraryVersion: 1,
      baseMapVersion: 0,
      upsertEntities: [first, second],
      removeEntityIds: [],
      upsertRoutes: [],
      removeRouteIds: [],
      dayPaths: [{ dayNumber: 1, entityIds: ["first"], startEntityId: "first", endEntityId: "first", overnightEntityId: "first" }],
      warnings: [],
    });
    store.applyMapPatch(trip.id, 1, manifest.baseMapVersion, patch);
    const candidate = (id: string, latitude: number) => ({
      providerPlaceId: id,
      displayName: id,
      latitude,
      longitude: 135.7,
      category: "tourism",
      sourceUrl: "https://www.openstreetmap.org",
      sourceType: "nominatim" as const,
      evidenceUrl: null,
      confidence: "high" as const,
      decisionNote: null,
    });
    store.updateMapEntity(
      trip.id,
      1,
      "first",
      "ambiguous",
      null,
      [candidate("allowed", 35), candidate("other", 36)],
      null,
    );
    store.updateMapEntity(trip.id, 1, "second", "unresolved", null, [], null);
    const invalid = MapResolutionOutputSchema.parse({
      schemaVersion: 1,
      baseItineraryVersion: 1,
      baseMapVersion: manifest.mapVersion,
      selections: [
        {
          entityId: "first",
          providerPlaceId: "forged",
          decisionNote: "错误候选",
        },
      ],
      coordinates: [
        {
          entityId: "second",
          displayName: "知识坐标",
          latitude: 35.1,
          longitude: 135.8,
          sourceType: "ai_knowledge",
          evidenceUrl: null,
          confidence: "medium",
          decisionNote: "模型知识",
        },
      ],
      unresolved: [],
    });
    await expect(maps.applyResolution(trip.id, 1, manifest.mapVersion, invalid)).rejects.toThrow("候选列表之外");
    expect(
      store.mapEntities(trip.id, 1).find((item) => item.id === "second")
        ?.location,
    ).toBeNull();
    const valid = MapResolutionOutputSchema.parse({
      ...invalid,
      selections: [
        {
          entityId: "first",
          providerPlaceId: "allowed",
          decisionNote: "城市和类型匹配",
        },
      ],
    });
    await maps.applyResolution(trip.id, 1, manifest.mapVersion, valid);
    expect(
      store.mapEntities(trip.id, 1).find((item) => item.id === "first")
        ?.location?.providerPlaceId,
    ).toBe("allowed");
    expect(
      store.mapEntities(trip.id, 1).find((item) => item.id === "second")
        ?.location?.sourceType,
    ).toBe("ai_knowledge");
    maps.close();
    store.close();
  });

  it("keeps public progress history and coalesces streaming segments", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    store.upsertAiTask({
      id: "planner:1",
      tripId: trip.id,
      agent: "planner",
      label: "旅行规划",
      status: "starting",
      summary: "开始",
      canStop: false,
    });
    store.appendAiProgress(
      "planner:1",
      "running",
      "reasoning:item:0",
      "先核对目的地",
    );
    store.appendAiProgress(
      "planner:1",
      "running",
      "reasoning:item:0",
      "再安排每天节奏",
    );
    store.appendAiProgress("planner:1", "completed", "task:completed", "完成");
    const task = store.getAiTask("planner:1");
    expect(task?.events.map((event) => event.summary)).toEqual([
      "再安排每天节奏",
      "完成",
    ]);
    expect(task?.canStop).toBe(false);
    store.close();
  });

  it("persists retry metadata across restarts and keeps waiting tasks stoppable", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "travelplanner-retry-test-")); folders.push(folder);
    const database = path.join(folder, "travel.sqlite3");
    const first = new TravelStore(database); const trip = first.createTrip();
    first.upsertAiTask({ id: "planner:retry", tripId: trip.id, agent: "planner", label: "旅行规划", status: "starting", summary: "开始", canStop: false });
    first.setAiTaskRetry("planner:retry", 2, "2030-01-02T03:04:05.000Z", "ECONNRESET");
    first.appendAiProgress("planner:retry", "waiting", "outline:waiting", "等待第二次重试");
    first.close();

    const reopened = new TravelStore(database);
    expect(reopened.getAiTask("planner:retry")).toMatchObject({
      status: "waiting",
      retryCount: 2,
      nextAttemptAt: "2030-01-02T03:04:05.000Z",
      lastError: "ECONNRESET",
      canStop: true,
    });
    reopened.close();
  });

  it("terminates historical invalid-protocol turns during the v13 migration", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "travelplanner-v12-test-")); folders.push(folder);
    const database = path.join(folder, "travel.sqlite3");
    const original = new TravelStore(database); const trip = original.createTrip(); const messageId = original.createUserMessage(trip.id, "除了岛上全程自驾如何");
    original.updateTurn(messageId, "starting", { error: "Invalid request: unknown variant route outline", progress: "等待服务恢复" });
    original.upsertAiTask({ id: `planner:${messageId}`, tripId: trip.id, agent: "planner", label: "旅行规划", status: "waiting", summary: "等待服务恢复", canStop: true });
    original.close();

    const v12 = new DatabaseSync(database);
    v12.exec("ALTER TABLE ai_tasks DROP COLUMN last_error; ALTER TABLE ai_tasks DROP COLUMN next_attempt_at; ALTER TABLE ai_tasks DROP COLUMN retry_count; PRAGMA user_version = 12;");
    v12.close();

    const migrated = new TravelStore(database);
    expect(migrated.getAiTask(`planner:${messageId}`)).toMatchObject({ status: "failed", canStop: false, retryCount: 0, nextAttemptAt: null });
    expect(migrated.listMessages(trip.id).find((item) => item.id === messageId)?.turn).toMatchObject({ status: "failed", progressMessage: "应用协议错误已修复，请重试原问题" });
    migrated.close();
  });

  it("persists per-day retry state and exposes it through map progress", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    store.applyAgentOutput(trip.id, store.createUserMessage(trip.id, "安排京都一日游"), output());
    store.initializeMapDayRuns(trip.id, 1, [1]);
    store.updateMapDayRun(trip.id, 1, 1, "repairing", { generationRetries: 3, repairRetries: 2, error: "路线不属于每日路径" });
    expect(store.mapDayProgress(trip.id, 1)).toMatchObject([{ dayNumber: 1, status: "repairing", generationRetries: 3, repairRetries: 2, error: "路线不属于每日路径" }]);
    store.updateMapDayRun(trip.id, 1, 1, "failed", { generationRetries: 3, repairRetries: 3, error: "仍未通过合同" });
    expect(store.resetFailedMapDayRuns(trip.id, 1)).toEqual([1]);
    expect(store.mapDayRuns(trip.id, 1).get(1)).toMatchObject({ status: "pending", generationRetries: 0, repairRetries: 0, error: null });
    store.close();
  });

  it("expands a route skeleton immediately and persists daily detail task state", async () => {
    const store = await makeStore(); const trip = store.createTrip(); const messageId = store.createUserMessage(trip.id, "澳大利亚自驾");
    const requirements = { destinations: [{ city: "悉尼", country: "澳大利亚", timezone: "Australia/Sydney" }], dates: { durationDays: 4 }, travelers: { summary: "两位成人" }, budget: {}, pace: "适中", themes: ["自然"], preferences: [], assumptions: [], openQuestions: [] };
    const applied = store.applySkeleton(trip.id, messageId, { requirements, assistantMessage: "先看路线草案", skeleton: { tripName: "澳洲东海岸", timezone: "Australia/Sydney", stops: [{ city: "悉尼", country: "Australia", nights: 2, reason: "城市与海港" }, { city: "卧龙岗", country: "Australia", nights: 1, reason: "海岸自驾" }], legs: [{ fromStop: 0, toStop: 1, mode: "drive", estimatedMinutes: 120, note: "沿海公路", needsVerification: false }], decisions: [], assumptions: [], warnings: [] } });
    expect(store.getRevision(trip.id, applied.version)?.plan.days).toHaveLength(4);
    expect(store.requireTrip(trip.id).planningStage).toBe("outline");
    store.confirmDetailing(trip.id); store.updateDailyTask(trip.id, 1, "repairing", { repairCount: 1, error: "活动时间重叠" });
    expect(store.requireTrip(trip.id).detailProgress).toMatchObject({ total: 4, repairing: 1 });
    const detailed = store.applyDailyDetail(trip.id, { dayNumber: 1, title: "悉尼海港", places: [{ id: "temporary-agent-id", kind: "attraction", nameZh: "悉尼歌剧院", nameEn: "Sydney Opera House", nameLocal: "Sydney Opera House", localLanguage: "en", approximate: false, geocoding: { name: "Sydney Opera House", city: "Sydney", region: "NSW", country: "Australia", countryCode: "au" } }], activities: [{ id: "temporary-activity-id", startTime: "10:00", endTime: "12:00", placeName: "悉尼歌剧院", placeIds: ["temporary-agent-id", "outline-stop-1"], activity: "参观海港建筑并返回悉尼住宿城市", durationMinutes: 120, transportMode: "walk", transportMinutes: 10, costNote: "待核验" }], warnings: [] });
    expect(detailed.version).toBe(applied.version); expect(store.requireTrip(trip.id).activeRevision?.plan.days[0].activities[0].id).not.toBe("temporary-activity-id");
    store.close();
  });

  it("persists route decisions, deferred messages, and rejects stale day baselines", async () => {
    const store = await makeStore(); const trip = store.createTrip(); const messageId = store.createUserMessage(trip.id, "澳大利亚亲子路线");
    const requirements = { destinations: [{ city: "悉尼", country: "澳大利亚" }], dates: { durationDays: 2 }, travelers: { summary: "亲子家庭" }, budget: {}, pace: "适中", themes: [], preferences: [], assumptions: [], openQuestions: [] };
    store.applySkeleton(trip.id, messageId, { requirements, assistantMessage: "路线草案", skeleton: { tripName: "悉尼一日", timezone: "Australia/Sydney", stops: [{ city: "悉尼", country: "Australia", nights: 1, reason: "减少移动" }], legs: [], decisions: [{ id: "child-seat", question: "是否预订儿童座椅？", recommendation: "预订", impact: "影响租车可用性", defaultChoice: "accept" }], assumptions: [], warnings: [] } });
    expect(store.requireTrip(trip.id).decisions).toMatchObject([{ id: "child-seat", status: "pending" }]);
    store.recordRouteDecision(trip.id, "child-seat", "accept"); expect(store.requireTrip(trip.id).decisions[0]).toMatchObject({ status: "accepted", choice: "accept" });
    const deferred = store.createUserMessage(trip.id, "晚一点出发", null, true); expect(store.nextDeferredMessage(trip.id)?.id).toBe(deferred); store.activateDeferredMessage(deferred); expect(store.nextDeferredMessage(trip.id)).toBeNull();
    store.confirmDetailing(trip.id); const task = store.dailyTasks(trip.id)[0]; store.supersedeDetailing(trip.id);
    expect(() => store.applyDailyDetail(trip.id, { dayNumber: 1, title: "旧结果", places: [], activities: [{ id: "old", startTime: "10:00", endTime: "11:00", placeName: "悉尼", placeIds: ["outline-stop-1"], activity: "旧结果", durationMinutes: 60, transportMode: "walk", transportMinutes: 0, costNote: "" }], warnings: [] }, { generation: task.generation, baselineVersion: task.baselineVersion })).toThrow("DETAIL_BASELINE_SUPERSEDED");
    store.close();
  });
});
