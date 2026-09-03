import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  AiProposalSchema,
  DayRouteSchema,
  PlaceResolutionSchema,
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type AiProposal,
  type DayRoute,
  type PlaceResolution,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import {
  AiActionRecordSchema,
  ConversationStageSchema,
  StageThreadRecordSchema,
  type AiActionRecord,
  type AiTaskAgentV3,
  type ConversationStage,
  type StageThreadRecord,
} from "./ai-stage-contracts-v3.js";
import { actionRegistration } from "./ai-registries-v3.js";
import { parseActionParametersV3 } from "./ai-action-input-contracts-v3.js";
import { normalizeRequirementsCtaParametersV3 } from "./requirements-duration-v3.js";

type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;

export const TRAVEL_DATABASE_VERSION_V3 = 3;
export const STAGE_THREAD_MAX_TURNS = 40;
const DATABASE_ERROR = "旅行数据库不是空数据库或完整 TravelPlanner v3 数据库；已停止读写。v2、未知版本和损坏 Schema 均不会自动迁移、删除或重建。";
const EXPECTED_COLUMNS_V3 = {
  trips: ["id", "state", "current_plan_json", "title", "content_generation", "plan_language", "created_at", "updated_at"],
  plan_revisions: ["trip_id", "version", "plan_json", "source", "summary", "created_at"],
  messages: ["id", "trip_id", "stage", "role", "content", "reply_json", "status", "turn_status", "cancel_requested", "progress_message", "error_message", "codex_turn_id", "created_at"],
  stage_conversation_threads: ["trip_id", "stage", "thread_id", "prompt_hash", "prompt_version", "context_generation", "turn_count", "created_at", "updated_at"],
  ai_actions: ["id", "trip_id", "stage", "action_type", "executor", "origin", "source_message_id", "request_key", "parameters_json", "target_ids_json", "scope_json", "base_generation", "status", "task_id", "proposal_id", "result_ref", "started_at", "updated_at", "completed_at", "error_summary"],
  ai_tasks: ["id", "trip_id", "agent", "label", "status", "summary", "metadata_json", "started_at", "updated_at", "can_stop", "retry_count", "next_attempt_at", "last_error"],
  ai_progress_events: ["id", "task_id", "trip_id", "agent", "status", "kind", "summary", "created_at"],
  place_resolutions: ["trip_id", "place_id", "resolution_json", "updated_at"],
  day_routes: ["trip_id", "day_id", "version", "route_json", "updated_at"],
  ai_proposals: ["id", "trip_id", "base_generation", "status", "proposal_json", "applied_revision_version", "created_at", "updated_at"],
} as const;

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const stringify = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === "string" ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
};

const parseTravelPlanJson = (value: unknown) => TravelPlanDocumentSchema.parse(parse(value, null));
const parseProposalJson = (value: unknown) => AiProposalSchema.parse(parse(value, null));

export type TripStateV3 = "active" | "trashed";
export type PlanLanguageV3 = "zh" | "en" | "bilingual";
export type TripSummaryV3 = {
  id: string;
  title: string;
  state: TripStateV3;
  updatedAt: string;
  planLanguage: PlanLanguageV3;
  contentGeneration: number;
  plan: TravelPlanDocument;
};
export type TripDetailV3 = TripSummaryV3;
export type PlanRevisionSummaryV3 = { version: number; createdAt: string; source: string; summary: string };
export type TurnStatusV3 = "queued" | "starting" | "active" | "completed" | "failed" | "interrupted";
export type ChatMessageV3 = {
  id: string;
  stage: ConversationStage;
  role: "user" | "assistant";
  content: string;
  reply: unknown | null;
  status: "pending" | "completed" | "failed";
  turn: {
    status: TurnStatusV3;
    cancelRequested: boolean;
    errorMessage: string | null;
    progressMessage: string | null;
    codexTurnId: string | null;
  } | null;
  createdAt: string;
};
export type AiTaskStatusV3 = "starting" | "running" | "waiting" | "reconnecting" | "completed" | "failed" | "stopped" | "cancelled_by_generation";
export type AiProgressEventV3 = { id: number; taskId: string; tripId: string; agent: AiTaskAgentV3; status: AiTaskStatusV3; kind: string; summary: string; createdAt: string };
export type AiTaskSnapshotV3 = { id: string; tripId: string; agent: AiTaskAgentV3; label: string; status: AiTaskStatusV3; summary: string; startedAt: string; updatedAt: string; canStop: boolean; retryCount: number; nextAttemptAt: string | null; lastError: string | null; metadata: Record<string, unknown>; events: AiProgressEventV3[] };

type RevisionInput = { source: string; summary: string };
type WriteOptions = { keepPendingProposalId?: string; keepActionId?: string };
type WriteWithinTransactionResult = { generation: number; version: number; updatedAt: string };
type CanonicalChanges = { trip: boolean; candidateIds: Set<string>; placeIds: Set<string>; dayIds: Set<string> };

function changedIds<T extends { id: string }>(before: T[], after: T[]) {
  const left = new Map(before.map((item) => [item.id, item]));
  const right = new Map(after.map((item) => [item.id, item]));
  const ids = new Set([...left.keys(), ...right.keys()]);
  return new Set([...ids].filter((id) => stringify(left.get(id) ?? null) !== stringify(right.get(id) ?? null)));
}

function canonicalChanges(before: TravelPlanDocument, after: TravelPlanDocument): CanonicalChanges {
  return {
    trip: stringify(before.trip) !== stringify(after.trip),
    candidateIds: changedIds(before.candidates, after.candidates),
    placeIds: changedIds(before.places, after.places),
    dayIds: changedIds(before.days, after.days),
  };
}

