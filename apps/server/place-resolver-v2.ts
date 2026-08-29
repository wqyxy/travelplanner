import { createHash } from "node:crypto";
import {
  DirectPlaceResolutionInputSchema,
  MapResolutionAssistOutputSchema,
  PlaceSchema,
  ProviderResolutionSelectionInputSchema,
  type MapResolutionAssistOutput,
  type Place,
  type PlaceResolution,
  type ProviderPlaceCandidate,
} from "./contracts-v2.js";
import type { MapCandidate, MapService } from "./map-service.js";
import type { TravelStoreV2 } from "./travel-store-v2.js";

// Keep v2 in the fingerprint so historical resolved records remain current.
export const PLACE_RESOLUTION_VERSION = "v2";

export type RankedProviderCandidate = { candidate: ProviderPlaceCandidate; score: number };
export type PlaceResolutionAssist = (input: { place: Place; candidates: ProviderPlaceCandidate[]; round?: 1 | 2 }) => Promise<MapResolutionAssistOutput | null>;
export type PlaceResolutionResult = { resolution: PlaceResolution; candidates: RankedProviderCandidate[] };
export type PlaceResolutionPreview = { geoFingerprint: string; selected: RankedProviderCandidate | null; candidates: RankedProviderCandidate[]; method: "provider_match" | "provider_choice"; reason: string | null };

type Maps = Pick<MapService, "search" | "reverse">;

const normalize = (value: string | null | undefined) => (value ?? "").normalize("NFKC").toLocaleLowerCase().trim();
const now = () => new Date().toISOString();
const primaryName = (place: Place) => place.nameLocal ?? place.nameEn ?? place.nameZh;

export function placeGeoFingerprint(place: Place) {
  const value = [PLACE_RESOLUTION_VERSION, normalize(primaryName(place)), place.kind, normalize(place.city), normalize(place.region), normalize(place.countryCode ?? place.country), place.approximate ? "approximate" : "exact"].join("|");
  return createHash("sha256").update(value).digest("hex");
}

export function resolutionIsCurrent(place: Place, resolution: PlaceResolution | null | undefined) {
  return Boolean(resolution && resolution.placeId === place.id && resolution.geoFingerprint === placeGeoFingerprint(place));
}

export function buildPlaceSearchQueries(place: Place, hints: string[] = []) {
  const values: string[] = [];
  const add = (...parts: Array<string | null | undefined>) => {
    const query = parts.filter((part): part is string => Boolean(part?.trim())).join(", ").trim();
    if (query && !values.some((item) => normalize(item) === normalize(query))) values.push(query);
  };
  for (const hint of hints) add(hint, place.city, place.region, place.country ?? place.countryCode);
  for (const name of [place.nameLocal, place.nameEn, place.nameZh]) {
    add(name, place.city, place.region, place.country ?? place.countryCode);
    add(name, place.city, place.country ?? place.countryCode);
    add(name, place.region, place.country ?? place.countryCode);
    add(name, place.country ?? place.countryCode);
    add(name);
  }
  return values.slice(0, 16);
}

function providerCandidate(candidate: MapCandidate): ProviderPlaceCandidate {
  return {
    provider: "nominatim",
    providerPlaceId: candidate.providerPlaceId,
    name: candidate.name,
    displayName: candidate.displayName,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    category: candidate.category,
    placeType: candidate.placeType,
    countryCode: candidate.countryCode,
    region: candidate.region,
    city: candidate.city,
  };
}

export function deduplicateProviderCandidates(candidates: MapCandidate[]) {
  const values = new Map<string, MapCandidate>();
  const providerSeen = new Set<string>();
  for (const candidate of candidates) {
    if (providerSeen.has(candidate.providerPlaceId)) continue;
    providerSeen.add(candidate.providerPlaceId);
    const physicalKey = [normalize(candidate.name ?? candidate.displayName.split(",", 1)[0]), candidate.latitude.toFixed(7), candidate.longitude.toFixed(7)].join("|");
    if (!values.has(physicalKey)) values.set(physicalKey, candidate);
  }
  return [...values.values()];
}

export function filterProviderCandidates(_place: Place, candidates: MapCandidate[]) {
  return deduplicateProviderCandidates(candidates);
}

export function scoreProviderCandidate(_place: Place, _candidate: MapCandidate) {
  return 0;
}

