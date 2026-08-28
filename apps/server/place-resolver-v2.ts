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

export const PLACE_RESOLUTION_VERSION = "v2";
export const PLACE_AUTO_SELECT_MIN_SCORE = 70;
export const PLACE_AUTO_SELECT_MIN_MARGIN = 15;

export type RankedProviderCandidate = { candidate: ProviderPlaceCandidate; score: number };
export type PlaceResolutionAssist = (input: { place: Place; candidates: ProviderPlaceCandidate[] }) => Promise<MapResolutionAssistOutput | null>;
export type PlaceResolutionResult = { resolution: PlaceResolution; candidates: RankedProviderCandidate[] };
export type PlaceResolutionPreview = { geoFingerprint: string; selected: RankedProviderCandidate | null; candidates: RankedProviderCandidate[]; method: "provider_match" | "provider_choice" };

type Maps = Pick<MapService, "search" | "reverse">;

const normalize = (value: string | null | undefined) => (value ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "").trim();
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
  for (const hint of hints) add(hint, place.countryCode);
  for (const name of [place.nameLocal, place.nameEn, place.nameZh]) {
    add(name, place.city, place.region, place.countryCode);
    add(name, place.city, place.countryCode);
    add(name, place.region, place.countryCode);
    add(name, place.countryCode);
  }
  return values.slice(0, 16);
}

function exactNameMatch(place: Place, candidate: MapCandidate) {
  const candidateName = normalize(candidate.name ?? candidate.displayName.split(",", 1)[0]);
  return Boolean(candidateName) && [place.nameZh, place.nameLocal, place.nameEn].some((name) => Boolean(name) && normalize(name) === candidateName);
}

function typeCompatible(place: Place, candidate: MapCandidate) {
  const category = candidate.category ?? "";
  const type = candidate.placeType ?? "";
  if (place.kind === "airport") return category === "aeroway" || ["airport", "aerodrome"].includes(type);
  if (place.kind === "station") return ["railway", "public_transport"].includes(category) || ["station", "halt", "bus_station"].includes(type);
  if (place.kind === "port") return ["waterway", "harbour"].includes(category) || ["harbour", "port", "marina", "ferry_terminal"].includes(type);
  if (place.kind === "city" || place.kind === "waypoint") return ["place", "boundary"].includes(category);
  if (place.kind === "lodging") return ["tourism", "building", "amenity", "place"].includes(category);
  if (place.kind === "attraction") return ["tourism", "historic", "leisure", "natural", "amenity", "man_made", "building", "aerialway"].includes(category);
  if (place.kind === "meal") return ["amenity", "shop", "tourism"].includes(category);
  return ["aeroway", "railway", "public_transport", "highway", "amenity", "place"].includes(category);
}

export function deduplicateProviderCandidates(candidates: MapCandidate[]) {
  const values = new Map<string, MapCandidate>();
  for (const candidate of candidates) {
    const key = [candidate.countryCode ?? "", normalize(candidate.name ?? candidate.displayName), candidate.category ?? "", candidate.placeType ?? "", candidate.latitude.toFixed(6), candidate.longitude.toFixed(6)].join("|");
    const previous = values.get(key);
    if (!previous || candidate.providerPlaceId.localeCompare(previous.providerPlaceId) < 0) values.set(key, candidate);
  }
  return [...values.values()];
}

export function filterProviderCandidates(place: Place, candidates: MapCandidate[]) {
  const country = place.countryCode?.toLowerCase() ?? null;
  return deduplicateProviderCandidates(candidates).filter((candidate) => (!country || candidate.countryCode === country) && (exactNameMatch(place, candidate) || typeCompatible(place, candidate)));
}

