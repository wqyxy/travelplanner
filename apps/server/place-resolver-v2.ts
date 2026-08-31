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
import type { MapCandidate } from "./map-service.js";
import type { TravelStoreV2 } from "./travel-store-v2.js";

export const PLACE_RESOLUTION_VERSION = "v2";
export const PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT = 4;
export const PLACE_RESOLUTION_BASE_SEARCH_LIMIT = 2;
// MapService still serializes/rate-limits Provider HTTP requests. This only lets
// several Places advance cooperatively so one ambiguous Place cannot block all others.
export const PLACE_RESOLUTION_BATCH_CONCURRENCY = 3;

export type RankedProviderCandidate = { candidate: ProviderPlaceCandidate; score: number };
export type PlaceResolutionAssist = (input: {
  place: Place;
  candidates: ProviderPlaceCandidate[];
  round?: 1 | 2;
  signal?: AbortSignal;
}) => Promise<MapResolutionAssistOutput | null>;
export type PlaceResolutionResult = { resolution: PlaceResolution; candidates: RankedProviderCandidate[] };
export type PlaceResolutionBatchProgress = {
  placeId: string;
  status: PlaceResolution["status"];
  completed: number;
  total: number;
  resolution: PlaceResolution;
};
export type PlaceResolutionPreview = {
  geoFingerprint: string;
  selected: RankedProviderCandidate | null;
  candidates: RankedProviderCandidate[];
  method: "provider_match" | "provider_choice";
  reason: string | null;
};

type Maps = {
  search(query: string, countryCode?: string | null, signal?: AbortSignal): Promise<MapCandidate[]>;
  reverse(latitude: number, longitude: number, signal?: AbortSignal): Promise<MapCandidate | null>;
};
type MatchFacts = { nameScore: number; countryMatch: boolean; cityMatch: boolean; regionMatch: boolean; typeScore: number };
type SearchState = { raw: MapCandidate[]; ranked: RankedProviderCandidate[]; searchCount: number; queries: Set<string> };

const normalize = (value: string | null | undefined) => (value ?? "").normalize("NFKC").toLocaleLowerCase().trim();
const compact = (value: string | null | undefined) => normalize(value).replace(/[\p{P}\p{S}\s]+/gu, "");
const now = () => new Date().toISOString();
const primaryName = (place: Place) => place.nameLocal ?? place.nameEn ?? place.nameZh;
const targetNames = (place: Place) => [...new Set([place.nameLocal, place.nameEn, place.nameZh].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))];
const physicalKey = (candidate: { latitude: number; longitude: number }) => `${candidate.latitude.toFixed(6)}|${candidate.longitude.toFixed(6)}`;

function abortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("AI 任务已停止。");
}
function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw abortError(signal); }
function notifyResolution(callback: ((resolution: PlaceResolution) => void) | undefined, resolution: PlaceResolution) {
  try { callback?.(resolution); } catch { /* Progress observers must never break resolution. */ }
}

export function placeGeoFingerprint(place: Place) {
  const value = [PLACE_RESOLUTION_VERSION, normalize(primaryName(place)), place.kind, normalize(place.city), normalize(place.region), normalize(place.countryCode ?? place.country), place.approximate ? "approximate" : "exact"].join("|");
  return createHash("sha256").update(value).digest("hex");
}
export function resolutionIsCurrent(place: Place, resolution: PlaceResolution | null | undefined) {
  return Boolean(resolution && resolution.placeId === place.id && resolution.geoFingerprint === placeGeoFingerprint(place));
}

export function buildPlaceSearchQueries(place: Place, _compatibilityHints: string[] = []) {
  const values: string[] = [];
  const country = place.country ?? place.countryCode;
  const names = targetNames(place);
  const first = names[0] ?? place.nameZh;
  const second = names.find((name) => normalize(name) !== normalize(first)) ?? null;
  const add = (...parts: Array<string | null | undefined>) => {
    const query = parts.filter((part): part is string => Boolean(part?.trim())).join(", ").trim();
    if (query && !values.some((item) => normalize(item) === normalize(query))) values.push(query);
  };
  if (place.kind === "city") {
    // A city is its own locality. Repeating it as "Picton, Picton" makes
    // Nominatim favor same-named facilities such as stations and bus stops.
    add(first, place.region, country);
    add(first, country);
  } else {
    add(first, place.city, country);
    if (second) add(second, place.city, country); else add(first, place.region, country);
  }
  return values.slice(0, PLACE_RESOLUTION_BASE_SEARCH_LIMIT);
}
function hintQuery(place: Place, hint: string) {
  const context = [place.city, place.region, place.country ?? place.countryCode]
    .filter((value): value is string => Boolean(value?.trim()));
  const normalizedHint = normalize(hint);
  return [hint.trim(), ...context.filter((value) => !normalizedHint.includes(normalize(value)))].join(", ");
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

function deduplicateByProvider(candidates: MapCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.providerPlaceId)) return false;
    seen.add(candidate.providerPlaceId);
    return true;
  });
}