function scopeConflicts(scope: unknown, changes: CanonicalChanges, before: TravelPlanDocument) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return true;
  const value = scope as Record<string, unknown>;
  const type = String(value.type ?? "");
  const id = typeof value.id === "string" ? value.id : null;
  if (type === "trip") return changes.trip || changes.candidateIds.size > 0 || changes.placeIds.size > 0 || changes.dayIds.size > 0;
  if (type === "candidate_pool") return changes.candidateIds.size > 0 || changes.placeIds.size > 0;
  if (type === "candidate") {
    if (!id) return true;
    const candidate = before.candidates.find((item) => item.id === id);
    return changes.candidateIds.has(id) || Boolean(candidate && changes.placeIds.has(candidate.placeId));
  }
  if (type === "place") {
    if (!id) return true;
    const linkedCandidateIds = before.candidates.filter((candidate) => candidate.placeId === id).map((candidate) => candidate.id);
    return changes.placeIds.has(id) || linkedCandidateIds.some((candidateId) => changes.candidateIds.has(candidateId));
  }
  if (type === "day") {
    if (!id) return true;
    const day = before.days.find((item) => item.id === id);
    if (!day) return true;
    const placeIds = new Set([day.startAnchor.placeId, day.endAnchor.placeId, ...day.stops.map((stop) => stop.placeId)].filter((placeId): placeId is string => Boolean(placeId)));
    const candidateIds = new Set(day.stops.map((stop) => stop.candidateId).filter((candidateId): candidateId is string => Boolean(candidateId)));
    return changes.dayIds.has(id) || [...placeIds].some((placeId) => changes.placeIds.has(placeId)) || [...candidateIds].some((candidateId) => changes.candidateIds.has(candidateId));
  }
  return true;
}

export class TravelStoreV3 {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    try {
      this.initialize();
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  private initialize() {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version === 0) {
      const objects = this.db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as Row[];
      if (objects.length) throw new Error(DATABASE_ERROR);
      this.createSchema();
    }
    const current = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (current !== TRAVEL_DATABASE_VERSION_V3 || !this.hasExpectedSchema()) throw new Error(DATABASE_ERROR);
  }

  private createSchema() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE trips (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK(state IN ('active','trashed')),
          current_plan_json TEXT NOT NULL,
          title TEXT NOT NULL,
          content_generation INTEGER NOT NULL,
          plan_language TEXT NOT NULL DEFAULT 'bilingual' CHECK(plan_language IN ('zh','en','bilingual')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE plan_revisions (
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          plan_json TEXT NOT NULL,
          source TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(trip_id, version)
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          stage TEXT NOT NULL CHECK(stage IN ('requirements','destinations','interests','itinerary')),
          role TEXT NOT NULL CHECK(role IN ('user','assistant')),
          content TEXT NOT NULL,
          reply_json TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
          turn_status TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          progress_message TEXT,
          error_message TEXT,
          codex_turn_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX messages_trip_stage_created ON messages(trip_id,stage,created_at);
        CREATE TABLE stage_conversation_threads (
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          stage TEXT NOT NULL CHECK(stage IN ('requirements','destinations','interests','itinerary')),
          thread_id TEXT NOT NULL,
          prompt_hash TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          context_generation INTEGER NOT NULL,
          turn_count INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(trip_id,stage)
        );
        CREATE TABLE ai_tasks (
          id TEXT PRIMARY KEY,
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          agent TEXT NOT NULL CHECK(agent IN ('dialogue','action','map')),
          label TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('starting','running','waiting','reconnecting','completed','failed','stopped','cancelled_by_generation')),
          summary TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          can_stop INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT
        );
        CREATE TABLE ai_progress_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          agent TEXT NOT NULL CHECK(agent IN ('dialogue','action','map')),
          status TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX ai_progress_trip_created ON ai_progress_events(trip_id,created_at);
        CREATE TABLE place_resolutions (
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          place_id TEXT NOT NULL,
          resolution_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(trip_id,place_id)
        );
        CREATE TABLE day_routes (
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          day_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          route_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(trip_id,day_id)
        );
        CREATE TABLE ai_proposals (
          id TEXT PRIMARY KEY,
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          base_generation INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','applied','rejected','superseded','undone')),
          proposal_json TEXT NOT NULL,
          applied_revision_version INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX ai_proposals_trip_updated ON ai_proposals(trip_id,updated_at DESC);
        CREATE TABLE ai_actions (
          id TEXT PRIMARY KEY,
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          stage TEXT NOT NULL CHECK(stage IN ('requirements','destinations','interests','itinerary')),
          action_type TEXT NOT NULL,
          executor TEXT NOT NULL CHECK(executor IN ('ai','deterministic')),
          origin TEXT NOT NULL CHECK(origin IN ('conversation','cta')),
          source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
          request_key TEXT,
          parameters_json TEXT NOT NULL,
          target_ids_json TEXT NOT NULL,
          scope_json TEXT NOT NULL,
          base_generation INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending_confirmation','executing','awaiting_apply','completed','failed','cancelled','superseded','applied','rejected')),
          task_id TEXT,
          proposal_id TEXT,
          result_ref TEXT,
          started_at TEXT,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          error_summary TEXT,
          UNIQUE(trip_id,request_key)
        );
        CREATE INDEX ai_actions_trip_stage_updated ON ai_actions(trip_id,stage,updated_at DESC);
        PRAGMA user_version = 3;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve original error. */ }
      throw error;
    }
  }

