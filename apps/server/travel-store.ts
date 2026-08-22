import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AiAgentKind, AiTaskSnapshot, AiTaskStatus, Candidate, MapAgentOutput, MapDayPath, MapEntityPatch, MapEntityView, MapJobStatus, MapRoutePatch, MapRouteView, MapSnapshot, TravelAgentOutput, TravelRequirements, TripPlan } from "./contracts.js";
import { emptyRequirements, RequirementsSchema, TripPlanSchema } from "./contracts.js";

type SqliteModule = typeof import("node:sqlite");
const sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
const { DatabaseSync } = sqlite;

export type TripState = "active" | "trashed";
export type TripSummary = { id: string; title: string; state: TripState; updatedAt: string; activeRevision: { id: string; version: number; plan: TripPlan } | null };
export type TripDetail = TripSummary & { requirements: TravelRequirements; requirementsRevision: number; codexThreadId: string | null; mapCodexThreadId: string | null };
export type ChatMessage = { id: string; role: "user" | "assistant"; content: string; reply: TravelAgentOutput | null; status: "pending" | "completed" | "failed"; turn: { status: "queued" | "starting" | "active" | "completed" | "failed" | "interrupted"; cancelRequested: boolean; errorMessage: string | null; progressMessage?: string } | null; createdAt: string };
export type RevisionSummary = { version: number; createdAt: string; source: string; summary: string };
type DbRow = Record<string, unknown>;
const iso = () => new Date().toISOString();
const json = <T>(value: T) => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => { try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const normalizeCandidate = (value: unknown): Candidate | null => {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Candidate>;
  if (!item.providerPlaceId || !item.displayName || !Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return null;
  return { providerPlaceId: item.providerPlaceId, displayName: item.displayName, latitude: Number(item.latitude), longitude: Number(item.longitude), category: item.category ?? null, sourceUrl: item.sourceUrl || `https://www.openstreetmap.org/?mlat=${item.latitude}&mlon=${item.longitude}`, sourceType: item.sourceType ?? "nominatim", evidenceUrl: item.evidenceUrl ?? null, confidence: item.confidence ?? "high", decisionNote: item.decisionNote ?? null };
};
const normalizeCandidates = (value: unknown) => parse<unknown[]>(value, []).flatMap((item) => { const found = normalizeCandidate(item); return found ? [found] : []; });

export class TravelStore {
  private readonly db: InstanceType<typeof DatabaseSync>;
  constructor(filename: string) { this.db = new DatabaseSync(filename); this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;"); this.migrate(); }
  close() { this.db.close(); }
  private migrate() {
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 4) throw new Error("travel.sqlite3 版本高于当前应用，已停止写入。");
    if (version.user_version === 0) {
      this.db.exec(`
        CREATE TABLE trips (id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','trashed')), codex_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE requirements (trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, revision INTEGER NOT NULL, content_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY(trip_id, revision));
        CREATE TABLE itinerary_revisions (trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, version INTEGER NOT NULL, plan_json TEXT NOT NULL, requirements_revision INTEGER NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL, summary TEXT NOT NULL, PRIMARY KEY(trip_id, version));
        CREATE TABLE messages (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, reply_json TEXT, status TEXT NOT NULL, turn_status TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, progress_message TEXT, error_message TEXT, codex_turn_id TEXT, created_at TEXT NOT NULL);
        CREATE TABLE activity_locations (trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, revision INTEGER NOT NULL, activity_id TEXT NOT NULL, candidate_json TEXT NOT NULL, PRIMARY KEY(trip_id, revision, activity_id));
        CREATE INDEX messages_trip_created ON messages(trip_id, created_at);
        PRAGMA user_version = 1;
      `);
    }
    const current = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (current === 1) {
      this.db.exec(`
        ALTER TABLE trips ADD COLUMN map_codex_thread_id TEXT;
        CREATE TABLE ai_tasks (
          id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          agent TEXT NOT NULL CHECK(agent IN ('planner','map')), label TEXT NOT NULL,
          status TEXT NOT NULL, summary TEXT NOT NULL, started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, can_stop INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE ai_progress_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, agent TEXT NOT NULL,
          status TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX ai_progress_trip_created ON ai_progress_events(trip_id, created_at);
        CREATE TABLE map_manifests (
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, itinerary_version INTEGER NOT NULL,
          map_version INTEGER NOT NULL, base_map_version INTEGER NOT NULL, status TEXT NOT NULL,
          summary TEXT NOT NULL, warnings_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(trip_id, itinerary_version), UNIQUE(trip_id, map_version)
        );
        CREATE TABLE map_entities (
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, itinerary_version INTEGER NOT NULL,
          entity_id TEXT NOT NULL, data_json TEXT NOT NULL, status TEXT NOT NULL,
          candidate_json TEXT, candidates_json TEXT NOT NULL, warning TEXT,
          PRIMARY KEY(trip_id, itinerary_version, entity_id)
        );
        CREATE TABLE map_routes (
          trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, itinerary_version INTEGER NOT NULL,
          route_id TEXT NOT NULL, data_json TEXT NOT NULL, status TEXT NOT NULL,
          geometry_json TEXT, warning TEXT,
          PRIMARY KEY(trip_id, itinerary_version, route_id)
        );
        PRAGMA user_version = 2;
      `);
    }
    const afterMaps = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (afterMaps === 2) {
      this.db.exec(`
        ALTER TABLE map_manifests ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 1;
        PRAGMA user_version = 3;
      `);
    }
    const afterContract = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (afterContract === 3) this.db.exec("ALTER TABLE map_manifests ADD COLUMN day_paths_json TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version = 4;");
  }
  private activeRevision(tripId: string) { const row = this.db.prepare("SELECT version, plan_json FROM itinerary_revisions WHERE trip_id=? ORDER BY version DESC LIMIT 1").get(tripId) as DbRow | undefined; if (!row) return null; const plan = TripPlanSchema.safeParse(parse(row.plan_json, null)); return plan.success ? { id: `${tripId}:${row.version}`, version: Number(row.version), plan: plan.data } : null; }
  private latestRequirements(tripId: string) { const row = this.db.prepare("SELECT revision, content_json, updated_at, updated_by FROM requirements WHERE trip_id=? ORDER BY revision DESC LIMIT 1").get(tripId) as DbRow | undefined; if (!row) return { revision: 0, content: emptyRequirements(), updatedAt: "", updatedBy: "system" }; const content = RequirementsSchema.safeParse(parse(row.content_json, {})); return { revision: Number(row.revision), content: content.success ? content.data : emptyRequirements(), updatedAt: String(row.updated_at), updatedBy: String(row.updated_by) }; }
  private summary(row: DbRow): TripSummary { const revision = this.activeRevision(String(row.id)); return { id: String(row.id), title: String(row.title), state: String(row.state) as TripState, updatedAt: String(row.updated_at), activeRevision: revision }; }
  listTrips(view: TripState = "active") { return (this.db.prepare("SELECT * FROM trips WHERE state=? ORDER BY updated_at DESC").all(view) as DbRow[]).map((row) => this.summary(row)); }
  createTrip() { const id = randomUUID(); const now = iso(); this.db.prepare("INSERT INTO trips(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "未命名旅行", "active", now, now); this.db.prepare("INSERT INTO requirements(trip_id,revision,content_json,updated_at,updated_by) VALUES(?,?,?,?,?)").run(id, 1, json(emptyRequirements()), now, "system"); return this.getTrip(id)!; }
  getTrip(id: string): TripDetail | null { const row = this.db.prepare("SELECT * FROM trips WHERE id=?").get(id) as DbRow | undefined; if (!row) return null; const requirements = this.latestRequirements(id); return { ...this.summary(row), requirements: requirements.content, requirementsRevision: requirements.revision, codexThreadId: typeof row.codex_thread_id === "string" ? row.codex_thread_id : null, mapCodexThreadId: typeof row.map_codex_thread_id === "string" ? row.map_codex_thread_id : null }; }
  requirementsDocument(id: string) { this.requireTrip(id); return this.latestRequirements(id); }
  requireTrip(id: string) { const trip = this.getTrip(id); if (!trip) throw new Error("找不到这趟旅行。"); return trip; }
  rename(id: string, title: string) { const trimmed = title.trim().slice(0, 200); if (!trimmed) throw new Error("旅行名称不能为空。"); this.db.prepare("UPDATE trips SET title=?, updated_at=? WHERE id=?").run(trimmed, iso(), id); return this.requireTrip(id); }
  duplicate(id: string) {
    const source = this.requireTrip(id); const req = this.latestRequirements(id); const nextId = randomUUID(); const now = iso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO trips(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)").run(nextId, `${source.title} 副本`, "active", now, now);
      this.db.prepare("INSERT INTO requirements(trip_id,revision,content_json,updated_at,updated_by) VALUES(?,?,?,?,?)").run(nextId, 1, json(req.content), now, "system");
      if (source.activeRevision) {
        this.db.prepare("INSERT INTO itinerary_revisions(trip_id,version,plan_json,requirements_revision,created_at,source,summary) VALUES(?,?,?,?,?,?,?)").run(nextId, 1, json(source.activeRevision.plan), 1, now, "duplicate", `复制自 ${source.title}`);
        const manifest = this.db.prepare("SELECT * FROM map_manifests WHERE trip_id=? AND itinerary_version=?").get(id, source.activeRevision.version) as DbRow | undefined;
        if (manifest) {
          const hasRenderableMapData = this.mapEntities(id, source.activeRevision.version).some((item) => item.location !== null) || this.mapRoutes(id, source.activeRevision.version).some((item) => item.geometry !== null);
          const active = ["queued", "analyzing", "resolving"].includes(String(manifest.status));
          const status = active ? (hasRenderableMapData ? "partial" : "idle") : String(manifest.status);
          const summary = active ? (hasRenderableMapData ? "复制的部分地图，可继续重试完成" : "等待地图 Agent") : String(manifest.summary);
          this.db.prepare("INSERT INTO map_manifests(trip_id,itinerary_version,map_version,base_map_version,status,summary,warnings_json,created_at,updated_at,contract_version,day_paths_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(nextId, 1, 1, 0, status, summary, String(manifest.warnings_json), now, now, Number(manifest.contract_version ?? 3), String(manifest.day_paths_json ?? "[]"));
          const entities = this.db.prepare("SELECT * FROM map_entities WHERE trip_id=? AND itinerary_version=?").all(id, source.activeRevision.version) as DbRow[];
          for (const row of entities) this.db.prepare("INSERT INTO map_entities(trip_id,itinerary_version,entity_id,data_json,status,candidate_json,candidates_json,warning) VALUES(?,?,?,?,?,?,?,?)").run(nextId, 1, String(row.entity_id), String(row.data_json), String(row.status), typeof row.candidate_json === "string" ? row.candidate_json : null, String(row.candidates_json), typeof row.warning === "string" ? row.warning : null);
          const routes = this.db.prepare("SELECT * FROM map_routes WHERE trip_id=? AND itinerary_version=?").all(id, source.activeRevision.version) as DbRow[];
          for (const row of routes) this.db.prepare("INSERT INTO map_routes(trip_id,itinerary_version,route_id,data_json,status,geometry_json,warning) VALUES(?,?,?,?,?,?,?)").run(nextId, 1, String(row.route_id), String(row.data_json), String(row.status), typeof row.geometry_json === "string" ? row.geometry_json : null, typeof row.warning === "string" ? row.warning : null);
        }
      }
      this.db.exec("COMMIT"); return this.requireTrip(nextId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  setState(id: string, state: TripState) { this.db.prepare("UPDATE trips SET state=?, updated_at=? WHERE id=?").run(state, iso(), id); return this.requireTrip(id); }
  permanentDelete(id: string) { this.db.prepare("DELETE FROM trips WHERE id=?").run(id); }
  setThread(id: string, threadId: string | null) { this.db.prepare("UPDATE trips SET codex_thread_id=?, updated_at=? WHERE id=?").run(threadId, iso(), id); }
  setMapThread(id: string, threadId: string | null) { this.db.prepare("UPDATE trips SET map_codex_thread_id=?, updated_at=? WHERE id=?").run(threadId, iso(), id); }
  saveRequirements(id: string, content: unknown, expectedRevision: number, updatedBy: "user" | "agent" | "system" = "user") { const current = this.latestRequirements(id); if (current.revision !== expectedRevision) throw new Error("需求总览已被更新，请重新读取后再保存。"); const parsed = RequirementsSchema.parse(content); const revision = current.revision + 1; const now = iso(); this.db.prepare("INSERT INTO requirements(trip_id,revision,content_json,updated_at,updated_by) VALUES(?,?,?,?,?)").run(id, revision, json(parsed), now, updatedBy); this.db.prepare("UPDATE trips SET updated_at=? WHERE id=?").run(now, id); return { revision, content: parsed, updatedAt: now, updatedBy };
  }
  listMessages(tripId: string): ChatMessage[] { return (this.db.prepare("SELECT * FROM messages WHERE trip_id=? ORDER BY created_at ASC").all(tripId) as DbRow[]).map((row) => ({ id: String(row.id), role: String(row.role) as "user" | "assistant", content: String(row.content), reply: row.reply_json ? parse<TravelAgentOutput | null>(row.reply_json, null) : null, status: String(row.status) as ChatMessage["status"], turn: row.turn_status ? { status: String(row.turn_status) as NonNullable<ChatMessage["turn"]>["status"], cancelRequested: Boolean(row.cancel_requested), errorMessage: row.error_message ? String(row.error_message) : null, ...(row.progress_message ? { progressMessage: String(row.progress_message) } : {}) } : null, createdAt: String(row.created_at) })); }
  createUserMessage(tripId: string, content: string, retryOf?: string | null) { const id = randomUUID(); const now = iso(); this.db.prepare("INSERT INTO messages(id,trip_id,role,content,status,turn_status,progress_message,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, tripId, "user", content, "pending", "queued", retryOf ? "正在重试请求" : "请求已提交", now); return id; }
  updateTurn(messageId: string, status: NonNullable<ChatMessage["turn"]>["status"], patch: { progress?: string; error?: string | null; cancelRequested?: boolean; codexTurnId?: string } = {}) { const completed = ["completed", "failed", "interrupted"].includes(status); this.db.prepare("UPDATE messages SET status=?,turn_status=?,progress_message=?,error_message=?,cancel_requested=?,codex_turn_id=COALESCE(?,codex_turn_id) WHERE id=?").run(completed && status === "completed" ? "completed" : completed ? "failed" : "pending", status, patch.progress ?? null, patch.error ?? null, patch.cancelRequested ? 1 : 0, patch.codexTurnId ?? null, messageId); }
  private insertRevision(tripId: string, plan: TripPlan, requirementsRevision: number, source: string, summary: string) { const next = Number((this.db.prepare("SELECT COALESCE(MAX(version),0) AS value FROM itinerary_revisions WHERE trip_id=?").get(tripId) as DbRow).value) + 1; const now = iso(); this.db.prepare("INSERT INTO itinerary_revisions(trip_id,version,plan_json,requirements_revision,created_at,source,summary) VALUES(?,?,?,?,?,?,?)").run(tripId, next, json(plan), requirementsRevision, now, source, summary.slice(0, 240)); this.db.prepare("UPDATE trips SET title=?,updated_at=? WHERE id=?").run(plan.tripName.slice(0, 200), now, tripId); return next; }
  applyAgentOutput(tripId: string, userMessageId: string, output: TravelAgentOutput) { this.db.exec("BEGIN IMMEDIATE"); try { const current = this.latestRequirements(tripId); const req = this.saveRequirements(tripId, output.requirements, current.revision, "agent"); let version: number | null = null; if (output.plan) version = this.insertRevision(tripId, output.plan, req.revision, "agent", output.assistantMessage.replace(/\s+/g, " ")); const now = iso(); this.db.prepare("INSERT INTO messages(id,trip_id,role,content,reply_json,status,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), tripId, "assistant", output.assistantMessage, json(output), "completed", now); this.updateTurn(userMessageId, "completed", { progress: version ? `行程已更新为 v${version}` : "需求已整理" }); this.db.exec("COMMIT"); return { version, requirements: req }; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  listRevisions(tripId: string): RevisionSummary[] { return (this.db.prepare("SELECT version,created_at,source,summary FROM itinerary_revisions WHERE trip_id=? ORDER BY version DESC").all(tripId) as DbRow[]).map((row) => ({ version: Number(row.version), createdAt: String(row.created_at), source: String(row.source), summary: String(row.summary) })); }
  getRevision(tripId: string, version: number) { const row = this.db.prepare("SELECT * FROM itinerary_revisions WHERE trip_id=? AND version=?").get(tripId, version) as DbRow | undefined; if (!row) return null; const plan = TripPlanSchema.parse(parse(row.plan_json, {})); const requirements = this.db.prepare("SELECT content_json FROM requirements WHERE trip_id=? AND revision=?").get(tripId, Number(row.requirements_revision)) as DbRow | undefined; return { version: Number(row.version), createdAt: String(row.created_at), source: String(row.source), summary: String(row.summary), plan, requirements: RequirementsSchema.parse(parse(requirements?.content_json, {})) }; }
  restoreRevision(tripId: string, version: number) { const old = this.getRevision(tripId, version); if (!old) throw new Error("找不到该行程版本。"); this.db.exec("BEGIN IMMEDIATE"); try { const current = this.latestRequirements(tripId); const req = this.saveRequirements(tripId, old.requirements, current.revision, "system"); const next = this.insertRevision(tripId, old.plan, req.revision, "restore", `从 v${version} 恢复`); this.db.exec("COMMIT"); return { version: next, trip: this.requireTrip(tripId) }; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  selectedLocation(tripId: string, revision: number, activityId: string): Candidate | null { const row = this.db.prepare("SELECT candidate_json FROM activity_locations WHERE trip_id=? AND revision=? AND activity_id=?").get(tripId, revision, activityId) as DbRow | undefined; return row ? parse<Candidate | null>(row.candidate_json, null) : null; }
  selectLocation(tripId: string, revision: number, activityId: string, candidate: Candidate) { this.db.prepare("INSERT INTO activity_locations(trip_id,revision,activity_id,candidate_json) VALUES(?,?,?,?) ON CONFLICT(trip_id,revision,activity_id) DO UPDATE SET candidate_json=excluded.candidate_json").run(tripId, revision, activityId, json(candidate)); }

  upsertAiTask(input: { id: string; tripId: string; agent: AiAgentKind; label: string; status: AiTaskStatus; summary: string; canStop: boolean; resetStartedAt?: boolean }) {
    const now = iso(); const existing = this.db.prepare("SELECT started_at FROM ai_tasks WHERE id=?").get(input.id) as DbRow | undefined;
    const startedAt = existing && !input.resetStartedAt ? String(existing.started_at) : now;
    this.db.prepare(`INSERT INTO ai_tasks(id,trip_id,agent,label,status,summary,started_at,updated_at,can_stop) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,summary=excluded.summary,started_at=excluded.started_at,updated_at=excluded.updated_at,can_stop=excluded.can_stop,label=excluded.label`).run(input.id, input.tripId, input.agent, input.label, input.status, input.summary, startedAt, now, input.canStop ? 1 : 0);
    return this.getAiTask(input.id)!;
  }
  appendAiProgress(taskId: string, status: AiTaskStatus, kind: string, summary: string) {
    const task = this.db.prepare("SELECT trip_id,agent FROM ai_tasks WHERE id=?").get(taskId) as DbRow | undefined; if (!task) return null;
    const now = iso(); const segment = this.db.prepare("SELECT id FROM ai_progress_events WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT 1").get(taskId, kind) as DbRow | undefined;
    if (segment && (kind.startsWith("reasoning:") || kind.startsWith("plan:"))) this.db.prepare("UPDATE ai_progress_events SET status=?,summary=?,created_at=? WHERE id=?").run(status, summary, now, Number(segment.id));
    else this.db.prepare("INSERT INTO ai_progress_events(task_id,trip_id,agent,status,kind,summary,created_at) VALUES(?,?,?,?,?,?,?)").run(taskId, String(task.trip_id), String(task.agent), status, kind, summary, now);
    this.db.prepare("UPDATE ai_tasks SET status=?,summary=?,updated_at=?,can_stop=? WHERE id=?").run(status, summary, now, ["running","reconnecting"].includes(status) ? 1 : 0, taskId);
    return this.getAiTask(taskId);
  }
  getAiTask(id: string): AiTaskSnapshot | null { const row = this.db.prepare("SELECT * FROM ai_tasks WHERE id=?").get(id) as DbRow | undefined; return row ? this.aiTask(row) : null; }
  listAiTasks(tripId: string): AiTaskSnapshot[] { return (this.db.prepare("SELECT * FROM ai_tasks WHERE trip_id=? ORDER BY updated_at DESC").all(tripId) as DbRow[]).map((row) => this.aiTask(row)); }
  private aiTask(row: DbRow): AiTaskSnapshot { const events = (this.db.prepare("SELECT * FROM ai_progress_events WHERE task_id=? ORDER BY id ASC").all(String(row.id)) as DbRow[]).map((event) => ({ id: Number(event.id), taskId: String(event.task_id), tripId: String(event.trip_id), agent: String(event.agent) as AiAgentKind, status: String(event.status) as AiTaskStatus, kind: String(event.kind), summary: String(event.summary), createdAt: String(event.created_at) })); return { id: String(row.id), tripId: String(row.trip_id), agent: String(row.agent) as AiAgentKind, label: String(row.label), status: String(row.status) as AiTaskStatus, summary: String(row.summary), startedAt: String(row.started_at), updatedAt: String(row.updated_at), canStop: Boolean(row.can_stop), events }; }

  latestMapMeta(tripId: string, beforeItineraryVersion?: number) { const row = this.db.prepare(`SELECT * FROM map_manifests WHERE trip_id=? ${beforeItineraryVersion ? "AND itinerary_version<?" : ""} ORDER BY itinerary_version DESC LIMIT 1`).get(...(beforeItineraryVersion ? [tripId, beforeItineraryVersion] : [tripId])) as DbRow | undefined; return row ? { itineraryVersion: Number(row.itinerary_version), mapVersion: Number(row.map_version), baseMapVersion: Number(row.base_map_version), contractVersion: Number(row.contract_version ?? 1), status: String(row.status) as MapJobStatus, summary: String(row.summary), warnings: parse<string[]>(row.warnings_json, []) } : null; }
  prepareMapManifest(tripId: string, itineraryVersion: number, reusableActivityIds: string[], forceRebuild = false) {
    const found = this.db.prepare("SELECT * FROM map_manifests WHERE trip_id=? AND itinerary_version=?").get(tripId, itineraryVersion) as DbRow | undefined;
    if (found && !forceRebuild) return { itineraryVersion, mapVersion: Number(found.map_version), baseMapVersion: Number(found.base_map_version), removedEntityIds: [] as string[], removedRouteIds: [] as string[] };
    if (found && forceRebuild) {
      const mapVersion = Number((this.db.prepare("SELECT COALESCE(MAX(map_version),0) AS value FROM map_manifests WHERE trip_id=?").get(tripId) as DbRow).value) + 1;
      const baseMapVersion = Number(found.map_version);
      const removedEntityIds = this.mapEntities(tripId, itineraryVersion).map((item) => item.id);
      const removedRouteIds = this.mapRoutes(tripId, itineraryVersion).map((item) => item.id);
      this.db.exec("BEGIN IMMEDIATE"); try {
        this.db.prepare("DELETE FROM map_routes WHERE trip_id=? AND itinerary_version=?").run(tripId, itineraryVersion);
        this.db.prepare("DELETE FROM map_entities WHERE trip_id=? AND itinerary_version=?").run(tripId, itineraryVersion);
        this.db.prepare("UPDATE map_manifests SET map_version=?,base_map_version=?,status='queued',summary='等待地图 Agent 重新拆分地点',day_paths_json='[]',updated_at=? WHERE trip_id=? AND itinerary_version=?").run(mapVersion, baseMapVersion, iso(), tripId, itineraryVersion);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      return { itineraryVersion, mapVersion, baseMapVersion, removedEntityIds, removedRouteIds };
    }
    const previous = this.latestMapMeta(tripId, itineraryVersion); const mapVersion = Number((this.db.prepare("SELECT COALESCE(MAX(map_version),0) AS value FROM map_manifests WHERE trip_id=?").get(tripId) as DbRow).value) + 1; const now = iso();
    this.db.exec("BEGIN IMMEDIATE"); try {
      this.db.prepare("INSERT INTO map_manifests(trip_id,itinerary_version,map_version,base_map_version,status,summary,warnings_json,created_at,updated_at,contract_version,day_paths_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(tripId, itineraryVersion, mapVersion, previous?.mapVersion ?? 0, "queued", "等待地图 Agent 分析", "[]", now, now, 3, "[]");
      if (previous) {
        const reusable = new Set(reusableActivityIds); const entityRows = this.db.prepare("SELECT * FROM map_entities WHERE trip_id=? AND itinerary_version=?").all(tripId, previous.itineraryVersion) as DbRow[]; const copied = new Set<string>();
        for (const row of entityRows) { const data = parse<MapEntityPatch | null>(row.data_json, null); if (!data || (data.activityId && !reusable.has(data.activityId))) continue; this.db.prepare("INSERT INTO map_entities(trip_id,itinerary_version,entity_id,data_json,status,candidate_json,candidates_json,warning) VALUES(?,?,?,?,?,?,?,?)").run(tripId, itineraryVersion, String(row.entity_id), String(row.data_json), String(row.status), typeof row.candidate_json === "string" ? row.candidate_json : null, String(row.candidates_json), typeof row.warning === "string" ? row.warning : null); copied.add(String(row.entity_id)); }
        const routeRows = this.db.prepare("SELECT * FROM map_routes WHERE trip_id=? AND itinerary_version=?").all(tripId, previous.itineraryVersion) as DbRow[];
        for (const row of routeRows) { const data = parse<MapRoutePatch | null>(row.data_json, null); if (!data || !copied.has(data.fromEntityId) || !copied.has(data.toEntityId)) continue; this.db.prepare("INSERT INTO map_routes(trip_id,itinerary_version,route_id,data_json,status,geometry_json,warning) VALUES(?,?,?,?,?,?,?)").run(tripId, itineraryVersion, String(row.route_id), String(row.data_json), String(row.status), typeof row.geometry_json === "string" ? row.geometry_json : null, typeof row.warning === "string" ? row.warning : null); }
      }
      this.db.exec("COMMIT"); return { itineraryVersion, mapVersion, baseMapVersion: previous?.mapVersion ?? 0, removedEntityIds: [] as string[], removedRouteIds: [] as string[] };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  setMapStatus(tripId: string, itineraryVersion: number, status: MapJobStatus, summary: string, warnings?: string[]) { this.db.prepare("UPDATE map_manifests SET status=?,summary=?,warnings_json=COALESCE(?,warnings_json),updated_at=? WHERE trip_id=? AND itinerary_version=?").run(status, summary.slice(0, 500), warnings ? json(warnings) : null, iso(), tripId, itineraryVersion); }
  mapContext(tripId: string, itineraryVersion: number) { const meta = this.latestMapMeta(tripId, itineraryVersion + 1); if (!meta || meta.itineraryVersion !== itineraryVersion) return null; const entities = this.mapEntities(tripId, itineraryVersion); const routes = this.mapRoutes(tripId, itineraryVersion); return { ...meta, entities: entities.map(({ location: _location, candidates: _candidates, status: _status, warning: _warning, ...item }) => item), routes: routes.map(({ geometry: _geometry, status: _status, warning: _warning, ...item }) => item) }; }
  applyMapPatch(tripId: string, itineraryVersion: number, expectedBaseMapVersion: number, patch: MapAgentOutput, replaceAll = false) {
    const meta = this.latestMapMeta(tripId, itineraryVersion + 1); if (!meta || meta.itineraryVersion !== itineraryVersion || meta.baseMapVersion !== expectedBaseMapVersion || patch.baseMapVersion !== expectedBaseMapVersion || patch.baseItineraryVersion !== itineraryVersion) throw new Error("地图补丁基线已经过期。");
    this.db.exec("BEGIN IMMEDIATE"); try {
      const removedEntityIds = new Set<string>();
      const removedRouteIds = new Set<string>();
      const captureRemoved = (entityIds: string[], routeIds: string[]) => {
        for (const id of entityIds) removedEntityIds.add(id);
        for (const id of routeIds) removedRouteIds.add(id);
      };
      if (replaceAll) captureRemoved(
        this.mapEntities(tripId, itineraryVersion).map((item) => item.id),
        this.mapRoutes(tripId, itineraryVersion).map((item) => item.id),
      );
      if (replaceAll) { this.db.prepare("DELETE FROM map_routes WHERE trip_id=? AND itinerary_version=?").run(tripId, itineraryVersion); this.db.prepare("DELETE FROM map_entities WHERE trip_id=? AND itinerary_version=?").run(tripId, itineraryVersion); }
      for (const id of patch.removeRouteIds) { if (this.mapRoutes(tripId, itineraryVersion).some((item) => item.id === id)) removedRouteIds.add(id); this.db.prepare("DELETE FROM map_routes WHERE trip_id=? AND itinerary_version=? AND route_id=?").run(tripId, itineraryVersion, id); }
      for (const id of patch.removeEntityIds) {
        if (this.mapEntities(tripId, itineraryVersion).some((item) => item.id === id)) removedEntityIds.add(id);
        for (const route of this.mapRoutes(tripId, itineraryVersion)) if (route.fromEntityId === id || route.toEntityId === id) removedRouteIds.add(route.id);
        this.db.prepare("DELETE FROM map_routes WHERE trip_id=? AND itinerary_version=? AND (json_extract(data_json,'$.fromEntityId')=? OR json_extract(data_json,'$.toEntityId')=?)").run(tripId, itineraryVersion, id, id); this.db.prepare("DELETE FROM map_entities WHERE trip_id=? AND itinerary_version=? AND entity_id=?").run(tripId, itineraryVersion, id);
      }
      for (const item of patch.upsertEntities) this.db.prepare(`INSERT INTO map_entities(trip_id,itinerary_version,entity_id,data_json,status,candidate_json,candidates_json,warning) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(trip_id,itinerary_version,entity_id) DO UPDATE SET data_json=excluded.data_json,status='pending',candidate_json=NULL,candidates_json='[]',warning=NULL`).run(tripId, itineraryVersion, item.id, json(item), "pending", null, "[]", null);
      for (const item of patch.upsertRoutes) this.db.prepare(`INSERT INTO map_routes(trip_id,itinerary_version,route_id,data_json,status,geometry_json,warning) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(trip_id,itinerary_version,route_id) DO UPDATE SET data_json=excluded.data_json,status='pending',geometry_json=NULL,warning=NULL`).run(tripId, itineraryVersion, item.id, json(item), "pending", null, null);
      const entities = this.mapEntities(tripId, itineraryVersion); const routes = this.mapRoutes(tripId, itineraryVersion); const ids = new Set(entities.map((item) => item.id)); for (const route of routes) if (!ids.has(route.fromEntityId) || !ids.has(route.toEntityId)) throw new Error(`路线 ${route.id} 引用了不存在的地点。`);
      const paths = [...patch.dayPaths].sort((a, b) => a.dayNumber - b.dayNumber); const itineraryDays = this.getRevision(tripId, itineraryVersion)?.plan.days.map((day) => day.dayNumber) ?? [];
      if (paths.length !== itineraryDays.length || paths.some((path, index) => path.dayNumber !== itineraryDays[index])) throw new Error("每日路径必须覆盖当前行程的每一天且仅一次。");
      const routeKeys = new Set<string>(); const expectedKeys = new Set<string>();
      for (let index = 0; index < paths.length; index += 1) {
        const path = paths[index];
        if (path.entityIds[0] !== path.startEntityId || path.entityIds.at(-1) !== path.endEntityId || path.endEntityId !== path.overnightEntityId) throw new Error(`Day ${path.dayNumber} 路径首尾不一致。`);
        const repeats = path.entityIds.filter((id, position) => path.entityIds.indexOf(id) !== position);
        const roundTripLodging = path.entityIds.length > 2 && path.entityIds[0] === path.entityIds.at(-1) && repeats.length === 1 && path.entityIds.filter((id) => id === path.entityIds[0]).length === 2;
        if (repeats.length && !roundTripLodging) throw new Error(`Day ${path.dayNumber} 路径包含重复地点。`);
        for (const id of path.entityIds) if (!ids.has(id)) throw new Error(`Day ${path.dayNumber} 路径引用不存在地点。`);
        for (let n = 0; n < path.entityIds.length - 1; n += 1) expectedKeys.add(`${path.dayNumber}:${path.entityIds[n]}>${path.entityIds[n + 1]}`);
        if (index < paths.length - 1) { const next = paths[index + 1]; const overnight = entities.find((entity) => entity.id === path.overnightEntityId); if (overnight?.kind !== "lodging" || next.startEntityId !== path.overnightEntityId) throw new Error(`Day ${path.dayNumber} 必须以住宿结束并作为次日出发点。`); }
      }
      for (const route of routes) { const key = `${route.dayNumber}:${route.fromEntityId}>${route.toEntityId}`; if (routeKeys.has(key)) throw new Error(`路线重复：${key}`); routeKeys.add(key); if (!expectedKeys.has(key)) throw new Error(`路线 ${route.id} 不属于每日路径。`); }
      if (routeKeys.size !== expectedKeys.size || [...expectedKeys].some((key) => !routeKeys.has(key))) throw new Error("每日路径存在断链。");
      this.db.prepare("UPDATE map_manifests SET contract_version=3,day_paths_json=? WHERE trip_id=? AND itinerary_version=?").run(json(paths), tripId, itineraryVersion);
      this.setMapStatus(tripId, itineraryVersion, "resolving", "正在解析地点与路线", patch.warnings); this.db.exec("COMMIT");
      return { removedEntityIds: [...removedEntityIds], removedRouteIds: [...removedRouteIds] };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  mapEntities(tripId: string, itineraryVersion: number): MapEntityView[] { return (this.db.prepare("SELECT * FROM map_entities WHERE trip_id=? AND itinerary_version=? ORDER BY json_extract(data_json,'$.dayNumber'),json_extract(data_json,'$.order')").all(tripId, itineraryVersion) as DbRow[]).flatMap((row) => { const data = parse<MapEntityPatch | null>(row.data_json, null); return data ? [{ ...data, approximateLodgingArea: data.approximateLodgingArea ?? false, status: String(row.status) as MapEntityView["status"], location: normalizeCandidate(parse<unknown>(row.candidate_json, null)), candidates: normalizeCandidates(row.candidates_json), warning: row.warning ? String(row.warning) : null }] : []; }); }
  mapRoutes(tripId: string, itineraryVersion: number): MapRouteView[] { return (this.db.prepare("SELECT * FROM map_routes WHERE trip_id=? AND itinerary_version=? ORDER BY json_extract(data_json,'$.dayNumber'),json_extract(data_json,'$.order')").all(tripId, itineraryVersion) as DbRow[]).flatMap((row) => { const data = parse<MapRoutePatch | null>(row.data_json, null); return data ? [{ ...data, status: String(row.status) as MapRouteView["status"], geometry: parse<unknown | null>(row.geometry_json, null), warning: row.warning ? String(row.warning) : null }] : []; }); }
  pendingMapEntities(tripId: string, itineraryVersion: number) { return this.mapEntities(tripId, itineraryVersion).filter((item) => item.status === "pending" || item.status === "failed" || item.status === "unresolved"); }
  pendingMapRoutes(tripId: string, itineraryVersion: number) { return this.mapRoutes(tripId, itineraryVersion).filter((item) => item.status === "pending" || item.status === "failed" || item.status === "unresolved"); }
  updateMapEntity(tripId: string, itineraryVersion: number, entityId: string, status: MapEntityView["status"], location: Candidate | null, candidates: Candidate[], warning: string | null) { this.db.prepare("UPDATE map_entities SET status=?,candidate_json=?,candidates_json=?,warning=? WHERE trip_id=? AND itinerary_version=? AND entity_id=?").run(status, location ? json(location) : null, json(candidates), warning, tripId, itineraryVersion, entityId); }
  updateMapRoute(tripId: string, itineraryVersion: number, routeId: string, status: MapRouteView["status"], geometry: unknown | null, warning: string | null) { this.db.prepare("UPDATE map_routes SET status=?,geometry_json=?,warning=? WHERE trip_id=? AND itinerary_version=? AND route_id=?").run(status, geometry ? json(geometry) : null, warning, tripId, itineraryVersion, routeId); }
  getMapSnapshot(tripId: string, scope: "all" | "day" = "all", dayNumber: number | null = null): MapSnapshot | null { const trip = this.requireTrip(tripId); const itineraryVersion = trip.activeRevision?.version; if (!itineraryVersion) return null; const meta = this.latestMapMeta(tripId, itineraryVersion + 1); if (!meta || meta.itineraryVersion !== itineraryVersion) return { itineraryVersion, mapVersion: 0, scope, dayNumber, status: "idle", summary: "等待地图 Agent", warnings: [], entities: [], routes: [], dayPaths: [] }; const paths = parse<MapDayPath[]>((this.db.prepare("SELECT day_paths_json FROM map_manifests WHERE trip_id=? AND itinerary_version=?").get(tripId, itineraryVersion) as DbRow).day_paths_json, []); const selected = scope === "day" && dayNumber ? paths.find((path) => path.dayNumber === dayNumber) : null; const allowed = selected ? new Set(selected.entityIds) : null; const entities = this.mapEntities(tripId, itineraryVersion); const routes = this.mapRoutes(tripId, itineraryVersion); return { itineraryVersion, mapVersion: meta.mapVersion, scope, dayNumber: scope === "day" ? dayNumber : null, status: meta.status, summary: meta.summary, warnings: meta.warnings, entities: allowed ? entities.filter((item) => allowed.has(item.id)) : entities, routes: selected ? routes.filter((item) => item.dayNumber === selected.dayNumber) : routes, dayPaths: scope === "day" && selected ? [selected] : paths }; }
  selectMapCandidate(tripId: string, itineraryVersion: number, entityId: string, candidate: Candidate) { this.updateMapEntity(tripId, itineraryVersion, entityId, "resolved", candidate, [candidate], null); this.db.prepare("UPDATE map_routes SET status='pending',geometry_json=NULL,warning=NULL WHERE trip_id=? AND itinerary_version=? AND (json_extract(data_json,'$.fromEntityId')=? OR json_extract(data_json,'$.toEntityId')=?)").run(tripId, itineraryVersion, entityId, entityId); }
  resetMapEntity(tripId: string, itineraryVersion: number, entityId: string, warning: string) { this.updateMapEntity(tripId, itineraryVersion, entityId, "pending", null, [], warning); this.db.prepare("UPDATE map_routes SET status='pending',geometry_json=NULL,warning=NULL WHERE trip_id=? AND itinerary_version=? AND (json_extract(data_json,'$.fromEntityId')=? OR json_extract(data_json,'$.toEntityId')=?)").run(tripId, itineraryVersion, entityId, entityId); }
}