export function rankProviderCandidates(place: Place, candidates: MapCandidate[]): RankedProviderCandidate[] {
  return filterProviderCandidates(place, candidates).map((candidate) => ({ candidate: providerCandidate(candidate), score: 0 }));
}

export function chooseProviderAutomatically(_place: Place, _ranked: RankedProviderCandidate[]) {
  return null;
}

function resolutionFromProvider(tripId: string, place: Place, selected: RankedProviderCandidate): PlaceResolution {
  return {
    tripId,
    placeId: place.id,
    geoFingerprint: placeGeoFingerprint(place),
    status: "resolved",
    method: "provider_choice",
    provider: selected.candidate.provider,
    providerPlaceId: selected.candidate.providerPlaceId,
    latitude: selected.candidate.latitude,
    longitude: selected.candidate.longitude,
    address: selected.candidate.displayName,
    confidence: null,
    resolvedAt: now(),
    errorMessage: null,
  };
}

function unresolved(tripId: string, place: Place, message: string): PlaceResolution {
  return {
    tripId,
    placeId: place.id,
    geoFingerprint: placeGeoFingerprint(place),
    status: "unresolved",
    method: "provider_match",
    provider: null,
    providerPlaceId: null,
    latitude: null,
    longitude: null,
    address: null,
    confidence: null,
    resolvedAt: null,
    errorMessage: message,
  };
}

export class PlaceResolverV2 {
  constructor(private readonly options: { store: TravelStoreV2; maps: Maps; assist?: PlaceResolutionAssist }) {}

  private currentTrip(tripId: string, expectedGeneration: number) {
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    return trip;
  }

  private place(tripId: string, placeId: string, expectedGeneration: number) {
    const trip = this.currentTrip(tripId, expectedGeneration);
    const place = trip.plan.places.find((item) => item.id === placeId);
    if (!place) throw new Error(`未知 Place：${placeId}`);
    return place;
  }

  private async searchPlaceCandidates(place: Place, hints: string[] = [], assertCurrent: () => void = () => undefined) {
    const all: MapCandidate[] = [];
    for (const query of buildPlaceSearchQueries(place, hints)) {
      const candidates = await this.options.maps.search(query, null);
      assertCurrent();
      all.push(...candidates);
    }
    return rankProviderCandidates(place, all);
  }

  async searchCandidates(tripId: string, placeId: string, expectedGeneration: number, hints: string[] = []) {
    const place = this.place(tripId, placeId, expectedGeneration);
    return this.searchPlaceCandidates(place, hints, () => { this.currentTrip(tripId, expectedGeneration); });
  }

  private async askAi(place: Place, candidates: RankedProviderCandidate[], round: 1 | 2, assertCurrent: () => void) {
    if (!this.options.assist) return { decision: null as MapResolutionAssistOutput | null, selected: null as RankedProviderCandidate | null };
    const raw = await this.options.assist({ place, candidates: candidates.map((item) => item.candidate), round });
    assertCurrent();
    const decision = raw ? MapResolutionAssistOutputSchema.parse(raw) : null;
    const selected = decision?.action === "choose_candidate"
      ? candidates.find((item) => item.candidate.providerPlaceId === decision.providerPlaceId) ?? null
      : null;
    return { decision, selected };
  }

  private async matchPlace(place: Place, assertCurrent: () => void = () => undefined): Promise<PlaceResolutionPreview> {
    let candidates = await this.searchPlaceCandidates(place, [], assertCurrent);
    let reason: string | null = null;
    const first = await this.askAi(place, candidates, 1, assertCurrent);
    if (first.selected) return { geoFingerprint: placeGeoFingerprint(place), selected: first.selected, candidates, method: "provider_choice", reason: first.decision?.reason ?? null };
    reason = first.decision?.reason ?? null;

    if (first.decision?.action === "retry_with_hints") {
      const supplemental = await this.searchPlaceCandidates(place, first.decision.searchHints, assertCurrent);
      const byId = new Map<string, RankedProviderCandidate>();
      for (const item of [...candidates, ...supplemental]) if (!byId.has(item.candidate.providerPlaceId)) byId.set(item.candidate.providerPlaceId, item);
      candidates = [...byId.values()];
      const second = await this.askAi(place, candidates, 2, assertCurrent);
      if (second.selected) return { geoFingerprint: placeGeoFingerprint(place), selected: second.selected, candidates, method: "provider_choice", reason: second.decision?.reason ?? null };
      reason = second.decision?.reason ?? reason ?? "第二轮地图消歧仍无法确认目标实体。";
    }

    return { geoFingerprint: placeGeoFingerprint(place), selected: null, candidates, method: "provider_choice", reason: reason ?? "AI 无法从地图候选中确认目标实体。" };
  }