/** Compatibility export: physical de-duplication without scoring. Ranking below keeps the best-scoring physical representative. */
export function deduplicateProviderCandidates(candidates: MapCandidate[]) {
  const values = new Map<string, MapCandidate>();
  for (const candidate of deduplicateByProvider(candidates)) if (!values.has(physicalKey(candidate))) values.set(physicalKey(candidate), candidate);
  return [...values.values()];
}

export function filterProviderCandidates(place: Place, candidates: MapCandidate[]) {
  const targetCountry = normalize(place.countryCode);
  return deduplicateByProvider(candidates).filter((candidate) => {
    const providerCountry = normalize(candidate.countryCode);
    return !(targetCountry && providerCountry && targetCountry !== providerCountry);
  });
}

function tokens(value: string | null | undefined) {
  return normalize(value).split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2 || /[^\x00-\x7F]/u.test(token));
}
function tokenOverlap(left: string, right: string) {
  const a = new Set(tokens(left)); const b = new Set(tokens(right));
  if (!a.size || !b.size) return { jaccard: 0, coverage: 0, shared: 0 };
  const shared = [...a].filter((token) => b.has(token)).length;
  return { jaccard: shared / new Set([...a, ...b]).size, coverage: shared / Math.min(a.size, b.size), shared };
}
function nameMatchScore(place: Place, candidate: MapCandidate) {
  const candidateNames = [candidate.name, candidate.displayName.split(",", 1)[0], candidate.displayName].filter((value): value is string => Boolean(value?.trim()));
  let best = 0;
  for (const target of targetNames(place)) {
    const targetCompact = compact(target);
    if (!targetCompact) continue;
    for (const providerName of candidateNames) {
      const providerCompact = compact(providerName);
      if (!providerCompact) continue;
      if (targetCompact === providerCompact) best = Math.max(best, 60);
      else if (targetCompact.includes(providerCompact) || providerCompact.includes(targetCompact)) best = Math.max(best, 45);
      else {
        const overlap = tokenOverlap(target, providerName);
        if (overlap.coverage >= 0.8 || overlap.jaccard >= 0.7) best = Math.max(best, 40);
        else if (overlap.shared > 0 && (overlap.coverage >= 0.4 || overlap.jaccard >= 0.3)) best = Math.max(best, 25);
      }
    }
  }
  return best;
}
function localityMatches(target: string | null | undefined, actual: string | null | undefined) {
  const left = compact(target); const right = compact(actual);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

const TYPE_HINTS: Record<Place["kind"], string[]> = {
  city: ["city", "town", "municipality", "administrative"],
  attraction: ["attraction", "tourism", "museum", "gallery", "viewpoint", "park", "garden", "historic", "monument", "memorial", "castle", "waterfall", "aerialway", "artwork", "zoo"],
  lodging: ["hotel", "hostel", "motel", "guest_house", "lodging", "accommodation"],
  meal: ["restaurant", "cafe", "fast_food", "food", "bar"],
  airport: ["airport", "aerodrome", "terminal", "aeroway"],
  station: ["station", "halt", "railway", "subway", "tram_stop", "public_transport"],
  port: ["port", "harbour", "ferry_terminal", "ferry"],
  stop: ["stop", "platform", "bus_stop", "public_transport"],
  waypoint: ["viewpoint", "trail", "path", "peak", "natural", "waypoint"],
};
function matchFacts(place: Place, candidate: MapCandidate): MatchFacts {
  const countryMatch = Boolean(place.countryCode && candidate.countryCode && normalize(place.countryCode) === normalize(candidate.countryCode));
  const cityMatch = localityMatches(place.city, candidate.city);
  const regionMatch = localityMatches(place.region, candidate.region);
  const providerType = normalize(`${candidate.category ?? ""} ${candidate.placeType ?? ""}`);
  const typeScore = TYPE_HINTS[place.kind].some((hint) => providerType.includes(normalize(hint))) ? 5 : 0;
  return { nameScore: nameMatchScore(place, candidate), countryMatch, cityMatch, regionMatch, typeScore };
}
export function scoreProviderCandidate(place: Place, candidate: MapCandidate) {
  const facts = matchFacts(place, candidate);
  return facts.nameScore + (facts.countryMatch ? 20 : 0) + (facts.cityMatch ? 15 : 0) + (facts.regionMatch ? 10 : 0) + facts.typeScore;
}

export function rankProviderCandidates(place: Place, candidates: MapCandidate[]): RankedProviderCandidate[] {
  const scored = filterProviderCandidates(place, candidates)
    .map((candidate) => ({ candidate: providerCandidate(candidate), score: scoreProviderCandidate(place, candidate) }))
    .sort((left, right) => right.score - left.score || left.candidate.providerPlaceId.localeCompare(right.candidate.providerPlaceId));
  const physical = new Map<string, RankedProviderCandidate>();
  for (const item of scored) if (!physical.has(physicalKey(item.candidate))) physical.set(physicalKey(item.candidate), item);
  return [...physical.values()].sort((left, right) => right.score - left.score || left.candidate.providerPlaceId.localeCompare(right.candidate.providerPlaceId));
}
function resolutionFromProvider(tripId: string, place: Place, selected: RankedProviderCandidate, method: "provider_match" | "provider_choice"): PlaceResolution {
  return {
    tripId, placeId: place.id, geoFingerprint: placeGeoFingerprint(place), status: "resolved", method,
    provider: selected.candidate.provider, providerPlaceId: selected.candidate.providerPlaceId,
    latitude: selected.candidate.latitude, longitude: selected.candidate.longitude, address: selected.candidate.displayName,
    confidence: null, resolvedAt: now(), errorMessage: null,
  };
}
function unresolved(tripId: string, place: Place, message: string, method: "provider_match" | "provider_choice" = "provider_match"): PlaceResolution {
  return {
    tripId, placeId: place.id, geoFingerprint: placeGeoFingerprint(place), status: "unresolved", method,
    provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: message,
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

  private async runSearch(place: Place, query: string, state: SearchState, signal?: AbortSignal, assertCurrent: () => void = () => undefined) {
    if (state.searchCount >= PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT) return false;
    const key = normalize(query);
    if (!key || state.queries.has(key)) return false;
    state.queries.add(key); state.searchCount += 1;
    throwIfAborted(signal);
    const values = await this.options.maps.search(query, null, signal);
    throwIfAborted(signal); assertCurrent();
    state.raw = deduplicateByProvider([...state.raw, ...values]);
    state.ranked = rankProviderCandidates(place, state.raw);
    return true;
  }
  private async searchPlaceCandidates(place: Place, signal?: AbortSignal, assertCurrent: () => void = () => undefined) {
    const state: SearchState = { raw: [], ranked: [], searchCount: 0, queries: new Set() };
    for (const query of buildPlaceSearchQueries(place)) await this.runSearch(place, query, state, signal, assertCurrent);
    return state.ranked;
  }
  async searchCandidates(tripId: string, placeId: string, expectedGeneration: number, signal?: AbortSignal) {
    const place = this.place(tripId, placeId, expectedGeneration);
    return this.searchPlaceCandidates(place, signal, () => { this.currentTrip(tripId, expectedGeneration); });
  }

  private async askAi(place: Place, candidates: RankedProviderCandidate[], round: 1 | 2, signal: AbortSignal | undefined, assertCurrent: () => void) {
    if (!this.options.assist) return { decision: null as MapResolutionAssistOutput | null, selected: null as RankedProviderCandidate | null };
    throwIfAborted(signal);
    const raw = await this.options.assist({ place, candidates: candidates.map((item) => item.candidate), round, signal });
    throwIfAborted(signal); assertCurrent();
    const decision = raw ? MapResolutionAssistOutputSchema.parse(raw) : null;
    const selected = decision?.action === "choose_candidate" ? candidates.find((item) => item.candidate.providerPlaceId === decision.providerPlaceId) ?? null : null;
    return { decision, selected };
  }

  private async resolveAmbiguity(place: Place, state: SearchState, signal: AbortSignal | undefined, assertCurrent: () => void): Promise<PlaceResolutionPreview> {
    const first = await this.askAi(place, state.ranked, 1, signal, assertCurrent);
    if (first.selected) return { geoFingerprint: placeGeoFingerprint(place), selected: first.selected, candidates: state.ranked, method: "provider_choice", reason: first.decision?.reason ?? null };
    if (!first.decision) return { geoFingerprint: placeGeoFingerprint(place), selected: null, candidates: state.ranked, method: "provider_choice", reason: "地图消歧 Agent 暂时无法判断目标实体。" };
    if (first.decision.action === "unresolved") return { geoFingerprint: placeGeoFingerprint(place), selected: null, candidates: state.ranked, method: "provider_choice", reason: first.decision.reason };

    let supplemented = false;
    for (const hint of first.decision.searchHints) {
      if (state.searchCount >= PLACE_RESOLUTION_PROVIDER_SEARCH_LIMIT) break;
      const searched = await this.runSearch(place, hintQuery(place, hint), state, signal, assertCurrent);
      if (!searched) continue;
      supplemented = true;
    }
    if (!supplemented) return { geoFingerprint: placeGeoFingerprint(place), selected: null, candidates: state.ranked, method: "provider_choice", reason: first.decision.reason || "搜索预算已用尽，仍无法确认目标实体。" };
    const second = await this.askAi(place, state.ranked, 2, signal, assertCurrent);
    if (second.selected) return { geoFingerprint: placeGeoFingerprint(place), selected: second.selected, candidates: state.ranked, method: "provider_choice", reason: second.decision?.reason ?? null };
    return { geoFingerprint: placeGeoFingerprint(place), selected: null, candidates: state.ranked, method: "provider_choice", reason: second.decision?.reason ?? first.decision.reason ?? "最终地图消歧仍无法确认目标实体。" };
  }

  private async matchPlace(place: Place, signal?: AbortSignal, assertCurrent: () => void = () => undefined): Promise<PlaceResolutionPreview> {
    const state: SearchState = { raw: [], ranked: [], searchCount: 0, queries: new Set() };
    for (const query of buildPlaceSearchQueries(place)) await this.runSearch(place, query, state, signal, assertCurrent);
    if (!this.options.assist) return { geoFingerprint: placeGeoFingerprint(place), selected: null, candidates: state.ranked, method: "provider_choice", reason: "地图消歧 Agent 暂时无法判断目标实体。" };
    return this.resolveAmbiguity(place, state, signal, assertCurrent);
  }

  async preview(place: Place, options: { signal?: AbortSignal } = {}) {
    const parsed = PlaceSchema.parse(place);
    try { return await this.matchPlace(parsed, options.signal); }
    catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal);
      return { geoFingerprint: placeGeoFingerprint(parsed), selected: null, candidates: [], method: "provider_match" as const, reason: error instanceof Error ? error.message : "地图定位预检失败。" };
    }
  }
  commitPreview(tripId: string, placeId: string, preview: PlaceResolutionPreview, expectedGeneration: number) {
    const place = this.place(tripId, placeId, expectedGeneration);
    if (preview.geoFingerprint !== placeGeoFingerprint(place)) throw new Error("地点预检结果与当前 Place 不一致。");
    const resolution = preview.selected ? resolutionFromProvider(tripId, place, preview.selected, preview.method) : unresolved(tripId, place, preview.reason ?? "地图实体仍待确认。", preview.method);
    this.options.store.upsertPlaceResolution(tripId, resolution, expectedGeneration);
    return resolution;
  }
  commitPreviewLatest(tripId: string, placeId: string, preview: PlaceResolutionPreview, signal?: AbortSignal) {
    throwIfAborted(signal);
    const trip = this.options.store.requireTrip(tripId);
    const place = trip.plan.places.find((item) => item.id === placeId);
    if (!place || preview.geoFingerprint !== placeGeoFingerprint(place)) return null;
    throwIfAborted(signal);
    const resolution = preview.selected ? resolutionFromProvider(tripId, place, preview.selected, preview.method) : unresolved(tripId, place, preview.reason ?? "地图实体仍待确认。", preview.method);
    this.options.store.upsertPlaceResolution(tripId, resolution, trip.contentGeneration);
    return resolution;
  }

  async resolve(tripId: string, placeId: string, expectedGeneration: number, signal?: AbortSignal, onStatus?: (resolution: PlaceResolution) => void): Promise<PlaceResolutionResult> {
    const place = this.place(tripId, placeId, expectedGeneration);
    const existing = this.options.store.listPlaceResolutions(tripId).find((item) => item.placeId === placeId);
    if (existing?.status === "resolved" && resolutionIsCurrent(place, existing)) {
      notifyResolution(onStatus, existing);
      return { resolution: existing, candidates: [] };
    }
    throwIfAborted(signal);
    const resolving: PlaceResolution = {
      tripId, placeId, geoFingerprint: placeGeoFingerprint(place), status: "resolving", method: "provider_match",
      provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: null,
    };
    this.options.store.upsertPlaceResolution(tripId, resolving, expectedGeneration);
    notifyResolution(onStatus, resolving);
    try {
      const matched = await this.matchPlace(place, signal, () => { this.currentTrip(tripId, expectedGeneration); });
      throwIfAborted(signal);
      const resolution = matched.selected ? resolutionFromProvider(tripId, place, matched.selected, matched.method) : unresolved(tripId, place, matched.reason ?? "地图实体仍待确认。", matched.method);
      this.options.store.upsertPlaceResolution(tripId, resolution, expectedGeneration);
      notifyResolution(onStatus, resolution);
      return { resolution, candidates: matched.candidates };
    } catch (error) {
      if (signal?.aborted) {
        try {
          this.currentTrip(tripId, expectedGeneration);
          const resolution = unresolved(tripId, place, "定位已停止。");
          this.options.store.upsertPlaceResolution(tripId, resolution, expectedGeneration);
          notifyResolution(onStatus, resolution);
        } catch { /* A generation change already invalidated this resolution attempt. */ }
        throw abortError(signal);
      }
      this.currentTrip(tripId, expectedGeneration);
      const resolution = unresolved(tripId, place, error instanceof Error ? error.message : "地点解析失败。");
      this.options.store.upsertPlaceResolution(tripId, resolution, expectedGeneration);
      notifyResolution(onStatus, resolution);
      return { resolution, candidates: [] };
    }
  }
  async resolveMany(
    tripId: string,
    placeIds: string[],
    expectedGeneration: number,
    signal?: AbortSignal,
    onProgress?: (progress: PlaceResolutionBatchProgress) => void,
  ) {
    const ids = [...new Set(placeIds)];
    if (!ids.length) return [];
    const values = new Array<PlaceResolutionResult>(ids.length);
    const finished = new Set<string>();
    let cursor = 0;
    let completed = 0;
    let fatal = false;
    const report = (placeId: string, resolution: PlaceResolution) => {
      if (resolution.status !== "resolving" && !finished.has(placeId)) {
        finished.add(placeId);
        completed += 1;
      }
      try { onProgress?.({ placeId, status: resolution.status, completed, total: ids.length, resolution }); }
      catch { /* Progress observers must never break resolution. */ }
    };
    const worker = async () => {
      while (!fatal) {
        throwIfAborted(signal);
        const index = cursor;
        cursor += 1;
        if (index >= ids.length) return;
        const placeId = ids[index];
        try {
          values[index] = await this.resolve(tripId, placeId, expectedGeneration, signal, (resolution) => report(placeId, resolution));
        } catch (error) {
          fatal = true;
          throw error;
        }
      }
    };
    const workerCount = Math.min(PLACE_RESOLUTION_BATCH_CONCURRENCY, ids.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
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
    try { reverse = await this.options.maps.reverse(parsed.latitude, parsed.longitude); this.currentTrip(tripId, parsed.expectedGeneration); }
    catch { /* Reverse lookup is display-only for user-authorized coordinates. */ }
    if (reverse?.countryCode && place.countryCode && normalize(reverse.countryCode) !== normalize(place.countryCode)) throw new Error("所选坐标的 countryCode 与目标 Place 不一致。");
    const resolution: PlaceResolution = {
      tripId, placeId, geoFingerprint: placeGeoFingerprint(place), status: "resolved", method: parsed.method,
      provider: null, providerPlaceId: null, latitude: parsed.latitude, longitude: parsed.longitude,
      address: parsed.address ?? reverse?.displayName ?? null, confidence: null, resolvedAt: now(), errorMessage: null,
    };
    this.options.store.upsertPlaceResolution(tripId, resolution, parsed.expectedGeneration);
    return resolution;
  }
}
