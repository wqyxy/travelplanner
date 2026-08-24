import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { emptyItinerary } from "./contracts.js";
import { TravelStore } from "./travel-store.js";

const paths: string[] = [];
async function open() { const dir = await mkdtemp(path.join(os.tmpdir(), "travel-itinerary-v1-")); paths.push(dir); return new TravelStore(path.join(dir, "travel.sqlite3")); }
afterEach(async () => { await Promise.all(paths.splice(0).map((target) => rm(target, { recursive: true, force: true }))); });

describe("TravelStore itinerary:v1", () => {
  it("creates planning itinerary as the only active travel fact", async () => { const store = await open(); const trip = store.createTrip(); expect(trip.itinerary).toEqual(emptyItinerary()); expect(trip.contentGeneration).toBe(0); store.close(); });
  it("atomically applies canonical writes and rejects stale generations", async () => { const store = await open(); const trip = store.createTrip(); const first = store.writeItinerary(trip.id, { ...trip.itinerary, trip: { ...trip.itinerary.trip, title: "京都周末" } }, 0, { revision: { source: "draft", summary: "首次初稿" } }); expect(first.generation).toBe(1); expect(first.trip.title).toBe("京都周末"); expect(store.listRevisions(trip.id)).toHaveLength(1); expect(() => store.writeItinerary(trip.id, trip.itinerary, 0)).toThrow("CONTENT_GENERATION_SUPERSEDED"); expect(store.requireTrip(trip.id).contentGeneration).toBe(1); store.close(); });
  it("restores a snapshot as a new current generation and revision", async () => { const store = await open(); const trip = store.createTrip(); store.writeItinerary(trip.id, { ...trip.itinerary, trip: { ...trip.itinerary.trip, title: "v1" } }, 0, { revision: { source: "draft", summary: "v1" } }); const current = store.requireTrip(trip.id); store.writeItinerary(trip.id, { ...current.itinerary, trip: { ...current.itinerary.trip, title: "v2" } }, current.contentGeneration, { revision: { source: "mutation", summary: "v2" } }); const restored = store.restoreRevision(trip.id, 1); expect(restored.trip.itinerary.trip.title).toBe("v1"); expect(restored.generation).toBe(3); expect(store.listRevisions(trip.id)).toHaveLength(3); store.close(); });
  it("rejects a non-itinerary database shape without migration", async () => { const dir = await mkdtemp(path.join(os.tmpdir(), "travel-unknown-schema-")); paths.push(dir); const filename = path.join(dir, "travel.sqlite3"); const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite"); const db = new DatabaseSync(filename); db.exec("CREATE TABLE trips(id TEXT PRIMARY KEY); PRAGMA user_version = 1;"); db.close(); expect(() => new TravelStore(filename)).toThrow("不是 itinerary:v1 数据库"); });

  it("does not initialize a non-empty version-zero database", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "travel-unknown-v0-")); paths.push(dir);
    const filename = path.join(dir, "travel.sqlite3");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(filename); db.exec("CREATE TABLE unrelated(value TEXT);"); db.close();
    expect(() => new TravelStore(filename)).toThrow("不是 itinerary:v1 数据库");
    const check = new DatabaseSync(filename);
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    expect(check.prepare("SELECT name FROM sqlite_schema WHERE name='unrelated'").get()).toBeTruthy();
    check.close();
  });

  it("rejects an unknown newer database version", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "travel-unknown-version-")); paths.push(dir);
    const filename = path.join(dir, "travel.sqlite3");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(filename); db.exec("PRAGMA user_version = 2;"); db.close();
    expect(() => new TravelStore(filename)).toThrow("不是 itinerary:v1 数据库");
  });

  it("treats trips.title only as a checked projection of the canonical itinerary", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "travel-title-projection-")); paths.push(dir);
    const filename = path.join(dir, "travel.sqlite3");
    const store = new TravelStore(filename); const trip = store.createTrip();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(filename); db.prepare("UPDATE trips SET title=? WHERE id=?").run("错误索引", trip.id); db.close();
    expect(() => store.requireTrip(trip.id)).toThrow("标题索引与 canonical itinerary 不一致");
    store.close();
  });

  it("persists messages, generic AI task progress and generation-bound map state", async () => {
    const store = await open(); const trip = store.createTrip();
    const userMessageId = store.createUserMessage(trip.id, "规划京都行程");
    store.updateTurn(userMessageId, "active", { progress: "正在规划", codexTurnId: "turn-1" });
    store.createAssistantMessage(trip.id, "请确认日期", { nextAction: "none" });
    expect(store.listMessages(trip.id).map((message) => message.role)).toEqual(["user", "assistant"]);
    store.upsertAiTask({ id: "task-1", tripId: trip.id, agent: "planner", label: "规划", status: "running", summary: "正在规划", canStop: true, metadata: { completedDayIds: [] } });
    expect(store.setAiTaskMetadata("task-1", { completedDayIds: ["day-1"] })?.metadata).toEqual({ completedDayIds: ["day-1"] });
    expect(store.stopInterruptedAiRuns()).toBe(1); expect(store.getAiTask("task-1")?.status).toBe("stopped"); expect(store.listMessages(trip.id)[0].turn?.status).toBe("interrupted");
    const completed = store.appendAiProgress("task-1", "completed", "result", "规划完成");
    expect(completed?.status).toBe("completed"); expect(completed?.canStop).toBe(false); expect(completed?.events).toHaveLength(2);
    const savedMap = store.setMapState(trip.id, { generation: 0, resolvedPlaces: [], map: { visits: [], edges: [] }, status: "ready", warnings: [] }, 0);
    expect(store.getMapState(trip.id)).toEqual(savedMap);
    const updated = store.writeItinerary(trip.id, { ...trip.itinerary, trip: { ...trip.itinerary.trip, title: "京都" } }, 0);
    expect(() => store.setMapState(trip.id, { generation: 0, resolvedPlaces: [], map: null, status: "ready", warnings: [] }, updated.generation)).toThrow("CONTENT_GENERATION_SUPERSEDED");
    store.permanentDelete(trip.id);
    expect(store.getTrip(trip.id)).toBeNull(); expect(store.listMessages(trip.id)).toEqual([]); expect(store.listAiTasks(trip.id)).toEqual([]); expect(store.getMapState(trip.id)).toBeNull();
    store.close();
  });
});
