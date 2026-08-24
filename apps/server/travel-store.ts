import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { ItinerarySchema, emptyItinerary, type AiAgentKind, type AiProgressEvent, type AiTaskSnapshot, type AiTaskStatus, type Itinerary, type MapState, type ResolvedPlace } from "./contracts.js";

type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
const DATABASE_VERSION = 1;
const DATABASE_ERROR = "travel.sqlite3 不是 itinerary:v1 数据库；已停止读取和写入，必须先按安全流程重置 private_data。";
const EXPECTED_COLUMNS = {
  trips: ["id", "state", "current_itinerary_json", "title", "content_generation", "codex_thread_id", "itinerary_language", "created_at", "updated_at"],
  itinerary_revisions: ["trip_id", "version", "itinerary_json", "source", "summary", "created_at"],
  messages: ["id", "trip_id", "role", "content", "reply_json", "status", "turn_status", "cancel_requested", "progress_message", "error_message", "codex_turn_id", "created_at"],
  ai_tasks: ["id", "trip_id", "agent", "label", "status", "summary", "metadata_json", "started_at", "updated_at", "can_stop", "retry_count", "next_attempt_at", "last_error"],
  ai_progress_events: ["id", "task_id", "trip_id", "agent", "status", "kind", "summary", "created_at"],
  map_state: ["trip_id", "generation", "resolved_places_json", "map_json", "status", "warnings_json", "updated_at"],
} as const;
type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const stringify = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => { try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; } };

export type TripState = "active" | "trashed";
export type ItineraryLanguage = "zh" | "en" | "bilingual";
export type TripSummary = { id: string; title: string; state: TripState; updatedAt: string; itineraryLanguage: ItineraryLanguage; contentGeneration: number; itinerary: Itinerary };
export type TripDetail = TripSummary & { codexThreadId: string | null };
export type RevisionSummary = { version: number; createdAt: string; source: string; summary: string };
export type ChatMessage = { id: string; role: "user" | "assistant"; content: string; reply: unknown | null; status: "pending" | "completed" | "failed"; turn: { status: "queued" | "starting" | "active" | "completed" | "failed" | "interrupted"; cancelRequested: boolean; errorMessage: string | null; progressMessage: string | null; codexTurnId: string | null } | null; createdAt: string };

export class TravelStore {
  private readonly db: InstanceType<typeof DatabaseSync>;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    try {
      this.initialize();
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() { this.db.close(); }

  private initialize() {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version === 0) {
      const existingObjects = this.db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as Row[];
      if (existingObjects.length) throw new Error(DATABASE_ERROR);
      this.createSchema();
    }
    const current = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (current !== DATABASE_VERSION || !this.hasNewSchema()) throw new Error(DATABASE_ERROR);
  }

