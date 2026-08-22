import { createRequire } from "node:module";

type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;

const OSM_TILE_SOURCE = "https://tile.openstreetmap.org";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_TILE_ZOOM = 19;
export const MAX_TILE_CACHE_BYTES = 1024 * 1024 * 1024;

type TileRow = {
  content: Uint8Array;
  content_type: string;
  size_bytes: number;
  expires_at: number;
  etag: string | null;
  last_modified: string | null;
};

export type CachedMapTile = {
  content: Buffer;
  contentType: string;
  cacheStatus: "hit" | "refreshed" | "stale";
};

type TileFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class TileFetchError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "TileFetchError";
  }
}

export function validateTileCoordinates(zoom: number, x: number, y: number) {
  if (!Number.isInteger(zoom) || !Number.isInteger(x) || !Number.isInteger(y) || zoom < 0 || zoom > MAX_TILE_ZOOM) return false;
  const width = 2 ** zoom;
  return x >= 0 && y >= 0 && x < width && y < width;
}

function expiryFrom(headers: Headers, now: number) {
  const cacheControl = headers.get("cache-control") || "";
  const maxAge = /(?:^|,)\s*(?:s-maxage|max-age)=(\d+)/i.exec(cacheControl);
  if (maxAge) return now + Number(maxAge[1]) * 1000;
  const expires = Date.parse(headers.get("expires") || "");
  return Number.isFinite(expires) && expires > now ? expires : now + DEFAULT_TTL_MS;
}

function safeReferrer(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export class MapTileCache {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly inFlight = new Map<string, Promise<CachedMapTile>>();

  constructor(filename: string, private readonly fetcher: TileFetch = (input, init) => fetch(input, init), private readonly maxBytes = MAX_TILE_CACHE_BYTES) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tile_cache (
        source TEXT NOT NULL,
        zoom INTEGER NOT NULL,
        tile_x INTEGER NOT NULL,
        tile_y INTEGER NOT NULL,
        content BLOB NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        etag TEXT,
        last_modified TEXT,
        last_accessed_at INTEGER NOT NULL,
        PRIMARY KEY(source, zoom, tile_x, tile_y)
      );
      CREATE INDEX IF NOT EXISTS tile_cache_lru ON tile_cache(last_accessed_at);
    `);
  }

  close() { this.db.close(); }

  stats() {
    const row = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM tile_cache").get() as { count: number; bytes: number };
    return { count: Number(row.count), bytes: Number(row.bytes) };
  }

  async getTile(zoom: number, x: number, y: number, referrer?: string): Promise<CachedMapTile> {
    if (!validateTileCoordinates(zoom, x, y)) throw new TileFetchError("无效的地图瓦片坐标。", 400);
    const key = `${zoom}/${x}/${y}`;
    const active = this.inFlight.get(key);
    if (active) return active;
    const request = this.loadTile(zoom, x, y, referrer).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private row(zoom: number, x: number, y: number) {
    return this.db.prepare("SELECT content,content_type,size_bytes,expires_at,etag,last_modified FROM tile_cache WHERE source=? AND zoom=? AND tile_x=? AND tile_y=?").get(OSM_TILE_SOURCE, zoom, x, y) as TileRow | undefined;
  }

  private touch(zoom: number, x: number, y: number, now: number) {
    this.db.prepare("UPDATE tile_cache SET last_accessed_at=? WHERE source=? AND zoom=? AND tile_x=? AND tile_y=?").run(now, OSM_TILE_SOURCE, zoom, x, y);
  }

  private asTile(row: TileRow, cacheStatus: CachedMapTile["cacheStatus"]) {
    return { content: Buffer.from(row.content), contentType: row.content_type, cacheStatus };
  }

  private async loadTile(zoom: number, x: number, y: number, referrer?: string): Promise<CachedMapTile> {
    const now = Date.now();
    const previous = this.row(zoom, x, y);
    if (previous && previous.expires_at > now) {
      this.touch(zoom, x, y, now);
      return this.asTile(previous, "hit");
    }
    try {
      const headers: Record<string, string> = {
        Accept: "image/png,image/*;q=0.8,*/*;q=0.1",
        "User-Agent": "AI-Travel-Planner/0.1",
      };
      const referer = safeReferrer(referrer);
      if (referer) headers.Referer = referer;
      if (previous?.etag) headers["If-None-Match"] = previous.etag;
      if (previous?.last_modified) headers["If-Modified-Since"] = previous.last_modified;
      const response = await this.fetcher(`${OSM_TILE_SOURCE}/${zoom}/${x}/${y}.png`, { headers });
      if (response.status === 304 && previous) {
        this.db.prepare("UPDATE tile_cache SET expires_at=?,etag=COALESCE(?,etag),last_modified=COALESCE(?,last_modified),last_accessed_at=? WHERE source=? AND zoom=? AND tile_x=? AND tile_y=?").run(expiryFrom(response.headers, now), response.headers.get("etag"), response.headers.get("last-modified"), now, OSM_TILE_SOURCE, zoom, x, y);
        return this.asTile({ ...previous, expires_at: expiryFrom(response.headers, now) }, "refreshed");
      }
      if (!response.ok) throw new TileFetchError(`地图瓦片服务暂时不可用（${response.status}）。`);
      const contentType = response.headers.get("content-type") || "image/png";
      if (!contentType.toLowerCase().startsWith("image/")) throw new TileFetchError("地图瓦片服务返回了无效内容。");
      const content = Buffer.from(await response.arrayBuffer());
      if (!content.length) throw new TileFetchError("地图瓦片服务返回了空内容。");
      this.save(zoom, x, y, content, contentType, response.headers, now);
      return { content, contentType, cacheStatus: "refreshed" };
    } catch (error) {
      if (previous) {
        this.touch(zoom, x, y, now);
        return this.asTile(previous, "stale");
      }
      throw error instanceof TileFetchError ? error : new TileFetchError("地图瓦片服务暂时不可用。");
    }
  }

  private save(zoom: number, x: number, y: number, content: Buffer, contentType: string, headers: Headers, now: number) {
    const expiresAt = expiryFrom(headers, now);
    this.db.prepare("INSERT INTO tile_cache(source,zoom,tile_x,tile_y,content,content_type,size_bytes,expires_at,etag,last_modified,last_accessed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,zoom,tile_x,tile_y) DO UPDATE SET content=excluded.content,content_type=excluded.content_type,size_bytes=excluded.size_bytes,expires_at=excluded.expires_at,etag=excluded.etag,last_modified=excluded.last_modified,last_accessed_at=excluded.last_accessed_at").run(OSM_TILE_SOURCE, zoom, x, y, content, contentType, content.length, expiresAt, headers.get("etag"), headers.get("last-modified"), now);
    this.prune();
  }

  private prune() {
    let bytes = this.stats().bytes;
    if (bytes <= this.maxBytes) return;
    const remove = this.db.prepare("DELETE FROM tile_cache WHERE rowid IN (SELECT rowid FROM tile_cache ORDER BY last_accessed_at ASC, rowid ASC LIMIT 1)");
    while (bytes > this.maxBytes && remove.run().changes) bytes = this.stats().bytes;
  }
}
