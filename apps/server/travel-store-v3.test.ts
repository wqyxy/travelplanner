import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { TravelStoreV3 } from "./travel-store-v3.js";
import { TravelPlanDocumentSchema } from "./contracts-v2.js";
import type { AiActionRecord } from "./ai-stage-contracts-v3.js";

type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
const roots: string[] = [];

function databasePath() {
  const root = mkdtempSync(path.join(tmpdir(), "travel-store-v3-"));
  roots.push(root);
  return path.join(root, "travel-v2.sqlite3");
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function dialogueParameters() {
  return {
    request: "把节奏改轻松一点",
    candidateId: null,
    candidateIds: [],
    preference: null,
    dayId: null,
    dayIds: [],
    stopId: null,
    targetDayId: null,
    targetIndex: null,
    index: null,
    anchor: null,
    placeId: null,
    label: null,
    notes: null,
    activity: null,
    fields: [],
    changes: { pace: "relaxed" },
    placeChanges: null,
    candidateChanges: null,
    allowWeb: null,
  };
}

function pendingAction(tripId: string, sourceMessageId: string, generation: number): AiActionRecord {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(), tripId, stage: "requirements", actionType: "requirements.update", executor: "deterministic", origin: "conversation", sourceMessageId,
    parameters: dialogueParameters(), targetIds: [], scope: { type: "trip", id: null }, baseGeneration: generation, status: "pending_confirmation",
    taskId: null, proposalId: null, resultRef: null, startedAt: null, updatedAt: timestamp, completedAt: null, errorSummary: null,
  };
}

