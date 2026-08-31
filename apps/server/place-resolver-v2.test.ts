import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyTravelPlan, type MapResolutionAssistOutput, type Place } from "./contracts-v2.js";
import type { MapCandidate } from "./map-service.js";
import {
  PLACE_RESOLUTION_BASE_SEARCH_LIMIT,
  PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT,
  PlaceResolverV2,
  buildPlaceSearchQueries,
  placeGeoFingerprint,
  rankProviderCandidates,
  resolutionIsCurrent,
} from "./place-resolver-v2.js";
import { TravelStoreV2 } from "./travel-store-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function databasePath() { const root = mkdtempSync(path.join(tmpdir(), "place-resolver-v2-")); roots.push(root); return path.join(root, "travel.sqlite3"); }

const place = { id: "p-1", nameZh: "清水寺", nameLocal: "清水寺", nameEn: "Kiyomizu-dera", kind: "attraction" as const, city: "京都", region: "京都府", country: "日本", countryCode: "JP", approximate: false };
const picton = { id: "picton", nameZh: "皮克顿", nameLocal: "Picton", nameEn: "Picton", kind: "city" as const, city: "Picton", region: "Marlborough", country: "New Zealand", countryCode: "NZ", approximate: true };
const candidate = (overrides: Partial<MapCandidate> = {}): MapCandidate => ({ providerPlaceId: "provider-1", name: "Kiyomizu-dera", displayName: "Kiyomizu-dera, Kyoto, Japan", latitude: 34.9948, longitude: 135.785, category: "tourism", placeType: "attraction", countryCode: "jp", region: "京都府", city: "京都", timezone: null, ...overrides });
const choose = (providerPlaceId: string, reason = "候选与目标实体一致。"): MapResolutionAssistOutput => ({ schemaVersion: 1, action: "choose_candidate", providerPlaceId, searchHints: [], reason });

function seededStore(seedPlace: Place = place) {
  const store = new TravelStoreV2(databasePath());
  const created = store.createTrip();
  const plan = emptyTravelPlan();
  plan.places.push(seedPlace);
  plan.candidates.push({ id: "c-1", placeId: seedPlace.id, planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 90, tags: [] });
  const written = store.writePlan(created.id, plan, 0, { source: "test", summary: "seed place" });
  return { store, tripId: created.id, generation: written.generation };
}

describe("deterministic provider candidate handling", () => {
  it("uses two baseline searches and reserves the remaining Provider budget for AI hints", () => {
    const queries = buildPlaceSearchQueries(place);
    expect(queries).toEqual([
      "清水寺, 京都, 日本",
      "Kiyomizu-dera, 京都, 日本",
    ]);
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries.length).toBe(PLACE_RESOLUTION_BASE_SEARCH_LIMIT);
    expect(queries.length).toBeLessThan(PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT);
  });

  it("uses a region-first query for a city instead of repeating the city name", () => {
    expect(buildPlaceSearchQueries(picton)).toEqual([
      "Picton, Marlborough, New Zealand",
      "Picton, New Zealand",
    ]);
  });

  it("keeps Provider candidates ranked but leaves their semantic choice to AI", () => {
    const ranked = rankProviderCandidates(place, [candidate(), candidate({ providerPlaceId: "wrong", countryCode: "us", displayName: "Kiyomizu, USA" })]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].score).toBeGreaterThanOrEqual(80);
  });
});