  preview(place: Place) {
    return this.matchPlace(PlaceSchema.parse(place));
  }

  commitPreview(tripId: string, placeId: string, preview: PlaceResolutionPreview, expectedGeneration: number) {
    const place = this.place(tripId, placeId, expectedGeneration);
    if (!preview.selected || preview.geoFingerprint !== placeGeoFingerprint(place)) throw new Error("地点预检结果与当前 Place 不一致。");
    const resolution = resolutionFromProvider(tripId, place, preview.selected);
    this.options.store.upsertPlaceResolution(tripId, resolution, expectedGeneration);
    return resolution;
  }

  async resolve(tripId: string, placeId: string, expectedGeneration: number): Promise<PlaceResolutionResult> {
    const place = this.place(tripId, placeId, expectedGeneration);
    const existing = this.options.store.listPlaceResolutions(tripId).find((item) => item.placeId === placeId);
    if (existing?.status === "resolved" && resolutionIsCurrent(place, existing)) return { resolution: existing, candidates: [] };

    this.options.store.upsertPlaceResolution(tripId, {
      tripId, placeId, geoFingerprint: placeGeoFingerprint(place), status: "resolving", method: "provider_match",
      provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: null,
    }, expectedGeneration);
    try {
      const matched = await this.matchPlace(place, () => { this.currentTrip(tripId, expectedGeneration); });
      const resolution = matched.selected ? resolutionFromProvider(tripId, place, matched.selected) : unresolved(tripId, place, matched.reason ?? "地图实体仍待确认。");
      this.options.store.upsertPlaceResolution(tripId, resolution, expectedGeneration);
      return { resolution, candidates: matched.candidates };
    } catch (error) {
      this.currentTrip(tripId, expectedGeneration);
      const message = error instanceof Error ? error.message : "地点解析失败。";
      const resolution = unresolved(tripId, place, message);
      this.options.store.upsertPlaceResolution(tripId, resolution, expectedGeneration);
      return { resolution, candidates: [] };
    }
  }

  async resolveMany(tripId: string, placeIds: string[], expectedGeneration: number) {
    const values: PlaceResolutionResult[] = [];
    for (const placeId of [...new Set(placeIds)]) values.push(await this.resolve(tripId, placeId, expectedGeneration));
    return values;
  }

  async selectProviderCandidate(tripId: string, placeId: string, input: unknown) {
    const parsed = ProviderResolutionSelectionInputSchema.parse(input);
    const place = this.place(tripId, placeId, parsed.expectedGeneration);
    const ranked = await this.searchCandidates(tripId, placeId, parsed.expectedGeneration);
    const selected = ranked.find((item) => item.candidate.providerPlaceId === parsed.providerPlaceId);
    if (!selected) throw new Error("所选 Provider Candidate 不在服务端当前候选集合中。");
    const resolution = resolutionFromProvider(tripId, place, selected);
    this.options.store.upsertPlaceResolution(tripId, resolution, parsed.expectedGeneration);
    return { resolution, candidates: ranked };
  }

  async setDirectCoordinates(tripId: string, placeId: string, input: unknown) {
    const parsed = DirectPlaceResolutionInputSchema.parse(input);
    const place = this.place(tripId, placeId, parsed.expectedGeneration);
    let reverse: MapCandidate | null = null;
    try {
      reverse = await this.options.maps.reverse(parsed.latitude, parsed.longitude);
      this.currentTrip(tripId, parsed.expectedGeneration);
    } catch { /* Reverse lookup is display-only for user-authorized coordinates. */ }
    const resolution: PlaceResolution = {
      tripId,
      placeId,
      geoFingerprint: placeGeoFingerprint(place),
      status: "resolved",
      method: parsed.method,
      provider: null,
      providerPlaceId: null,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      address: parsed.address ?? reverse?.displayName ?? null,
      confidence: null,
      resolvedAt: now(),
      errorMessage: null,
    };
    this.options.store.upsertPlaceResolution(tripId, resolution, parsed.expectedGeneration);
    return resolution;
  }
}
