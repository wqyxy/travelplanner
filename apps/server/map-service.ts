import { createRequire } from "node:module";

type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;

type CacheRow = { payload_json: string; expires_at: number };
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type MapCandidate = {
  providerPlaceId: string;
  name: string | null;
  displayName: string;
  latitude: number;
  longitude: number;
  category: string | null;
  placeType: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
};

export type MapRouteResult = { geometry: unknown | null; distanceKm: number | null; durationMinutes: number | null; warning: string | null };

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export const ROUTE_SUCCESS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ROUTE_FAILURE_CACHE_TTL_MS = 60 * 60 * 1000;
export const GEOCODE_CACHE_VERSION = "v5-ai-led";

export function nominatimSearchUrl(query: string, _countryCode?: string | null, language = "en") {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  // Technical provider cap only. Application code does not rank or semantically trim these results.
  url.searchParams.set("limit", "20");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", language);
  url.searchParams.set("q", query);
  return url;
}

export function nominatimReverseUrl(latitude: number, longitude: number, language = "en") {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", language);
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  return url;
}

function candidateFromNominatim(value: unknown): MapCandidate | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const latitude = Number(item.lat); const longitude = Number(item.lon);
  const address = item.address && typeof item.address === "object" ? item.address as Record<string, unknown> : {};
  const city = [address.city, address.town, address.village, address.municipality, address.county].find((entry): entry is string => typeof entry === "string") ?? null;
  const countryCode = typeof address.country_code === "string" ? address.country_code.toLowerCase() : null;
  const providerPlaceId = String(item.place_id ?? ""); const displayName = String(item.display_name ?? "");
  if (!providerPlaceId || !displayName || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const displayNameHead = displayName.split(",", 1)[0]?.trim() || null;
  return {
    providerPlaceId,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : displayNameHead,
    displayName, latitude, longitude,
    category: typeof item.category === "string" ? item.category : null,
    placeType: typeof item.type === "string" ? item.type : null,
    countryCode,
    region: typeof address.state === "string" ? address.state : typeof address.region === "string" ? address.region : null,
    city,
    timezone: null,
  };
}

/** Public-data provider/cache only. It never reads or writes canonical travel data. */
export class MapService {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private serial: Promise<unknown> = Promise.resolve();
  private nextNominatimRequestAt = 0;

  constructor(filename: string, private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS geocode_cache(key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS route_cache(key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,expires_at INTEGER NOT NULL);");
  }

  close() { this.db.close(); }

  private cached<T>(table: "geocode_cache" | "route_cache", key: string): T | null {
    const row = this.db.prepare(`SELECT payload_json,expires_at FROM ${table} WHERE key=?`).get(key) as CacheRow | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    try { return JSON.parse(row.payload_json) as T; } catch { return null; }
  }

  private save<T>(table: "geocode_cache" | "route_cache", key: string, payload: T, ttl: number) {
    this.db.prepare(`INSERT INTO ${table}(key,payload_json,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json,expires_at=excluded.expires_at`).run(key, JSON.stringify(payload), Date.now() + ttl);
  }

  private request<T>(operation: () => Promise<T>) {
    const run = this.serial.then(async () => {
      const wait = Math.max(0, this.nextNominatimRequestAt - Date.now());
      if (wait) await sleep(wait);
      this.nextNominatimRequestAt = Date.now() + 1100;
      return operation();
    });
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  async search(query: string, _countryCode?: string | null): Promise<MapCandidate[]> {
    const key = `${GEOCODE_CACHE_VERSION}:${query.normalize("NFKC").trim().toLocaleLowerCase()}`;
    const cached = this.cached<MapCandidate[]>("geocode_cache", key);
    if (cached) return cached;
    const candidates = await this.request(async () => {
      const response = await this.fetcher(nominatimSearchUrl(query), { headers: { "User-Agent": "AI-Travel-Planner/0.1 (personal local travel planner)", Accept: "application/json" } });
      if (!response.ok) throw new Error("公开地点服务暂时不可用。");
      const payload = await response.json() as unknown;
      return Array.isArray(payload) ? payload.map(candidateFromNominatim).filter((item): item is MapCandidate => item !== null) : [];
    });
    this.save("geocode_cache", key, candidates, 30 * 24 * 60 * 60 * 1000);
    return candidates;
  }

  async reverse(latitude: number, longitude: number): Promise<MapCandidate | null> {
    const key = `${GEOCODE_CACHE_VERSION}:reverse:${latitude.toFixed(6)},${longitude.toFixed(6)}`;
    const cached = this.cached<MapCandidate | null>("geocode_cache", key);
    if (cached !== null) return cached;
    const candidate = await this.request(async () => {
      const response = await this.fetcher(nominatimReverseUrl(latitude, longitude), { headers: { "User-Agent": "AI-Travel-Planner/0.1 (personal local travel planner)", Accept: "application/json" } });
      if (!response.ok) throw new Error("公开地点服务暂时不可用。");
      return candidateFromNominatim(await response.json() as unknown);
    });
    this.save("geocode_cache", key, candidate, 30 * 24 * 60 * 60 * 1000);
    return candidate;
  }

  async route(mode: "walk" | "drive" | "bike", from: [number, number], to: [number, number], routeKey: string): Promise<MapRouteResult> {
    const cached = this.cached<MapRouteResult>("route_cache", routeKey);
    if (cached) return cached;
    const host = mode === "walk" ? "https://routing.openstreetmap.de/routed-foot/route/v1/driving" : mode === "bike" ? "https://routing.openstreetmap.de/routed-bike/route/v1/driving" : "https://routing.openstreetmap.de/routed-car/route/v1/driving";
    try {
      const url = new URL(`${host}/${from[0]},${from[1]};${to[0]},${to[1]}`);
      url.searchParams.set("overview", "full"); url.searchParams.set("geometries", "geojson");
      const response = await this.fetcher(url, { headers: { "User-Agent": "AI-Travel-Planner/0.1 (personal local travel planner)", Accept: "application/json" } });
      if (!response.ok) {
        const result: MapRouteResult = { geometry: null, distanceKm: null, durationMinutes: null, warning: "路线服务暂时不可用。" };
        this.save("route_cache", routeKey, result, ROUTE_FAILURE_CACHE_TTL_MS);
        return result;
      }
      const payload = await response.json() as { code?: string; routes?: Array<{ geometry?: unknown; distance?: unknown; duration?: unknown }> };
      const route = payload.routes?.[0]; const distance = typeof route?.distance === "number" ? route.distance : Number.NaN; const duration = typeof route?.duration === "number" ? route.duration : Number.NaN;
      const result: MapRouteResult = payload.code === "Ok" && route?.geometry
        ? { geometry: route.geometry, distanceKm: Number.isFinite(distance) && distance >= 0 ? distance / 1000 : null, durationMinutes: Number.isFinite(duration) && duration >= 0 ? duration / 60 : null, warning: null }
        : { geometry: null, distanceKm: null, durationMinutes: null, warning: "未能找到该路段的路线。" };
      this.save("route_cache", routeKey, result, ROUTE_SUCCESS_CACHE_TTL_MS);
      return result;
    } catch {
      const result: MapRouteResult = { geometry: null, distanceKm: null, durationMinutes: null, warning: "路线服务暂时不可用。" };
      this.save("route_cache", routeKey, result, ROUTE_FAILURE_CACHE_TTL_MS);
      return result;
    }
  }
}
