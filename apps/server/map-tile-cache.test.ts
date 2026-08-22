import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MapTileCache, TileFetchError, validateTileCoordinates } from "./map-tile-cache.js";

const folders: string[] = [];
async function createCache(fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>, maxBytes?: number) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "travel-tile-cache-"));
  folders.push(folder);
  return new MapTileCache(path.join(folder, "cache.sqlite3"), fetcher, maxBytes);
}
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true }))); });

describe("MapTileCache", () => {
  it("stores a tile BLOB and serves a fresh cache hit", async () => {
    let requests = 0;
    const cache = await createCache(async () => { requests += 1; return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png", "cache-control": "max-age=3600", etag: "v1" } }); });
    try {
      expect((await cache.getTile(1, 0, 0)).content).toEqual(Buffer.from([1, 2, 3]));
      expect((await cache.getTile(1, 0, 0)).cacheStatus).toBe("hit");
      expect(requests).toBe(1);
      expect(cache.stats()).toEqual({ count: 1, bytes: 3 });
    } finally { cache.close(); }
  });

  it("refreshes expired tiles with conditional headers after a 304", async () => {
    const headers: Headers[] = [];
    let requests = 0;
    const cache = await createCache(async (_input, init) => {
      headers.push(new Headers(init?.headers));
      requests += 1;
      return requests === 1
        ? new Response(new Uint8Array([1]), { headers: { "content-type": "image/png", "cache-control": "max-age=0", etag: "v1", "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT" } })
        : new Response(null, { status: 304, headers: { "cache-control": "max-age=3600", etag: "v1" } });
    });
    try {
      expect((await cache.getTile(1, 0, 0, "http://127.0.0.1:6688/")).cacheStatus).toBe("refreshed");
      expect((await cache.getTile(1, 0, 0)).cacheStatus).toBe("refreshed");
      expect(headers[0].get("user-agent")).toBe("AI-Travel-Planner/0.1");
      expect(headers[0].get("referer")).toBe("http://127.0.0.1:6688/");
      expect(headers[1].get("if-none-match")).toBe("v1");
      expect(headers[1].get("if-modified-since")).toContain("Wed, 21 Oct 2015");
    } finally { cache.close(); }
  });

  it("serves an expired tile when its refresh fails", async () => {
    let requests = 0;
    const cache = await createCache(async () => {
      requests += 1;
      if (requests === 1) return new Response(new Uint8Array([9]), { headers: { "content-type": "image/png", "cache-control": "max-age=0" } });
      throw new Error("offline");
    });
    try {
      await cache.getTile(1, 0, 0);
      expect((await cache.getTile(1, 0, 0)).cacheStatus).toBe("stale");
    } finally { cache.close(); }
  });

  it("rejects invalid coordinates and evicts least-recently-used tiles over the limit", async () => {
    let next = 0;
    const cache = await createCache(async () => new Response(new Uint8Array([next += 1, 2, 3]), { headers: { "content-type": "image/png", "cache-control": "max-age=3600" } }), 4);
    try {
      await expect(cache.getTile(1, 2, 0)).rejects.toBeInstanceOf(TileFetchError);
      await cache.getTile(1, 0, 0);
      await cache.getTile(1, 1, 0);
      expect(cache.stats()).toEqual({ count: 1, bytes: 3 });
      expect(validateTileCoordinates(19, 524287, 524287)).toBe(true);
      expect(validateTileCoordinates(20, 0, 0)).toBe(false);
    } finally { cache.close(); }
  });
});
