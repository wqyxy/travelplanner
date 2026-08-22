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

  it("migrates an existing map database from v2 to the v2 map contract marker", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "travelplanner-test-"));
    folders.push(folder);
    const filename = path.join(folder, "travel.sqlite3");
    const database = new DatabaseSync(filename);
    database.exec(
      "CREATE TABLE map_manifests(trip_id TEXT NOT NULL,itinerary_version INTEGER NOT NULL,map_version INTEGER NOT NULL,base_map_version INTEGER NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL,warnings_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(trip_id,itinerary_version),UNIQUE(trip_id,map_version)); PRAGMA user_version=2;",
    );
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
    ).toBe(4);
    expect(
      migrated
        .prepare("PRAGMA table_info(map_manifests)")
        .all()
        .some(
          (column) =>
            String((column as { name: string }).name) === "contract_version",
        ),
    ).toBe(true);
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
    expect(() =>
      maps.applyResolution(trip.id, 1, manifest.mapVersion, invalid),
    ).toThrow("候选列表之外");
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
    maps.applyResolution(trip.id, 1, manifest.mapVersion, valid);
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
});