describe("PlaceResolverV2", () => {
  it("asks AI to confirm even a single exact Provider candidate", async () => {
    const { store, tripId, generation } = seededStore();
    let searches = 0;
    let assists = 0;
    const resolver = new PlaceResolverV2({
      store,
      maps: { search: async () => { searches += 1; return [candidate()]; }, reverse: async () => null },
      assist: async () => { assists += 1; return { schemaVersion: 1, action: "choose_candidate", providerPlaceId: "provider-1", searchHints: [], reason: "名称和地点一致。" }; },
    });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(searches).toBe(PLACE_RESOLUTION_BASE_SEARCH_LIMIT);
    expect(assists).toBe(1);
    expect(result.resolution).toMatchObject({ status: "resolved", method: "provider_choice", providerPlaceId: "provider-1" });
    store.close();
  });

  it("keeps the Provider request budget bounded when AI declines weak candidates", async () => {
    const { store, tripId, generation } = seededStore();
    let searches = 0;
    let assists = 0;
    const weak = candidate({ providerPlaceId: "weak", name: "Temple", displayName: "Temple, Japan", city: null, region: null, category: null, placeType: null });
    const resolver = new PlaceResolverV2({
      store,
      maps: { search: async () => { searches += 1; return [weak]; }, reverse: async () => null },
      assist: async () => { assists += 1; return { schemaVersion: 1, action: "unresolved", providerPlaceId: null, searchHints: [], reason: "证据不足。" }; },
    });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(searches).toBe(PLACE_RESOLUTION_BASE_SEARCH_LIMIT);
    expect(assists).toBe(1);
    expect(result.resolution.status).toBe("unresolved");
    store.close();
  });

  it("uses AI only for plausible ambiguity and charges hint searches to the same four-request budget", async () => {
    const { store, tripId, generation } = seededStore();
    const queries: string[] = [];
    let assists = 0;
    const ambiguous = [
      candidate({ providerPlaceId: "a", name: "Kiyomizu Temple", displayName: "Kiyomizu Temple, Kyoto, Japan", city: "京都", region: null }),
      candidate({ providerPlaceId: "b", name: "Kiyomizu Historic Temple", displayName: "Kiyomizu Historic Temple, Kyoto, Japan", latitude: 34.995, city: "京都", region: null }),
    ];
    const resolver = new PlaceResolverV2({
      store,
      maps: {
        search: async (query: string) => {
          queries.push(query);
          return query.includes("official Higashiyama") ? [candidate()] : ambiguous;
        },
        reverse: async () => null,
      },
      assist: async ({ round }) => {
        assists += 1;
        return round === 1
          ? { schemaVersion: 1, action: "retry_with_hints", providerPlaceId: null, searchHints: ["Kiyomizu-dera official Higashiyama"], reason: "需要正式名称确认。" }
          : { schemaVersion: 1, action: "choose_candidate", providerPlaceId: "provider-1", searchHints: [], reason: "补充搜索给出了正式地点。" };
      },
    });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(assists).toBe(2);
    expect(queries.some((query) => query.includes("official Higashiyama"))).toBe(true);
    expect(queries.length).toBeLessThanOrEqual(PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT);
    expect(result.resolution).toMatchObject({ status: "resolved", method: "provider_choice", providerPlaceId: "provider-1" });
    store.close();
  });

  it("lets AI choose only from the injected finite ambiguous candidate set", async () => {
    const { store, tripId, generation } = seededStore();
    const candidates = [
      candidate({ providerPlaceId: "provider-1", name: "Kiyomizu Temple", displayName: "Kiyomizu Temple, Kyoto, Japan", city: "京都", region: null }),
      candidate({ providerPlaceId: "provider-2", name: "Kiyomizu Historic Temple", displayName: "Kiyomizu Historic Temple, Kyoto, Japan", latitude: 35, longitude: 135.8, city: "京都", region: null }),
    ];
    let assistInput: string[] = [];
    const assist = async (input: { candidates: Array<{ providerPlaceId: string }> }): Promise<MapResolutionAssistOutput> => {
      assistInput = input.candidates.map((item) => item.providerPlaceId);
      return { schemaVersion: 1, action: "choose_candidate", providerPlaceId: "provider-2", searchHints: [], reason: "第二项是目标实体。" };
    };
    const resolver = new PlaceResolverV2({ store, maps: { search: async () => candidates, reverse: async () => null }, assist });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(assistInput).toEqual(["provider-1", "provider-2"]);
    expect(result.resolution).toMatchObject({ status: "resolved", method: "provider_choice", providerPlaceId: "provider-2" });
    store.close();
  });

  it("gives AI both the same-named Picton station and town, then preserves the town choice", async () => {
    const { store, tripId, generation } = seededStore(picton);
    const station = candidate({ providerPlaceId: "picton-station", name: "Picton", displayName: "Picton Station, Picton, Marlborough, New Zealand", latitude: -41.28837, longitude: 174.00486, category: "railway", placeType: "station", countryCode: "nz", region: "Marlborough", city: "Picton" });
    const town = candidate({ providerPlaceId: "picton-town", name: "Picton", displayName: "Picton, Marlborough District, Marlborough, New Zealand", latitude: -41.290916, longitude: 174.006908, category: "place", placeType: "town", countryCode: "nz", region: "Marlborough", city: "Picton" });
    const queries: string[] = [];
    let seenCandidates: string[] = [];
    const resolver = new PlaceResolverV2({
      store,
      maps: { search: async (query) => { queries.push(query); return [station, town]; }, reverse: async () => null },
      assist: async ({ candidates }) => { seenCandidates = candidates.map((item) => item.providerPlaceId); return choose("picton-town", "town 是目的地语义匹配项。"); },
    });
    const result = await resolver.resolve(tripId, picton.id, generation);
    expect(queries).toEqual(["Picton, Marlborough, New Zealand", "Picton, New Zealand"]);
    expect(seenCandidates).toEqual(["picton-town", "picton-station"]);
    expect(result.resolution).toMatchObject({ status: "resolved", method: "provider_choice", providerPlaceId: "picton-town" });
    store.close();
  });

  it("does not auto-select a same-named station and avoids duplicating AI hint context", async () => {
    const { store, tripId, generation } = seededStore(picton);
    const station = candidate({ providerPlaceId: "picton-station", name: "Picton", displayName: "Picton Station, Picton, Marlborough, New Zealand", latitude: -41.28837, longitude: 174.00486, category: "railway", placeType: "station", countryCode: "nz", region: "Marlborough", city: "Picton" });
    const queries: string[] = [];
    const resolver = new PlaceResolverV2({
      store,
      maps: { search: async (query) => { queries.push(query); return [station]; }, reverse: async () => null },
      assist: async ({ round }) => round === 1
        ? { schemaVersion: 1, action: "retry_with_hints", providerPlaceId: null, searchHints: ["Picton town centre, Marlborough, New Zealand"], reason: "需要城镇候选。" }
        : { schemaVersion: 1, action: "unresolved", providerPlaceId: null, searchHints: [], reason: "仍只有车站候选。" },
    });
    const result = await resolver.resolve(tripId, picton.id, generation);
    expect(queries).toContain("Picton town centre, Marlborough, New Zealand");
    expect(queries).not.toContain("Picton town centre, Marlborough, New Zealand, Picton, New Zealand");
    expect(result.resolution).toMatchObject({ status: "unresolved", providerPlaceId: null, latitude: null, longitude: null });
    store.close();
  });

  it("lets AI request a supplemental search when the baseline searches return nothing", async () => {
    const { store, tripId, generation } = seededStore();
    let searches = 0;
    let assists = 0;
    const resolver = new PlaceResolverV2({
      store,
      maps: { search: async (query) => { searches += 1; return query.includes("official") ? [candidate()] : []; }, reverse: async () => null },
      assist: async ({ round }) => {
        assists += 1;
        return round === 1
          ? { schemaVersion: 1, action: "retry_with_hints", providerPlaceId: null, searchHints: ["Kiyomizu-dera official"], reason: "需要更精确的名称。" }
          : { schemaVersion: 1, action: "choose_candidate", providerPlaceId: "provider-1", searchHints: [], reason: "补充候选匹配。" };
      },
    });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(searches).toBe(PLACE_RESOLUTION_BASE_SEARCH_LIMIT + 1);
    expect(assists).toBe(2);
    expect(result.resolution).toMatchObject({ status: "resolved", method: "provider_choice", providerPlaceId: "provider-1" });
    store.close();
  });

  it("previews without writes, commits across unrelated generations, and drops stale semantic previews", async () => {
    const { store, tripId, generation } = seededStore();
    const resolver = new PlaceResolverV2({ store, maps: { search: async () => [candidate()], reverse: async () => null }, assist: async () => choose("provider-1") });
    const preview = await resolver.preview(place);
    expect(store.listPlaceResolutions(tripId)).toEqual([]);

    const unrelated = structuredClone(store.requireTrip(tripId).plan);
    unrelated.trip.title = "京都旅行（已更新标题）";
    const unrelatedWrite = store.writePlan(tripId, unrelated, generation, { source: "test", summary: "unrelated edit" });
    const committed = resolver.commitPreviewLatest(tripId, "p-1", preview);
    expect(committed).toMatchObject({ status: "resolved", method: "provider_choice" });
    expect(store.getPlaceResolution(tripId, "p-1")).toEqual(committed);

    const stalePreview = await resolver.preview(unrelated.places[0]);
    const edited = structuredClone(store.requireTrip(tripId).plan);
    edited.places[0].city = "大阪";
    store.writePlan(tripId, edited, unrelatedWrite.generation, { source: "test", summary: "semantic edit" });
    expect(resolver.commitPreviewLatest(tripId, "p-1", stalePreview)).toBeNull();
    store.close();
  });

  it("revalidates a Provider choice against current server candidates", async () => {
    const { store, tripId, generation } = seededStore();
    const resolver = new PlaceResolverV2({ store, maps: { search: async () => [candidate()], reverse: async () => null } });
    await expect(resolver.selectProviderCandidate(tripId, "p-1", { expectedGeneration: generation, providerPlaceId: "not-returned" })).rejects.toThrow(/不在服务端当前候选集合/);
    const selected = await resolver.selectProviderCandidate(tripId, "p-1", { expectedGeneration: generation, providerPlaceId: "provider-1" });
    expect(selected.resolution.method).toBe("provider_choice");
    store.close();
  });

  it("supports user-authorized coordinates with country validation", async () => {
    const { store, tripId, generation } = seededStore();
    const resolver = new PlaceResolverV2({ store, maps: { search: async () => [], reverse: async () => candidate() } });
    const direct = await resolver.setDirectCoordinates(tripId, "p-1", { expectedGeneration: generation, method: "map_pick", latitude: 34.99, longitude: 135.78, address: null });
    expect(direct).toMatchObject({ status: "resolved", method: "map_pick", provider: null, providerPlaceId: null, address: "Kiyomizu-dera, Kyoto, Japan" });
    const mismatched = new PlaceResolverV2({ store, maps: { search: async () => [], reverse: async () => candidate({ countryCode: "us" }) } });
    await expect(mismatched.setDirectCoordinates(tripId, "p-1", { expectedGeneration: generation, method: "manual_coordinates", latitude: 40, longitude: -74, address: null })).rejects.toThrow(/countryCode.*不一致/);
    store.close();
  });

  it("rejects stale strict generations and detects semantic fingerprint changes", async () => {
    const { store, tripId, generation } = seededStore();
    const resolver = new PlaceResolverV2({ store, maps: { search: async () => [candidate()], reverse: async () => candidate() }, assist: async () => choose("provider-1") });
    const resolved = await resolver.resolve(tripId, "p-1", generation);
    expect(resolutionIsCurrent(place, resolved.resolution)).toBe(true);
    const trip = store.requireTrip(tripId);
    const changed = structuredClone(trip.plan);
    changed.places[0].city = "大阪";
    const written = store.writePlan(tripId, changed, generation);
    expect(resolutionIsCurrent(changed.places[0], store.getPlaceResolution(tripId, "p-1"))).toBe(false);
    await expect(resolver.resolve(tripId, "p-1", generation)).rejects.toThrow("CONTENT_GENERATION_SUPERSEDED");
    expect(placeGeoFingerprint(changed.places[0])).not.toBe(resolved.resolution.geoFingerprint);
    expect(written.generation).toBe(generation + 1);
    store.close();
  });
});
