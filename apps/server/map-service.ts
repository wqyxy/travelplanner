import { createRequire } from "node:module";
import type { Candidate, MapDayPath, MapEntityView, MapResolutionOutput, MapRouteView, MapSnapshot } from "./contracts.js";
import type { TravelStore } from "./travel-store.js";

type CacheRow = { payload_json: string; expires_at: number };
type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
type MapPatchPayload = { tripId: string; itineraryVersion: number; mapVersion: number; replaceAll?: boolean; entities: { upsert: MapEntityView[]; remove: string[] }; routes: { upsert: MapRouteView[]; remove: string[] }; dayPaths?: MapDayPath[] };
type MapJobPayload = { tripId: string; itineraryVersion: number; mapVersion: number; status: string; summary: string };
export type MapResolutionBatch = { entityId: string; name: string; query: string; city: string; kind: MapEntityView["kind"]; approximateLodgingArea: boolean; detail: string; candidates: Candidate[] }[];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const asCandidate = (item: Record<string, unknown>): Candidate | null => {
  const latitude = Number(item.lat); const longitude = Number(item.lon); const providerPlaceId = String(item.place_id ?? ""); const displayName = String(item.display_name ?? "");
  return providerPlaceId && displayName && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { providerPlaceId, displayName, latitude, longitude, category: typeof item.category === "string" ? item.category : null, sourceUrl: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}`, sourceType: "nominatim", evidenceUrl: null, confidence: "high", decisionNote: null } : null;
};

export class MapService {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private nextRequest = 0;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(filename: string, private readonly store: TravelStore, private readonly onPatch: (payload: MapPatchPayload) => void = () => {}, private readonly onJob: (payload: MapJobPayload) => void = () => {}) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS geocode_cache(key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS route_cache(key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,expires_at INTEGER NOT NULL);");
  }
  close() { this.db.close(); }
  private cached<T>(table: "geocode_cache" | "route_cache", key: string): T | null { const row = this.db.prepare(`SELECT payload_json,expires_at FROM ${table} WHERE key=?`).get(key) as CacheRow | undefined; if (!row || row.expires_at < Date.now()) return null; try { return JSON.parse(row.payload_json) as T; } catch { return null; } }
  private save<T>(table: "geocode_cache" | "route_cache", key: string, payload: T, ttlMs: number) { this.db.prepare(`INSERT INTO ${table}(key,payload_json,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json,expires_at=excluded.expires_at`).run(key, JSON.stringify(payload), Date.now() + ttlMs); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const run = this.serial.then(operation, operation); this.serial = run.then(() => undefined, () => undefined); return run; }
  private async request<T>(operation: () => Promise<T>) { return this.enqueue(async () => { const wait = Math.max(0, this.nextRequest - Date.now()); if (wait) await sleep(wait); this.nextRequest = Date.now() + 1100; return operation(); }); }
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
    const parts = item.query.split(",").map((part) => part.trim()).filter(Boolean); const variants = [item.query];
    if (parts.length > 3) variants.push([parts[0], parts.at(-2), parts.at(-1)].filter(Boolean).join(", "));
    if (parts.length > 2) variants.push([parts[0], parts.at(-1)].filter(Boolean).join(", "));
    const unique = [...new Set(variants)]; let fallback: Candidate[] = [];
    for (const query of unique) { const options = await this.geocode(query); const relevant = this.relevantCandidates(item, options); if (relevant.length) return relevant; if (!fallback.length) fallback = options; }
    return this.relevantCandidates(item, fallback);
  }
  private async useApproximateCityLocation(tripId: string, itineraryVersion: number, mapVersion: number, item: MapEntityView, reason: string) {
    const city = item.city.trim();
    if (!city) { this.store.updateMapEntity(tripId, itineraryVersion, item.id, "unlocated", null, item.candidates, `${reason}；未提供可用于大致定位的城市。`); this.emitEntity(tripId, itineraryVersion, mapVersion, item.id); return; }
    try {
      const options = await this.geocode(city);
      const selected = options.find((candidate) => ["place", "boundary"].includes(candidate.category || "")) ?? options[0];
      if (!selected) { this.store.updateMapEntity(tripId, itineraryVersion, item.id, "unlocated", null, item.candidates, `${reason}；未能定位到${city}。`); this.emitEntity(tripId, itineraryVersion, mapVersion, item.id); return; }
      const location: Candidate = { ...selected, confidence: "medium", decisionNote: `${reason}；使用${city}的城市/区域中心作大致定位。` };
      this.store.selectMapCandidate(tripId, itineraryVersion, item.id, location, "approximate", "未找到可靠的精确地点，地图以城市/区域中心（大致）显示。");
    } catch (error) {
      this.store.updateMapEntity(tripId, itineraryVersion, item.id, "unlocated", null, item.candidates, `${reason}；${error instanceof Error ? error.message : "城市大致定位失败。"}`);
    }
    this.emitEntity(tripId, itineraryVersion, mapVersion, item.id);
  }
  private profile(mode: string) { if (mode === "bike") return "https://routing.openstreetmap.de/routed-bike/route/v1/driving"; if (mode === "walk") return "https://routing.openstreetmap.de/routed-foot/route/v1/driving"; return "https://routing.openstreetmap.de/routed-car/route/v1/driving"; }
  private async route(from: Candidate, to: Candidate, mode: string): Promise<{ geometry: unknown | null; warning: string | null }> {
    if (mode === "transit_advisory" || mode === "none") return { geometry: null, warning: mode === "transit_advisory" ? "公共交通仅作未实时核验建议。" : null };
    const key = `${mode}:${from.longitude},${from.latitude}:${to.longitude},${to.latitude}`; const cached = this.cached<{ geometry: unknown | null; warning: string | null }>("route_cache", key); if (cached) return cached;
    const result = await this.request(async () => { const url = new URL(`${this.profile(mode)}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}`); url.searchParams.set("overview", "full"); url.searchParams.set("geometries", "geojson"); const response = await fetch(url, { headers: { "User-Agent": "AI-Travel-Planner/0.1 (personal local travel planner)", Accept: "application/json" } }); if (!response.ok) return { geometry: null, warning: "路线服务暂时不可用。" }; const data = await response.json() as { code?: string; routes?: Array<{ geometry?: unknown }> }; return data.code === "Ok" && data.routes?.[0]?.geometry ? { geometry: data.routes[0].geometry, warning: null } : { geometry: null, warning: "未能找到该路段的路线。" }; });
    this.save("route_cache", key, result, 7 * 24 * 60 * 60 * 1000); return result;
  }
  private emitEntity(tripId: string, itineraryVersion: number, mapVersion: number, id: string) { const entity = this.store.mapEntities(tripId, itineraryVersion).find((item) => item.id === id); if (entity) this.onPatch({ tripId, itineraryVersion, mapVersion, entities: { upsert: [entity], remove: [] }, routes: { upsert: [], remove: [] } }); }
  private emitRoute(tripId: string, itineraryVersion: number, mapVersion: number, id: string) { const route = this.store.mapRoutes(tripId, itineraryVersion).find((item) => item.id === id); if (route) this.onPatch({ tripId, itineraryVersion, mapVersion, entities: { upsert: [], remove: [] }, routes: { upsert: [route], remove: [] } }); }
  private assertCurrent(tripId: string, itineraryVersion: number, mapVersion: number) { const meta = this.store.latestMapMeta(tripId); if (!meta || meta.itineraryVersion !== itineraryVersion || meta.mapVersion !== mapVersion) throw new Error("地图任务基线已经过期。"); return meta; }

  async resolveLocations(tripId: string, itineraryVersion: number, mapVersion: number): Promise<MapResolutionBatch> {
    this.assertCurrent(tripId, itineraryVersion, mapVersion); this.store.setMapStatus(tripId, itineraryVersion, "resolving", "正在使用 Nominatim 解析原子地点"); this.onJob({ tripId, itineraryVersion, mapVersion, status: "resolving", summary: "正在使用 Nominatim 解析原子地点" });
    for (const item of this.store.mapEntities(tripId, itineraryVersion)) if (item.status === "resolved" && item.location?.sourceType === "nominatim" && !this.relevantCandidates(item, [item.location]).length) this.store.resetMapEntity(tripId, itineraryVersion, item.id, "已有坐标与地点类型不匹配，正在重新解析。");
    for (const item of this.store.pendingMapEntities(tripId, itineraryVersion)) {
      this.assertCurrent(tripId, itineraryVersion, mapVersion);
      try { const options = await this.geocodeEntity(item); const selected = options.length === 1 ? options[0] : null; const status = selected ? "resolved" : options.length ? "ambiguous" : "unresolved"; this.store.updateMapEntity(tripId, itineraryVersion, item.id, status, selected, options, selected ? null : options.length ? "等待 AI 从多个候选中确认。" : "Nominatim 未找到合适候选，等待 AI 补充坐标。"); }
      catch (error) { this.store.updateMapEntity(tripId, itineraryVersion, item.id, "unresolved", null, [], error instanceof Error ? error.message : "地点解析失败。"); }
      this.emitEntity(tripId, itineraryVersion, mapVersion, item.id);
    }
    return this.resolutionBatch(tripId, itineraryVersion);
  }

  resolutionBatch(tripId: string, itineraryVersion: number): MapResolutionBatch { return this.store.mapEntities(tripId, itineraryVersion).filter((item) => item.status === "ambiguous" || item.status === "unresolved").map((item) => ({ entityId: item.id, name: item.name, query: item.query, city: item.city, kind: item.kind, approximateLodgingArea: item.approximateLodgingArea, detail: item.detail, candidates: item.candidates })); }

  /** Final safety net, including when the AI resolution turn is unavailable. */
  async settleUnresolvedWithCityFallback(tripId: string, itineraryVersion: number, mapVersion: number) {
    for (const entity of this.store.mapEntities(tripId, itineraryVersion).filter((item) => item.status === "unresolved" || item.status === "ambiguous" || item.status === "failed" || item.status === "pending")) {
      this.assertCurrent(tripId, itineraryVersion, mapVersion);
      await this.useApproximateCityLocation(tripId, itineraryVersion, mapVersion, entity, entity.warning || "未能获得可靠的精确坐标");
    }
  }

  async applyResolution(tripId: string, itineraryVersion: number, mapVersion: number, output: MapResolutionOutput) {
    const meta = this.assertCurrent(tripId, itineraryVersion, mapVersion); if (output.baseItineraryVersion !== itineraryVersion || output.baseMapVersion !== mapVersion || meta.mapVersion !== output.baseMapVersion) throw new Error("AI 坐标决策基线已经过期。");
    const eligible = new Map(this.store.mapEntities(tripId, itineraryVersion).filter((item) => item.status === "ambiguous" || item.status === "unresolved").map((item) => [item.id, item]));
    const decided = new Set([...output.selections, ...output.coordinates, ...output.unresolved].map((item) => item.entityId)); for (const entityId of eligible.keys()) if (!decided.has(entityId)) throw new Error(`AI 坐标决策遗漏了待处理地点：${entityId}`);
    const requireEligible = (entityId: string) => { const entity = eligible.get(entityId); if (!entity) throw new Error(`AI 坐标决策引用了非待处理地点：${entityId}`); return entity; };
    for (const decision of output.selections) { const entity = requireEligible(decision.entityId); if (!entity.candidates.some((item) => item.providerPlaceId === decision.providerPlaceId)) throw new Error(`AI 选择了候选列表之外的地点：${decision.entityId}`); }
    for (const decision of output.coordinates) requireEligible(decision.entityId);
    for (const decision of output.unresolved) requireEligible(decision.entityId);
    for (const decision of output.selections) {
      const entity = requireEligible(decision.entityId); const selected = entity.candidates.find((item) => item.providerPlaceId === decision.providerPlaceId)!;
      this.store.selectMapCandidate(tripId, itineraryVersion, entity.id, { ...selected, decisionNote: decision.decisionNote }); this.emitEntity(tripId, itineraryVersion, mapVersion, entity.id);
    }
    for (const decision of output.coordinates) {
      const entity = requireEligible(decision.entityId);
      if (decision.confidence === "low") { await this.useApproximateCityLocation(tripId, itineraryVersion, mapVersion, entity, `AI 坐标置信度较低：${decision.decisionNote}`); continue; }
      const sourceUrl = `https://www.openstreetmap.org/?mlat=${decision.latitude}&mlon=${decision.longitude}`; const location: Candidate = { providerPlaceId: `ai:${decision.sourceType}:${entity.id}`, displayName: decision.displayName, latitude: decision.latitude, longitude: decision.longitude, category: entity.kind, sourceUrl, sourceType: decision.sourceType, evidenceUrl: decision.evidenceUrl, confidence: decision.confidence, decisionNote: decision.decisionNote };
      this.store.selectMapCandidate(tripId, itineraryVersion, entity.id, location); this.emitEntity(tripId, itineraryVersion, mapVersion, entity.id);
    }
    for (const decision of output.unresolved) { const entity = requireEligible(decision.entityId); await this.useApproximateCityLocation(tripId, itineraryVersion, mapVersion, entity, decision.reason); }
  }

  async resolveRoutes(tripId: string, itineraryVersion: number, mapVersion: number) {
    this.assertCurrent(tripId, itineraryVersion, mapVersion); this.store.setMapStatus(tripId, itineraryVersion, "resolving", "正在用已确认坐标绘制路线"); this.onJob({ tripId, itineraryVersion, mapVersion, status: "resolving", summary: "正在用已确认坐标绘制路线" });
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
    this.assertCurrent(tripId, itineraryVersion, mapVersion); const entities = this.store.mapEntities(tripId, itineraryVersion); const approximate = entities.filter((item) => item.status === "approximate").length; const unresolved = entities.filter((item) => item.status === "unlocated" || item.status === "unresolved" || item.status === "failed" || item.status === "ambiguous" || item.status === "pending").length; const summary = `全程地图已完成${approximate || unresolved ? `（${[approximate ? `${approximate} 个大致定位` : "", unresolved ? `${unresolved} 个未定位` : ""].filter(Boolean).join("，")}）` : ""}`;
    const status = "ready";
    this.store.setMapStatus(tripId, itineraryVersion, status, summary); this.onJob({ tripId, itineraryVersion, mapVersion, status, summary }); return this.store.getMapSnapshot(tripId, "all");
  }

  async resolveManifest(tripId: string, itineraryVersion: number, mapVersion: number) { await this.resolveLocations(tripId, itineraryVersion, mapVersion); await this.resolveRoutes(tripId, itineraryVersion, mapVersion); return this.finalize(tripId, itineraryVersion, mapVersion); }
  snapshot(tripId: string, scope: "all" | "day", dayNumber: number | null): MapSnapshot | null { return this.store.getMapSnapshot(tripId, scope, dayNumber); }
  async selectCandidate(tripId: string, entityId: string, value: unknown) { const item = value as Candidate; if (!item || typeof item.providerPlaceId !== "string") throw new Error("地点候选无效。"); const trip = this.store.requireTrip(tripId); if (!trip.activeRevision) throw new Error("当前没有行程版本。"); const meta = this.store.latestMapMeta(tripId); if (!meta || meta.itineraryVersion !== trip.activeRevision.version) throw new Error("当前地图尚未建立。"); const entity = this.store.mapEntities(tripId, meta.itineraryVersion).find((candidate) => candidate.id === entityId); const allowed = entity?.candidates.find((candidate) => candidate.providerPlaceId === item.providerPlaceId); if (!allowed) throw new Error("地点候选不属于当前待处理地点。"); this.store.selectMapCandidate(tripId, meta.itineraryVersion, entityId, { ...allowed, sourceType: "manual", confidence: "high", decisionNote: "用户手工确认地图候选" }); this.emitEntity(tripId, meta.itineraryVersion, meta.mapVersion, entityId); await this.resolveRoutes(tripId, meta.itineraryVersion, meta.mapVersion); this.finalize(tripId, meta.itineraryVersion, meta.mapVersion); }
}
