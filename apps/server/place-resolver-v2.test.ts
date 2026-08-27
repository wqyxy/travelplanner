import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyTravelPlan, type MapResolutionAssistOutput } from "./contracts-v2.js";
import type { MapCandidate } from "./map-service.js";
import { buildPlaceSearchQueries, chooseProviderAutomatically, placeGeoFingerprint, PlaceResolverV2, rankProviderCandidates, resolutionIsCurrent } from "./place-resolver-v2.js";
import { TravelStoreV2 } from "./travel-store-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function databasePath() { const root = mkdtempSync(path.join(tmpdir(), "place-resolver-v2-")); roots.push(root); return path.join(root, "travel.sqlite3"); }

const place = { id: "p-1", nameZh: "清水寺", nameLocal: "清水寺", nameEn: "Kiyomizu-dera", kind: "attraction" as const, city: "京都", region: "京都府", country: "日本", countryCode: "JP", approximate: false };
const candidate = (overrides: Partial<MapCandidate> = {}): MapCandidate => ({ providerPlaceId: "provider-1", name: "Kiyomizu-dera", displayName: "Kiyomizu-dera, Kyoto, Japan", latitude: 34.9948, longitude: 135.785, category: "tourism", placeType: "attraction", countryCode: "jp", region: "京都府", city: "京都", timezone: null, ...overrides });

function seededStore() {
  const store = new TravelStoreV2(databasePath());
  const created = store.createTrip();
  const plan = emptyTravelPlan();
  plan.places.push(place);
  plan.candidates.push({ id: "c-1", placeId: "p-1", planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 90, tags: [] });
  const written = store.writePlan(created.id, plan, 0, { source: "test", summary: "seed place" });
  return { store, tripId: created.id, generation: written.generation };
}

describe("deterministic provider candidate handling", () => {
  it("builds deterministic localized queries without duplicates", () => {
    const queries = buildPlaceSearchQueries(place, ["Kiyomizu Temple Kyoto", "Kiyomizu Temple Kyoto"]);
    expect(queries[0]).toContain("Kiyomizu Temple Kyoto");
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries.some((query) => query.includes("JP"))).toBe(true);
  });

  it("filters the country and selects a high-confidence exact candidate", () => {
    const ranked = rankProviderCandidates(place, [candidate(), candidate({ providerPlaceId: "wrong", countryCode: "us", displayName: "Kiyomizu, USA" })]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].score).toBeGreaterThanOrEqual(70);
    expect(chooseProviderAutomatically(place, ranked)?.candidate.providerPlaceId).toBe("provider-1");
  });

  it("does not auto-select low confidence or country-unknown targets", () => {
    const weak = rankProviderCandidates(place, [candidate({ name: "Temple", city: null, region: null, category: "tourism", placeType: "attraction" })]);
    expect(chooseProviderAutomatically(place, weak)).toBeNull();
    expect(chooseProviderAutomatically({ ...place, countryCode: null }, rankProviderCandidates({ ...place, countryCode: null }, [candidate()]))).toBeNull();
  });
});

describe("PlaceResolverV2", () => {
  it("writes an automatic Provider resolution without any AI coordinate output", async () => {
    const { store, tripId, generation } = seededStore();
    const maps = { search: async () => [candidate()], reverse: async () => candidate() };
    const resolver = new PlaceResolverV2({ store, maps });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(result.resolution).toMatchObject({ status: "resolved", method: "provider_match", providerPlaceId: "provider-1", latitude: 34.9948, longitude: 135.785 });
    expect(store.getPlaceResolution(tripId, "p-1")).toEqual(result.resolution);
    store.close();
  });

  it("allows 02 only to choose from the injected finite candidate set", async () => {
    const { store, tripId, generation } = seededStore();
    const candidates = [
      candidate({ providerPlaceId: "provider-1", name: "Kiyomizu Temple", city: null, region: null }),
      candidate({ providerPlaceId: "provider-2", name: "Kiyomizu-dera Annex", latitude: 35, longitude: 135.8, city: null, region: null }),
    ];
    let assistInput: string[] = [];
    const assist = async (input: { candidates: Array<{ providerPlaceId: string }> }): Promise<MapResolutionAssistOutput> => {
      assistInput = input.candidates.map((item) => item.providerPlaceId);
      return { schemaVersion: 1, action: "choose_candidate", providerPlaceId: "provider-2", searchHints: [], reason: "第二项名称和区域更接近。" };
    };
    const resolver = new PlaceResolverV2({ store, maps: { search: async () => candidates, reverse: async () => null }, assist });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(assistInput).toEqual(["provider-1", "provider-2"]);
    expect(result.resolution).toMatchObject({ status: "resolved", method: "provider_choice", providerPlaceId: "provider-2", latitude: 35, longitude: 135.8 });
    store.close();
  });

  it("uses AI search hints only to run another Provider search", async () => {
    const { store, tripId, generation } = seededStore();
    const queries: string[] = [];
    const maps = {
      search: async (query: string) => { queries.push(query); return query.includes("Higashiyama official") ? [candidate()] : []; },
      reverse: async () => null,
    };
    const resolver = new PlaceResolverV2({ store, maps, assist: async () => ({ schemaVersion: 1, action: "retry_with_hints", providerPlaceId: null, searchHints: ["Kiyomizu-dera Higashiyama official"], reason: "补充正式英文名和区域。" }) });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(queries.some((query) => query.includes("Higashiyama official"))).toBe(true);
    expect(result.resolution.status).toBe("resolved");
    store.close();
  });

  it("keeps unresolved visible and retryable when no reliable candidate exists", async () => {
    const { store, tripId, generation } = seededStore();
    const resolver = new PlaceResolverV2({ store, maps: { search: async () => [], reverse: async () => null } });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(result.resolution).toMatchObject({ status: "unresolved", latitude: null, longitude: null });
    expect(result.resolution.errorMessage).toMatch(/地图服务未找到/);
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

  it("supports user-authorized map picks and manual coordinates with country validation", async () => {
    const { store, tripId, generation } = seededStore();
    const resolver = new PlaceResolverV2({ store, maps: { search: async () => [], reverse: async () => candidate() } });
    const direct = await resolver.setDirectCoordinates(tripId, "p-1", { expectedGeneration: generation, method: "map_pick", latitude: 34.99, longitude: 135.78, address: null });
    expect(direct).toMatchObject({ status: "resolved", method: "map_pick", provider: null, providerPlaceId: null, address: "Kiyomizu-dera, Kyoto, Japan" });
    const mismatched = new PlaceResolverV2({ store, maps: { search: async () => [], reverse: async () => candidate({ countryCode: "us" }) } });
    await expect(mismatched.setDirectCoordinates(tripId, "p-1", { expectedGeneration: generation, method: "manual_coordinates", latitude: 40, longitude: -74, address: null })).rejects.toThrow(/countryCode 不一致/);
    store.close();
  });

  it("rejects stale generations and detects a stale semantic fingerprint", async () => {
    const { store, tripId, generation } = seededStore();
    const resolver = new PlaceResolverV2({ store, maps: { search: async () => [candidate()], reverse: async () => candidate() } });
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
