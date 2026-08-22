import { createRequire } from "node:module";
import type { Candidate, MapDayPath, MapDayProgress, MapEntityView, MapResolutionOutput, MapRouteView, MapSnapshot, MapVisit } from "./contracts.js";
import type { TravelStore } from "./travel-store.js";

type CacheRow = { payload_json: string; expires_at: number };
type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
export type MapPatchPayload = { tripId: string; itineraryVersion: number; mapVersion: number; sequence: number; replaceAll?: boolean; places?: { upsert: MapEntityView[]; remove: string[] }; visits?: { upsert: MapVisit[]; remove: string[] }; dayProgress?: MapDayProgress[]; entities: { upsert: MapEntityView[]; remove: string[] }; routes: { upsert: MapRouteView[]; remove: string[] }; dayPaths?: MapDayPath[] };
type MapJobPayload = { tripId: string; itineraryVersion: number; mapVersion: number; status: string; summary: string };
export type MapResolutionBatch = { entityId: string; name: string; query: string; city: string; kind: MapEntityView["kind"]; approximateLodgingArea: boolean; detail: string; candidates: Candidate[] }[];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const dayPlacesAreTerminal = (statuses: MapEntityView["status"][]) => statuses.every((status) => !["pending", "ambiguous", "unresolved", "failed"].includes(status));
const asCandidate = (item: Record<string, unknown>): Candidate | null => {
  const latitude = Number(item.lat); const longitude = Number(item.lon); const providerPlaceId = String(item.place_id ?? ""); const displayName = String(item.display_name ?? "");
  return providerPlaceId && displayName && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { providerPlaceId, displayName, latitude, longitude, category: typeof item.category === "string" ? item.category : null, sourceUrl: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}`, sourceType: "nominatim", evidenceUrl: null, confidence: "high", decisionNote: null } : null;
};

export class MapService {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private nextRequest = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly placeInFlight = new Map<string, Promise<Candidate[]>>();
  private readonly placeWorkQueue: Array<() => Promise<void>> = [];
  private activePlaceWorkers = 0;
  private readonly routeWorkQueue: Array<() => Promise<void>> = [];
  private activeRouteWorkers = 0;
  private readonly routeInFlight = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, { token: string; controller: AbortController }>();
  constructor(filename: string, private readonly store: TravelStore, private readonly onPatch: (payload: MapPatchPayload) => void = () => {}, private readonly onJob: (payload: MapJobPayload) => void = () => {}) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS geocode_cache(key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS route_cache(key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,expires_at INTEGER NOT NULL);");
  }
  close() { this.db.close(); }
  private cached<T>(table: "geocode_cache" | "route_cache", key: string): T | null { const row = this.db.prepare(`SELECT payload_json,expires_at FROM ${table} WHERE key=?`).get(key) as CacheRow | undefined; if (!row || row.expires_at < Date.now()) return null; try { return JSON.parse(row.payload_json) as T; } catch { return null; } }
  private save<T>(table: "geocode_cache" | "route_cache", key: string, payload: T, ttlMs: number) { this.db.prepare(`INSERT INTO ${table}(key,payload_json,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json,expires_at=excluded.expires_at`).run(key, JSON.stringify(payload), Date.now() + ttlMs); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const run = this.serial.then(operation, operation); this.serial = run.then(() => undefined, () => undefined); return run; }
  private async request<T>(operation: () => Promise<T>) { return this.enqueue(async () => { const wait = Math.max(0, this.nextRequest - Date.now()); if (wait) await sleep(wait); this.nextRequest = Date.now() + 1100; return operation(); }); }
  private schedulePlaceWork(operation: () => Promise<void>) { return new Promise<void>((resolve, reject) => { this.placeWorkQueue.push(async () => { try { await operation(); resolve(); } catch (error) { reject(error); } }); this.pumpPlaceWorkers(); }); }
  private pumpPlaceWorkers() { while (this.activePlaceWorkers < 3 && this.placeWorkQueue.length) { const work = this.placeWorkQueue.shift()!; this.activePlaceWorkers += 1; void work().finally(() => { this.activePlaceWorkers -= 1; this.pumpPlaceWorkers(); }); } }
  private scheduleRouteWork(key: string, operation: () => Promise<void>) { const existing = this.routeInFlight.get(key); if (existing) return existing; const pending = new Promise<void>((resolve, reject) => { this.routeWorkQueue.push(async () => { try { await operation(); resolve(); } catch (error) { reject(error); } }); this.pumpRouteWorkers(); }); this.routeInFlight.set(key, pending); void pending.finally(() => this.routeInFlight.delete(key)).catch(() => undefined); return pending; }
  private pumpRouteWorkers() { while (this.activeRouteWorkers < 3 && this.routeWorkQueue.length) { const work = this.routeWorkQueue.shift()!; this.activeRouteWorkers += 1; void work().finally(() => { this.activeRouteWorkers -= 1; this.pumpRouteWorkers(); }); } }
  activateRun(tripId: string, token: string) { this.activeRuns.get(tripId)?.controller.abort(); this.activeRuns.set(tripId, { token, controller: new AbortController() }); }
  deactivateRun(tripId: string, token: string) { const active = this.activeRuns.get(tripId); if (active?.token === token) { active.controller.abort(); this.activeRuns.delete(tripId); } }
  private runSignal(tripId: string, token?: string) { const active = this.activeRuns.get(tripId); return token && active?.token === token ? active.controller.signal : undefined; }
  private async geocode(query: string): Promise<Candidate[]> {
    const key = query.trim().toLocaleLowerCase(); const cached = this.cached<Candidate[]>("geocode_cache", key); if (cached) return cached.map((item) => ({ ...item, sourceType: item.sourceType || "nominatim", evidenceUrl: item.evidenceUrl ?? null, confidence: item.confidence || "high", decisionNote: item.decisionNote ?? null }));
    const values = await this.request(async () => { const url = new URL("https://nominatim.openstreetmap.org/search"); url.searchParams.set("format", "jsonv2"); url.searchParams.set("limit", "5"); url.searchParams.set("q", query); const response = await fetch(url, { headers: { "User-Agent": "AI-Travel-Planner/0.1 (personal local travel planner)", Accept: "application/json" } }); if (!response.ok) throw new Error("公开地点服务暂时不可用。"); const data = await response.json() as unknown; return Array.isArray(data) ? data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")).map(asCandidate).filter((item): item is Candidate => item !== null) : []; });
    this.save("geocode_cache", key, values, 30 * 24 * 60 * 60 * 1000); return values;
  }
  private relevantCandidates(item: MapEntityView, options: Candidate[]) {
    const query = `${item.name} ${item.query}`.toLocaleLowerCase();
    if (/airport|机场/.test(query)) return options.filter((candidate) => candidate.category === "aeroway");
    if (/beach|海滩/.test(query)) return options.filter((candidate) => ["natural", "place", "leisure"].includes(candidate.category || ""));
    if (item.kind === "city" || item.kind === "lodging") return options.filter((candidate) => ["place", "boundary"].includes(candidate.category || ""));
    return options;
  }
  private async geocodeEntity(item: MapEntityView) {
    const key = item.canonicalKey || `${item.name}|${item.city}`.toLocaleLowerCase();
    const existing = this.placeInFlight.get(key); if (existing) return existing;
    const task = this.geocodeEntityUnshared(item); this.placeInFlight.set(key, task);
    try { return await task; } finally { this.placeInFlight.delete(key); }
  }
  private async geocodeEntityUnshared(item: MapEntityView) {
    const parts = item.query.split(",").map((part) => part.trim()).filter(Boolean); const variants = [item.query];
    if (parts.length > 3) variants.push([parts[0], parts.at(-2), parts.at(-1)].filter(Boolean).join(", "));
    if (parts.length > 2) variants.push([parts[0], parts.at(-1)].filter(Boolean).join(", "));
    const unique = [...new Set(variants)]; let fallback: Candidate[] = [];
    for (const query of unique) { const options = await this.geocode(query); const relevant = this.relevantCandidates(item, options); if (relevant.length) return relevant; if (!fallback.length) fallback = options; }
    return this.relevantCandidates(item, fallback);
  }
  private async useApproximateCityLocation(tripId: string, itineraryVersion: number, mapVersion: number, item: MapEntityView, reason: string, runToken?: string) {
    const city = item.city.trim();
    if (!city) { this.store.updateMapEntity(tripId, itineraryVersion, item.id, "unlocated", null, item.candidates, `${reason}；未提供可用于大致定位的城市。`); this.emitEntity(tripId, itineraryVersion, mapVersion, item.id); return; }
    try {
      const options = await this.geocode(city); this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken);
      const selected = options.find((candidate) => ["place", "boundary"].includes(candidate.category || "")) ?? options[0];
      if (!selected) { this.store.updateMapEntity(tripId, itineraryVersion, item.id, "unlocated", null, item.candidates, `${reason}；未能定位到${city}。`); this.emitEntity(tripId, itineraryVersion, mapVersion, item.id); return; }
      const location: Candidate = { ...selected, confidence: "medium", decisionNote: `${reason}；使用${city}的城市/区域中心作大致定位。` };
      const selectedPlace = this.store.selectMapCandidate(tripId, itineraryVersion, item.id, location, "approximate", "未找到可靠的精确地点，地图以城市/区域中心（大致）显示。"); await this.rerouteAffectedDays(tripId, itineraryVersion, mapVersion, selectedPlace.affectedDayNumbers, runToken);
    } catch (error) {
      this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken);
      this.store.updateMapEntity(tripId, itineraryVersion, item.id, "unlocated", null, item.candidates, `${reason}；${error instanceof Error ? error.message : "城市大致定位失败。"}`);
    }
    this.emitEntity(tripId, itineraryVersion, mapVersion, item.id);
  }
  private profile(mode: string) { if (mode === "bike") return "https://routing.openstreetmap.de/routed-bike/route/v1/driving"; if (mode === "walk") return "https://routing.openstreetmap.de/routed-foot/route/v1/driving"; return "https://routing.openstreetmap.de/routed-car/route/v1/driving"; }
  private async route(from: Candidate, to: Candidate, mode: string, signal?: AbortSignal): Promise<{ geometry: unknown | null; warning: string | null }> {
    if (mode === "transit_advisory" || mode === "none") return { geometry: null, warning: mode === "transit_advisory" ? "公共交通仅作未实时核验建议。" : null };
    const key = `${mode}:${from.longitude},${from.latitude}:${to.longitude},${to.latitude}`; const cached = this.cached<{ geometry: unknown | null; warning: string | null }>("route_cache", key); if (cached) return cached;
    // Routing has an independent pool; Nominatim's public one-request cadence must not serialize routes.
    const result = await (async () => { const url = new URL(`${this.profile(mode)}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}`); url.searchParams.set("overview", "full"); url.searchParams.set("geometries", "geojson"); const response = await fetch(url, { signal, headers: { "User-Agent": "AI-Travel-Planner/0.1 (personal local travel planner)", Accept: "application/json" } }); if (!response.ok) return { geometry: null, warning: "路线服务暂时不可用。" }; const data = await response.json() as { code?: string; routes?: Array<{ geometry?: unknown }> }; return data.code === "Ok" && data.routes?.[0]?.geometry ? { geometry: data.routes[0].geometry, warning: null } : { geometry: null, warning: "未能找到该路段的路线。" }; })();
    this.save("route_cache", key, result, 7 * 24 * 60 * 60 * 1000); return result;
  }
  private emitEntity(tripId: string, itineraryVersion: number, mapVersion: number, id: string, remove: string[] = []) { const entity = this.store.mapPlaces(tripId, itineraryVersion).find((item) => item.id === id); if (entity) { const sequence = this.store.nextMapPatchSequence(tripId, itineraryVersion); const snapshot = this.store.getMapSnapshot(tripId, "all"); this.onPatch({ tripId, itineraryVersion, mapVersion, sequence, places: { upsert: [entity], remove }, visits: { upsert: snapshot?.visits.filter((visit) => visit.placeId === id) ?? [], remove: [] }, dayProgress: snapshot?.dayProgress ?? [], entities: { upsert: [entity], remove }, routes: { upsert: [], remove: [] }, dayPaths: snapshot?.dayPaths }); } }
  private emitRoute(tripId: string, itineraryVersion: number, mapVersion: number, id: string) { const route = this.store.mapRoutes(tripId, itineraryVersion).find((item) => item.id === id); if (route) { const sequence = this.store.nextMapPatchSequence(tripId, itineraryVersion); const snapshot = this.store.getMapSnapshot(tripId, "all"); this.onPatch({ tripId, itineraryVersion, mapVersion, sequence, places: { upsert: [], remove: [] }, visits: { upsert: [], remove: [] }, dayProgress: snapshot?.dayProgress ?? [], entities: { upsert: [], remove: [] }, routes: { upsert: [route], remove: [] } }); } }
  private async rerouteAffectedDays(tripId: string, itineraryVersion: number, mapVersion: number, dayNumbers: number[], runToken?: string) { await Promise.all([...new Set(dayNumbers)].map((dayNumber) => this.resolveDayRoutes(tripId, itineraryVersion, mapVersion, dayNumber, runToken))); }
  private assertCurrent(tripId: string, itineraryVersion: number, mapVersion: number, runToken?: string) { const meta = this.store.latestMapMeta(tripId); const activeRevision = this.store.requireTrip(tripId).activeRevision?.version; if (!meta || meta.itineraryVersion !== itineraryVersion || activeRevision !== itineraryVersion || meta.mapVersion !== mapVersion || meta.status === "stopped" || (runToken && this.activeRuns.get(tripId)?.token !== runToken)) throw new Error("地图任务基线已经过期。"); return meta; }

  async resolveLocations(tripId: string, itineraryVersion: number, mapVersion: number): Promise<MapResolutionBatch> {
    this.assertCurrent(tripId, itineraryVersion, mapVersion); this.store.setMapStatus(tripId, itineraryVersion, "resolving", "正在使用 Nominatim 解析原子地点"); this.onJob({ tripId, itineraryVersion, mapVersion, status: "resolving", summary: "正在使用 Nominatim 解析原子地点" });
    for (const item of this.store.mapEntities(tripId, itineraryVersion)) if (item.status === "resolved" && item.location?.sourceType === "nominatim" && !this.relevantCandidates(item, [item.location]).length) this.store.resetMapEntity(tripId, itineraryVersion, item.id, "已有坐标与地点类型不匹配，正在重新解析。");
    const pending = this.store.pendingMapEntities(tripId, itineraryVersion).sort((a, b) => (a.queueOrder ?? a.order) - (b.queueOrder ?? b.order));
    // Workers dequeue in first-seen order. Nominatim itself remains single-filed by `request`.
    let cursor = 0; const worker = async () => { while (cursor < pending.length) { const item = pending[cursor++];
      this.assertCurrent(tripId, itineraryVersion, mapVersion);
      try { const options = await this.geocodeEntity(item); const selected = options.length === 1 ? options[0] : null; const status = selected ? "resolved" : options.length ? "ambiguous" : "unresolved"; if (selected) { const merged = this.store.selectMapCandidate(tripId, itineraryVersion, item.id, selected); this.emitEntity(tripId, itineraryVersion, mapVersion, merged.entityId, merged.removedEntityIds); continue; } this.store.updateMapEntity(tripId, itineraryVersion, item.id, status, null, options, options.length ? "等待 AI 从多个候选中确认。" : "Nominatim 未找到合适候选，等待 AI 补充坐标。"); }
      catch (error) { this.store.updateMapEntity(tripId, itineraryVersion, item.id, "unresolved", null, [], error instanceof Error ? error.message : "地点解析失败。"); }
      this.emitEntity(tripId, itineraryVersion, mapVersion, item.id);
    } }; await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
    return this.resolutionBatch(tripId, itineraryVersion);
  }

  /** Resolve only the unique places referenced by one day; shared places keep their prior result. */
  async resolveLocationsForDay(tripId: string, itineraryVersion: number, mapVersion: number, dayNumber: number, runToken?: string): Promise<MapResolutionBatch> {
    const snapshot = this.store.getMapSnapshot(tripId, "day", dayNumber); if (!snapshot) return [];
    this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken);
    const pending = snapshot.places.filter((item) => item.status === "pending" || item.status === "failed" || item.status === "unresolved").sort((a, b) => (a.queueOrder ?? a.order) - (b.queueOrder ?? b.order));
    await Promise.all(pending.map((place) => this.schedulePlaceWork(async () => {
      this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken);
      try { const options = await this.geocodeEntity(place); this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken); const selected = options.length === 1 ? options[0] : null; if (selected) { const merged = this.store.selectMapCandidate(tripId, itineraryVersion, place.id, selected); this.emitEntity(tripId, itineraryVersion, mapVersion, merged.entityId, merged.removedEntityIds); await this.rerouteAffectedDays(tripId, itineraryVersion, mapVersion, merged.affectedDayNumbers, runToken); return; } this.store.updateMapEntity(tripId, itineraryVersion, place.id, options.length ? "ambiguous" : "unresolved", null, options, "等待补充地点坐标。"); }
      catch (error) { this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken); this.store.updateMapEntity(tripId, itineraryVersion, place.id, "unresolved", null, [], error instanceof Error ? error.message : "地点解析失败。"); }
      this.emitEntity(tripId, itineraryVersion, mapVersion, place.id);
    })));
    return this.resolutionBatch(tripId, itineraryVersion, dayNumber);
  }

  resolutionBatch(tripId: string, itineraryVersion: number, dayNumber?: number): MapResolutionBatch { const allowed = dayNumber ? new Set(this.store.getMapSnapshot(tripId, "day", dayNumber)?.places.map((item) => item.id) ?? []) : null; return this.store.mapEntities(tripId, itineraryVersion).filter((item) => (!allowed || allowed.has(item.id)) && (item.status === "ambiguous" || item.status === "unresolved")).map((item) => ({ entityId: item.id, name: item.name, query: item.query, city: item.city, kind: item.kind, approximateLodgingArea: item.approximateLodgingArea, detail: item.detail, candidates: item.candidates })); }

  /** Final safety net, including when the AI resolution turn is unavailable. */
  async settleUnresolvedWithCityFallback(tripId: string, itineraryVersion: number, mapVersion: number, dayNumber?: number, runToken?: string, entityIds?: string[]) {
    const allowed = dayNumber ? new Set(this.store.getMapSnapshot(tripId, "day", dayNumber)?.places.map((item) => item.id) ?? []) : null;
    const claimed = entityIds ? new Set(entityIds) : null;
    for (const entity of this.store.mapEntities(tripId, itineraryVersion).filter((item) => (!allowed || allowed.has(item.id)) && (!claimed || claimed.has(item.id)) && (item.status === "unresolved" || item.status === "ambiguous" || item.status === "failed" || item.status === "pending"))) {
      this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken);
      await this.useApproximateCityLocation(tripId, itineraryVersion, mapVersion, entity, entity.warning || "未能获得可靠的精确坐标", runToken);
    }
  }

  async applyResolution(tripId: string, itineraryVersion: number, mapVersion: number, output: MapResolutionOutput, dayNumber?: number, runToken?: string, entityIds?: string[]) {
    const meta = this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken); if (output.baseItineraryVersion !== itineraryVersion || output.baseMapVersion !== mapVersion || meta.mapVersion !== output.baseMapVersion) throw new Error("AI 坐标决策基线已经过期。");
    const allowed = dayNumber ? new Set(this.store.getMapSnapshot(tripId, "day", dayNumber)?.places.map((item) => item.id) ?? []) : null;
    const claimed = entityIds ? new Set(entityIds) : null;
    const eligible = new Map(this.store.mapEntities(tripId, itineraryVersion).filter((item) => (!allowed || allowed.has(item.id)) && (!claimed || claimed.has(item.id)) && (item.status === "ambiguous" || item.status === "unresolved")).map((item) => [item.id, item]));
    const decided = new Set([...output.selections, ...output.coordinates, ...output.unresolved].map((item) => item.entityId)); for (const entityId of eligible.keys()) if (!decided.has(entityId)) throw new Error(`AI 坐标决策遗漏了待处理地点：${entityId}`);
    const requireEligible = (entityId: string) => { const entity = eligible.get(entityId); if (!entity) throw new Error(`AI 坐标决策引用了非待处理地点：${entityId}`); return entity; };
    for (const decision of output.selections) { const entity = requireEligible(decision.entityId); if (!entity.candidates.some((item) => item.providerPlaceId === decision.providerPlaceId)) throw new Error(`AI 选择了候选列表之外的地点：${decision.entityId}`); }
    for (const decision of output.coordinates) requireEligible(decision.entityId);
    for (const decision of output.unresolved) requireEligible(decision.entityId);
    for (const decision of output.selections) {
      const entity = requireEligible(decision.entityId); const selected = entity.candidates.find((item) => item.providerPlaceId === decision.providerPlaceId)!;
      const merged = this.store.selectMapCandidate(tripId, itineraryVersion, entity.id, { ...selected, decisionNote: decision.decisionNote }); this.emitEntity(tripId, itineraryVersion, mapVersion, merged.entityId, merged.removedEntityIds); await this.rerouteAffectedDays(tripId, itineraryVersion, mapVersion, merged.affectedDayNumbers, runToken);
    }
    for (const decision of output.coordinates) {
      const entity = requireEligible(decision.entityId);
      if (decision.confidence === "low") { await this.useApproximateCityLocation(tripId, itineraryVersion, mapVersion, entity, `AI 坐标置信度较低：${decision.decisionNote}`, runToken); continue; }
      const sourceUrl = `https://www.openstreetmap.org/?mlat=${decision.latitude}&mlon=${decision.longitude}`; const location: Candidate = { providerPlaceId: `ai:${decision.sourceType}:${entity.id}`, displayName: decision.displayName, latitude: decision.latitude, longitude: decision.longitude, category: entity.kind, sourceUrl, sourceType: decision.sourceType, evidenceUrl: decision.evidenceUrl, confidence: decision.confidence, decisionNote: decision.decisionNote };
      const merged = this.store.selectMapCandidate(tripId, itineraryVersion, entity.id, location); this.emitEntity(tripId, itineraryVersion, mapVersion, merged.entityId, merged.removedEntityIds); await this.rerouteAffectedDays(tripId, itineraryVersion, mapVersion, merged.affectedDayNumbers, runToken);
    }
    for (const decision of output.unresolved) { const entity = requireEligible(decision.entityId); await this.useApproximateCityLocation(tripId, itineraryVersion, mapVersion, entity, decision.reason, runToken); }
  }

  /** Draw a day as soon as every referenced place has a usable coordinate. */
  async resolveDayRoutes(tripId: string, itineraryVersion: number, mapVersion: number, dayNumber: number, runToken?: string) {
    this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken);
    const snapshot = this.store.getMapSnapshot(tripId, "day", dayNumber); if (!snapshot || !snapshot.visits.length) return;
    if (!dayPlacesAreTerminal(snapshot.places.map((place) => place.status))) return;
    const places = new Map(snapshot.places.map((item) => [item.id, item]));
    const path = snapshot.dayPaths[0]; const visitIds = path?.visitIds ?? snapshot.visits.sort((a, b) => a.subOrder - b.subOrder).map((item) => item.id);
    const visits = new Map(snapshot.visits.map((item) => [item.id, item]));
    const anchors = visitIds.map((visitId, index) => ({ visitId, index, visit: visits.get(visitId), place: places.get(visits.get(visitId)?.placeId || "") })).filter((item): item is typeof item & { visit: MapVisit; place: MapEntityView } => Boolean(item.visit && item.place?.location));
    const pending = snapshot.routes.filter((route) => route.status === "pending" || route.status === "failed" || route.status === "unresolved").sort((a, b) => (a.edgeOrder ?? a.order) - (b.edgeOrder ?? b.order));
    if (anchors.length < 2) {
      for (const route of pending) { this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken); this.store.updateMapRoute(tripId, itineraryVersion, route.id, "resolved", null, "当天不足两个可定位地点，未绘制路线。"); this.emitRoute(tripId, itineraryVersion, mapVersion, route.id); }
      return;
    }
    const handled = new Set<string>(); const work: Array<{ key: string; run: () => Promise<void> }> = [];
    for (let index = 0; index < anchors.length - 1; index += 1) {
      const from = anchors[index]; const to = anchors[index + 1];
      const segment = pending.filter((route) => { const edge = (route.edgeOrder ?? route.order) - 1; return edge >= from.index && edge < to.index; });
      const primary = segment[0]; if (!primary) continue; for (const route of segment) handled.add(route.id);
      work.push({ key: `${tripId}:${itineraryVersion}:${primary.id}`, run: async () => {
        this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken);
        const skipped = visitIds.slice(from.index + 1, to.index).map((id) => visits.get(id)?.activity || id);
        if (from.place.id === to.place.id) this.store.updateMapRoute(tripId, itineraryVersion, primary.id, "resolved", null, "连续重复地点，无需绘制路线。");
        else try {
          const result = primary.mode === "flight" ? { geometry: this.flightGeometry(from.place.location!, to.place.location!), warning: null } : await this.route(from.place.location!, to.place.location!, primary.mode, this.runSignal(tripId, runToken)); this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken);
          const geometry = result.geometry ?? (primary.mode === "none" || primary.mode === "transit_advisory" ? null : this.flightGeometry(from.place.location!, to.place.location!));
          const warning = [skipped.length ? `已略过未定位地点：${skipped.join("、")}。` : null, result.warning, !result.geometry && geometry ? "路线服务不可用，已显示直连线。" : null].filter(Boolean).join(" ") || null;
          this.store.updateMapRoute(tripId, itineraryVersion, primary.id, "resolved", geometry, warning);
        } catch (error) { this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken); this.store.updateMapRoute(tripId, itineraryVersion, primary.id, "resolved", primary.mode === "none" || primary.mode === "transit_advisory" ? null : this.flightGeometry(from.place.location!, to.place.location!), error instanceof Error ? error.message : "路线服务失败，已显示直连线。"); }
        this.emitRoute(tripId, itineraryVersion, mapVersion, primary.id);
        for (const route of segment.slice(1)) { this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken); this.store.updateMapRoute(tripId, itineraryVersion, route.id, "resolved", null, `已由 ${primary.id} 跨过未定位地点连接。`); this.emitRoute(tripId, itineraryVersion, mapVersion, route.id); }
      } });
    }
    await Promise.all(work.map((operation) => this.scheduleRouteWork(operation.key, operation.run)));
    for (const route of pending.filter((item) => !handled.has(item.id))) { this.assertCurrent(tripId, itineraryVersion, mapVersion, runToken); this.store.updateMapRoute(tripId, itineraryVersion, route.id, "resolved", null, "路线端点未定位，未绘制该段。"); this.emitRoute(tripId, itineraryVersion, mapVersion, route.id); }
  }

  async resolveRoutes(tripId: string, itineraryVersion: number, mapVersion: number) {
    this.assertCurrent(tripId, itineraryVersion, mapVersion); this.store.setMapStatus(tripId, itineraryVersion, "resolving", "正在用已确认坐标绘制路线"); this.onJob({ tripId, itineraryVersion, mapVersion, status: "resolving", summary: "正在用已确认坐标绘制路线" });
    const v4Days = this.store.getMapSnapshot(tripId, "all")?.dayPaths.map((path) => path.dayNumber) ?? [];
    if (v4Days.length) { await Promise.all(v4Days.map((dayNumber) => this.resolveDayRoutes(tripId, itineraryVersion, mapVersion, dayNumber))); return; }
    const entities = new Map(this.store.mapEntities(tripId, itineraryVersion).map((entity) => [entity.id, entity]));
    const routes = this.store.mapRoutes(tripId, itineraryVersion);
    const routeFor = new Map(routes.map((route) => [`${route.dayNumber}:${route.fromEntityId}>${route.toEntityId}`, route]));
    const paths = this.store.getMapSnapshot(tripId, "all")?.dayPaths ?? [];
    for (const path of paths) {
      this.assertCurrent(tripId, itineraryVersion, mapVersion);
      const anchors = path.entityIds.map((id, index) => ({ id, index, entity: entities.get(id) })).filter((item): item is { id: string; index: number; entity: MapEntityView } => Boolean(item.entity?.location));
      const pathRoutes = path.entityIds.slice(0, -1).map((fromEntityId, index) => routeFor.get(`${path.dayNumber}:${fromEntityId}>${path.entityIds[index + 1]}`)).filter((item): item is MapRouteView => Boolean(item));
      if (anchors.length < 2) {
        for (const route of pathRoutes) { this.store.updateMapRoute(tripId, itineraryVersion, route.id, "resolved", null, "当天不足两个可定位地点，未绘制路线。"); this.emitRoute(tripId, itineraryVersion, mapVersion, route.id); }
        continue;
      }
      for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
        const from = anchors[anchorIndex]; const to = anchors[anchorIndex + 1]; const skipped = path.entityIds.slice(from.index + 1, to.index);
        const segmentRoutes = pathRoutes.filter((route) => {
          const start = path.entityIds.indexOf(route.fromEntityId); return start >= from.index && start < to.index;
        });
        const primary = segmentRoutes[0]; if (!primary) continue;
        try {
          const result = primary.mode === "flight" ? { geometry: this.flightGeometry(from.entity.location!, to.entity.location!), warning: null } : await this.route(from.entity.location!, to.entity.location!, primary.mode);
          const geometry = result.geometry ?? (primary.mode === "none" || primary.mode === "transit_advisory" ? null : this.flightGeometry(from.entity.location!, to.entity.location!));
          const warning = [skipped.length ? `已略过未定位地点：${skipped.map((id) => entities.get(id)?.name || id).join("、")}。` : null, result.warning, !result.geometry && geometry ? "路线服务不可用，已显示直连线。" : null].filter(Boolean).join(" ") || null;
          this.store.updateMapRoute(tripId, itineraryVersion, primary.id, "resolved", geometry, warning);
        } catch (error) {
          const geometry = primary.mode === "none" || primary.mode === "transit_advisory" ? null : this.flightGeometry(from.entity.location!, to.entity.location!);
          this.store.updateMapRoute(tripId, itineraryVersion, primary.id, "resolved", geometry, `${skipped.length ? "已略过未定位地点。" : ""}${error instanceof Error ? error.message : "路线服务失败，已显示直连线。"}`);
        }
        this.emitRoute(tripId, itineraryVersion, mapVersion, primary.id);
        for (const route of segmentRoutes.slice(1)) { this.store.updateMapRoute(tripId, itineraryVersion, route.id, "resolved", null, `已略过未定位地点，由 ${primary.id} 连接相邻可定位地点。`); this.emitRoute(tripId, itineraryVersion, mapVersion, route.id); }
      }
    }
  }

  private flightGeometry(from: Candidate, to: Candidate) {
    const a: [number, number] = [from.longitude, from.latitude]; const b: [number, number] = [to.longitude, to.latitude];
    if (Math.abs(a[0] - b[0]) <= 180) return { type: "LineString", coordinates: [a, b] };
    // Unwrap the destination in the direction of the shortest arc, then split
    // exactly at the antimeridian.  This works in both directions.
    const eastward = b[0] - a[0] < -180;
    const targetLongitude = eastward ? b[0] + 360 : b[0] - 360;
    const boundary = eastward ? 180 : -180;
    const ratio = (boundary - a[0]) / (targetLongitude - a[0]);
    const latitude = a[1] + (b[1] - a[1]) * ratio;
    return { type: "MultiLineString", coordinates: [[a, [boundary, latitude]], [[-boundary, latitude], b]] };
  }

  finalize(tripId: string, itineraryVersion: number, mapVersion: number) {
    this.assertCurrent(tripId, itineraryVersion, mapVersion); const entities = this.store.mapEntities(tripId, itineraryVersion); const approximate = entities.filter((item) => item.status === "approximate").length; const unresolved = entities.filter((item) => item.status === "unlocated" || item.status === "unresolved" || item.status === "failed" || item.status === "ambiguous" || item.status === "pending").length; const progress = this.store.mapDayProgress(tripId, itineraryVersion); const complete = progress.length > 0 && progress.every((item) => item.status === "ready"); const any = progress.some((item) => item.resolvedPlaces || item.resolvedRoutes); const summary = `${complete ? "全程地图已完成" : any ? "地图已部分完成" : "地图等待定位"}${approximate || unresolved ? `（${[approximate ? `${approximate} 个大致定位` : "", unresolved ? `${unresolved} 个未定位` : ""].filter(Boolean).join("，")}）` : ""}`;
    const status: "ready" | "partial" | "failed" = complete && !approximate && !unresolved ? "ready" : any ? "partial" : "failed";
    this.store.setMapStatus(tripId, itineraryVersion, status, summary); this.onJob({ tripId, itineraryVersion, mapVersion, status, summary }); return this.store.getMapSnapshot(tripId, "all");
  }

  async resolveManifest(tripId: string, itineraryVersion: number, mapVersion: number) { await this.resolveLocations(tripId, itineraryVersion, mapVersion); await this.resolveRoutes(tripId, itineraryVersion, mapVersion); return this.finalize(tripId, itineraryVersion, mapVersion); }
  snapshot(tripId: string, scope: "all" | "day", dayNumber: number | null): MapSnapshot | null { return this.store.getMapSnapshot(tripId, scope, dayNumber); }
  async selectCandidate(tripId: string, entityId: string, value: unknown) { const item = value as Candidate; if (!item || typeof item.providerPlaceId !== "string") throw new Error("地点候选无效。"); const trip = this.store.requireTrip(tripId); if (!trip.activeRevision) throw new Error("当前没有行程版本。"); const meta = this.store.latestMapMeta(tripId); if (!meta || meta.itineraryVersion !== trip.activeRevision.version) throw new Error("当前地图尚未建立。"); const entity = this.store.mapEntities(tripId, meta.itineraryVersion).find((candidate) => candidate.id === entityId); const allowed = entity?.candidates.find((candidate) => candidate.providerPlaceId === item.providerPlaceId); if (!allowed) throw new Error("地点候选不属于当前待处理地点。"); const merged = this.store.selectMapCandidate(tripId, meta.itineraryVersion, entityId, { ...allowed, sourceType: "manual", confidence: "high", decisionNote: "用户手工确认地图候选" }); this.emitEntity(tripId, meta.itineraryVersion, meta.mapVersion, merged.entityId, merged.removedEntityIds); await this.resolveRoutes(tripId, meta.itineraryVersion, meta.mapVersion); this.finalize(tripId, meta.itineraryVersion, meta.mapVersion); }
}
