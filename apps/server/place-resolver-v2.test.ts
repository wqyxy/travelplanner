import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyTravelPlan, type MapResolutionAssistOutput } from "./contracts-v2.js";
import type { MapCandidate } from "./map-service.js";
import {
  PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT,
  PlaceResolverV2,
  buildPlaceSearchQueries,
  chooseProviderAutomatically,
  placeGeoFingerprint,
  rankProviderCandidates,
  resolutionIsCurrent,
} from "./place-resolver-v2.js";
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
  it("builds at most four prioritized localized queries without duplicates", () => {
    const queries = buildPlaceSearchQueries(place);
    expect(queries).toEqual([
      "清水寺, 京都, 日本",
      "Kiyomizu-dera, 京都, 日本",
      "清水寺, 京都府, 日本",
      "清水寺, 日本",
    ]);
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries.length).toBeLessThanOrEqual(PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT);
  });

  it("filters a conflicting country and selects a high-confidence exact candidate", () => {
    const ranked = rankProviderCandidates(place, [candidate(), candidate({ providerPlaceId: "wrong", countryCode: "us", displayName: "Kiyomizu, USA" })]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].score).toBeGreaterThanOrEqual(80);
    expect(chooseProviderAutomatically(place, ranked)?.candidate.providerPlaceId).toBe("provider-1");
  });

  it("does not auto-select low confidence or country-unknown targets", () => {
    const weak = rankProviderCandidates(place, [candidate({ name: "Temple", displayName: "Temple, Kyoto, Japan", city: null, region: null, category: "tourism", placeType: "attraction" })]);
    expect(chooseProviderAutomatically(place, weak)).toBeNull();
    expect(chooseProviderAutomatically({ ...place, countryCode: null }, rankProviderCandidates({ ...place, countryCode: null }, [candidate()]))).toBeNull();
  });
});

describe("PlaceResolverV2", () => {
  it("stops after the first clear Provider match and never calls AI", async () => {
    const { store, tripId, generation } = seededStore();
    let searches = 0;
    let assists = 0;
    const resolver = new PlaceResolverV2({
      store,
      maps: { search: async () => { searches += 1; return [candidate()]; }, reverse: async () => null },
      assist: async () => { assists += 1; return null; },
    });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(searches).toBe(1);
    expect(assists).toBe(0);
    expect(result.resolution).toMatchObject({ status: "resolved", method: "provider_match", providerPlaceId: "provider-1" });
    store.close();
  });

  it("continues past weak candidates but never exceeds four Provider searches", async () => {
    const { store, tripId, generation } = seededStore();
    let searches = 0;
    let assists = 0;
    const weak = candidate({ providerPlaceId: "weak", name: "Temple", displayName: "Temple, Japan", city: null, region: null, category: null, placeType: null });
    const resolver = new PlaceResolverV2({
      store,
      maps: { search: async () => { searches += 1; return [weak]; }, reverse: async () => null },
      assist: async () => { assists += 1; return null; },
    });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(searches).toBe(PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT);
    expect(assists).toBe(0);
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
      assist: async () => {
        assists += 1;
        return { schemaVersion: 1, action: "retry_with_hints", providerPlaceId: null, searchHints: ["Kiyomizu-dera official Higashiyama"], reason: "需要正式名称确认。" };
      },
    });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(assists).toBe(1);
    expect(queries.some((query) => query.includes("official Higashiyama"))).toBe(true);
    expect(queries.length).toBeLessThanOrEqual(PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT);
    expect(result.resolution).toMatchObject({ status: "resolved", method: "provider_match", providerPlaceId: "provider-1" });
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

  it("does not call AI when four searches produce no reasonable candidate", async () => {
    const { store, tripId, generation } = seededStore();
    let searches = 0;
    let assists = 0;
    const resolver = new PlaceResolverV2({
      store,
      maps: { search: async () => { searches += 1; return []; }, reverse: async () => null },
      assist: async () => { assists += 1; return null; },
    });
    const result = await resolver.resolve(tripId, "p-1", generation);
    expect(searches).toBe(PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT);
    expect(assists).toBe(0);
    expect(result.resolution).toMatchObject({ status: "unresolved", latitude: null, longitude: null });
    expect(result.resolution.errorMessage).toMatch(/地图服务未找到/);
    store.close();
  });

  it("previews without writes, commits across unrelated generations, and drops stale semantic previews", async () => {
    const { store, tripId, generation } = seededStore();
    const resolver = new PlaceResolverV2({ store, maps: { search: async () => [candidate()], reverse: async () => null } });
    const preview = await resolver.preview(place);
    expect(store.listPlaceResolutions(tripId)).toEqual([]);

    const unrelated = structuredClone(store.requireTrip(tripId).plan);
    unrelated.trip.title = "京都旅行（已更新标题）";
    const unrelatedWrite = store.writePlan(tripId, unrelated, generation, { source: "test", summary: "unrelated edit" });
    const committed = resolver.commitPreviewLatest(tripId, "p-1", preview);
    expect(committed).toMatchObject({ status: "resolved", method: "provider_match" });
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
