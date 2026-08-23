import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AiAgentKind, AiTaskSnapshot, AiTaskStatus, Candidate, MapAgentOutput, MapDayPath, MapDayProgress, MapEntityPatch, MapEntityView, MapJobStatus, MapRoutePatch, MapRouteView, MapSnapshot, MapVisit, TravelAgentOutput, TravelRequirements, TripPlan } from "./contracts.js";
import { emptyRequirements, RequirementsSchema, TripPlanSchema } from "./contracts.js";

type SqliteModule = typeof import("node:sqlite");
const sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
const { DatabaseSync } = sqlite;

export type TripState = "active" | "trashed";
export type ItineraryLanguage = "zh" | "en" | "bilingual";
export type TripSummary = { id: string; title: string; state: TripState; updatedAt: string; itineraryLanguage: ItineraryLanguage; activeRevision: { id: string; version: number; plan: TripPlan } | null };
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
  return { providerPlaceId: item.providerPlaceId, displayName: item.displayName, latitude: Number(item.latitude), longitude: Number(item.longitude), category: item.category ?? null, placeType: item.placeType ?? null, countryCode: item.countryCode?.toLowerCase() ?? null, region: item.region ?? null, city: item.city ?? null, sourceUrl: item.sourceUrl || `https://www.openstreetmap.org/?mlat=${item.latitude}&mlon=${item.longitude}`, sourceType: item.sourceType ?? "nominatim", evidenceUrl: item.evidenceUrl ?? null, confidence: item.confidence ?? "high", decisionNote: item.decisionNote ?? null };
};
const normalizeCandidates = (value: unknown) => parse<unknown[]>(value, []).flatMap((item) => { const found = normalizeCandidate(item); return found ? [found] : []; });
/** Stable internal identity; this is deliberately never used as the map label. */
export const canonicalPlaceKey = (name: string, city = "", region = "", country = "") => [name, city, region, country]
  .map((part) => part.trim().toLocaleLowerCase().replace(/\s+/g, " ")).join("|");
// Keep official place names intact; this only separates generated functional suffixes.
export const normalizeGeneratedPlaceName = (value: string) => value.trim()
  .replace(/\s+(市区|住宿(?:区域)?(?:（约）)?|酒店区域|景区|博物馆|花园|植物园|公园|海滩|中心|区域|机场|火车站|高铁站|汽车站|码头|渡轮码头)$/u, " $1")
  .replace(/(?<=[\p{Script=Han}A-Za-z])(?=(?:市区|住宿(?:区域)?(?:（约）)?|酒店区域|景区|博物馆|花园|植物园|公园|海滩|中心|区域|机场|火车站|高铁站|汽车站|码头|渡轮码头)$)/u, " ");
const normalizeGeneratedPlan = (plan: TripPlan): TripPlan => ({ ...plan, days: plan.days.map((day) => ({ ...day, activities: day.activities.map((activity) => ({ ...activity, placeName: normalizeGeneratedPlaceName(activity.placeName) })) })) });

