import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GEOCODE_CACHE_VERSION, MapService, ROUTE_FAILURE_CACHE_TTL_MS, ROUTE_SUCCESS_CACHE_TTL_MS } from "./map-service.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })));
});

describe("public route cache", () => {
  it("treats an HTTP outage as transient rather than a seven-day no-route result", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "map-service-")); directories.push(directory);
    const filename = path.join(directory, "public-cache.sqlite3");
    const maps = new MapService(filename, async () => new Response("unavailable", { status: 503 }));
    const startedAt = Date.now();
    await expect(maps.route("drive", [135, 35], [135.1, 35.1], "route-key")).resolves.toEqual({ geometry: null, distanceKm: null, durationMinutes: null, warning: "路线服务暂时不可用。" });
    expect(ROUTE_FAILURE_CACHE_TTL_MS).toBeLessThan(ROUTE_SUCCESS_CACHE_TTL_MS);
    maps.close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(filename);
    const row = db.prepare("SELECT expires_at FROM route_cache WHERE key=?").get("route-key") as { expires_at: number };
    expect(row.expires_at).toBeGreaterThanOrEqual(startedAt + ROUTE_FAILURE_CACHE_TTL_MS);
    expect(row.expires_at).toBeLessThan(startedAt + ROUTE_SUCCESS_CACHE_TTL_MS);
    db.close();
  });

  it("keeps provider distance and duration with the cached route geometry", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "map-route-metrics-")); directories.push(directory);
    const filename = path.join(directory, "public-cache.sqlite3"); let fetches = 0;
    const geometry = { type: "LineString", coordinates: [[135, 35], [135.1, 35.1]] };
    const maps = new MapService(filename, async () => { fetches += 1; return Response.json({ code: "Ok", routes: [{ geometry, distance: 12345, duration: 4560 }] }); });
    const expected = { geometry, distanceKm: 12.345, durationMinutes: 76, warning: null };
    await expect(maps.route("drive", [135, 35], [135.1, 35.1], "route-metrics-v2")).resolves.toEqual(expected);
    await expect(maps.route("drive", [135, 35], [135.1, 35.1], "route-metrics-v2")).resolves.toEqual(expected);
    expect(fetches).toBe(1); maps.close();
  });
});

describe("public geocode cache", () => {
  it("keeps the provider short name and uses the current cache contract version", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "geocode-service-")); directories.push(directory);
    const filename = path.join(directory, "public-cache.sqlite3"); let fetches = 0;
    const maps = new MapService(filename, async () => {
      fetches += 1;
      return Response.json([{ place_id: 42, name: "Example City", display_name: "Example City, Example Region, Exampleland", lat: "-43.5", lon: "172.6", category: "place", type: "city", address: { city: "Example City", state: "Example Region", country_code: "ex" } }]);
    });
    await expect(maps.search("Example City, EX", "EX")).resolves.toEqual([expect.objectContaining({ providerPlaceId: "42", name: "Example City", displayName: "Example City, Example Region, Exampleland" })]);
    await maps.search("Example City, EX", "EX");
    expect(fetches).toBe(1); maps.close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(filename); const key = String((db.prepare("SELECT key FROM geocode_cache").get() as { key: string }).key);
    expect(key).toBe(`${GEOCODE_CACHE_VERSION}:example city, ex`); db.close();
  });
});