export function scoreProviderCandidate(place: Place, candidate: MapCandidate) {
  const names = [place.nameZh, place.nameLocal, place.nameEn].filter((name): name is string => Boolean(name)).map(normalize);
  const candidateName = normalize(candidate.name);
  const display = normalize(candidate.displayName);
  let score = candidateName && names.includes(candidateName) ? 55 : 0;
  if (candidateName && [place.nameLocal, place.nameEn].filter((name): name is string => Boolean(name)).map(normalize).includes(candidateName)) score += 20;
  if (!score && names.some((name) => name.length >= 4 && (display.includes(name) || name.includes(candidateName)))) score += 30;
  if (normalize(place.city) && normalize(place.city) === normalize(candidate.city)) score += 20;
  if (normalize(place.region) && normalize(place.region) === normalize(candidate.region)) score += 10;
  if (typeCompatible(place, candidate)) score += 15;
  if (place.countryCode && candidate.countryCode === place.countryCode.toLowerCase()) score += 10;
  return score;
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

export function rankProviderCandidates(place: Place, candidates: MapCandidate[]): RankedProviderCandidate[] {
  return filterProviderCandidates(place, candidates)
    .map((candidate) => ({ candidate: providerCandidate(candidate), score: scoreProviderCandidate(place, candidate) }))
    .sort((left, right) => right.score - left.score || left.candidate.providerPlaceId.localeCompare(right.candidate.providerPlaceId));
}

export function chooseProviderAutomatically(place: Place, ranked: RankedProviderCandidate[]) {
  if (!place.countryCode || !ranked.length) return null;
  if (ranked.length === 1 && ranked[0].score >= PLACE_AUTO_SELECT_MIN_SCORE) return ranked[0];
  if (ranked[0].score >= PLACE_AUTO_SELECT_MIN_SCORE && ranked[0].score - ranked[1].score >= PLACE_AUTO_SELECT_MIN_MARGIN) return ranked[0];
  return null;
}

function resolutionFromProvider(tripId: string, place: Place, selected: RankedProviderCandidate, method: "provider_match" | "provider_choice"): PlaceResolution {
  return {
    tripId,
    placeId: place.id,
    geoFingerprint: placeGeoFingerprint(place),
    status: "resolved",
    method,
    provider: selected.candidate.provider,
    providerPlaceId: selected.candidate.providerPlaceId,
    latitude: selected.candidate.latitude,
    longitude: selected.candidate.longitude,
    address: selected.candidate.displayName,
    confidence: Math.min(1, selected.score / 100),
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
    const values = new Map<string, MapCandidate>();
    for (const query of buildPlaceSearchQueries(place, hints)) {
      const candidates = await this.options.maps.search(query, place.countryCode);
      assertCurrent();
      for (const candidate of candidates) values.set(candidate.providerPlaceId, candidate);
    }
    return rankProviderCandidates(place, [...values.values()]);
  }

  async searchCandidates(tripId: string, placeId: string, expectedGeneration: number, hints: string[] = []) {
    const place = this.place(tripId, placeId, expectedGeneration);
    return this.searchPlaceCandidates(place, hints, () => { this.currentTrip(tripId, expectedGeneration); });
  }

  private async matchPlace(place: Place, assertCurrent: () => void = () => undefined): Promise<PlaceResolutionPreview> {
    let candidates = await this.searchPlaceCandidates(place, [], assertCurrent);
    let selected = chooseProviderAutomatically(place, candidates);
    let method: PlaceResolutionPreview["method"] = "provider_match";
    if (!selected && this.options.assist) {
      const rawDecision = await this.options.assist({ place, candidates: candidates.slice(0, 5).map((item) => item.candidate) });
      assertCurrent();
      const decision = rawDecision ? MapResolutionAssistOutputSchema.parse(rawDecision) : null;
      if (decision?.action === "choose_candidate") {
        selected = candidates.slice(0, 5).find((item) => item.candidate.providerPlaceId === decision.providerPlaceId) ?? null;
        if (selected) method = "provider_choice";
      }
      if (decision?.action === "retry_with_hints") {
        candidates = await this.searchPlaceCandidates(place, decision.searchHints, assertCurrent);
        selected = chooseProviderAutomatically(place, candidates);
      }
    }
    return { geoFingerprint: placeGeoFingerprint(place), selected, candidates, method };
  }

  preview(place: Place) {
    return this.matchPlace(PlaceSchema.parse(place));
  }

  commitPreview(tripId: string, placeId: string, preview: PlaceResolutionPreview, expectedGeneration: number) {
    const place = this.place(tripId, placeId, expectedGeneration);
    if (!preview.selected || preview.geoFingerprint !== placeGeoFingerprint(place)) throw new Error("地点预检结果与当前 Place 不一致。");
    const resolution = resolutionFromProvider(tripId, place, preview.selected, preview.method);
    this.options.store.upsertPlaceResolution(tripId, resolution, expectedGeneration);
    return resolution;
  }

  async resolve(tripId: string, placeId: string, expectedGeneration: number): Promise<PlaceResolutionResult> {
    const place = this.place(tripId, placeId, expectedGeneration);
    this.options.store.upsertPlaceResolution(tripId, {
      tripId, placeId, geoFingerprint: placeGeoFingerprint(place), status: "resolving", method: "provider_match",
      provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: null,
    }, expectedGeneration);
    try {
      const matched = await this.matchPlace(place, () => { this.currentTrip(tripId, expectedGeneration); });
      const resolution = matched.selected ? resolutionFromProvider(tripId, place, matched.selected, matched.method) : unresolved(tripId, place, matched.candidates.length ? "存在多个或低置信度候选，请手动选择地点。" : "地图服务未找到可靠候选，可重试、地图点选或手工输入坐标。");
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
    const unique = [...new Set(placeIds)];
    const values: PlaceResolutionResult[] = [];
    for (const placeId of unique) values.push(await this.resolve(tripId, placeId, expectedGeneration));
    return values;
  }

  async selectProviderCandidate(tripId: string, placeId: string, input: unknown) {
    const parsed = ProviderResolutionSelectionInputSchema.parse(input);
    const place = this.place(tripId, placeId, parsed.expectedGeneration);
    const ranked = await this.searchCandidates(tripId, placeId, parsed.expectedGeneration);
    const selected = ranked.find((item) => item.candidate.providerPlaceId === parsed.providerPlaceId);
    if (!selected) throw new Error("所选 Provider Candidate 不在服务端当前候选集合中。");
    const resolution = resolutionFromProvider(tripId, place, selected, "provider_choice");
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
    } catch { /* User-authorized direct coordinates remain usable when reverse lookup is unavailable. */ }
    if (place.countryCode && reverse?.countryCode && reverse.countryCode !== place.countryCode.toLowerCase()) throw new Error("坐标所在国家与 Place 的 countryCode 不一致。");
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
      confidence: parsed.method === "map_pick" ? 0.9 : 0.75,
      resolvedAt: now(),
      errorMessage: null,
    };
    this.options.store.upsertPlaceResolution(tripId, resolution, parsed.expectedGeneration);
    return resolution;
  }
}