export class TravelStore {
  private readonly db: InstanceType<typeof DatabaseSync>;
  constructor(filename: string) { this.db = new DatabaseSync(filename); this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;"); this.migrate(); }
  close() { this.db.close(); }
  private migrate() {
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 8) throw new Error("travel.sqlite3 版本高于当前应用，已停止写入。");
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
    const v4 = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v4 === 4) this.db.exec(`
      ALTER TABLE map_manifests ADD COLUMN patch_sequence INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE map_visits (
        trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, itinerary_version INTEGER NOT NULL,
        visit_id TEXT NOT NULL, place_id TEXT NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY(trip_id, itinerary_version, visit_id)
      );
      CREATE INDEX map_visits_place ON map_visits(trip_id, itinerary_version, place_id);
      PRAGMA user_version = 5;
    `);
    const v5 = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v5 === 5) this.db.exec(`
      ALTER TABLE map_entities ADD COLUMN canonical_key TEXT;
      CREATE UNIQUE INDEX map_entities_canonical_v4 ON map_entities(trip_id,itinerary_version,canonical_key) WHERE canonical_key IS NOT NULL;
      PRAGMA user_version = 6;
    `);
    const v6 = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    // Some pre-v4 test/repair databases contain only map tables.  Preserve
    // their historical partial-migration behaviour; real travel databases
    // always include `trips` and receive the V7 column.
    if (v6 === 6 && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trips'").get()) this.db.exec("ALTER TABLE trips ADD COLUMN itinerary_language TEXT NOT NULL DEFAULT 'bilingual' CHECK(itinerary_language IN ('zh','en','bilingual')); PRAGMA user_version = 7;");
    const v7 = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v7 === 7) this.db.exec(`
      CREATE TABLE map_day_runs (
        trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        itinerary_version INTEGER NOT NULL,
        day_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        generation_retries INTEGER NOT NULL DEFAULT 0,
        repair_retries INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(trip_id, itinerary_version, day_number)
      );
      PRAGMA user_version = 8;
    `);
  }
  private activeRevision(tripId: string) { const row = this.db.prepare("SELECT version, plan_json FROM itinerary_revisions WHERE trip_id=? ORDER BY version DESC LIMIT 1").get(tripId) as DbRow | undefined; if (!row) return null; const plan = TripPlanSchema.safeParse(parse(row.plan_json, null)); return plan.success ? { id: `${tripId}:${row.version}`, version: Number(row.version), plan: plan.data } : null; }
  private latestRequirements(tripId: string) { const row = this.db.prepare("SELECT revision, content_json, updated_at, updated_by FROM requirements WHERE trip_id=? ORDER BY revision DESC LIMIT 1").get(tripId) as DbRow | undefined; if (!row) return { revision: 0, content: emptyRequirements(), updatedAt: "", updatedBy: "system" }; const content = RequirementsSchema.safeParse(parse(row.content_json, {})); return { revision: Number(row.revision), content: content.success ? content.data : emptyRequirements(), updatedAt: String(row.updated_at), updatedBy: String(row.updated_by) }; }
  private summary(row: DbRow): TripSummary { const revision = this.activeRevision(String(row.id)); const language = row.itinerary_language; return { id: String(row.id), title: String(row.title), state: String(row.state) as TripState, updatedAt: String(row.updated_at), itineraryLanguage: language === "zh" || language === "en" || language === "bilingual" ? language : "bilingual", activeRevision: revision }; }
  listTrips(view: TripState = "active") { return (this.db.prepare("SELECT * FROM trips WHERE state=? ORDER BY updated_at DESC").all(view) as DbRow[]).map((row) => this.summary(row)); }
  createTrip() { const id = randomUUID(); const now = iso(); this.db.prepare("INSERT INTO trips(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "未命名旅行", "active", now, now); this.db.prepare("INSERT INTO requirements(trip_id,revision,content_json,updated_at,updated_by) VALUES(?,?,?,?,?)").run(id, 1, json(emptyRequirements()), now, "system"); return this.getTrip(id)!; }
  getTrip(id: string): TripDetail | null { const row = this.db.prepare("SELECT * FROM trips WHERE id=?").get(id) as DbRow | undefined; if (!row) return null; const requirements = this.latestRequirements(id); return { ...this.summary(row), requirements: requirements.content, requirementsRevision: requirements.revision, codexThreadId: typeof row.codex_thread_id === "string" ? row.codex_thread_id : null, mapCodexThreadId: typeof row.map_codex_thread_id === "string" ? row.map_codex_thread_id : null }; }
  requirementsDocument(id: string) { this.requireTrip(id); return this.latestRequirements(id); }
  requireTrip(id: string) { const trip = this.getTrip(id); if (!trip) throw new Error("找不到这趟旅行。"); return trip; }
  rename(id: string, title: string) { const trimmed = title.trim().slice(0, 200); if (!trimmed) throw new Error("旅行名称不能为空。"); this.db.prepare("UPDATE trips SET title=?, updated_at=? WHERE id=?").run(trimmed, iso(), id); return this.requireTrip(id); }
  setItineraryLanguage(id: string, language: ItineraryLanguage) { this.db.prepare("UPDATE trips SET itinerary_language=?, updated_at=? WHERE id=?").run(language, iso(), id); return this.requireTrip(id); }
  duplicate(id: string) {
    const source = this.requireTrip(id); const req = this.latestRequirements(id); const nextId = randomUUID(); const now = iso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO trips(id,title,state,itinerary_language,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(nextId, `${source.title} 副本`, "active", source.itineraryLanguage, now, now);
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
          for (const row of entities) this.db.prepare("INSERT INTO map_entities(trip_id,itinerary_version,entity_id,data_json,status,candidate_json,candidates_json,warning,canonical_key) VALUES(?,?,?,?,?,?,?,?,?)").run(nextId, 1, String(row.entity_id), String(row.data_json), String(row.status), typeof row.candidate_json === "string" ? row.candidate_json : null, String(row.candidates_json), typeof row.warning === "string" ? row.warning : null, typeof row.canonical_key === "string" ? row.canonical_key : null);
          const visits = this.db.prepare("SELECT * FROM map_visits WHERE trip_id=? AND itinerary_version=?").all(id, source.activeRevision.version) as DbRow[];
          for (const row of visits) this.db.prepare("INSERT INTO map_visits(trip_id,itinerary_version,visit_id,place_id,data_json) VALUES(?,?,?,?,?)").run(nextId, 1, String(row.visit_id), String(row.place_id), String(row.data_json));
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
  private insertRevision(tripId: string, plan: TripPlan, requirementsRevision: number, source: string, summary: string) { const normalized = normalizeGeneratedPlan(plan); const next = Number((this.db.prepare("SELECT COALESCE(MAX(version),0) AS value FROM itinerary_revisions WHERE trip_id=?").get(tripId) as DbRow).value) + 1; const now = iso(); this.db.prepare("INSERT INTO itinerary_revisions(trip_id,version,plan_json,requirements_revision,created_at,source,summary) VALUES(?,?,?,?,?,?,?)").run(tripId, next, json(normalized), requirementsRevision, now, source, summary.slice(0, 240)); this.db.prepare("UPDATE trips SET title=?,updated_at=? WHERE id=?").run(normalized.tripName.slice(0, 200), now, tripId); return next; }
  applyAgentOutput(tripId: string, userMessageId: string, output: TravelAgentOutput) { this.db.exec("BEGIN IMMEDIATE"); try { const normalizedOutput = output.plan ? { ...output, plan: normalizeGeneratedPlan(output.plan) } : output; const current = this.latestRequirements(tripId); const req = this.saveRequirements(tripId, normalizedOutput.requirements, current.revision, "agent"); let version: number | null = null; if (normalizedOutput.plan) version = this.insertRevision(tripId, normalizedOutput.plan, req.revision, "agent", normalizedOutput.assistantMessage.replace(/\s+/g, " ")); const now = iso(); this.db.prepare("INSERT INTO messages(id,trip_id,role,content,reply_json,status,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), tripId, "assistant", normalizedOutput.assistantMessage, json(normalizedOutput), "completed", now); this.updateTurn(userMessageId, "completed", { progress: version ? `行程已更新为 v${version}` : "需求已整理" }); this.db.exec("COMMIT"); return { version, requirements: req }; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
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
  initializeMapDayRuns(tripId: string, itineraryVersion: number, dayNumbers: number[]) {
    const statement = this.db.prepare("INSERT INTO map_day_runs(trip_id,itinerary_version,day_number,status,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(trip_id,itinerary_version,day_number) DO NOTHING");
    for (const dayNumber of dayNumbers) statement.run(tripId, itineraryVersion, dayNumber, "pending", iso());
  }
  updateMapDayRun(tripId: string, itineraryVersion: number, dayNumber: number, status: MapDayProgress["status"], patch: { generationRetries?: number; repairRetries?: number; error?: string | null } = {}) {
    const current = this.mapDayRuns(tripId, itineraryVersion).get(dayNumber);
    const generationRetries = patch.generationRetries ?? current?.generationRetries ?? 0;
    const repairRetries = patch.repairRetries ?? current?.repairRetries ?? 0;
    const error = patch.error === undefined ? current?.error ?? null : patch.error;
    this.db.prepare("INSERT INTO map_day_runs(trip_id,itinerary_version,day_number,status,generation_retries,repair_retries,error_message,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(trip_id,itinerary_version,day_number) DO UPDATE SET status=excluded.status,generation_retries=excluded.generation_retries,repair_retries=excluded.repair_retries,error_message=excluded.error_message,updated_at=excluded.updated_at")
      .run(tripId, itineraryVersion, dayNumber, status, generationRetries, repairRetries, error, iso());
  }
  resetFailedMapDayRuns(tripId: string, itineraryVersion: number) {
    const rows = this.db.prepare("SELECT day_number FROM map_day_runs WHERE trip_id=? AND itinerary_version=? AND status='failed'").all(tripId, itineraryVersion) as DbRow[];
    this.db.prepare("UPDATE map_day_runs SET status='pending',generation_retries=0,repair_retries=0,error_message=NULL,updated_at=? WHERE trip_id=? AND itinerary_version=? AND status='failed'").run(iso(), tripId, itineraryVersion);
    return rows.map((row) => Number(row.day_number));
  }
  mapDayRuns(tripId: string, itineraryVersion: number) { return new Map((this.db.prepare("SELECT * FROM map_day_runs WHERE trip_id=? AND itinerary_version=?").all(tripId, itineraryVersion) as DbRow[]).map((row) => [Number(row.day_number), { status: String(row.status) as MapDayProgress["status"], generationRetries: Number(row.generation_retries), repairRetries: Number(row.repair_retries), error: row.error_message ? String(row.error_message) : null }])); }
  /** Convert a readable v3 map in-place so recovery can be performed one day at a time. */
  upgradeLegacyMap(tripId: string, itineraryVersion: number) {
    const meta = this.latestMapMeta(tripId, itineraryVersion + 1); if (!meta || meta.itineraryVersion !== itineraryVersion || meta.contractVersion >= 4) return;
    const paths = parse<MapDayPath[]>((this.db.prepare("SELECT day_paths_json FROM map_manifests WHERE trip_id=? AND itinerary_version=?").get(tripId, itineraryVersion) as DbRow).day_paths_json, []);
    const entities = new Map(this.mapEntities(tripId, itineraryVersion).map((item) => [item.id, item]));
    this.db.exec("BEGIN IMMEDIATE"); try {
      for (const path of paths) {
        const visitIds = path.entityIds.map((placeId, index) => {
          const place = entities.get(placeId); const id = `v${path.dayNumber}-${index + 1}-${place?.activityId || placeId}`.slice(0, 180);
          const visit: MapVisit = { id, placeId, activityId: place?.activityId ?? null, dayNumber: path.dayNumber, order: place?.order ?? index, subOrder: index, activity: place?.detail ?? place?.name ?? "", detail: place?.detail ?? "", startTime: place?.startTime ?? "", endTime: place?.endTime ?? "", durationMinutes: place?.durationMinutes ?? 0, transportMode: place?.transportMode ?? "none", costNote: place?.costNote ?? "", notes: place?.notes ?? "" };
          this.db.prepare("INSERT OR REPLACE INTO map_visits(trip_id,itinerary_version,visit_id,place_id,data_json) VALUES(?,?,?,?,?)").run(tripId, itineraryVersion, id, placeId, json(visit)); return id;
        });
        path.visitIds = visitIds;
      }
      this.db.prepare("UPDATE map_manifests SET contract_version=4,day_paths_json=?,updated_at=? WHERE trip_id=? AND itinerary_version=?").run(json(paths), iso(), tripId, itineraryVersion);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  prepareMapManifest(tripId: string, itineraryVersion: number, reusableActivityIds: string[], forceRebuild = false) {
    const found = this.db.prepare("SELECT * FROM map_manifests WHERE trip_id=? AND itinerary_version=?").get(tripId, itineraryVersion) as DbRow | undefined;
    if (found && !forceRebuild) return { itineraryVersion, mapVersion: Number(found.map_version), baseMapVersion: Number(found.base_map_version), removedEntityIds: [] as string[], removedRouteIds: [] as string[] };
    if (found && forceRebuild) {
      const mapVersion = Number((this.db.prepare("SELECT COALESCE(MAX(map_version),0) AS value FROM map_manifests WHERE trip_id=?").get(tripId) as DbRow).value) + 1;
      const baseMapVersion = Number(found.map_version);
      const removedEntityIds = this.mapEntities(tripId, itineraryVersion).map((item) => item.id);
      const removedRouteIds = this.mapRoutes(tripId, itineraryVersion).map((item) => item.id);
      this.db.exec("BEGIN IMMEDIATE"); try {
        // Keep the last renderable map until the first valid V4 day is ready.
        // `applyMapPatch(..., replaceAll=true)` performs the actual replacement
        // atomically, so a failed Agent contract never clears useful map data.
        this.db.prepare("UPDATE map_manifests SET map_version=?,base_map_version=?,status='queued',summary='等待地图 Agent 重新拆分地点',patch_sequence=0,updated_at=? WHERE trip_id=? AND itinerary_version=?").run(mapVersion, baseMapVersion, iso(), tripId, itineraryVersion);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      return { itineraryVersion, mapVersion, baseMapVersion, removedEntityIds, removedRouteIds };
    }
    const previous = this.latestMapMeta(tripId, itineraryVersion); const mapVersion = Number((this.db.prepare("SELECT COALESCE(MAX(map_version),0) AS value FROM map_manifests WHERE trip_id=?").get(tripId) as DbRow).value) + 1; const now = iso();
    this.db.exec("BEGIN IMMEDIATE"); try {
      this.db.prepare("INSERT INTO map_manifests(trip_id,itinerary_version,map_version,base_map_version,status,summary,warnings_json,created_at,updated_at,contract_version,day_paths_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(tripId, itineraryVersion, mapVersion, previous?.mapVersion ?? 0, "queued", "等待地图 Agent 分析", "[]", now, now, 4, "[]");
      if (previous) {
        const reusable = new Set(reusableActivityIds); const entityRows = this.db.prepare("SELECT * FROM map_entities WHERE trip_id=? AND itinerary_version=?").all(tripId, previous.itineraryVersion) as DbRow[]; const copied = new Set<string>();
        for (const row of entityRows) { const data = parse<MapEntityPatch | null>(row.data_json, null); if (!data || (data.activityId && !reusable.has(data.activityId))) continue; this.db.prepare("INSERT INTO map_entities(trip_id,itinerary_version,entity_id,data_json,status,candidate_json,candidates_json,warning,canonical_key) VALUES(?,?,?,?,?,?,?,?,?)").run(tripId, itineraryVersion, String(row.entity_id), String(row.data_json), String(row.status), typeof row.candidate_json === "string" ? row.candidate_json : null, String(row.candidates_json), typeof row.warning === "string" ? row.warning : null, typeof row.canonical_key === "string" ? row.canonical_key : null); copied.add(String(row.entity_id)); }
        const routeRows = this.db.prepare("SELECT * FROM map_routes WHERE trip_id=? AND itinerary_version=?").all(tripId, previous.itineraryVersion) as DbRow[];
        for (const row of routeRows) { const data = parse<MapRoutePatch | null>(row.data_json, null); if (!data || !copied.has(data.fromEntityId) || !copied.has(data.toEntityId)) continue; this.db.prepare("INSERT INTO map_routes(trip_id,itinerary_version,route_id,data_json,status,geometry_json,warning) VALUES(?,?,?,?,?,?,?)").run(tripId, itineraryVersion, String(row.route_id), String(row.data_json), String(row.status), typeof row.geometry_json === "string" ? row.geometry_json : null, typeof row.warning === "string" ? row.warning : null); }
      }
      this.db.exec("COMMIT"); return { itineraryVersion, mapVersion, baseMapVersion: previous?.mapVersion ?? 0, removedEntityIds: [] as string[], removedRouteIds: [] as string[] };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  setMapStatus(tripId: string, itineraryVersion: number, status: MapJobStatus, summary: string, warnings?: string[]) { this.db.prepare("UPDATE map_manifests SET status=?,summary=?,warnings_json=COALESCE(?,warnings_json),updated_at=? WHERE trip_id=? AND itinerary_version=?").run(status, summary.slice(0, 500), warnings ? json(warnings) : null, iso(), tripId, itineraryVersion); }
  /** Monotonic stream cursor used by WebSocket map patches. */
  nextMapPatchSequence(tripId: string, itineraryVersion: number) { this.db.prepare("UPDATE map_manifests SET patch_sequence=patch_sequence+1,updated_at=? WHERE trip_id=? AND itinerary_version=?").run(iso(), tripId, itineraryVersion); return Number((this.db.prepare("SELECT patch_sequence FROM map_manifests WHERE trip_id=? AND itinerary_version=?").get(tripId, itineraryVersion) as DbRow | undefined)?.patch_sequence ?? 0); }
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
      if (replaceAll) { this.db.prepare("DELETE FROM map_routes WHERE trip_id=? AND itinerary_version=?").run(tripId, itineraryVersion); this.db.prepare("DELETE FROM map_visits WHERE trip_id=? AND itinerary_version=?").run(tripId, itineraryVersion); this.db.prepare("DELETE FROM map_entities WHERE trip_id=? AND itinerary_version=?").run(tripId, itineraryVersion); }
      for (const id of patch.removeRouteIds) { if (this.mapRoutes(tripId, itineraryVersion).some((item) => item.id === id)) removedRouteIds.add(id); this.db.prepare("DELETE FROM map_routes WHERE trip_id=? AND itinerary_version=? AND route_id=?").run(tripId, itineraryVersion, id); }
      for (const id of patch.removeEntityIds) {
        if (this.mapEntities(tripId, itineraryVersion).some((item) => item.id === id)) removedEntityIds.add(id);
        for (const route of this.mapRoutes(tripId, itineraryVersion)) if (route.fromEntityId === id || route.toEntityId === id) removedRouteIds.add(route.id);
        this.db.prepare("DELETE FROM map_routes WHERE trip_id=? AND itinerary_version=? AND (json_extract(data_json,'$.fromEntityId')=? OR json_extract(data_json,'$.toEntityId')=?)").run(tripId, itineraryVersion, id, id); this.db.prepare("DELETE FROM map_entities WHERE trip_id=? AND itinerary_version=? AND entity_id=?").run(tripId, itineraryVersion, id);
      }
      // V4 stores physical places once and records every scheduled occurrence as a visit.
      const oldPaths = parse<MapDayPath[]>((this.db.prepare("SELECT day_paths_json FROM map_manifests WHERE trip_id=? AND itinerary_version=?").get(tripId, itineraryVersion) as DbRow).day_paths_json, []);
      const existingPlaces = this.mapEntities(tripId, itineraryVersion);
      const placeByKey = new Map(existingPlaces.map((place) => [place.canonicalKey || canonicalPlaceKey(place.name, place.city, place.region || "", place.country || ""), place]));
      const sourceToPlace = new Map<string, string>();
      let nextQueueOrder = existingPlaces.reduce((maximum, place) => Math.max(maximum, place.queueOrder ?? -1), -1) + 1;
      for (const source of patch.upsertEntities) {
        const name = normalizeGeneratedPlaceName(source.displayName || source.name);
        // V2's planner owns physical place identity.  Never derive it from a
        // translated display name; legacy V1 sources omit canonicalKey.
        const canonicalKey = source.canonicalKey?.startsWith("place:") ? source.canonicalKey : canonicalPlaceKey(name, source.city, source.region || "", source.country || "");
        const sourcePath = patch.dayPaths.find((path) => path.entityIds[0] === source.id);
        const priorPath = sourcePath ? oldPaths.find((path) => path.dayNumber === sourcePath.dayNumber - 1) : null;
        const priorEnd = priorPath ? existingPlaces.find((place) => place.id === priorPath.entityIds.at(-1)) : null;
        const sameArea = priorEnd && canonicalPlaceKey("", priorEnd.city, priorEnd.region || "", priorEnd.country || "") === canonicalPlaceKey("", source.city, source.region || "", source.country || "");
        const compactName = (value: string) => value.toLocaleLowerCase().replace(/[\s·・,，.。()（）_-]+/gu, "");
        const priorName = priorEnd ? compactName(priorEnd.displayName || priorEnd.name) : ""; const currentName = compactName(name);
        const similarName = priorName === currentName || (Math.min(priorName.length, currentName.length) >= 4 && (priorName.includes(currentName) || currentName.includes(priorName)));
        const continuityMatch = priorEnd && sameArea && similarName && ((priorEnd.kind === "lodging" && source.kind === "lodging") || (/机场|airport/iu.test(priorEnd.name) && /机场|airport/iu.test(name)));
        const previous = (continuityMatch ? priorEnd : null) || placeByKey.get(canonicalKey); const placeId = previous?.id || source.id;
        sourceToPlace.set(source.id, placeId);
        if (previous) {
          const aliases = [...new Set([...(previous.aliases ?? []), ...(name !== (previous.displayName || previous.name) ? [name] : [])])];
          const reused = { ...previous, ...source, id: previous.id, activityId: previous.activityId, dayNumber: previous.dayNumber, order: previous.order, name, displayName: name, canonicalKey, queueOrder: previous.queueOrder, aliases };
          this.db.prepare("UPDATE map_entities SET data_json=?,canonical_key=? WHERE trip_id=? AND itinerary_version=? AND entity_id=?").run(json(reused), canonicalKey, tripId, itineraryVersion, previous.id);
          placeByKey.set(canonicalKey, reused); placeByKey.set(previous.canonicalKey || canonicalPlaceKey(previous.name, previous.city, previous.region || "", previous.country || ""), reused);
        }
        if (!previous) {
          const place = { ...source, id: placeId, name, displayName: name, canonicalKey, queueOrder: nextQueueOrder++, aliases: source.aliases ?? [] };
          this.db.prepare(`INSERT INTO map_entities(trip_id,itinerary_version,entity_id,data_json,status,candidate_json,candidates_json,warning,canonical_key) VALUES(?,?,?,?,?,?,?,?,?)
            ON CONFLICT(trip_id,itinerary_version,entity_id) DO UPDATE SET data_json=excluded.data_json,canonical_key=excluded.canonical_key`).run(tripId, itineraryVersion, placeId, json(place), "pending", null, "[]", null, canonicalKey);
          placeByKey.set(canonicalKey, place as MapEntityView);
        }
      }
      const replacementDays = new Set(patch.dayPaths.map((path) => path.dayNumber));
      const replacedOldEntityIds = new Set(oldPaths.filter((path) => replacementDays.has(path.dayNumber)).flatMap((path) => path.entityIds));
      const paths = oldPaths.filter((path) => !replacementDays.has(path.dayNumber));
      for (const sourcePath of patch.dayPaths) {
        // A day is the replacement boundary.  Never wipe a useful map merely
        // because another day is being repaired or regenerated.
        this.db.prepare("DELETE FROM map_visits WHERE trip_id=? AND itinerary_version=? AND json_extract(data_json,'$.dayNumber')=?").run(tripId, itineraryVersion, sourcePath.dayNumber);
        const visitIds = sourcePath.entityIds.map((sourceId, index) => {
          const source = patch.upsertEntities.find((item) => item.id === sourceId); const placeId = sourceToPlace.get(sourceId) || sourceId;
          const id = `v${sourcePath.dayNumber}-${index + 1}-${source?.activityId || sourceId}`.slice(0, 180);
          const visit: MapVisit = { id, placeId, activityId: source?.activityId ?? null, dayNumber: sourcePath.dayNumber, order: source?.order ?? index, subOrder: index, activity: source?.detail ?? source?.name ?? "", detail: source?.detail ?? "", startTime: source?.startTime ?? "", endTime: source?.endTime ?? "", durationMinutes: source?.durationMinutes ?? 0, transportMode: source?.transportMode ?? "none", costNote: source?.costNote ?? "", notes: source?.notes ?? "" };
          this.db.prepare("INSERT INTO map_visits(trip_id,itinerary_version,visit_id,place_id,data_json) VALUES(?,?,?,?,?) ON CONFLICT(trip_id,itinerary_version,visit_id) DO UPDATE SET place_id=excluded.place_id,data_json=excluded.data_json").run(tripId, itineraryVersion, id, placeId, json(visit)); return id;
        });
        const entityIds = sourcePath.entityIds.map((id) => sourceToPlace.get(id) || id);
        paths.push({ ...sourcePath, entityIds, visitIds, startEntityId: entityIds[0], endEntityId: entityIds.at(-1)!, overnightEntityId: entityIds.at(-1)! });
      }
      for (const path of patch.dayPaths) {
        this.db.prepare("DELETE FROM map_routes WHERE trip_id=? AND itinerary_version=? AND json_extract(data_json,'$.dayNumber')=?").run(tripId, itineraryVersion, path.dayNumber);
        const current = paths.find((item) => item.dayNumber === path.dayNumber)!;
        for (let edgeOrder = 0; edgeOrder < current.visitIds!.length - 1; edgeOrder += 1) {
          const supplied = patch.upsertRoutes.find((item) => item.dayNumber === path.dayNumber && item.order === edgeOrder + 1); const mode = supplied?.mode || patch.upsertEntities.find((item) => item.id === path.entityIds[edgeOrder + 1])?.transportMode || "none";
          const route: MapRoutePatch = { id: supplied?.id || `d${path.dayNumber}-r${edgeOrder + 1}`, dayNumber: path.dayNumber, order: edgeOrder + 1, edgeOrder: edgeOrder + 1, fromEntityId: current.entityIds[edgeOrder], toEntityId: current.entityIds[edgeOrder + 1], fromVisitId: current.visitIds![edgeOrder], toVisitId: current.visitIds![edgeOrder + 1], mode };
          this.db.prepare("INSERT INTO map_routes(trip_id,itinerary_version,route_id,data_json,status,geometry_json,warning) VALUES(?,?,?,?,?,?,?)").run(tripId, itineraryVersion, route.id, json(route), "pending", null, null);
        }
      }
      paths.sort((a, b) => a.dayNumber - b.dayNumber);
      const referenced = new Set(paths.flatMap((path) => path.entityIds));
      for (const entity of this.mapEntities(tripId, itineraryVersion)) if (replacedOldEntityIds.has(entity.id) && !referenced.has(entity.id)) {
        removedEntityIds.add(entity.id);
        this.db.prepare("DELETE FROM map_routes WHERE trip_id=? AND itinerary_version=? AND (json_extract(data_json,'$.fromEntityId')=? OR json_extract(data_json,'$.toEntityId')=?)").run(tripId, itineraryVersion, entity.id, entity.id);
        this.db.prepare("DELETE FROM map_entities WHERE trip_id=? AND itinerary_version=? AND entity_id=?").run(tripId, itineraryVersion, entity.id);
      }
      this.db.prepare("UPDATE map_manifests SET contract_version=4,day_paths_json=?,patch_sequence=patch_sequence+1 WHERE trip_id=? AND itinerary_version=?").run(json(paths), tripId, itineraryVersion);
      this.setMapStatus(tripId, itineraryVersion, "resolving", "正在解析地点与路线", patch.warnings); this.db.exec("COMMIT");
      return { removedEntityIds: [...removedEntityIds], removedRouteIds: [...removedRouteIds] };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  mapEntities(tripId: string, itineraryVersion: number): MapEntityView[] { return (this.db.prepare("SELECT * FROM map_entities WHERE trip_id=? AND itinerary_version=? ORDER BY json_extract(data_json,'$.dayNumber'),json_extract(data_json,'$.order')").all(tripId, itineraryVersion) as DbRow[]).flatMap((row) => { const data = parse<MapEntityPatch | null>(row.data_json, null); return data ? [{ ...data, approximateLodgingArea: data.approximateLodgingArea ?? false, status: String(row.status) as MapEntityView["status"], location: normalizeCandidate(parse<unknown>(row.candidate_json, null)), candidates: normalizeCandidates(row.candidates_json), warning: row.warning ? String(row.warning) : null }] : []; }); }
  /** V4 canonical name for unique physical locations. */
  mapPlaces(tripId: string, itineraryVersion: number) { return this.mapEntities(tripId, itineraryVersion); }
  mapVisits(tripId: string, itineraryVersion: number): MapVisit[] { return (this.db.prepare("SELECT data_json FROM map_visits WHERE trip_id=? AND itinerary_version=? ORDER BY json_extract(data_json,'$.dayNumber'),json_extract(data_json,'$.subOrder')").all(tripId, itineraryVersion) as DbRow[]).flatMap((row) => { const visit = parse<MapVisit | null>(row.data_json, null); return visit ? [visit] : []; }); }
  mapDayProgress(tripId: string, itineraryVersion: number): MapDayProgress[] {
    const places = new Map(this.mapPlaces(tripId, itineraryVersion).map((item) => [item.id, item])); const visits = this.mapVisits(tripId, itineraryVersion); const routes = this.mapRoutes(tripId, itineraryVersion);
    const runs = this.mapDayRuns(tripId, itineraryVersion);
    const days = this.getRevision(tripId, itineraryVersion)?.plan.days.map((day) => day.dayNumber) ?? [];
    return days.map((dayNumber) => { const dayVisits = visits.filter((item) => item.dayNumber === dayNumber); const dayRoutes = routes.filter((item) => item.dayNumber === dayNumber); const resolvedPlaces = new Set(dayVisits.filter((item) => Boolean(places.get(item.placeId)?.location)).map((item) => item.placeId)).size; const totalPlaces = new Set(dayVisits.map((item) => item.placeId)).size; const resolvedRoutes = dayRoutes.filter((item) => item.status === "resolved").length; const run = runs.get(dayNumber); const derived: MapDayProgress["status"] = totalPlaces && resolvedPlaces === totalPlaces && resolvedRoutes === dayRoutes.length ? "ready" : resolvedPlaces || resolvedRoutes ? "partial" : "pending"; const status = run?.status === "failed" ? "failed" : derived === "ready" ? "ready" : run?.status ?? derived; return { dayNumber, status, resolvedPlaces, totalPlaces, resolvedRoutes, totalRoutes: dayRoutes.length, generationRetries: run?.generationRetries ?? 0, repairRetries: run?.repairRetries ?? 0, error: run?.error ?? null }; });
  }
  mapRoutes(tripId: string, itineraryVersion: number): MapRouteView[] { return (this.db.prepare("SELECT * FROM map_routes WHERE trip_id=? AND itinerary_version=? ORDER BY json_extract(data_json,'$.dayNumber'),json_extract(data_json,'$.order')").all(tripId, itineraryVersion) as DbRow[]).flatMap((row) => { const data = parse<MapRoutePatch | null>(row.data_json, null); return data ? [{ ...data, status: String(row.status) as MapRouteView["status"], geometry: parse<unknown | null>(row.geometry_json, null), warning: row.warning ? String(row.warning) : null }] : []; }); }
  // `unresolved` is retained for historical snapshots and is retried; new terminal failures use `unlocated`.
  pendingMapEntities(tripId: string, itineraryVersion: number) { return this.mapEntities(tripId, itineraryVersion).filter((item) => item.status === "pending" || item.status === "failed" || item.status === "unresolved"); }
  pendingMapRoutes(tripId: string, itineraryVersion: number) { return this.mapRoutes(tripId, itineraryVersion).filter((item) => item.status === "pending" || item.status === "failed" || item.status === "unresolved"); }
  updateMapEntity(tripId: string, itineraryVersion: number, entityId: string, status: MapEntityView["status"], location: Candidate | null, candidates: Candidate[], warning: string | null) { this.db.prepare("UPDATE map_entities SET status=?,candidate_json=?,candidates_json=?,warning=? WHERE trip_id=? AND itinerary_version=? AND entity_id=?").run(status, location ? json(location) : null, json(candidates), warning, tripId, itineraryVersion, entityId); }
  updateMapRoute(tripId: string, itineraryVersion: number, routeId: string, status: MapRouteView["status"], geometry: unknown | null, warning: string | null) { this.db.prepare("UPDATE map_routes SET status=?,geometry_json=?,warning=? WHERE trip_id=? AND itinerary_version=? AND route_id=?").run(status, geometry ? json(geometry) : null, warning, tripId, itineraryVersion, routeId); }
  getMapSnapshot(tripId: string, scope: "all" | "day" = "all", dayNumber: number | null = null): MapSnapshot | null { const trip = this.requireTrip(tripId); const itineraryVersion = trip.activeRevision?.version; if (!itineraryVersion) return null; const meta = this.latestMapMeta(tripId, itineraryVersion + 1); if (!meta || meta.itineraryVersion !== itineraryVersion) return { itineraryVersion, mapVersion: 0, contractVersion: 4, sequence: 0, scope, dayNumber, status: "idle", summary: "等待地图 Agent", warnings: [], places: [], visits: [], dayProgress: [], entities: [], routes: [], dayPaths: [] }; const manifest = this.db.prepare("SELECT day_paths_json,patch_sequence FROM map_manifests WHERE trip_id=? AND itinerary_version=?").get(tripId, itineraryVersion) as DbRow; const paths = parse<MapDayPath[]>(manifest.day_paths_json, []); const selected = scope === "day" && dayNumber ? paths.find((path) => path.dayNumber === dayNumber) : null; const allowed = selected ? new Set(selected.entityIds) : null; const visits = this.mapVisits(tripId, itineraryVersion); const places = this.mapPlaces(tripId, itineraryVersion); const filteredVisits = selected ? visits.filter((item) => selected.visitIds?.includes(item.id)) : visits; const filteredPlaces = selected ? places.filter((item) => allowed!.has(item.id)) : places; const routes = this.mapRoutes(tripId, itineraryVersion); return { itineraryVersion, mapVersion: meta.mapVersion, contractVersion: meta.contractVersion, sequence: Number(manifest.patch_sequence ?? 0), scope, dayNumber: scope === "day" ? dayNumber : null, status: meta.status, summary: meta.summary, warnings: meta.warnings, places: filteredPlaces, visits: filteredVisits, dayProgress: meta.contractVersion >= 4 ? this.mapDayProgress(tripId, itineraryVersion) : [], entities: filteredPlaces, routes: selected ? routes.filter((item) => item.dayNumber === selected.dayNumber) : routes, dayPaths: scope === "day" && selected ? [selected] : paths }; }
  selectMapCandidate(tripId: string, itineraryVersion: number, entityId: string, candidate: Candidate, status: "resolved" | "approximate" = "resolved", warning: string | null = null) {
    const affectedDayNumbers = new Set(this.mapRoutes(tripId, itineraryVersion).filter((route) => route.fromEntityId === entityId || route.toEntityId === entityId).map((route) => route.dayNumber));
    this.updateMapEntity(tripId, itineraryVersion, entityId, status, candidate, [candidate], warning);
    this.db.prepare("UPDATE map_routes SET status='pending',geometry_json=NULL,warning=NULL WHERE trip_id=? AND itinerary_version=? AND (json_extract(data_json,'$.fromEntityId')=? OR json_extract(data_json,'$.toEntityId')=?)").run(tripId, itineraryVersion, entityId, entityId);
    if (status !== "resolved") return { entityId, removedEntityIds: [] as string[], affectedDayNumbers: [...affectedDayNumbers] };
    const matching = this.mapEntities(tripId, itineraryVersion).filter((place) => place.location?.providerPlaceId === candidate.providerPlaceId).sort((a, b) => (a.queueOrder ?? Number.MAX_SAFE_INTEGER) - (b.queueOrder ?? Number.MAX_SAFE_INTEGER));
    if (matching.length < 2) return { entityId, removedEntityIds: [] as string[], affectedDayNumbers: [...affectedDayNumbers] };
    const winner = matching[0]; const removedEntityIds: string[] = [];
    this.db.exec("BEGIN IMMEDIATE"); try {
      const aliases = [...new Set([...(winner.aliases ?? []), ...matching.slice(1).flatMap((place) => [place.displayName || place.name, ...(place.aliases ?? [])])])];
      this.db.prepare("UPDATE map_entities SET data_json=json_set(data_json,'$.aliases',json(?)) WHERE trip_id=? AND itinerary_version=? AND entity_id=?").run(json(aliases), tripId, itineraryVersion, winner.id);
      for (const loser of matching.slice(1)) {
        removedEntityIds.push(loser.id);
        const visitRows = this.db.prepare("SELECT visit_id,data_json FROM map_visits WHERE trip_id=? AND itinerary_version=? AND place_id=?").all(tripId, itineraryVersion, loser.id) as DbRow[];
        for (const row of visitRows) { const visit = parse<MapVisit>(row.data_json, {} as MapVisit); const next = { ...visit, placeId: winner.id }; this.db.prepare("UPDATE map_visits SET place_id=?,data_json=? WHERE trip_id=? AND itinerary_version=? AND visit_id=?").run(winner.id, json(next), tripId, itineraryVersion, String(row.visit_id)); }
        const routeRows = this.db.prepare("SELECT route_id,data_json FROM map_routes WHERE trip_id=? AND itinerary_version=? AND (json_extract(data_json,'$.fromEntityId')=? OR json_extract(data_json,'$.toEntityId')=?)").all(tripId, itineraryVersion, loser.id, loser.id) as DbRow[];
        for (const row of routeRows) { const route = parse<MapRoutePatch>(row.data_json, {} as MapRoutePatch); affectedDayNumbers.add(route.dayNumber); const next = { ...route, fromEntityId: route.fromEntityId === loser.id ? winner.id : route.fromEntityId, toEntityId: route.toEntityId === loser.id ? winner.id : route.toEntityId }; this.db.prepare("UPDATE map_routes SET data_json=?,status='pending',geometry_json=NULL,warning=NULL WHERE trip_id=? AND itinerary_version=? AND route_id=?").run(json(next), tripId, itineraryVersion, String(row.route_id)); }
        const manifest = this.db.prepare("SELECT day_paths_json FROM map_manifests WHERE trip_id=? AND itinerary_version=?").get(tripId, itineraryVersion) as DbRow;
        const paths = parse<MapDayPath[]>(manifest.day_paths_json, []).map((path) => ({ ...path, entityIds: path.entityIds.map((id) => id === loser.id ? winner.id : id), startEntityId: path.startEntityId === loser.id ? winner.id : path.startEntityId, endEntityId: path.endEntityId === loser.id ? winner.id : path.endEntityId, overnightEntityId: path.overnightEntityId === loser.id ? winner.id : path.overnightEntityId }));
        this.db.prepare("UPDATE map_manifests SET day_paths_json=? WHERE trip_id=? AND itinerary_version=?").run(json(paths), tripId, itineraryVersion);
        this.db.prepare("DELETE FROM map_entities WHERE trip_id=? AND itinerary_version=? AND entity_id=?").run(tripId, itineraryVersion, loser.id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { entityId: winner.id, removedEntityIds, affectedDayNumbers: [...affectedDayNumbers] };
  }
  resetMapEntity(tripId: string, itineraryVersion: number, entityId: string, warning: string) { this.updateMapEntity(tripId, itineraryVersion, entityId, "pending", null, [], warning); this.db.prepare("UPDATE map_routes SET status='pending',geometry_json=NULL,warning=NULL WHERE trip_id=? AND itinerary_version=? AND (json_extract(data_json,'$.fromEntityId')=? OR json_extract(data_json,'$.toEntityId')=?)").run(tripId, itineraryVersion, entityId, entityId); }
}