  private hasExpectedSchema() {
    const tables = (this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map((row) => String(row.name));
    const expectedTables = Object.keys(EXPECTED_COLUMNS_V3).sort();
    if (tables.length !== expectedTables.length || tables.some((name, index) => name !== expectedTables[index])) return false;
    return expectedTables.every((table) => {
      const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name));
      const expected = EXPECTED_COLUMNS_V3[table as keyof typeof EXPECTED_COLUMNS_V3];
      return columns.length === expected.length && columns.every((name, index) => name === expected[index]);
    });
  }

  private rowToTrip(row: Row): TripSummaryV3 {
    const plan = parseTravelPlanJson(row.current_plan_json);
    if (String(row.title) !== plan.trip.title) throw new Error("旅行标题索引与 canonical plan 不一致；已停止读取损坏状态。");
    const planLanguage: PlanLanguageV3 = row.plan_language === "zh" || row.plan_language === "en" || row.plan_language === "bilingual" ? row.plan_language : "bilingual";
    return { id: String(row.id), title: plan.trip.title, state: String(row.state) as TripStateV3, updatedAt: String(row.updated_at), planLanguage, contentGeneration: Number(row.content_generation), plan };
  }

  listTrips(state: TripStateV3 = "active") {
    return (this.db.prepare("SELECT * FROM trips WHERE state=? ORDER BY updated_at DESC").all(state) as Row[]).map((row) => this.rowToTrip(row));
  }

  createTrip() {
    const id = randomUUID();
    const createdAt = now();
    const plan = emptyTravelPlan();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO trips(id,state,current_plan_json,title,content_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, "active", stringify(plan), plan.trip.title, 0, createdAt, createdAt);
      this.insertRevision(id, plan, "create", "创建旅行", createdAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.requireTrip(id);
  }

  getTrip(id: string): TripDetailV3 | null {
    const row = this.db.prepare("SELECT * FROM trips WHERE id=?").get(id) as Row | undefined;
    return row ? this.rowToTrip(row) : null;
  }

  requireTrip(id: string) {
    const trip = this.getTrip(id);
    if (!trip) throw new Error("找不到这趟旅行。");
    return trip;
  }

  setState(id: string, state: TripStateV3) { this.db.prepare("UPDATE trips SET state=?,updated_at=? WHERE id=?").run(state, now(), id); return this.requireTrip(id); }
  permanentDelete(id: string) { this.db.prepare("DELETE FROM trips WHERE id=?").run(id); }
  setPlanLanguage(id: string, language: PlanLanguageV3) { this.db.prepare("UPDATE trips SET plan_language=?,updated_at=? WHERE id=?").run(language, now(), id); return this.requireTrip(id); }

  private cleanupDerivedState(tripId: string, plan: TravelPlanDocument) {
    const placeIds = new Set(plan.places.map((place) => place.id));
    for (const row of this.db.prepare("SELECT place_id FROM place_resolutions WHERE trip_id=?").all(tripId) as Row[]) if (!placeIds.has(String(row.place_id))) this.db.prepare("DELETE FROM place_resolutions WHERE trip_id=? AND place_id=?").run(tripId, String(row.place_id));
    const dayIds = new Set(plan.days.map((day) => day.id));
    for (const row of this.db.prepare("SELECT day_id FROM day_routes WHERE trip_id=?").all(tripId) as Row[]) {
      const routeDayId = String(row.day_id);
      const canonicalDayId = routeDayId.startsWith("macro:") ? routeDayId.slice("macro:".length) : routeDayId;
      if (!dayIds.has(canonicalDayId)) this.db.prepare("DELETE FROM day_routes WHERE trip_id=? AND day_id=?").run(tripId, routeDayId);
    }
  }

  private reconcilePendingState(tripId: string, before: TravelPlanDocument, after: TravelPlanDocument, oldGeneration: number, newGeneration: number, options: WriteOptions) {
    const changes = canonicalChanges(before, after);
    const timestamp = now();
    for (const row of this.db.prepare("SELECT * FROM ai_proposals WHERE trip_id=? AND status='pending' AND base_generation=?").all(tripId, oldGeneration) as Row[]) {
      if (String(row.id) === options.keepPendingProposalId) continue;
      const proposal = this.rowToProposal(row);
      if (scopeConflicts(proposal.scope, changes, before)) {
        const superseded = AiProposalSchema.parse({ ...proposal, status: "superseded", updatedAt: timestamp });
        this.updateProposalRow(superseded);
      } else {
        const rebased = AiProposalSchema.parse({ ...proposal, baseGeneration: newGeneration, updatedAt: timestamp });
        this.db.prepare("UPDATE ai_proposals SET base_generation=?,proposal_json=?,updated_at=? WHERE id=?").run(newGeneration, stringify(rebased), timestamp, proposal.id);
      }
    }
    for (const row of this.db.prepare("SELECT * FROM ai_actions WHERE trip_id=? AND base_generation=? AND status IN ('pending_confirmation','executing','awaiting_apply')").all(tripId, oldGeneration) as Row[]) {
      if (String(row.id) === options.keepActionId) continue;
      const action = this.rowToAction(row);
      if (scopeConflicts(action.scope, changes, before)) {
        this.db.prepare("UPDATE ai_actions SET status='superseded',updated_at=?,completed_at=?,error_summary=? WHERE id=?").run(timestamp, timestamp, "计划已发生冲突修改。", action.id);
      } else {
        this.db.prepare("UPDATE ai_actions SET base_generation=?,updated_at=? WHERE id=?").run(newGeneration, timestamp, action.id);
      }
    }
  }

  private writePlanWithinTransaction(id: string, plan: TravelPlanDocument, expectedGeneration: number, revision: RevisionInput, options: WriteOptions = {}): WriteWithinTransactionResult {
    const row = this.db.prepare("SELECT content_generation,current_plan_json FROM trips WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("找不到这趟旅行。");
    if (Number(row.content_generation) !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const before = parseTravelPlanJson(row.current_plan_json);
    const generation = expectedGeneration + 1;
    const updatedAt = now();
    this.db.prepare("UPDATE trips SET current_plan_json=?,title=?,content_generation=?,updated_at=? WHERE id=?").run(stringify(plan), plan.trip.title, generation, updatedAt, id);
    const version = this.insertRevision(id, plan, revision.source, revision.summary, updatedAt);
    this.cleanupDerivedState(id, plan);
    this.reconcilePendingState(id, before, plan, expectedGeneration, generation, options);
    return { generation, version, updatedAt };
  }

  writePlan(id: string, value: unknown, expectedGeneration: number, revision: RevisionInput = { source: "edit", summary: "更新旅行计划" }, options: WriteOptions = {}) {
    const plan = TravelPlanDocumentSchema.parse(value);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.writePlanWithinTransaction(id, plan, expectedGeneration, revision, options);
      const trip = this.requireTrip(id);
      this.db.exec("COMMIT");
      return { trip, ...result };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  writePlanAndPlaceResolution(id: string, value: unknown, resolutionValue: unknown, expectedGeneration: number, revision: RevisionInput) {
    const plan = TravelPlanDocumentSchema.parse(value);
    const resolution = PlaceResolutionSchema.parse(resolutionValue);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.writePlanWithinTransaction(id, plan, expectedGeneration, revision);
      if (resolution.tripId !== id || !plan.places.some((place) => place.id === resolution.placeId)) throw new Error("PlaceResolution 必须引用当前旅行中的 Place。");
      this.db.prepare("INSERT INTO place_resolutions(trip_id,place_id,resolution_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(trip_id,place_id) DO UPDATE SET resolution_json=excluded.resolution_json,updated_at=excluded.updated_at").run(id, resolution.placeId, stringify(resolution), now());
      const trip = this.requireTrip(id);
      this.db.exec("COMMIT");
      return { trip, resolution, ...result };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  rename(id: string, title: string) {
    const trip = this.requireTrip(id);
    const value = title.trim().slice(0, 200);
    if (!value) throw new Error("旅行名称不能为空。");
    return this.writePlan(id, { ...trip.plan, trip: { ...trip.plan.trip, title: value } }, trip.contentGeneration, { source: "rename", summary: "重命名旅行" }).trip;
  }

  duplicate(id: string) {
    const original = this.requireTrip(id);
    const copyId = randomUUID();
    const createdAt = now();
    const plan = TravelPlanDocumentSchema.parse({ ...structuredClone(original.plan), trip: { ...original.plan.trip, title: `${original.plan.trip.title} 副本`.slice(0, 200) } });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO trips(id,state,current_plan_json,title,content_generation,plan_language,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(copyId, "active", stringify(plan), plan.trip.title, 0, original.planLanguage, createdAt, createdAt);
      this.insertRevision(copyId, plan, "duplicate", "复制旅行", createdAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.requireTrip(copyId);
  }

  private insertRevision(tripId: string, plan: TravelPlanDocument, source: string, summary: string, createdAt = now()) {
    const version = Number((this.db.prepare("SELECT COALESCE(MAX(version),0)+1 AS value FROM plan_revisions WHERE trip_id=?").get(tripId) as Row).value);
    this.db.prepare("INSERT INTO plan_revisions(trip_id,version,plan_json,source,summary,created_at) VALUES(?,?,?,?,?,?)").run(tripId, version, stringify(plan), source.slice(0, 80), summary.slice(0, 240), createdAt);
    return version;
  }

  listRevisions(tripId: string): PlanRevisionSummaryV3[] { return (this.db.prepare("SELECT version,created_at,source,summary FROM plan_revisions WHERE trip_id=? ORDER BY version DESC").all(tripId) as Row[]).map((row) => ({ version: Number(row.version), createdAt: String(row.created_at), source: String(row.source), summary: String(row.summary) })); }
  getRevision(tripId: string, version: number) {
    const row = this.db.prepare("SELECT * FROM plan_revisions WHERE trip_id=? AND version=?").get(tripId, version) as Row | undefined;
    return row ? { version: Number(row.version), createdAt: String(row.created_at), source: String(row.source), summary: String(row.summary), plan: parseTravelPlanJson(row.plan_json) } : null;
  }
  restoreRevision(tripId: string, version: number) {
    const revision = this.getRevision(tripId, version);
    if (!revision) throw new Error("找不到该计划版本。");
    const trip = this.requireTrip(tripId);
    return this.writePlan(tripId, revision.plan, trip.contentGeneration, { source: "restore", summary: `从 v${version} 恢复` });
  }

  private rowToMessage(row: Row): ChatMessageV3 {
    return {
      id: String(row.id),
      stage: ConversationStageSchema.parse(row.stage),
      role: String(row.role) as "user" | "assistant",
      content: String(row.content),
      reply: row.reply_json ? parse(row.reply_json, null) : null,
      status: String(row.status) as ChatMessageV3["status"],
      turn: row.turn_status ? {
        status: String(row.turn_status) as TurnStatusV3,
        cancelRequested: Boolean(row.cancel_requested),
        errorMessage: row.error_message ? String(row.error_message) : null,
        progressMessage: row.progress_message ? String(row.progress_message) : null,
        codexTurnId: row.codex_turn_id ? String(row.codex_turn_id) : null,
      } : null,
      createdAt: String(row.created_at),
    };
  }

  listMessages(tripId: string, stage?: ConversationStage): ChatMessageV3[] {
    const rows = stage
      ? this.db.prepare("SELECT * FROM messages WHERE trip_id=? AND stage=? ORDER BY created_at ASC").all(tripId, stage)
      : this.db.prepare("SELECT * FROM messages WHERE trip_id=? ORDER BY created_at ASC").all(tripId);
    return (rows as Row[]).map((row) => this.rowToMessage(row));
  }

  createUserMessage(tripId: string, stage: ConversationStage, content: string) {
    this.requireTrip(tripId);
    ConversationStageSchema.parse(stage);
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const busy = this.db.prepare("SELECT id FROM messages WHERE trip_id=? AND stage=? AND role='user' AND turn_status IN ('queued','starting','active') LIMIT 1").get(tripId, stage) as Row | undefined;
      if (busy) throw new Error("STAGE_TURN_BUSY");
      this.db.prepare("INSERT INTO messages(id,trip_id,stage,role,content,status,turn_status,progress_message,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, tripId, stage, "user", content, "pending", "queued", "请求已提交", now());
      this.db.exec("COMMIT");
      return id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  createAssistantMessage(tripId: string, stage: ConversationStage, content: string, reply: unknown) {
    this.requireTrip(tripId);
    ConversationStageSchema.parse(stage);
    const id = randomUUID();
    this.db.prepare("INSERT INTO messages(id,trip_id,stage,role,content,reply_json,status,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, tripId, stage, "assistant", content, stringify(reply), "completed", now());
    return id;
  }

  updateTurn(messageId: string, status: TurnStatusV3, patch: { progress?: string | null; error?: string | null; cancelRequested?: boolean; codexTurnId?: string | null } = {}) {
    const done = status === "completed" || status === "failed" || status === "interrupted";
    this.db.prepare("UPDATE messages SET status=?,turn_status=?,progress_message=?,error_message=?,cancel_requested=?,codex_turn_id=COALESCE(?,codex_turn_id) WHERE id=?").run(status === "completed" ? "completed" : done ? "failed" : "pending", status, patch.progress ?? null, patch.error ?? null, patch.cancelRequested ? 1 : 0, patch.codexTurnId ?? null, messageId);
  }

  getStageThread(tripId: string, stage: ConversationStage): StageThreadRecord | null {
    const row = this.db.prepare("SELECT * FROM stage_conversation_threads WHERE trip_id=? AND stage=?").get(tripId, stage) as Row | undefined;
    if (!row) return null;
    return StageThreadRecordSchema.parse({ tripId: row.trip_id, stage: row.stage, threadId: row.thread_id, promptHash: row.prompt_hash, promptVersion: row.prompt_version, contextGeneration: row.context_generation, turnCount: row.turn_count, createdAt: row.created_at, updatedAt: row.updated_at });
  }

  setStageThread(input: Omit<StageThreadRecord, "createdAt" | "updatedAt">) {
    this.requireTrip(input.tripId);
    const timestamp = now();
    this.db.prepare("INSERT INTO stage_conversation_threads(trip_id,stage,thread_id,prompt_hash,prompt_version,context_generation,turn_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(trip_id,stage) DO UPDATE SET thread_id=excluded.thread_id,prompt_hash=excluded.prompt_hash,prompt_version=excluded.prompt_version,context_generation=excluded.context_generation,turn_count=excluded.turn_count,updated_at=excluded.updated_at").run(input.tripId, input.stage, input.threadId, input.promptHash, input.promptVersion, input.contextGeneration, input.turnCount, timestamp, timestamp);
    return this.getStageThread(input.tripId, input.stage)!;
  }

  incrementStageThreadTurn(tripId: string, stage: ConversationStage, threadId: string, contextGeneration: number) {
    const timestamp = now();
    const result = this.db.prepare("UPDATE stage_conversation_threads SET turn_count=turn_count+1,context_generation=?,updated_at=? WHERE trip_id=? AND stage=? AND thread_id=?").run(contextGeneration, timestamp, tripId, stage, threadId);
    if (Number(result.changes) !== 1) throw new Error("STAGE_THREAD_SUPERSEDED");
    return this.getStageThread(tripId, stage)!;
  }

  deleteStageThread(tripId: string, stage: ConversationStage) { this.db.prepare("DELETE FROM stage_conversation_threads WHERE trip_id=? AND stage=?").run(tripId, stage); }

  private rowToAction(row: Row): AiActionRecord {
    return AiActionRecordSchema.parse({
      id: row.id,
      tripId: row.trip_id,
      stage: row.stage,
      actionType: row.action_type,
      executor: row.executor,
      origin: row.origin,
      sourceMessageId: row.source_message_id ?? null,
      parameters: parse(row.parameters_json, {}),
      targetIds: parse(row.target_ids_json, []),
      scope: parse(row.scope_json, {}),
      baseGeneration: Number(row.base_generation),
      status: row.status,
      taskId: row.task_id ?? null,
      proposalId: row.proposal_id ?? null,
      resultRef: row.result_ref ?? null,
      startedAt: row.started_at ?? null,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? null,
      errorSummary: row.error_summary ?? null,
    });
  }

  createAction(value: unknown, requestKey: string | null = null) {
    const parsed = AiActionRecordSchema.parse(value);
    const registration = actionRegistration(parsed.actionType);
    const parsedParameters = parseActionParametersV3(parsed.actionType, registration.inputContract, parsed.origin, parsed.parameters);
    const trip = this.requireTrip(parsed.tripId);
    const parameters = normalizeRequirementsCtaParametersV3(trip.plan, parsed.actionType, parsedParameters);
    const action = AiActionRecordSchema.parse({ ...parsed, parameters });
    if (action.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    if (requestKey) {
      const existing = this.db.prepare("SELECT * FROM ai_actions WHERE trip_id=? AND request_key=?").get(action.tripId, requestKey) as Row | undefined;
      if (existing) return { action: this.rowToAction(existing), created: false };
    }
    this.db.prepare("INSERT INTO ai_actions(id,trip_id,stage,action_type,executor,origin,source_message_id,request_key,parameters_json,target_ids_json,scope_json,base_generation,status,task_id,proposal_id,result_ref,started_at,updated_at,completed_at,error_summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(action.id, action.tripId, action.stage, action.actionType, action.executor, action.origin, action.sourceMessageId, requestKey, stringify(action.parameters), stringify(action.targetIds), stringify(action.scope), action.baseGeneration, action.status, action.taskId, action.proposalId, action.resultRef, action.startedAt, action.updatedAt, action.completedAt, action.errorSummary);
    return { action: this.getAction(action.id)!, created: true };
  }

  getAction(id: string) { const row = this.db.prepare("SELECT * FROM ai_actions WHERE id=?").get(id) as Row | undefined; return row ? this.rowToAction(row) : null; }
  listActions(tripId: string, stage?: ConversationStage) {
    const rows = stage ? this.db.prepare("SELECT * FROM ai_actions WHERE trip_id=? AND stage=? ORDER BY updated_at DESC").all(tripId, stage) : this.db.prepare("SELECT * FROM ai_actions WHERE trip_id=? ORDER BY updated_at DESC").all(tripId);
    return (rows as Row[]).map((row) => this.rowToAction(row));
  }

  claimActionForExecution(id: string, expectedGeneration: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = now();
      const result = this.db.prepare("UPDATE ai_actions SET status='executing',started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status='pending_confirmation' AND base_generation=? AND EXISTS(SELECT 1 FROM trips WHERE trips.id=ai_actions.trip_id AND trips.content_generation=?)").run(timestamp, timestamp, id, expectedGeneration, expectedGeneration);
      const action = this.getAction(id);
      if (!action) throw new Error("找不到该 Action。");
      this.db.exec("COMMIT");
      return { action, claimed: Number(result.changes) === 1 };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  cancelPendingAction(id: string) {
    const timestamp = now();
    const result = this.db.prepare("UPDATE ai_actions SET status='cancelled',updated_at=?,completed_at=? WHERE id=? AND status='pending_confirmation'").run(timestamp, timestamp, id);
    const action = this.getAction(id);
    if (!action) throw new Error("找不到该 Action。");
    return { action, cancelled: Number(result.changes) === 1 };
  }

  setActionTask(id: string, taskId: string) {
    this.db.prepare("UPDATE ai_actions SET task_id=?,updated_at=? WHERE id=? AND status='executing'").run(taskId, now(), id);
    return this.getAction(id);
  }

  setActionAwaitingApply(id: string, proposalId: string, resultRef: string | null = null) {
    this.db.prepare("UPDATE ai_actions SET status='awaiting_apply',proposal_id=?,result_ref=?,updated_at=? WHERE id=? AND status='executing'").run(proposalId, resultRef, now(), id);
    return this.getAction(id);
  }

  completeAction(id: string, resultRef: string | null = null) {
    const timestamp = now();
    this.db.prepare("UPDATE ai_actions SET status='completed',result_ref=?,updated_at=?,completed_at=?,error_summary=NULL WHERE id=? AND status='executing'").run(resultRef, timestamp, timestamp, id);
    return this.getAction(id);
  }

  failAction(id: string, errorSummary: string) {
    const timestamp = now();
    this.db.prepare("UPDATE ai_actions SET status='failed',updated_at=?,completed_at=?,error_summary=? WHERE id=? AND status IN ('executing','pending_confirmation')").run(timestamp, timestamp, errorSummary.slice(0, 2000), id);
    return this.getAction(id);
  }

  supersedeAction(id: string, reason = "计划已变化。") {
    const timestamp = now();
    this.db.prepare("UPDATE ai_actions SET status='superseded',updated_at=?,completed_at=?,error_summary=? WHERE id=? AND status IN ('pending_confirmation','executing','awaiting_apply')").run(timestamp, timestamp, reason.slice(0, 2000), id);
    return this.getAction(id);
  }

  upsertAiTask(input: { id: string; tripId: string; agent: AiTaskAgentV3; label: string; status: AiTaskStatusV3; summary: string; canStop: boolean; metadata?: Record<string, unknown>; resetStartedAt?: boolean }) {
    this.requireTrip(input.tripId);
    const timestamp = now();
    const existing = this.db.prepare("SELECT started_at FROM ai_tasks WHERE id=?").get(input.id) as Row | undefined;
    const startedAt = existing && !input.resetStartedAt ? String(existing.started_at) : timestamp;
    this.db.prepare("INSERT INTO ai_tasks(id,trip_id,agent,label,status,summary,metadata_json,started_at,updated_at,can_stop) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent=excluded.agent,label=excluded.label,status=excluded.status,summary=excluded.summary,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,can_stop=excluded.can_stop").run(input.id, input.tripId, input.agent, input.label, input.status, input.summary, stringify(input.metadata ?? {}), startedAt, timestamp, input.canStop ? 1 : 0);
    return this.getAiTask(input.id)!;
  }
  setAiTaskMetadata(id: string, metadata: Record<string, unknown>) { this.db.prepare("UPDATE ai_tasks SET metadata_json=?,updated_at=? WHERE id=?").run(stringify(metadata), now(), id); return this.getAiTask(id); }
  setAiTaskRetry(id: string, retryCount: number, nextAttemptAt: string | null, lastError: string | null) { this.db.prepare("UPDATE ai_tasks SET retry_count=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?").run(retryCount, nextAttemptAt, lastError, now(), id); return this.getAiTask(id); }

  stopInterruptedAiRuns() {
    const timestamp = now();
    const rows = this.db.prepare("SELECT id,trip_id,agent FROM ai_tasks WHERE status IN ('starting','running','waiting','reconnecting')").all() as Row[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) this.db.prepare("INSERT INTO ai_progress_events(task_id,trip_id,agent,status,kind,summary,created_at) VALUES(?,?,?,?,?,?,?)").run(String(row.id), String(row.trip_id), String(row.agent), "stopped", "task:app-restart", "应用已重启；任务未跨进程恢复。", timestamp);
      this.db.prepare("UPDATE ai_tasks SET status='stopped',summary=?,updated_at=?,can_stop=0,next_attempt_at=NULL WHERE status IN ('starting','running','waiting','reconnecting')").run("应用已重启；任务未跨进程恢复。", timestamp);
      this.db.prepare("UPDATE messages SET status='failed',turn_status='interrupted',cancel_requested=1,progress_message=?,error_message=NULL WHERE turn_status IN ('queued','starting','active')").run("应用已重启；本轮已停止。");
      this.db.prepare("UPDATE ai_actions SET status='failed',updated_at=?,completed_at=?,error_summary=? WHERE status='executing'").run(timestamp, timestamp, "应用已重启；Action 未跨进程恢复。");
      this.db.exec("COMMIT");
      return rows.length;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  appendAiProgress(taskId: string, status: AiTaskStatusV3, kind: string, summary: string) {
    const task = this.db.prepare("SELECT trip_id,agent FROM ai_tasks WHERE id=?").get(taskId) as Row | undefined;
    if (!task) return null;
    const timestamp = now();
    this.db.prepare("INSERT INTO ai_progress_events(task_id,trip_id,agent,status,kind,summary,created_at) VALUES(?,?,?,?,?,?,?)").run(taskId, String(task.trip_id), String(task.agent), status, kind, summary, timestamp);
    this.db.prepare("UPDATE ai_tasks SET status=?,summary=?,updated_at=?,can_stop=? WHERE id=?").run(status, summary, timestamp, ["starting","running","waiting","reconnecting"].includes(status) ? 1 : 0, taskId);
    return this.getAiTask(taskId);
  }

  getAiTask(id: string): AiTaskSnapshotV3 | null { const row = this.db.prepare("SELECT * FROM ai_tasks WHERE id=?").get(id) as Row | undefined; return row ? this.task(row) : null; }
  listAiTasks(tripId: string) { return (this.db.prepare("SELECT * FROM ai_tasks WHERE trip_id=? ORDER BY updated_at DESC").all(tripId) as Row[]).map((row) => this.task(row)); }
  private task(row: Row): AiTaskSnapshotV3 {
    const events = (this.db.prepare("SELECT * FROM ai_progress_events WHERE task_id=? ORDER BY id").all(String(row.id)) as Row[]).map((event): AiProgressEventV3 => ({ id: Number(event.id), taskId: String(event.task_id), tripId: String(event.trip_id), agent: String(event.agent) as AiTaskAgentV3, status: String(event.status) as AiTaskStatusV3, kind: String(event.kind), summary: String(event.summary), createdAt: String(event.created_at) }));
    return { id: String(row.id), tripId: String(row.trip_id), agent: String(row.agent) as AiTaskAgentV3, label: String(row.label), status: String(row.status) as AiTaskStatusV3, summary: String(row.summary), startedAt: String(row.started_at), updatedAt: String(row.updated_at), canStop: Boolean(row.can_stop), retryCount: Number(row.retry_count), nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null, lastError: row.last_error ? String(row.last_error) : null, metadata: parse(row.metadata_json, {}), events };
  }

  listPlaceResolutions(tripId: string) { return (this.db.prepare("SELECT resolution_json FROM place_resolutions WHERE trip_id=? ORDER BY place_id").all(tripId) as Row[]).map((row) => PlaceResolutionSchema.parse(parse(row.resolution_json, null))); }
  getPlaceResolution(tripId: string, placeId: string) { const row = this.db.prepare("SELECT resolution_json FROM place_resolutions WHERE trip_id=? AND place_id=?").get(tripId, placeId) as Row | undefined; return row ? PlaceResolutionSchema.parse(parse(row.resolution_json, null)) : null; }
  upsertPlaceResolution(tripId: string, value: unknown, expectedGeneration: number) {
    const resolution = PlaceResolutionSchema.parse(value); const trip = this.requireTrip(tripId);
    if (trip.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    if (resolution.tripId !== tripId || !trip.plan.places.some((place) => place.id === resolution.placeId)) throw new Error("PlaceResolution 必须引用当前旅行中的 Place。");
    const updatedAt = now();
    this.db.prepare("INSERT INTO place_resolutions(trip_id,place_id,resolution_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(trip_id,place_id) DO UPDATE SET resolution_json=excluded.resolution_json,updated_at=excluded.updated_at").run(tripId, resolution.placeId, stringify(resolution), updatedAt);
    return resolution;
  }
  deletePlaceResolution(tripId: string, placeId: string) { this.db.prepare("DELETE FROM place_resolutions WHERE trip_id=? AND place_id=?").run(tripId, placeId); }

  listDayRoutes(tripId: string) { return (this.db.prepare("SELECT route_json FROM day_routes WHERE trip_id=? ORDER BY day_id").all(tripId) as Row[]).map((row) => DayRouteSchema.parse(parse(row.route_json, null))); }
  getDayRoute(tripId: string, dayId: string) { const row = this.db.prepare("SELECT route_json FROM day_routes WHERE trip_id=? AND day_id=?").get(tripId, dayId) as Row | undefined; return row ? DayRouteSchema.parse(parse(row.route_json, null)) : null; }
  setDayRoute(tripId: string, value: unknown, expectedGeneration: number) {
    const route = DayRouteSchema.parse(value); const trip = this.requireTrip(tripId);
    if (trip.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const canonicalDayId = route.dayId.startsWith("macro:") ? route.dayId.slice("macro:".length) : route.dayId;
    if (route.tripId !== tripId || !trip.plan.days.some((day) => day.id === canonicalDayId)) throw new Error("DayRoute 必须引用当前旅行中的 Day。");
    const prior = this.getDayRoute(tripId, route.dayId); const expectedVersion = prior ? prior.version + 1 : 1;
    if (route.version !== expectedVersion) throw new Error(`DayRoute version 必须为 ${expectedVersion}。`);
    this.db.prepare("INSERT INTO day_routes(trip_id,day_id,version,route_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(trip_id,day_id) DO UPDATE SET version=excluded.version,route_json=excluded.route_json,updated_at=excluded.updated_at").run(tripId, route.dayId, route.version, stringify(route), now());
    return route;
  }
  deleteDayRoute(tripId: string, dayId: string) { this.db.prepare("DELETE FROM day_routes WHERE trip_id=? AND day_id=?").run(tripId, dayId); }

  private rowToProposal(row: Row) {
    const proposal = parseProposalJson(row.proposal_json);
    if (proposal.id !== String(row.id) || proposal.tripId !== String(row.trip_id) || proposal.baseGeneration !== Number(row.base_generation) || proposal.status !== String(row.status) || proposal.appliedRevisionVersion !== (row.applied_revision_version === null ? null : Number(row.applied_revision_version))) throw new Error("AI Proposal 索引与 JSON 不一致；已停止读取损坏状态。");
    return proposal;
  }
  private updateProposalRow(proposal: AiProposal) { this.db.prepare("UPDATE ai_proposals SET base_generation=?,status=?,proposal_json=?,applied_revision_version=?,updated_at=? WHERE id=?").run(proposal.baseGeneration, proposal.status, stringify(proposal), proposal.appliedRevisionVersion, proposal.updatedAt, proposal.id); }
  createProposal(value: unknown) {
    const proposal = AiProposalSchema.parse(value); const trip = this.requireTrip(proposal.tripId);
    if (proposal.status !== "pending" || proposal.appliedRevisionVersion !== null) throw new Error("新 Proposal 必须为 pending 且尚未应用。");
    if (proposal.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    this.db.prepare("INSERT INTO ai_proposals(id,trip_id,base_generation,status,proposal_json,applied_revision_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(proposal.id, proposal.tripId, proposal.baseGeneration, proposal.status, stringify(proposal), null, proposal.createdAt, proposal.updatedAt);
    return proposal;
  }
  getProposal(id: string) { const row = this.db.prepare("SELECT * FROM ai_proposals WHERE id=?").get(id) as Row | undefined; return row ? this.rowToProposal(row) : null; }
  listProposals(tripId: string) { return (this.db.prepare("SELECT * FROM ai_proposals WHERE trip_id=? ORDER BY updated_at DESC").all(tripId) as Row[]).map((row) => this.rowToProposal(row)); }

  rejectProposal(id: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.getProposal(id); if (!proposal) throw new Error("找不到该 Proposal。"); if (proposal.status !== "pending") throw new Error("只有 pending Proposal 可以拒绝。");
      const rejected = AiProposalSchema.parse({ ...proposal, status: "rejected", updatedAt: now() }); this.updateProposalRow(rejected);
      this.db.prepare("UPDATE ai_actions SET status='rejected',updated_at=?,completed_at=? WHERE proposal_id=? AND status='awaiting_apply'").run(rejected.updatedAt, rejected.updatedAt, id);
      this.db.exec("COMMIT"); return rejected;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  applyProposalPlan(id: string, value: unknown, revisionSummary = "应用 AI 修改建议") {
    const plan = TravelPlanDocumentSchema.parse(value);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.getProposal(id); if (!proposal) throw new Error("找不到该 Proposal。"); if (proposal.status !== "pending") throw new Error("只有 pending Proposal 可以应用。");
      const actionRow = this.db.prepare("SELECT id FROM ai_actions WHERE proposal_id=? AND status='awaiting_apply'").get(id) as Row | undefined;
      const result = this.writePlanWithinTransaction(proposal.tripId, plan, proposal.baseGeneration, { source: "proposal", summary: revisionSummary }, { keepPendingProposalId: proposal.id, keepActionId: actionRow ? String(actionRow.id) : undefined });
      const applied = AiProposalSchema.parse({ ...proposal, status: "applied", updatedAt: result.updatedAt, appliedRevisionVersion: result.version }); this.updateProposalRow(applied);
      if (actionRow) this.db.prepare("UPDATE ai_actions SET status='applied',base_generation=?,updated_at=?,completed_at=?,error_summary=NULL WHERE id=?").run(result.generation, result.updatedAt, result.updatedAt, String(actionRow.id));
      const trip = this.requireTrip(proposal.tripId); this.db.exec("COMMIT"); return { trip, proposal: applied, ...result };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  undoProposal(id: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.getProposal(id); if (!proposal) throw new Error("找不到该 Proposal。"); if (proposal.status !== "applied" || proposal.appliedRevisionVersion === null) throw new Error("只有已应用且未撤销的 Proposal 可以撤销。");
      const trip = this.requireTrip(proposal.tripId); if (trip.contentGeneration !== proposal.baseGeneration + 1) throw new Error("PROPOSAL_UNDO_SUPERSEDED");
      const base = this.getRevision(proposal.tripId, proposal.appliedRevisionVersion - 1); if (!base) throw new Error("找不到 Proposal 应用前的计划版本。");
      const result = this.writePlanWithinTransaction(proposal.tripId, base.plan, trip.contentGeneration, { source: "proposal_undo", summary: `撤销 Proposal：${proposal.title}` });
      const undone = AiProposalSchema.parse({ ...proposal, status: "undone", updatedAt: result.updatedAt }); this.updateProposalRow(undone);
      const nextTrip = this.requireTrip(proposal.tripId); this.db.exec("COMMIT"); return { trip: nextTrip, proposal: undone, ...result };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getWorkspace(tripId: string) {
    return { trip: this.requireTrip(tripId), resolutions: this.listPlaceResolutions(tripId), routes: this.listDayRoutes(tripId), proposals: this.listProposals(tripId), actions: this.listActions(tripId) };
  }
}
