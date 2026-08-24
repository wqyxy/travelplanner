import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Itinerary } from "./contracts.js";
import { AUTO_SELECT_MIN_MARGIN, AUTO_SELECT_MIN_SCORE, MapPipeline, buildMapQueries, chooseAutomatically, deriveMapGraph, filterMapCandidates, geoFingerprint, rankMapCandidates, routeCacheKey, straightGeometry } from "./map-pipeline.js";
import type { MapCandidate } from "./map-service.js";
import { TravelStore } from "./travel-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const place = (id: string, nameZh: string, nameLocal: string, city = "Kyoto") => ({ id, nameZh, nameLocal, nameEn: nameLocal, kind: "city" as const, city, region: "Kyoto", country: "Japan", countryCode: "JP", approximate: false });
const candidate = (id: string, name: string, city = "Kyoto"): MapCandidate => ({ providerPlaceId: id, displayName: name, latitude: 35, longitude: 135, category: "place", placeType: "city", countryCode: "jp", region: "Kyoto", city, timezone: null });

function itinerary(): Itinerary {
  const a = place("place-a", "京都", "Kyoto"); const b = place("place-b", "大阪", "Osaka", "Osaka");
  return { schemaVersion: 1, stage: "draft", trip: { title: "关西", originPlaceId: "place-a", destinationPlaceIds: ["place-b"], dates: { start: "2026-10-01", end: "2026-10-01", requestedDurationDays: null }, travelers: { summary: "两人", adults: 2, children: 0 }, budget: { amount: null, currency: null, note: null }, pace: null, themes: [], preferences: [], constraints: [], assumptions: [] }, places: [a, b], days: [{ id: "day-1", dayNumber: 1, date: "2026-10-01", title: "京都至大阪", detailLevel: "draft", stops: [
    { id: "stop-a", role: "start", placeId: "place-a", activity: "出发", period: "morning", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: null, costNote: null, costVerification: null, notes: null },
    { id: "stop-b", role: "visit", placeId: "place-b", activity: "访问", period: "afternoon", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: { mode: "drive", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } }, costNote: null, costVerification: null, notes: null },
    { id: "stop-c", role: "end", placeId: "place-b", activity: "结束", period: "evening", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: { mode: "walk", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } }, costNote: null, costVerification: null, notes: null },
  ] }], warnings: [] };
}

describe("deterministic map derivation", () => {
  it("derives stable Visits and adjacent Edges from Stops", () => {
    const graph = deriveMapGraph(itinerary());
    expect(graph.visits.map((visit) => visit.id)).toEqual(["stop-a", "stop-b", "stop-c"]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.map((edge) => edge.mode)).toEqual(["drive", "walk"]);
    expect(graph.edges[0].id).toBe(deriveMapGraph(itinerary()).edges[0].id);
  });

  it("uses local/en/cjk names with city then region deterministically", () => {
    const values = buildMapQueries(place("p", "京都", "Kyoto"));
    expect(values).toEqual(["Kyoto, Kyoto, JP", "京都, Kyoto, JP"]);
    const before = geoFingerprint(place("p", "京都", "Kyoto"));
    expect(geoFingerprint(place("p", "京都府", "Kyoto"))).toBe(before);
  });

  it("hard-filters country and type before score thresholds", () => {
    const target = place("p", "京都", "Kyoto");
    const wrongCountry = { ...candidate("foreign", "Kyoto"), countryCode: "us" };
    const wrongType = { ...candidate("road", "Kyoto"), category: "highway", placeType: "road" };
    expect(filterMapCandidates(target, [wrongCountry, wrongType, candidate("correct", "Kyoto")]).map((entry) => entry.providerPlaceId)).toEqual(["correct"]);
    expect(AUTO_SELECT_MIN_SCORE).toBe(65); expect(AUTO_SELECT_MIN_MARGIN).toBe(15);
    expect(chooseAutomatically(target, [candidate("one", "Kyoto")])?.candidate.providerPlaceId).toBe("one");
    expect(chooseAutomatically(target, [candidate("wrong", "Unrelated place")])).toBeNull();
  });

  it("invalidates a country change without a countryCode and never auto-selects an unknown-country candidate", () => {
    const withoutCode = { ...place("p", "京都", "Kyoto"), countryCode: null, country: "Japan" };
    expect(geoFingerprint({ ...withoutCode, country: "South Korea" })).not.toBe(geoFingerprint(withoutCode));
    expect(chooseAutomatically(withoutCode, [{ ...candidate("unknown", "Kyoto"), countryCode: null }])).toBeNull();
    expect(chooseAutomatically(withoutCode, [candidate("unconfirmed", "Kyoto")])).toBeNull();
  });

  it("keeps antimeridian flights short and keys routes by mode, coordinates and profile", () => {
    expect(straightGeometry([179, 10], [-179, 10])).toEqual({ type: "LineString", coordinates: [[179, 10], [181, 10]] });
    expect(routeCacheKey("drive", [135, 35], [135.1, 35.1])).toContain("drive:135.000000,35.000000:135.100000,35.100000:");
  });

  it("orders ambiguous candidates by deterministic score before passing them to 02", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "map-rank-")); directories.push(directory);
    const store = new TravelStore(path.join(directory, "travel.sqlite3")); const trip = store.createTrip(); const written = store.writeItinerary(trip.id, itinerary(), 0);
    const high = { ...candidate("best", "Kyoto Plaza"), region: null };
    const low = Array.from({ length: 5 }, (_value, index) => ({ ...candidate(`low-${index}`, `Other ${index}`), city: null, region: null }));
    expect(rankMapCandidates(written.trip.itinerary.places[0], [...low, high])[0].candidate.providerPlaceId).toBe("best");
    let received: string[] = [];
    const maps = {
      search: async (query: string) => query.includes("Osaka") || query.includes("大阪") ? [candidate("osaka", "Osaka", "Osaka")] : [...low, high],
      route: async () => ({ geometry: null, warning: null }),
    } as unknown as import("./map-service.js").MapService;
    const pipeline = new MapPipeline({ store, maps, decideCandidate: async (input) => { received = input.candidates.map((entry) => entry.providerPlaceId); return { schemaVersion: 1, providerPlaceId: "low-4", reason: "尝试选择未注入的候选" }; }, onChanged: () => {} });
    await pipeline.sync(trip.id, written.generation, ["day-1"]);
    expect(received).toHaveLength(5); expect(received[0]).toBe("best"); expect(received).not.toContain("low-4");
    expect(store.getMapState(trip.id)?.resolvedPlaces.find((entry) => entry.placeId === "place-a")?.resolution).not.toBe("exact");
    store.close();
  });
});

