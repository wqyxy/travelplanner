import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MapService, ROUTE_FAILURE_CACHE_TTL_MS, ROUTE_SUCCESS_CACHE_TTL_MS } from "./map-service.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("public route cache", () => {
  it("treats an HTTP outage as transient rather than a seven-day no-route result", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "map-service-")); directories.push(directory);
    const filename = path.join(directory, "public-cache.sqlite3");
    const maps = new MapService(filename, async () => new Response("unavailable", { status: 503 }));
    const startedAt = Date.now();
    await expect(maps.route("drive", [135, 35], [135.1, 35.1], "route-key")).resolves.toEqual({ geometry: null, warning: "路线服务暂时不可用。" });
    expect(ROUTE_FAILURE_CACHE_TTL_MS).toBeLessThan(ROUTE_SUCCESS_CACHE_TTL_MS);
    maps.close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(filename);
    const row = db.prepare("SELECT expires_at FROM route_cache WHERE key=?").get("route-key") as { expires_at: number };
    expect(row.expires_at).toBeGreaterThanOrEqual(startedAt + ROUTE_FAILURE_CACHE_TTL_MS);
    expect(row.expires_at).toBeLessThan(startedAt + ROUTE_SUCCESS_CACHE_TTL_MS);
    db.close();
  });
});
