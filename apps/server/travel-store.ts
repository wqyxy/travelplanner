import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AiAgentKind, AiTaskSnapshot, AiTaskStatus, Candidate, DetailDayPatch, MapAgentOutput, MapDayPath, MapDayProgress, MapEntityPatch, MapEntityView, MapJobStatus, MapRoutePatch, MapRouteView, MapSnapshot, MapVisit, RouteDecision, RouteSkeleton, TransportVerificationOutput, TravelAgentOutput, TravelRequirements, TripPlan } from "./contracts.js";
import { DetailDayPatchSchema, emptyRequirements, RequirementsSchema, RouteSkeletonSchema, TripPlanSchema, TripPlanV2Schema } from "./contracts.js";

type SqliteModule = typeof import("node:sqlite");
const sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
const { DatabaseSync } = sqlite;

export type TripState = "active" | "trashed";
export type ItineraryLanguage = "zh" | "en" | "bilingual";
export type TripSummary = { id: string; title: string; state: TripState; updatedAt: string; itineraryLanguage: ItineraryLanguage; activeRevision: { id: string; version: number; plan: TripPlan } | null };
export type PlanningStage = "outline" | "verifying" | "detailing" | "detailed" | "partial" | "waiting_service" | "stopped";
export type DailyDetailStatus = "pending" | "generating" | "repairing" | "waiting_service" | "completed" | "stopped" | "superseded";
export type DailyDetailTask = { dayNumber: number; generation: number; baselineVersion: number; status: DailyDetailStatus; repairCount: number; error: string | null; nextAttemptAt: string | null; partialOutput: string | null; serviceFailures: number };
export type RouteDecisionState = RouteDecision & { status: "pending" | "accepted" | "rejected"; choice: string | null };
export type TripDetail = TripSummary & { requirements: TravelRequirements; requirementsRevision: number; codexThreadId: string | null; mapCodexThreadId: string | null; planningStage: PlanningStage; skeleton: RouteSkeleton | null; decisions: RouteDecisionState[]; detailProgress: { completed: number; total: number; repairing: number; waiting: number; stopped: number; tasks: DailyDetailTask[] } };
export type ChatMessage = { id: string; role: "user" | "assistant"; content: string; reply: TravelAgentOutput | null; status: "pending" | "completed" | "failed"; turn: { status: "deferred" | "queued" | "starting" | "active" | "completed" | "failed" | "interrupted"; cancelRequested: boolean; errorMessage: string | null; progressMessage?: string } | null; createdAt: string };
export type RevisionSummary = { version: number; createdAt: string; source: string; summary: string };
type DbRow = Record<string, unknown>;
const iso = () => new Date().toISOString();
const json = <T>(value: T) => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => { try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const stableId = (prefix: string, value: string) => `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
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
    if (version.user_version > 13) throw new Error("travel.sqlite3 版本高于当前应用，已停止写入。");
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
    const v8 = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v8 === 8) this.db.exec(`
      ALTER TABLE trips ADD COLUMN planning_stage TEXT NOT NULL DEFAULT 'detailed';
      ALTER TABLE trips ADD COLUMN skeleton_json TEXT;
      ALTER TABLE trips ADD COLUMN planning_generation INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE daily_detail_tasks (
        trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        day_number INTEGER NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL,
        repair_count INTEGER NOT NULL DEFAULT 0, error_message TEXT, next_attempt_at TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY(trip_id, day_number, generation)
      );
      PRAGMA user_version = 9;
    `);
    const v9 = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v9 === 9) this.db.exec(`ALTER TABLE itinerary_revisions ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'complete'; ALTER TABLE daily_detail_tasks ADD COLUMN partial_output_json TEXT; ALTER TABLE daily_detail_tasks ADD COLUMN service_failures INTEGER NOT NULL DEFAULT 0; PRAGMA user_version = 10;`);
    const v10 = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v10 === 10) this.db.exec(`
      ALTER TABLE daily_detail_tasks ADD COLUMN baseline_version INTEGER NOT NULL DEFAULT 0;
      UPDATE daily_detail_tasks SET baseline_version=COALESCE((SELECT MAX(version) FROM itinerary_revisions WHERE itinerary_revisions.trip_id=daily_detail_tasks.trip_id),0);
      CREATE TABLE route_decisions (
        trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL, decision_id TEXT NOT NULL, decision_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', choice TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(trip_id,generation,decision_id)
      );
      PRAGMA user_version = 11;
    `);
    const v11 = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v11 === 11) this.db.exec(`
      CREATE TABLE planning_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        event TEXT NOT NULL, value REAL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX planning_metrics_trip_event ON planning_metrics(trip_id,event,created_at);
      PRAGMA user_version = 12;
    `);
    const v12 = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v12 === 12) this.db.exec(`
      ALTER TABLE ai_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ai_tasks ADD COLUMN next_attempt_at TEXT;
      ALTER TABLE ai_tasks ADD COLUMN last_error TEXT;
      UPDATE ai_tasks SET status='failed',summary='应用协议错误已修复，请重试原问题',can_stop=0
        WHERE id IN (SELECT 'planner:' || id FROM messages WHERE turn_status IN ('queued','starting','active') AND lower(COALESCE(error_message,'')) LIKE '%invalid request:%');
      UPDATE messages SET status='failed',turn_status='failed',progress_message='应用协议错误已修复，请重试原问题'
        WHERE turn_status IN ('queued','starting','active') AND lower(COALESCE(error_message,'')) LIKE '%invalid request:%';
      PRAGMA user_version = 13;
    `);
  }
  private activeRevision(tripId: string) { const row = this.db.prepare("SELECT version, plan_json FROM itinerary_revisions WHERE trip_id=? AND COALESCE(lifecycle,'complete')!='superseded' ORDER BY version DESC LIMIT 1").get(tripId) as DbRow | undefined; if (!row) return null; const plan = TripPlanSchema.safeParse(parse(row.plan_json, null)); return plan.success ? { id: `${tripId}:${row.version}`, version: Number(row.version), plan: plan.data } : null; }
  private latestRequirements(tripId: string) { const row = this.db.prepare("SELECT revision, content_json, updated_at, updated_by FROM requirements WHERE trip_id=? ORDER BY revision DESC LIMIT 1").get(tripId) as DbRow | undefined; if (!row) return { revision: 0, content: emptyRequirements(), updatedAt: "", updatedBy: "system" }; const content = RequirementsSchema.safeParse(parse(row.content_json, {})); return { revision: Number(row.revision), content: content.success ? content.data : emptyRequirements(), updatedAt: String(row.updated_at), updatedBy: String(row.updated_by) }; }
  private summary(row: DbRow): TripSummary { const revision = this.activeRevision(String(row.id)); const language = row.itinerary_language; return { id: String(row.id), title: String(row.title), state: String(row.state) as TripState, updatedAt: String(row.updated_at), itineraryLanguage: language === "zh" || language === "en" || language === "bilingual" ? language : "bilingual", activeRevision: revision }; }
  listTrips(view: TripState = "active") { return (this.db.prepare("SELECT * FROM trips WHERE state=? ORDER BY updated_at DESC").all(view) as DbRow[]).map((row) => this.summary(row)); }
  createTrip() { const id = randomUUID(); const now = iso(); this.db.prepare("INSERT INTO trips(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "未命名旅行", "active", now, now); this.db.prepare("INSERT INTO requirements(trip_id,revision,content_json,updated_at,updated_by) VALUES(?,?,?,?,?)").run(id, 1, json(emptyRequirements()), now, "system"); return this.getTrip(id)!; }
  getTrip(id: string): TripDetail | null { const row = this.db.prepare("SELECT * FROM trips WHERE id=?").get(id) as DbRow | undefined; if (!row) return null; const requirements = this.latestRequirements(id); const skeleton = RouteSkeletonSchema.safeParse(parse(row.skeleton_json, null)); const planningStage = ["outline","verifying","detailing","detailed","partial","waiting_service","stopped"].includes(String(row.planning_stage)) ? String(row.planning_stage) as PlanningStage : "detailed"; const tasks = this.dailyTasks(id); const generation = Number(row.planning_generation || 0); const decisionRows = this.db.prepare("SELECT * FROM route_decisions WHERE trip_id=? AND generation=? ORDER BY rowid").all(id, generation) as DbRow[]; const decisions = decisionRows.flatMap((decisionRow) => { const parsed = parse<RouteDecision | null>(decisionRow.decision_json, null); return parsed ? [{ ...parsed, status: String(decisionRow.status) as RouteDecisionState["status"], choice: decisionRow.choice === "accept" || decisionRow.choice === "reject" ? decisionRow.choice : null }] : []; }); return { ...this.summary(row), requirements: requirements.content, requirementsRevision: requirements.revision, codexThreadId: typeof row.codex_thread_id === "string" ? row.codex_thread_id : null, mapCodexThreadId: typeof row.map_codex_thread_id === "string" ? row.map_codex_thread_id : null, planningStage, skeleton: skeleton.success ? skeleton.data : null, decisions, detailProgress: { completed: tasks.filter((task) => task.status === "completed").length, total: this.activeRevision(id)?.plan.days.length ?? 0, repairing: tasks.filter((task) => task.status === "repairing").length, waiting: tasks.filter((task) => task.status === "waiting_service").length, stopped: tasks.filter((task) => task.status === "stopped").length, tasks } }; }
  requirementsDocument(id: string) { this.requireTrip(id); return this.latestRequirements(id); }
  requireTrip(id: string) { const trip = this.getTrip(id); if (!trip) throw new Error("找不到这趟旅行。"); return trip; }
  rename(id: string, title: string) { const trimmed = title.trim().slice(0, 200); if (!trimmed) throw new Error("旅行名称不能为空。"); this.db.prepare("UPDATE trips SET title=?, updated_at=? WHERE id=?").run(trimmed, iso(), id); return this.requireTrip(id); }
  setItineraryLanguage(id: string, language: ItineraryLanguage) { this.db.prepare("UPDATE trips SET itinerary_language=?, updated_at=? WHERE id=?").run(language, iso(), id); return this.requireTrip(id); }
  duplicate(id: string) {
    const source = this.requireTrip(id); const req = this.latestRequirements(id); const nextId = randomUUID(); const now = iso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO trips(id,title,state,itinerary_language,planning_stage,skeleton_json,planning_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(nextId, `${source.title} 副本`, "active", source.itineraryLanguage, source.planningStage, source.skeleton ? json(source.skeleton) : null, source.skeleton ? 1 : 0, now, now);
      this.db.prepare("INSERT INTO requirements(trip_id,revision,content_json,updated_at,updated_by) VALUES(?,?,?,?,?)").run(nextId, 1, json(req.content), now, "system");
      if (source.activeRevision) {
        this.db.prepare("INSERT INTO itinerary_revisions(trip_id,version,plan_json,requirements_revision,created_at,source,summary,lifecycle) VALUES(?,?,?,?,?,?,?,?)").run(nextId, 1, json(source.activeRevision.plan), 1, now, "duplicate", `复制自 ${source.title}`, source.planningStage === "detailed" ? "complete" : "working");
        for (const task of source.detailProgress.tasks) this.db.prepare("INSERT INTO daily_detail_tasks(trip_id,day_number,generation,baseline_version,status,repair_count,error_message,next_attempt_at,partial_output_json,service_failures,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(nextId, task.dayNumber, 1, 1, task.status === "completed" ? "completed" : source.planningStage === "stopped" ? "stopped" : "pending", task.repairCount, null, null, task.partialOutput, 0, now);
        for (const decision of source.decisions) this.db.prepare("INSERT INTO route_decisions(trip_id,generation,decision_id,decision_json,status,choice,updated_at) VALUES(?,?,?,?,?,?,?)").run(nextId, 1, decision.id, json({ id: decision.id, question: decision.question, recommendation: decision.recommendation, impact: decision.impact, defaultChoice: decision.defaultChoice }), decision.status, decision.choice, now);
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
  recordPlanningMetric(tripId: string, event: string, value: number | null = null, metadata: Record<string, unknown> = {}) { this.db.prepare("INSERT INTO planning_metrics(trip_id,event,value,metadata_json,created_at) VALUES(?,?,?,?,?)").run(tripId, event.slice(0, 120), value, json(metadata), iso()); }
  saveRequirements(id: string, content: unknown, expectedRevision: number, updatedBy: "user" | "agent" | "system" = "user") { const current = this.latestRequirements(id); if (current.revision !== expectedRevision) throw new Error("需求总览已被更新，请重新读取后再保存。"); const parsed = RequirementsSchema.parse(content); const revision = current.revision + 1; const now = iso(); this.db.prepare("INSERT INTO requirements(trip_id,revision,content_json,updated_at,updated_by) VALUES(?,?,?,?,?)").run(id, revision, json(parsed), now, updatedBy); this.db.prepare("UPDATE trips SET updated_at=? WHERE id=?").run(now, id); return { revision, content: parsed, updatedAt: now, updatedBy };
  }
  listMessages(tripId: string): ChatMessage[] { return (this.db.prepare("SELECT * FROM messages WHERE trip_id=? ORDER BY created_at ASC").all(tripId) as DbRow[]).map((row) => ({ id: String(row.id), role: String(row.role) as "user" | "assistant", content: String(row.content), reply: row.reply_json ? parse<TravelAgentOutput | null>(row.reply_json, null) : null, status: String(row.status) as ChatMessage["status"], turn: row.turn_status ? { status: String(row.turn_status) as NonNullable<ChatMessage["turn"]>["status"], cancelRequested: Boolean(row.cancel_requested), errorMessage: row.error_message ? String(row.error_message) : null, ...(row.progress_message ? { progressMessage: String(row.progress_message) } : {}) } : null, createdAt: String(row.created_at) })); }
  createUserMessage(tripId: string, content: string, retryOf?: string | null, deferred = false) { const id = randomUUID(); const now = iso(); this.db.prepare("INSERT INTO messages(id,trip_id,role,content,status,turn_status,progress_message,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, tripId, "user", content, "pending", deferred ? "deferred" : "queued", deferred ? "已排队，将在当前每日任务稳定后处理" : retryOf ? "正在重试请求" : "请求已提交", now); return id; }
  nextDeferredMessage(tripId: string) { const row = this.db.prepare("SELECT id,content FROM messages WHERE trip_id=? AND role='user' AND turn_status='deferred' ORDER BY created_at LIMIT 1").get(tripId) as DbRow | undefined; return row ? { id: String(row.id), content: String(row.content) } : null; }
  activateDeferredMessage(messageId: string) { this.db.prepare("UPDATE messages SET turn_status='queued',progress_message='正在处理已排队的修改' WHERE id=? AND turn_status='deferred'").run(messageId); }
  updateTurn(messageId: string, status: NonNullable<ChatMessage["turn"]>["status"], patch: { progress?: string; error?: string | null; cancelRequested?: boolean; codexTurnId?: string } = {}) { const completed = ["completed", "failed", "interrupted"].includes(status); this.db.prepare("UPDATE messages SET status=?,turn_status=?,progress_message=?,error_message=?,cancel_requested=?,codex_turn_id=COALESCE(?,codex_turn_id) WHERE id=?").run(completed && status === "completed" ? "completed" : completed ? "failed" : "pending", status, patch.progress ?? null, patch.error ?? null, patch.cancelRequested ? 1 : 0, patch.codexTurnId ?? null, messageId); }
  private insertRevision(tripId: string, plan: TripPlan, requirementsRevision: number, source: string, summary: string) { const normalized = normalizeGeneratedPlan(plan); const next = Number((this.db.prepare("SELECT COALESCE(MAX(version),0) AS value FROM itinerary_revisions WHERE trip_id=?").get(tripId) as DbRow).value) + 1; const now = iso(); this.db.prepare("INSERT INTO itinerary_revisions(trip_id,version,plan_json,requirements_revision,created_at,source,summary) VALUES(?,?,?,?,?,?,?)").run(tripId, next, json(normalized), requirementsRevision, now, source, summary.slice(0, 240)); this.db.prepare("UPDATE trips SET title=?,updated_at=? WHERE id=?").run(normalized.tripName.slice(0, 200), now, tripId); return next; }
  applyAgentOutput(tripId: string, userMessageId: string, output: TravelAgentOutput) { this.db.exec("BEGIN IMMEDIATE"); try { const normalizedOutput = output.plan ? { ...output, plan: normalizeGeneratedPlan(output.plan) } : output; const current = this.latestRequirements(tripId); const req = this.saveRequirements(tripId, normalizedOutput.requirements, current.revision, "agent"); let version: number | null = null; if (normalizedOutput.plan) version = this.insertRevision(tripId, normalizedOutput.plan, req.revision, "agent", normalizedOutput.assistantMessage.replace(/\s+/g, " ")); const now = iso(); this.db.prepare("INSERT INTO messages(id,trip_id,role,content,reply_json,status,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), tripId, "assistant", normalizedOutput.assistantMessage, json(normalizedOutput), "completed", now); this.updateTurn(userMessageId, "completed", { progress: version ? `行程已更新为 v${version}` : "需求已整理" }); this.db.exec("COMMIT"); return { version, requirements: req }; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  /** Persist a small route skeleton and deterministically expand it into a usable daily outline. */
  applySkeleton(tripId: string, userMessageId: string, output: { requirements: TravelRequirements; skeleton: RouteSkeleton; assistantMessage: string }) {
    this.db.exec("BEGIN IMMEDIATE"); try {
      const current = this.latestRequirements(tripId); const req = this.saveRequirements(tripId, output.requirements, current.revision, "agent");
      this.db.prepare("UPDATE itinerary_revisions SET lifecycle='superseded' WHERE trip_id=? AND lifecycle='working'").run(tripId); this.db.prepare("UPDATE daily_detail_tasks SET status='superseded',updated_at=? WHERE trip_id=? AND status NOT IN ('completed','superseded')").run(iso(), tripId); const plan = this.expandSkeleton(output.skeleton, req.content); const version = this.insertRevision(tripId, plan, req.revision, "outline", "已生成可确认的路线骨架"); const now = iso();
      this.db.prepare("UPDATE trips SET planning_stage='outline',skeleton_json=?,planning_generation=planning_generation+1,updated_at=? WHERE id=?").run(json(output.skeleton), now, tripId);
      this.db.prepare("UPDATE itinerary_revisions SET lifecycle='working' WHERE trip_id=? AND version=?").run(tripId, version);
      const generation = Number((this.db.prepare("SELECT planning_generation FROM trips WHERE id=?").get(tripId) as DbRow).planning_generation || 0); const decisionInsert = this.db.prepare("INSERT INTO route_decisions(trip_id,generation,decision_id,decision_json,status,updated_at) VALUES(?,?,?,?,?,?)"); for (const decision of output.skeleton.decisions) decisionInsert.run(tripId, generation, decision.id, json(decision), "pending", now);
      this.db.prepare("INSERT INTO messages(id,trip_id,role,content,reply_json,status,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), tripId, "assistant", output.assistantMessage, json(output), "completed", now);
      this.updateTurn(userMessageId, "completed", { progress: "路线草案已显示，可确认后逐日细化" }); const messageRow = this.db.prepare("SELECT created_at FROM messages WHERE id=?").get(userMessageId) as DbRow | undefined; const elapsed = messageRow ? Math.max(0, Date.now() - Date.parse(String(messageRow.created_at))) : null; this.recordPlanningMetric(tripId, "route_skeleton_completed", elapsed, { version, days: plan.days.length, stops: output.skeleton.stops.length }); this.db.exec("COMMIT"); return { version, requirements: req };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private expandSkeleton(skeleton: RouteSkeleton, requirements: TravelRequirements): TripPlan {
    const places: TripPlan extends { places?: infer P } ? NonNullable<P> : never = [] as never;
    const days: TripPlan["days"] = []; let dayNumber = 1; const totalNights = skeleton.stops.reduce((sum, stop) => sum + stop.nights, 0); const requestedDays = requirements.dates.durationDays; const dateFor = (number: number) => { const start = requirements.dates.start; if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null; const value = new Date(`${start}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + number - 1); return value.toISOString().slice(0, 10); };
    if (requestedDays && totalNights !== requestedDays - 1) throw new Error(`路线住宿晚数必须为 ${requestedDays - 1} 晚，当前为 ${totalNights} 晚。`);
    skeleton.stops.forEach((stop, index) => { const placeId = `outline-stop-${index + 1}`; (places as any[]).push({ id: placeId, kind: "city", nameZh: stop.city, nameEn: stop.city, nameLocal: stop.city, localLanguage: "und", approximate: true, geocoding: { name: stop.city, city: stop.city, region: "", country: stop.country || "待确认", countryCode: "xx" } }); for (let night = 0; night < stop.nights; night += 1) { const leg = night === 0 && index ? skeleton.legs[index - 1] : null; days.push({ dayNumber, date: dateFor(dayNumber), title: night === 0 && leg ? `${stop.city} · 抵达与安顿` : `${stop.city} · 自由探索`, activities: [{ id: `outline-d${dayNumber}`, startTime: night === 0 && leg ? "09:00" : "10:00", endTime: "18:00", placeName: stop.city, placeIds: [placeId], activity: night === 0 && leg ? `${leg.note}；抵达后安排轻松活动并在 ${stop.city} 过夜。` : `在 ${stop.city} 体验当地主题；详细活动将在路线确认后生成。`, durationMinutes: 480, transportMode: leg?.mode || "walk", transportMinutes: leg?.estimatedMinutes || 0, costNote: "详细预算待细化", notes: "路线草案" }] }); dayNumber += 1; } });
    const lastIndex = skeleton.stops.length - 1; const last = skeleton.stops[lastIndex]; const lastPlaceId = `outline-stop-${lastIndex + 1}`; days.push({ dayNumber, date: dateFor(dayNumber), title: `${last.city} · 返程或后续安排`, activities: [{ id: `outline-d${dayNumber}`, startTime: "09:00", endTime: "14:00", placeName: last.city, placeIds: [lastPlaceId], activity: `从 ${last.city} 从容返程；具体交通将在确认后细化。`, durationMinutes: 300, transportMode: "none", transportMinutes: 0, costNote: "详细预算待细化", notes: "路线草案" }] });
    return { schemaVersion: 2, tripName: skeleton.tripName, travelerSummary: requirements.travelers.summary || "待确认", pace: requirements.pace || "适中", themes: requirements.themes, timezone: skeleton.timezone, budgetNote: requirements.budget.note || "待确认", days, warnings: ["路线草案：确认后逐日细化", ...skeleton.warnings, ...skeleton.assumptions], generatedBy: "codex", places: places as any };
  }
  confirmDetailing(tripId: string) { const trip = this.requireTrip(tripId); const revision = trip.activeRevision; if (!revision || !trip.skeleton) throw new Error("请先生成路线草案。"); const generation = Number((this.db.prepare("SELECT planning_generation FROM trips WHERE id=?").get(tripId) as DbRow).planning_generation) || 0; const now = iso(); this.db.prepare("UPDATE itinerary_revisions SET lifecycle='working' WHERE trip_id=? AND version=?").run(tripId, revision.version); const statement = this.db.prepare("INSERT INTO daily_detail_tasks(trip_id,day_number,generation,baseline_version,status,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(trip_id,day_number,generation) DO UPDATE SET baseline_version=excluded.baseline_version,status=CASE WHEN daily_detail_tasks.status='completed' THEN 'completed' ELSE 'pending' END,updated_at=excluded.updated_at"); for (const day of revision.plan.days) statement.run(tripId, day.dayNumber, generation, revision.version, "pending", now); this.db.prepare("UPDATE trips SET planning_stage='detailing',updated_at=? WHERE id=?").run(now, tripId); this.recordPlanningMetric(tripId, "daily_detailing_confirmed", null, { generation, days: revision.plan.days.length }); return this.requireTrip(tripId); }
  planningBaseline(tripId: string) { const row = this.db.prepare("SELECT planning_generation FROM trips WHERE id=?").get(tripId) as DbRow | undefined; return { generation: Number(row?.planning_generation || 0), version: this.activeRevision(tripId)?.version || 0 }; }
  dailyTasks(tripId: string): DailyDetailTask[] { const generation = this.planningBaseline(tripId).generation; return (this.db.prepare("SELECT * FROM daily_detail_tasks WHERE trip_id=? AND generation=? ORDER BY day_number").all(tripId, generation) as DbRow[]).map((row) => ({ dayNumber: Number(row.day_number), generation: Number(row.generation), baselineVersion: Number(row.baseline_version || 0), status: String(row.status) as DailyDetailStatus, repairCount: Number(row.repair_count), error: row.error_message ? String(row.error_message) : null, nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null, partialOutput: row.partial_output_json ? String(row.partial_output_json) : null, serviceFailures: Number(row.service_failures || 0) })); }
  updateDailyTask(tripId: string, dayNumber: number, status: DailyDetailStatus, patch: { expectedGeneration?: number; repairCount?: number; error?: string | null; nextAttemptAt?: string | null; partialOutput?: string | null; serviceFailures?: number } = {}) { const baseline = this.planningBaseline(tripId); if (patch.expectedGeneration !== undefined && patch.expectedGeneration !== baseline.generation) return false; const generation = baseline.generation; const current = this.dailyTasks(tripId).find((task) => task.dayNumber === dayNumber); this.db.prepare("INSERT INTO daily_detail_tasks(trip_id,day_number,generation,baseline_version,status,repair_count,error_message,next_attempt_at,partial_output_json,service_failures,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(trip_id,day_number,generation) DO UPDATE SET status=excluded.status,repair_count=excluded.repair_count,error_message=excluded.error_message,next_attempt_at=excluded.next_attempt_at,partial_output_json=excluded.partial_output_json,service_failures=excluded.service_failures,updated_at=excluded.updated_at").run(tripId, dayNumber, generation, current?.baselineVersion || baseline.version, status, patch.repairCount ?? current?.repairCount ?? 0, patch.error === undefined ? current?.error ?? null : patch.error, patch.nextAttemptAt === undefined ? current?.nextAttemptAt ?? null : patch.nextAttemptAt, patch.partialOutput === undefined ? current?.partialOutput ?? null : patch.partialOutput, patch.serviceFailures ?? current?.serviceFailures ?? 0, iso()); if (status === "waiting_service") this.db.prepare("UPDATE trips SET planning_stage='waiting_service',updated_at=? WHERE id=? AND planning_stage!='stopped'").run(iso(), tripId); if (current?.status !== status && (status === "repairing" || status === "waiting_service")) this.recordPlanningMetric(tripId, status === "repairing" ? "daily_repair_started" : "service_wait_started", null, { dayNumber, generation, repairCount: patch.repairCount ?? current?.repairCount ?? 0 }); return true; }
  applyDailyDetail(tripId: string, patch: DetailDayPatch, expected?: { generation: number; baselineVersion: number }) {
    const checked = DetailDayPatchSchema.parse(patch); const baseline = this.planningBaseline(tripId);
    if (expected && (expected.generation !== baseline.generation || expected.baselineVersion !== baseline.version)) throw new Error("DETAIL_BASELINE_SUPERSEDED");
    const current = this.requireTrip(tripId); const revision = current.activeRevision; if (!revision) throw new Error("找不到路线草案。");
    const dayIndex = revision.plan.days.findIndex((day) => day.dayNumber === checked.dayNumber); if (dayIndex < 0) throw new Error("详细日期不属于当前路线。");
    const old = revision.plan.days[dayIndex]; const existingPlaces = (revision.plan as any).places as Array<any>; const placeById = new Map(existingPlaces.map((item) => [item.id, item])); const placeByCanonical = new Map(existingPlaces.map((item) => [canonicalPlaceKey(item.nameLocal, item.geocoding.city, item.geocoding.region, item.geocoding.country), item])); const remap = new Map<string, string>();
    for (const place of checked.places) { const key = canonicalPlaceKey(place.nameLocal, place.geocoding.city, place.geocoding.region, place.geocoding.country); const existing = placeByCanonical.get(key); const assignedId = existing?.id || stableId("place", key); remap.set(place.id, assignedId); if (!existing) { const assigned = { ...place, id: assignedId }; placeById.set(assignedId, assigned); placeByCanonical.set(key, assigned); } }
    const activities = checked.activities.map((activity, index) => ({ ...activity, id: stableId(`d${checked.dayNumber}-a${index + 1}`, `${activity.activity}|${activity.startTime}|${(activity.placeIds || []).map((id) => remap.get(id) || id).join(",")}`), placeIds: (activity.placeIds || []).map((id) => remap.get(id) || id) }));
    const expectedStop = current.skeleton ? (() => { let cursor = 0; for (const [index, stop] of current.skeleton!.stops.entries()) { cursor += stop.nights; if (checked.dayNumber <= cursor) return { stop, placeId: `outline-stop-${index + 1}` }; } const index = current.skeleton!.stops.length - 1; return { stop: current.skeleton!.stops[index], placeId: `outline-stop-${index + 1}` }; })() : null; const finalPlaceIds = activities.at(-1)?.placeIds || [];
    if (expectedStop && !finalPlaceIds.includes(expectedStop.placeId)) throw new Error(`当天最后活动必须保留已确认的过夜城市引用：${expectedStop.stop.city}（${expectedStop.placeId}）`);
    const nextPlan = TripPlanV2Schema.parse({ ...revision.plan, schemaVersion: 2, places: [...placeById.values()], days: revision.plan.days.map((day) => day.dayNumber === checked.dayNumber ? { ...day, title: checked.title, activities } : day), warnings: [...revision.plan.warnings.filter((warning) => warning !== "路线草案：确认后逐日细化" && !warning.startsWith(`Day ${checked.dayNumber}:`)), ...checked.warnings.map((warning) => `Day ${checked.dayNumber}: ${warning}`)] });
    this.db.exec("BEGIN IMMEDIATE"); try {
      const inside = this.planningBaseline(tripId); if (expected && (inside.generation !== expected.generation || inside.version !== expected.baselineVersion)) throw new Error("DETAIL_BASELINE_SUPERSEDED");
      this.db.prepare("UPDATE itinerary_revisions SET plan_json=?,summary=? WHERE trip_id=? AND version=?").run(json(normalizeGeneratedPlan(nextPlan)), `Day ${checked.dayNumber} 已细化`, tripId, revision.version);
      this.updateDailyTask(tripId, checked.dayNumber, "completed", { expectedGeneration: expected?.generation, error: null, nextAttemptAt: null, partialOutput: null, serviceFailures: 0 });
      const tasks = this.dailyTasks(tripId); const complete = tasks.length > 0 && tasks.every((task) => task.status === "completed");
      this.db.prepare("UPDATE itinerary_revisions SET lifecycle=? WHERE trip_id=? AND version=?").run(complete ? "complete" : "working", tripId, revision.version);
      this.db.prepare("UPDATE trips SET planning_stage=?,updated_at=? WHERE id=?").run(complete ? "detailed" : tasks.some((task) => task.status === "waiting_service") ? "waiting_service" : "detailing", iso(), tripId); this.recordPlanningMetric(tripId, "daily_detail_completed", null, { dayNumber: checked.dayNumber, version: revision.version }); this.db.exec("COMMIT");
      return { version: revision.version, previousDay: old, trip: this.requireTrip(tripId) };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  setDetailingStopped(tripId: string, stopped: boolean) {
    const tasks = this.dailyTasks(tripId);
    for (const task of tasks) {
      if (stopped && ["pending","generating","repairing","waiting_service"].includes(task.status)) this.updateDailyTask(tripId, task.dayNumber, "stopped", { expectedGeneration: task.generation });
      if (!stopped && task.status === "stopped") this.updateDailyTask(tripId, task.dayNumber, "pending", { expectedGeneration: task.generation, nextAttemptAt: null, error: null, serviceFailures: 0 });
    }
    const remaining = this.dailyTasks(tripId); const stage: PlanningStage = stopped ? "stopped" : remaining.some((task) => task.status === "waiting_service") ? "waiting_service" : "detailing";
    this.db.prepare("UPDATE trips SET planning_stage=?,updated_at=? WHERE id=?").run(stage, iso(), tripId); return this.requireTrip(tripId);
  }
  recordRouteDecision(tripId: string, decisionId: string, choice: "accept" | "reject") {
    const baseline = this.planningBaseline(tripId); const row = this.db.prepare("SELECT decision_json FROM route_decisions WHERE trip_id=? AND generation=? AND decision_id=?").get(tripId, baseline.generation, decisionId) as DbRow | undefined;
    if (!row) throw new Error("找不到这个路线决策。");
    this.db.prepare("UPDATE route_decisions SET status=?,choice=?,updated_at=? WHERE trip_id=? AND generation=? AND decision_id=?").run(choice === "accept" ? "accepted" : "rejected", choice, iso(), tripId, baseline.generation, decisionId);
    this.recordPlanningMetric(tripId, "route_decision_changed", choice === "reject" ? 1 : 0, { decisionId, choice, generation: baseline.generation });
    return parse<RouteDecision>(row.decision_json, {} as RouteDecision);
  }
  setPlanningStage(tripId: string, stage: PlanningStage) { this.db.prepare("UPDATE trips SET planning_stage=?,updated_at=? WHERE id=?").run(stage, iso(), tripId); }
  applyTransportVerification(tripId: string, generation: number, output: TransportVerificationOutput) {
    if (this.planningBaseline(tripId).generation !== generation) return false; const now = iso(); const insert = this.db.prepare("INSERT INTO route_decisions(trip_id,generation,decision_id,decision_json,status,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(trip_id,generation,decision_id) DO UPDATE SET decision_json=excluded.decision_json,updated_at=excluded.updated_at");
    for (const check of output.checks) if (check.decision) insert.run(tripId, generation, check.decision.id, json(check.decision), "pending", now);
    const row = this.db.prepare("SELECT planning_stage FROM trips WHERE id=?").get(tripId) as DbRow; if (String(row.planning_stage) === "verifying") this.setPlanningStage(tripId, "outline"); return true;
  }
  supersedeDetailing(tripId: string) {
    const generation = this.planningBaseline(tripId).generation; const now = iso();
    this.db.prepare("UPDATE daily_detail_tasks SET status='superseded',updated_at=? WHERE trip_id=? AND generation=? AND status!='completed'").run(now, tripId, generation);
    this.db.prepare("UPDATE trips SET planning_generation=planning_generation+1,planning_stage='outline',updated_at=? WHERE id=?").run(now, tripId);
  }
  planningReadyForDeferred(tripId: string) { const tasks = this.dailyTasks(tripId); return tasks.length === 0 || tasks.every((task) => ["completed","waiting_service","stopped","superseded"].includes(task.status)); }
  listRevisions(tripId: string): RevisionSummary[] { return (this.db.prepare("SELECT version,created_at,source,summary FROM itinerary_revisions WHERE trip_id=? AND COALESCE(lifecycle,'complete')='complete' ORDER BY version DESC").all(tripId) as DbRow[]).map((row) => ({ version: Number(row.version), createdAt: String(row.created_at), source: String(row.source), summary: String(row.summary) })); }
  getRevision(tripId: string, version: number) { const row = this.db.prepare("SELECT * FROM itinerary_revisions WHERE trip_id=? AND version=?").get(tripId, version) as DbRow | undefined; if (!row) return null; const plan = TripPlanSchema.parse(parse(row.plan_json, {})); const requirements = this.db.prepare("SELECT content_json FROM requirements WHERE trip_id=? AND revision=?").get(tripId, Number(row.requirements_revision)) as DbRow | undefined; return { version: Number(row.version), createdAt: String(row.created_at), source: String(row.source), summary: String(row.summary), plan, requirements: RequirementsSchema.parse(parse(requirements?.content_json, {})) }; }
  restoreRevision(tripId: string, version: number) { const old = this.getRevision(tripId, version); if (!old) throw new Error("找不到该行程版本。"); this.db.exec("BEGIN IMMEDIATE"); try { const current = this.latestRequirements(tripId); const req = this.saveRequirements(tripId, old.requirements, current.revision, "system"); const now = iso(); this.db.prepare("UPDATE itinerary_revisions SET lifecycle='superseded' WHERE trip_id=? AND lifecycle='working'").run(tripId); this.db.prepare("UPDATE daily_detail_tasks SET status='superseded',updated_at=? WHERE trip_id=? AND status NOT IN ('completed','superseded')").run(now, tripId); this.db.prepare("UPDATE trips SET planning_generation=planning_generation+1,planning_stage='detailed',skeleton_json=NULL,updated_at=? WHERE id=?").run(now, tripId); const next = this.insertRevision(tripId, old.plan, req.revision, "restore", `从 v${version} 恢复`); this.db.exec("COMMIT"); return { version: next, trip: this.requireTrip(tripId) }; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  selectedLocation(tripId: string, revision: number, activityId: string): Candidate | null { const row = this.db.prepare("SELECT candidate_json FROM activity_locations WHERE trip_id=? AND revision=? AND activity_id=?").get(tripId, revision, activityId) as DbRow | undefined; return row ? parse<Candidate | null>(row.candidate_json, null) : null; }
  selectLocation(tripId: string, revision: number, activityId: string, candidate: Candidate) { this.db.prepare("INSERT INTO activity_locations(trip_id,revision,activity_id,candidate_json) VALUES(?,?,?,?) ON CONFLICT(trip_id,revision,activity_id) DO UPDATE SET candidate_json=excluded.candidate_json").run(tripId, revision, activityId, json(candidate)); }

  upsertAiTask(input: { id: string; tripId: string; agent: AiAgentKind; label: string; status: AiTaskStatus; summary: string; canStop: boolean; resetStartedAt?: boolean }) {
    const now = iso(); const existing = this.db.prepare("SELECT started_at FROM ai_tasks WHERE id=?").get(input.id) as DbRow | undefined;
    const startedAt = existing && !input.resetStartedAt ? String(existing.started_at) : now;
    this.db.prepare(`INSERT INTO ai_tasks(id,trip_id,agent,label,status,summary,started_at,updated_at,can_stop) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,summary=excluded.summary,started_at=excluded.started_at,updated_at=excluded.updated_at,can_stop=excluded.can_stop,label=excluded.label`).run(input.id, input.tripId, input.agent, input.label, input.status, input.summary, startedAt, now, input.canStop ? 1 : 0);
    if (input.resetStartedAt) this.db.prepare("UPDATE ai_tasks SET retry_count=0,next_attempt_at=NULL,last_error=NULL WHERE id=?").run(input.id);
    return this.getAiTask(input.id)!;
  }
  setAiTaskRetry(taskId: string, retryCount: number, nextAttemptAt: string | null, lastError: string | null) { this.db.prepare("UPDATE ai_tasks SET retry_count=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?").run(retryCount, nextAttemptAt, lastError, iso(), taskId); return this.getAiTask(taskId); }
  clearAiTaskRetrySchedule(taskId: string) { this.db.prepare("UPDATE ai_tasks SET next_attempt_at=NULL WHERE id=?").run(taskId); return this.getAiTask(taskId); }
  appendAiProgress(taskId: string, status: AiTaskStatus, kind: string, summary: string) {
    const task = this.db.prepare("SELECT trip_id,agent FROM ai_tasks WHERE id=?").get(taskId) as DbRow | undefined; if (!task) return null;
    const now = iso(); const segment = this.db.prepare("SELECT id FROM ai_progress_events WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT 1").get(taskId, kind) as DbRow | undefined;
    if (segment && (kind.startsWith("reasoning:") || kind.startsWith("plan:"))) this.db.prepare("UPDATE ai_progress_events SET status=?,summary=?,created_at=? WHERE id=?").run(status, summary, now, Number(segment.id));
    else this.db.prepare("INSERT INTO ai_progress_events(task_id,trip_id,agent,status,kind,summary,created_at) VALUES(?,?,?,?,?,?,?)").run(taskId, String(task.trip_id), String(task.agent), status, kind, summary, now);
    this.db.prepare("UPDATE ai_tasks SET status=?,summary=?,updated_at=?,can_stop=?,next_attempt_at=CASE WHEN ? THEN NULL ELSE next_attempt_at END WHERE id=?").run(status, summary, now, ["running","waiting","reconnecting"].includes(status) ? 1 : 0, ["completed","failed","stopped"].includes(status) ? 1 : 0, taskId);
    return this.getAiTask(taskId);
  }
  getAiTask(id: string): AiTaskSnapshot | null { const row = this.db.prepare("SELECT * FROM ai_tasks WHERE id=?").get(id) as DbRow | undefined; return row ? this.aiTask(row) : null; }
  listAiTasks(tripId: string): AiTaskSnapshot[] { return (this.db.prepare("SELECT * FROM ai_tasks WHERE trip_id=? ORDER BY updated_at DESC").all(tripId) as DbRow[]).map((row) => this.aiTask(row)); }
  private aiTask(row: DbRow): AiTaskSnapshot { const events = (this.db.prepare("SELECT * FROM ai_progress_events WHERE task_id=? ORDER BY id ASC").all(String(row.id)) as DbRow[]).map((event) => ({ id: Number(event.id), taskId: String(event.task_id), tripId: String(event.trip_id), agent: String(event.agent) as AiAgentKind, status: String(event.status) as AiTaskStatus, kind: String(event.kind), summary: String(event.summary), createdAt: String(event.created_at) })); return { id: String(row.id), tripId: String(row.trip_id), agent: String(row.agent) as AiAgentKind, label: String(row.label), status: String(row.status) as AiTaskStatus, summary: String(row.summary), startedAt: String(row.started_at), updatedAt: String(row.updated_at), canStop: Boolean(row.can_stop), retryCount: Number(row.retry_count || 0), nextAttemptAt: typeof row.next_attempt_at === "string" ? row.next_attempt_at : null, lastError: typeof row.last_error === "string" ? row.last_error : null, events }; }

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