describe("generation-bound map pipeline", () => {
  it("does not let an older in-flight generation overwrite the current map snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "map-generation-")); directories.push(directory);
    const store = new TravelStore(path.join(directory, "travel.sqlite3")); const trip = store.createTrip(); const first = store.writeItinerary(trip.id, itinerary(), 0);
    let releaseFirstSearch!: () => void; let markFirstSearchStarted!: () => void; let searchCalls = 0;
    const firstSearchGate = new Promise<void>((resolve) => { releaseFirstSearch = resolve; });
    const firstSearchStarted = new Promise<void>((resolve) => { markFirstSearchStarted = resolve; });
    const maps = {
      search: async (query: string) => {
        searchCalls += 1;
        if (searchCalls === 1) { markFirstSearchStarted(); await firstSearchGate; }
        const osaka = query.includes("Osaka") || query.includes("大阪");
        return [candidate(osaka ? "osaka" : "kyoto", osaka ? "Osaka" : "Kyoto", osaka ? "Osaka" : "Kyoto")];
      },
      route: async () => ({ geometry: { type: "LineString", coordinates: [[135, 35], [135.1, 35.1]] }, warning: null }),
    } as unknown as import("./map-service.js").MapService;
    const pipeline = new MapPipeline({ store, maps, onChanged: () => {} });
    const olderSync = pipeline.sync(trip.id, first.generation, ["day-1"]);
    await firstSearchStarted;
    const current = store.rename(trip.id, "关西新版本");
    await pipeline.sync(trip.id, current.contentGeneration, []);
    releaseFirstSearch(); await olderSync;
    expect(store.getMapState(trip.id)?.generation).toBe(current.contentGeneration);
    store.close();
  });

  it("reuses unchanged ResolvedPlace and route geometry across a non-map generation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "map-pipeline-")); directories.push(directory);
    const store = new TravelStore(path.join(directory, "travel.sqlite3")); const trip = store.createTrip(); const first = store.writeItinerary(trip.id, itinerary(), 0);
    let searches = 0; let routes = 0;
    const maps = {
      search: async (query: string) => { searches += 1; return [candidate(query.includes("Osaka") || query.includes("大阪") ? "osaka" : "kyoto", query.includes("Osaka") || query.includes("大阪") ? "Osaka" : "Kyoto", query.includes("Osaka") || query.includes("大阪") ? "Osaka" : "Kyoto")]; },
      route: async () => { routes += 1; return { geometry: { type: "LineString", coordinates: [[135, 35], [135.1, 35.1]] }, warning: null }; },
    } as unknown as import("./map-service.js").MapService;
    const events: string[] = []; const pipeline = new MapPipeline({ store, maps, onChanged: (event) => events.push(event.status) });
    await pipeline.sync(trip.id, first.generation, ["day-1"]);
    expect(searches).toBeGreaterThan(0); expect(routes).toBe(1); expect(store.getMapState(trip.id)?.status).toBe("ready");
    const searchesAfterFirstSync = searches;
    const second = store.rename(trip.id, "关西秋游");
    await pipeline.sync(trip.id, second.contentGeneration, []);
    expect(searches).toBe(searchesAfterFirstSync); expect(routes).toBe(1);
    expect(store.getMapState(trip.id)?.generation).toBe(second.contentGeneration);
    expect(events).toEqual(["syncing", "ready", "syncing", "ready"]);
    store.close();
  });

  it("keeps mode=none geometry-free and retries a prior attention route on the next generation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "map-route-status-")); directories.push(directory);
    const store = new TravelStore(path.join(directory, "travel.sqlite3")); const trip = store.createTrip(); const draft = itinerary();
    draft.days[0].stops[1].transportFromPrevious = { mode: "none", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } };
    draft.days[0].stops[2].placeId = "place-a";
    const first = store.writeItinerary(trip.id, draft, 0); let routeCalls = 0;
    const maps = {
      search: async (query: string) => [candidate(query.includes("Osaka") || query.includes("大阪") ? "osaka" : "kyoto", query.includes("Osaka") || query.includes("大阪") ? "Osaka" : "Kyoto", query.includes("Osaka") || query.includes("大阪") ? "Osaka" : "Kyoto")],
      route: async () => { routeCalls += 1; return { geometry: null, warning: "路线服务暂时不可用。" }; },
    } as unknown as import("./map-service.js").MapService;
    const pipeline = new MapPipeline({ store, maps, onChanged: () => {} });
    await pipeline.sync(trip.id, first.generation, ["day-1"]);
    const firstMap = store.getMapState(trip.id)!.map as { routes: Array<{ status: string; geometry: unknown; warning: string | null }> };
    expect(firstMap.routes[0]).toMatchObject({ status: "ready", geometry: null, warning: null }); expect(routeCalls).toBe(1);
    const second = store.rename(trip.id, "关西路线更新");
    await pipeline.sync(trip.id, second.contentGeneration, []);
    expect(routeCalls).toBe(2);
    store.close();
  });

  it("uses only a scored country-confirmed city or region center for approximate fallback", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "map-approximate-")); directories.push(directory);
    const store = new TravelStore(path.join(directory, "travel.sqlite3"));
    const lowTrust = itinerary(); lowTrust.places[0] = { ...lowTrust.places[0], nameZh: "无匹配", nameLocal: "No Match", nameEn: "No Match", city: "No Match City", region: null };
    const lowTrip = store.createTrip(); const lowWritten = store.writeItinerary(lowTrip.id, lowTrust, 0);
    const maps = {
      search: async (query: string) => query.includes("Osaka") || query.includes("大阪") ? [candidate("osaka", "Osaka", "Osaka")] : [{ ...candidate("unrelated", "Unrelated", "Elsewhere"), region: null }],
      route: async () => ({ geometry: null, warning: null }),
    } as unknown as import("./map-service.js").MapService;
    const pipeline = new MapPipeline({ store, maps, decideCandidate: async () => null, onChanged: () => {} });
    await pipeline.sync(lowTrip.id, lowWritten.generation, ["day-1"]);
    expect(store.getMapState(lowTrip.id)?.resolvedPlaces.find((entry) => entry.placeId === "place-a")?.resolution).toBe("unresolved");

    const lodging = itinerary(); lodging.places[0] = { ...lodging.places[0], nameZh: "未知酒店", nameLocal: "Unknown Hotel", nameEn: "Unknown Hotel", kind: "lodging", city: "Kyoto" };
    const lodgingTrip = store.createTrip(); const lodgingWritten = store.writeItinerary(lodgingTrip.id, lodging, 0);
    const lodgingMaps = {
      search: async (query: string) => query.includes("Unknown Hotel") || query.includes("未知酒店") ? [] : query.includes("Osaka") || query.includes("大阪") ? [candidate("osaka", "Osaka", "Osaka")] : [candidate("kyoto-center", "Kyoto", "Kyoto")],
      route: async () => ({ geometry: null, warning: null }),
    } as unknown as import("./map-service.js").MapService;
    const lodgingPipeline = new MapPipeline({ store, maps: lodgingMaps, decideCandidate: async () => null, onChanged: () => {} });
    await lodgingPipeline.sync(lodgingTrip.id, lodgingWritten.generation, ["day-1"]);
    expect(store.getMapState(lodgingTrip.id)?.resolvedPlaces.find((entry) => entry.placeId === "place-a")?.resolution).toBe("approximate"); store.close();
  });
});