describe("TravelStoreV3", () => {
  it("creates only a fresh complete v3 database", () => {
    const filename = databasePath();
    const store = new TravelStoreV3(filename);
    const trip = store.createTrip();
    expect(trip.plan.schemaVersion).toBe(2);
    store.close();
    const db = new DatabaseSync(filename);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    const messageColumns = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(messageColumns).toContain("stage");
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toContain("stage_conversation_threads");
    expect(tables).toContain("ai_actions");
    db.close();
  });

  it("fails closed on v2 or unknown databases without migrating them", () => {
    const filename = databasePath();
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE trips(id TEXT PRIMARY KEY); PRAGMA user_version=2;");
    db.close();
    expect(() => new TravelStoreV3(filename)).toThrow(/不会自动迁移/);
    const check = new DatabaseSync(filename);
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    check.close();
  });

  it("isolates messages by stage and rejects concurrent turns in the same stage", () => {
    const store = new TravelStoreV3(databasePath());
    const trip = store.createTrip();
    const first = store.createUserMessage(trip.id, "requirements", "新西兰 20 天自驾");
    expect(() => store.createUserMessage(trip.id, "requirements", "预算宽松")).toThrow("STAGE_TURN_BUSY");
    const destinations = store.createUserMessage(trip.id, "destinations", "目的地怎么选？");
    expect(destinations).not.toBe(first);
    store.updateTurn(first, "completed");
    store.createAssistantMessage(trip.id, "requirements", "已记录需求。", { type: "reply" });
    expect(store.listMessages(trip.id, "requirements")).toHaveLength(2);
    expect(store.listMessages(trip.id, "destinations")).toHaveLength(1);
    store.close();
  });

  it("stores and rotates stage thread metadata independently", () => {
    const store = new TravelStoreV3(databasePath());
    const trip = store.createTrip();
    const saved = store.setStageThread({ tripId: trip.id, stage: "requirements", threadId: "thread-1", promptHash: "hash-1", promptVersion: "v1", contextGeneration: 0, turnCount: 0 });
    expect(saved.turnCount).toBe(0);
    expect(store.incrementStageThreadTurn(trip.id, "requirements", "thread-1", 0).turnCount).toBe(1);
    expect(() => store.incrementStageThreadTurn(trip.id, "requirements", "stale-thread", 0)).toThrow("STAGE_THREAD_SUPERSEDED");
    expect(store.getStageThread(trip.id, "destinations")).toBeNull();
    store.close();
  });

  it("claims a conversation Action atomically and only once", () => {
    const store = new TravelStoreV3(databasePath());
    const trip = store.createTrip();
    const messageId = store.createUserMessage(trip.id, "requirements", "节奏改轻松");
    store.updateTurn(messageId, "completed");
    const created = store.createAction(pendingAction(trip.id, messageId, 0), "request-1");
    expect(created.created).toBe(true);
    expect(created.action.parameters).toEqual({ changes: { pace: "relaxed" } });
    expect(store.createAction(pendingAction(trip.id, messageId, 0), "request-1").created).toBe(false);
    expect(store.claimActionForExecution(created.action.id, 0).claimed).toBe(true);
    expect(store.claimActionForExecution(created.action.id, 0).claimed).toBe(false);
    expect(store.getAction(created.action.id)?.status).toBe("executing");
    store.close();
  });

  it("rejects unregistered free-form Action parameters before persistence", () => {
    const store = new TravelStoreV3(databasePath());
    const trip = store.createTrip();
    const timestamp = new Date().toISOString();
    expect(() => store.createAction({
      id: randomUUID(), tripId: trip.id, stage: "requirements", actionType: "requirements.update", executor: "deterministic", origin: "cta", sourceMessageId: null,
      parameters: { totallyUnknownField: "accepted" }, targetIds: [], scope: { type: "trip", id: null }, baseGeneration: 0, status: "pending_confirmation",
      taskId: null, proposalId: null, resultRef: null, startedAt: null, updatedAt: timestamp, completedAt: null, errorSummary: null,
    })).toThrow();
    expect(store.listActions(trip.id)).toHaveLength(0);
    expect(store.requireTrip(trip.id).contentGeneration).toBe(0);
    store.close();
  });

  it("supersedes a candidate-scope Proposal when its linked Place changes", () => {
    const store = new TravelStoreV3(databasePath());
    const created = store.createTrip();
    const plan = TravelPlanDocumentSchema.parse({
      ...created.plan,
      places: [{ id: "place-1", nameZh: "原地点", nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: false }],
      candidates: [{ id: "candidate-1", placeId: "place-1", planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 60, tags: [] }],
    });
    store.writePlan(created.id, plan, 0, { source: "test", summary: "fixture" });
    const timestamp = new Date().toISOString();
    store.createProposal({
      id: "proposal-linked-place", tripId: created.id, baseGeneration: 1, scope: { type: "candidate", id: "candidate-1" }, status: "pending", title: "修改地点", explanation: "测试关联冲突",
      commands: [{ type: "update_place", placeId: "place-1", changes: { nameZh: "AI 新名称" } }],
      diff: { summary: "修改地点", commandSummaries: ["修改地点"], affectedCandidateIds: [], affectedPlaceIds: ["place-1"], affectedDayIds: [] },
      createdAt: timestamp, updatedAt: timestamp, appliedRevisionVersion: null,
    });
    const concurrent = structuredClone(store.requireTrip(created.id).plan);
    concurrent.places[0].nameZh = "用户先改的新名称";
    store.writePlan(created.id, concurrent, 1, { source: "test", summary: "concurrent place edit" });
    expect(store.getProposal("proposal-linked-place")?.status).toBe("superseded");
    expect(store.getProposal("proposal-linked-place")?.baseGeneration).toBe(1);
    store.close();
  });

  it("atomically writes a Google Maps place edit with its current resolution", () => {
    const store = new TravelStoreV3(databasePath());
    const created = store.createTrip();
    const original = TravelPlanDocumentSchema.parse({ ...created.plan, places: [{ id: "place-1", nameZh: "旧地点", nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: false }], candidates: [{ id: "candidate-1", placeId: "place-1", planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 60, tags: [] }] });
    store.writePlan(created.id, original, 0, { source: "test", summary: "fixture" });
    const changed = structuredClone(original); changed.places[0].nameZh = "新地点";
    const saved = store.writePlanAndPlaceResolution(created.id, changed, { tripId: created.id, placeId: "place-1", geoFingerprint: "v2|新地点", status: "resolved", method: "google_maps_link", provider: null, providerPlaceId: null, latitude: 35, longitude: 135, address: "测试地址", confidence: null, resolvedAt: new Date().toISOString(), errorMessage: null }, 1, { source: "google_maps_link", summary: "测试导入" });
    expect(saved.generation).toBe(2);
    expect(store.requireTrip(created.id).plan.places[0].nameZh).toBe("新地点");
    expect(store.getPlaceResolution(created.id, "place-1")).toMatchObject({ method: "google_maps_link", latitude: 35, longitude: 135 });
    store.close();
  });

  it("duplicates only canonical plan and leaves conversations, threads, tasks and actions behind", () => {
    const store = new TravelStoreV3(databasePath());
    const trip = store.createTrip();
    const messageId = store.createUserMessage(trip.id, "requirements", "两大一小");
    store.updateTurn(messageId, "completed");
    store.setStageThread({ tripId: trip.id, stage: "requirements", threadId: "thread-1", promptHash: "hash", promptVersion: "v1", contextGeneration: 0, turnCount: 1 });
    store.createAction(pendingAction(trip.id, messageId, 0));
    store.upsertAiTask({ id: "dialogue:test", tripId: trip.id, agent: "dialogue", label: "测试", status: "completed", summary: "完成", canStop: false });
    const copy = store.duplicate(trip.id);
    expect(store.listMessages(copy.id)).toHaveLength(0);
    expect(store.listActions(copy.id)).toHaveLength(0);
    expect(store.listAiTasks(copy.id)).toHaveLength(0);
    expect(store.getStageThread(copy.id, "requirements")).toBeNull();
    store.close();
  });
});