  private createSchema() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
          CREATE TABLE trips (
            id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('active','trashed')),
            current_itinerary_json TEXT NOT NULL, title TEXT NOT NULL, content_generation INTEGER NOT NULL,
            codex_thread_id TEXT, itinerary_language TEXT NOT NULL DEFAULT 'bilingual' CHECK(itinerary_language IN ('zh','en','bilingual')),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE itinerary_revisions (
            trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, version INTEGER NOT NULL,
            itinerary_json TEXT NOT NULL, source TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(trip_id, version)
          );
          CREATE TABLE messages (
            id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, reply_json TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')), turn_status TEXT,
            cancel_requested INTEGER NOT NULL DEFAULT 0, progress_message TEXT, error_message TEXT, codex_turn_id TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX messages_trip_created ON messages(trip_id, created_at);
          CREATE TABLE ai_tasks (
            id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            agent TEXT NOT NULL CHECK(agent IN ('planner','detailer','map')), label TEXT NOT NULL, status TEXT NOT NULL,
            summary TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            can_stop INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT
          );
          CREATE TABLE ai_progress_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
            trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, agent TEXT NOT NULL, status TEXT NOT NULL,
            kind TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL
          );
          CREATE INDEX ai_progress_trip_created ON ai_progress_events(trip_id, created_at);
          CREATE TABLE map_state (
            trip_id TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE, generation INTEGER NOT NULL,
            resolved_places_json TEXT NOT NULL, map_json TEXT NOT NULL, status TEXT NOT NULL,
            warnings_json TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          PRAGMA user_version = 1;
        `);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original initialization error. */ }
      throw error;
    }
  }

  private hasNewSchema() {
    const tables = (this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map((row) => String(row.name));
    const expectedTables = Object.keys(EXPECTED_COLUMNS).sort();
    if (tables.length !== expectedTables.length || tables.some((name, index) => name !== expectedTables[index])) return false;
    return expectedTables.every((table) => {
      const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name));
      const expected = EXPECTED_COLUMNS[table as keyof typeof EXPECTED_COLUMNS];
      return columns.length === expected.length && columns.every((name, index) => name === expected[index]);
    });
  }

  private rowToTrip(row: Row): TripSummary {
    const itinerary = ItinerarySchema.parse(parse(row.current_itinerary_json, null));
    if (String(row.title) !== itinerary.trip.title) throw new Error("travel.sqlite3 的标题索引与 canonical itinerary 不一致；已停止读取，避免传播损坏状态。");
    const language = row.itinerary_language === "zh" || row.itinerary_language === "en" || row.itinerary_language === "bilingual" ? row.itinerary_language : "bilingual";
    return { id: String(row.id), title: itinerary.trip.title, state: String(row.state) as TripState, updatedAt: String(row.updated_at), itineraryLanguage: language, contentGeneration: Number(row.content_generation), itinerary };
  }
  listTrips(state: TripState = "active") { return (this.db.prepare("SELECT * FROM trips WHERE state=? ORDER BY updated_at DESC").all(state) as Row[]).map((row) => this.rowToTrip(row)); }
  createTrip() {
    const id = randomUUID(); const createdAt = now(); const itinerary = emptyItinerary();
    this.db.prepare("INSERT INTO trips(id,state,current_itinerary_json,title,content_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, "active", stringify(itinerary), itinerary.trip.title, 0, createdAt, createdAt);
    return this.requireTrip(id);
  }
  getTrip(id: string): TripDetail | null { const row = this.db.prepare("SELECT * FROM trips WHERE id=?").get(id) as Row | undefined; return row ? { ...this.rowToTrip(row), codexThreadId: typeof row.codex_thread_id === "string" ? row.codex_thread_id : null } : null; }
  requireTrip(id: string) { const trip = this.getTrip(id); if (!trip) throw new Error("找不到这趟旅行。"); return trip; }
  setState(id: string, state: TripState) { this.db.prepare("UPDATE trips SET state=?,updated_at=? WHERE id=?").run(state, now(), id); return this.requireTrip(id); }
  permanentDelete(id: string) { this.db.prepare("DELETE FROM trips WHERE id=?").run(id); }
  setThread(id: string, threadId: string | null) { this.db.prepare("UPDATE trips SET codex_thread_id=?,updated_at=? WHERE id=?").run(threadId, now(), id); }
  setItineraryLanguage(id: string, language: ItineraryLanguage) { this.db.prepare("UPDATE trips SET itinerary_language=?,updated_at=? WHERE id=?").run(language, now(), id); return this.requireTrip(id); }

  writeItinerary(id: string, value: unknown, expectedGeneration: number, options: { revision?: { source: string; summary: string } } = {}) {
    const itinerary = ItinerarySchema.parse(value); this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT content_generation FROM trips WHERE id=?").get(id) as Row | undefined;
      if (!row) throw new Error("找不到这趟旅行。");
      if (Number(row.content_generation) !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
      const generation = expectedGeneration + 1; const updatedAt = now();
      this.db.prepare("UPDATE trips SET current_itinerary_json=?,title=?,content_generation=?,updated_at=? WHERE id=?").run(stringify(itinerary), itinerary.trip.title, generation, updatedAt, id);
      let version: number | null = null;
      if (options.revision) version = this.insertRevision(id, itinerary, options.revision.source, options.revision.summary, updatedAt);
      this.db.exec("COMMIT"); return { trip: this.requireTrip(id), generation, version };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  rename(id: string, title: string) { const trip = this.requireTrip(id); return this.writeItinerary(id, { ...trip.itinerary, trip: { ...trip.itinerary.trip, title: title.trim().slice(0, 200) } }, trip.contentGeneration).trip; }
  private insertRevision(tripId: string, itinerary: Itinerary, source: string, summary: string, createdAt = now()) { const version = Number((this.db.prepare("SELECT COALESCE(MAX(version),0)+1 AS value FROM itinerary_revisions WHERE trip_id=?").get(tripId) as Row).value); this.db.prepare("INSERT INTO itinerary_revisions(trip_id,version,itinerary_json,source,summary,created_at) VALUES(?,?,?,?,?,?)").run(tripId, version, stringify(itinerary), source.slice(0, 80), summary.slice(0, 240), createdAt); return version; }
  listRevisions(tripId: string): RevisionSummary[] { return (this.db.prepare("SELECT version,created_at,source,summary FROM itinerary_revisions WHERE trip_id=? ORDER BY version DESC").all(tripId) as Row[]).map((row) => ({ version: Number(row.version), createdAt: String(row.created_at), source: String(row.source), summary: String(row.summary) })); }
  getRevision(tripId: string, version: number) { const row = this.db.prepare("SELECT * FROM itinerary_revisions WHERE trip_id=? AND version=?").get(tripId, version) as Row | undefined; return row ? { version: Number(row.version), createdAt: String(row.created_at), source: String(row.source), summary: String(row.summary), itinerary: ItinerarySchema.parse(parse(row.itinerary_json, null)) } : null; }
  restoreRevision(tripId: string, version: number) { const revision = this.getRevision(tripId, version); if (!revision) throw new Error("找不到该行程版本。"); const trip = this.requireTrip(tripId); return this.writeItinerary(tripId, revision.itinerary, trip.contentGeneration, { revision: { source: "restore", summary: `从 v${version} 恢复` } }); }
  duplicate(id: string) { const original = this.requireTrip(id); const copyId = randomUUID(); const createdAt = now(); const itinerary = ItinerarySchema.parse({ ...original.itinerary, trip: { ...original.itinerary.trip, title: `${original.itinerary.trip.title} 副本`.slice(0, 200) } }); this.db.prepare("INSERT INTO trips(id,state,current_itinerary_json,title,content_generation,itinerary_language,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(copyId, "active", stringify(itinerary), itinerary.trip.title, 0, original.itineraryLanguage, createdAt, createdAt); return this.requireTrip(copyId); }

  listMessages(tripId: string): ChatMessage[] { return (this.db.prepare("SELECT * FROM messages WHERE trip_id=? ORDER BY created_at ASC").all(tripId) as Row[]).map((row) => ({ id: String(row.id), role: String(row.role) as "user" | "assistant", content: String(row.content), reply: row.reply_json ? parse(row.reply_json, null) : null, status: String(row.status) as ChatMessage["status"], turn: row.turn_status ? { status: String(row.turn_status) as NonNullable<ChatMessage["turn"]>["status"], cancelRequested: Boolean(row.cancel_requested), errorMessage: row.error_message ? String(row.error_message) : null, progressMessage: row.progress_message ? String(row.progress_message) : null, codexTurnId: row.codex_turn_id ? String(row.codex_turn_id) : null } : null, createdAt: String(row.created_at) })); }
  createUserMessage(tripId: string, content: string) { const id = randomUUID(); this.db.prepare("INSERT INTO messages(id,trip_id,role,content,status,turn_status,progress_message,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, tripId, "user", content, "pending", "queued", "请求已提交", now()); return id; }
  createAssistantMessage(tripId: string, content: string, reply: unknown) { const id = randomUUID(); this.db.prepare("INSERT INTO messages(id,trip_id,role,content,reply_json,status,created_at) VALUES(?,?,?,?,?,?,?)").run(id, tripId, "assistant", content, stringify(reply), "completed", now()); return id; }
  updateTurn(messageId: string, status: NonNullable<ChatMessage["turn"]>["status"], patch: { progress?: string | null; error?: string | null; cancelRequested?: boolean; codexTurnId?: string | null } = {}) { const done = status === "completed" || status === "failed" || status === "interrupted"; this.db.prepare("UPDATE messages SET status=?,turn_status=?,progress_message=?,error_message=?,cancel_requested=?,codex_turn_id=COALESCE(?,codex_turn_id) WHERE id=?").run(status === "completed" ? "completed" : done ? "failed" : "pending", status, patch.progress ?? null, patch.error ?? null, patch.cancelRequested ? 1 : 0, patch.codexTurnId ?? null, messageId); }

  upsertAiTask(input: { id: string; tripId: string; agent: AiAgentKind; label: string; status: AiTaskStatus; summary: string; canStop: boolean; metadata?: Record<string, unknown>; resetStartedAt?: boolean }) { const timestamp = now(); const existing = this.db.prepare("SELECT started_at FROM ai_tasks WHERE id=?").get(input.id) as Row | undefined; const startedAt = existing && !input.resetStartedAt ? String(existing.started_at) : timestamp; this.db.prepare("INSERT INTO ai_tasks(id,trip_id,agent,label,status,summary,metadata_json,started_at,updated_at,can_stop) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent=excluded.agent,label=excluded.label,status=excluded.status,summary=excluded.summary,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,can_stop=excluded.can_stop").run(input.id, input.tripId, input.agent, input.label, input.status, input.summary, stringify(input.metadata ?? {}), startedAt, timestamp, input.canStop ? 1 : 0); return this.getAiTask(input.id)!; }
  setAiTaskMetadata(id: string, metadata: Record<string, unknown>) { this.db.prepare("UPDATE ai_tasks SET metadata_json=?,updated_at=? WHERE id=?").run(stringify(metadata), now(), id); return this.getAiTask(id); }
  stopInterruptedAiRuns() {
    const timestamp = now(); const rows = this.db.prepare("SELECT id,trip_id,agent FROM ai_tasks WHERE status IN ('starting','running','waiting','reconnecting')").all() as Row[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) this.db.prepare("INSERT INTO ai_progress_events(task_id,trip_id,agent,status,kind,summary,created_at) VALUES(?,?,?,?,?,?,?)").run(String(row.id), String(row.trip_id), String(row.agent), "stopped", "task:app-restart", "应用已重启；任务未跨进程恢复，可从当前行程重新开始。", timestamp);
      this.db.prepare("UPDATE ai_tasks SET status='stopped',summary=?,updated_at=?,can_stop=0,next_attempt_at=NULL WHERE status IN ('starting','running','waiting','reconnecting')").run("应用已重启；任务未跨进程恢复，可从当前行程重新开始。", timestamp);
      this.db.prepare("UPDATE messages SET status='failed',turn_status='interrupted',cancel_requested=1,progress_message=?,error_message=NULL WHERE turn_status IN ('queued','starting','active')").run("应用已重启；本轮已停止。");
      this.db.exec("COMMIT"); return rows.length;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  setAiTaskRetry(id: string, retryCount: number, nextAttemptAt: string | null, lastError: string | null) { this.db.prepare("UPDATE ai_tasks SET retry_count=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?").run(retryCount, nextAttemptAt, lastError, now(), id); return this.getAiTask(id); }
  appendAiProgress(taskId: string, status: AiTaskStatus, kind: string, summary: string) { const task = this.db.prepare("SELECT trip_id,agent FROM ai_tasks WHERE id=?").get(taskId) as Row | undefined; if (!task) return null; const timestamp = now(); this.db.prepare("INSERT INTO ai_progress_events(task_id,trip_id,agent,status,kind,summary,created_at) VALUES(?,?,?,?,?,?,?)").run(taskId, String(task.trip_id), String(task.agent), status, kind, summary, timestamp); this.db.prepare("UPDATE ai_tasks SET status=?,summary=?,updated_at=?,can_stop=? WHERE id=?").run(status, summary, timestamp, ["starting", "running", "waiting", "reconnecting"].includes(status) ? 1 : 0, taskId); return this.getAiTask(taskId); }
  getAiTask(id: string): AiTaskSnapshot | null { const row = this.db.prepare("SELECT * FROM ai_tasks WHERE id=?").get(id) as Row | undefined; return row ? this.task(row) : null; }
  listAiTasks(tripId: string) { return (this.db.prepare("SELECT * FROM ai_tasks WHERE trip_id=? ORDER BY updated_at DESC").all(tripId) as Row[]).map((row) => this.task(row)); }
  private task(row: Row): AiTaskSnapshot { const events = (this.db.prepare("SELECT * FROM ai_progress_events WHERE task_id=? ORDER BY id").all(String(row.id)) as Row[]).map((event): AiProgressEvent => ({ id: Number(event.id), taskId: String(event.task_id), tripId: String(event.trip_id), agent: String(event.agent) as AiAgentKind, status: String(event.status) as AiTaskStatus, kind: String(event.kind), summary: String(event.summary), createdAt: String(event.created_at) })); return { id: String(row.id), tripId: String(row.trip_id), agent: String(row.agent) as AiAgentKind, label: String(row.label), status: String(row.status) as AiTaskStatus, summary: String(row.summary), startedAt: String(row.started_at), updatedAt: String(row.updated_at), canStop: Boolean(row.can_stop), retryCount: Number(row.retry_count), nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null, lastError: row.last_error ? String(row.last_error) : null, metadata: parse(row.metadata_json, {}), events }; }

  getMapState(tripId: string): MapState | null { const row = this.db.prepare("SELECT * FROM map_state WHERE trip_id=?").get(tripId) as Row | undefined; return row ? { generation: Number(row.generation), resolvedPlaces: parse<ResolvedPlace[]>(row.resolved_places_json, []), map: parse(row.map_json, null), status: String(row.status) as MapState["status"], warnings: parse<string[]>(row.warnings_json, []), updatedAt: String(row.updated_at) } : null; }
  setMapState(tripId: string, state: Omit<MapState, "updatedAt">, expectedGeneration: number) { const trip = this.requireTrip(tripId); if (trip.contentGeneration !== expectedGeneration || state.generation !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED"); const updatedAt = now(); this.db.prepare("INSERT INTO map_state(trip_id,generation,resolved_places_json,map_json,status,warnings_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(trip_id) DO UPDATE SET generation=excluded.generation,resolved_places_json=excluded.resolved_places_json,map_json=excluded.map_json,status=excluded.status,warnings_json=excluded.warnings_json,updated_at=excluded.updated_at").run(tripId, state.generation, stringify(state.resolvedPlaces), stringify(state.map), state.status, stringify(state.warnings), updatedAt); return { ...state, updatedAt }; }
}
