import { createHash } from "node:crypto";
import {
  DerivedMapSnapshotSchema,
  type CandidateDecisionOutput,
  type DerivedMapRoute,
  type DerivedMapSnapshot,
  type Itinerary,
  type MapChangedEvent,
  type MapEdge,
  type MapVisit,
  type Place,
  type ResolvedPlace,
} from "./contracts.js";
import { MapService, type MapCandidate } from "./map-service.js";
import type { TravelStore } from "./travel-store.js";

export const AUTO_SELECT_MIN_SCORE = 65;
export const AUTO_SELECT_MIN_MARGIN = 15;
export const ROUTING_PROFILE_VERSION = "v1";
export const MAP_RESOLUTION_VERSION = "v4";

export type ScoredCandidate = { candidate: MapCandidate; score: number };
type Decision = (input: { place: Place; candidates: MapCandidate[] }) => Promise<CandidateDecisionOutput | null>;
type ChangeListener = (event: MapChangedEvent) => void;

const normalize = (value: string | null | undefined) => (value ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "").trim();
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const coordinate = (place: ResolvedPlace) => place.lng === null || place.lat === null ? null : [place.lng, place.lat] as [number, number];
const primaryName = (place: Place) => place.nameLocal ?? place.nameEn ?? place.nameZh;
const placeLabel = (place: Place | undefined) => place?.nameZh ?? "未知地点";

/** A display-only translation does not change the preferred local/English identity. */
export function geoFingerprint(place: Place) {
  const countryIdentity = place.countryCode ? normalize(place.countryCode) : normalize(place.country);
  return [MAP_RESOLUTION_VERSION, normalize(primaryName(place)), place.kind, normalize(place.city), normalize(place.region), countryIdentity, place.approximate ? "approximate" : "exact"].join("|");
}

export function buildMapQueries(place: Place) {
  const names = [place.nameLocal, place.nameEn, place.nameZh];
  const areas = [place.city, place.region];
  const values: string[] = [];
  const add = (...parts: Array<string | null>) => {
    const query = parts.filter((part): part is string => Boolean(part?.trim())).join(", ").trim();
    if (query && !values.some((entry) => normalize(entry) === normalize(query))) values.push(query);
  };
  for (const area of areas) for (const name of names) {
    add(name, name && area && normalize(name) === normalize(area) ? null : area, place.countryCode);
  }
  for (const name of names) add(name, place.countryCode);
  return values;
}

export function deriveMapGraph(itinerary: Itinerary): Pick<DerivedMapSnapshot, "visits" | "edges"> {
  const visits: MapVisit[] = [];
  const edges: MapEdge[] = [];
  for (const day of itinerary.days) {
    const dayVisits = day.stops.map((stop, order) => ({ id: stop.id, dayId: day.id, dayNumber: day.dayNumber, stopId: stop.id, placeId: stop.placeId, order }));
    visits.push(...dayVisits);
    for (let order = 1; order < dayVisits.length; order += 1) {
      const from = dayVisits[order - 1]; const to = dayVisits[order];
      edges.push({ id: `edge-${hash(`${from.id}:${to.id}`)}`, dayId: day.id, fromVisitId: from.id, toVisitId: to.id, mode: day.stops[order].transportFromPrevious?.mode ?? "none", order: order - 1 });
    }
  }
  return { visits, edges };
}

function typeCompatible(place: Place, candidate: MapCandidate) {
  const category = candidate.category ?? ""; const type = candidate.placeType ?? "";
  if (place.kind === "airport") return category === "aeroway" || type === "aerodrome" || type === "airport";
  if (place.kind === "station") return ["railway", "public_transport"].includes(category) || ["station", "halt", "bus_station"].includes(type);
  if (place.kind === "port") return ["waterway", "harbour"].includes(category) || ["harbour", "port", "marina"].includes(type);
  if (place.kind === "city" || place.kind === "waypoint") return ["place", "boundary"].includes(category);
  if (place.kind === "lodging") return ["tourism", "building", "amenity", "place"].includes(category);
  if (place.kind === "attraction") return ["tourism", "historic", "leisure", "natural", "amenity", "man_made", "building"].includes(category);
  if (place.kind === "meal") return ["amenity", "shop", "tourism"].includes(category);
  return ["aeroway", "railway", "public_transport", "highway", "amenity", "place"].includes(category);
}

function exactNameMatch(place: Place, candidate: MapCandidate) {
  const candidateName = normalize(candidate.name);
  return Boolean(candidateName) && [place.nameZh, place.nameLocal, place.nameEn].some((name) => Boolean(name) && normalize(name) === candidateName);
}

/** Country stays strict; an exact provider short name can override a kind mismatch. */
export function filterMapCandidates(place: Place, candidates: MapCandidate[]) {
  const country = place.countryCode?.toLowerCase() ?? null;
  return deduplicateMapCandidates(candidates).filter((candidate) => (!country || candidate.countryCode === country) && (exactNameMatch(place, candidate) || typeCompatible(place, candidate)));
}

export function deduplicateMapCandidates(candidates: MapCandidate[]) {
  const unique = new Map<string, MapCandidate>();
  for (const candidate of candidates) {
    const key = [candidate.countryCode ?? "", normalize(candidate.name ?? candidate.displayName), candidate.category ?? "", candidate.placeType ?? "", candidate.latitude.toFixed(6), candidate.longitude.toFixed(6)].join("|");
    const previous = unique.get(key);
    if (!previous || candidate.providerPlaceId.localeCompare(previous.providerPlaceId) < 0) unique.set(key, candidate);
  }
  return [...unique.values()];
}

function distanceKm(left: [number, number], right: [number, number]) {
  const radians = (value: number) => value * Math.PI / 180;
  const latitude = radians(right[1] - left[1]); const longitude = radians(right[0] - left[0]);
  const value = Math.sin(latitude / 2) ** 2 + Math.cos(radians(left[1])) * Math.cos(radians(right[1])) * Math.sin(longitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function scoreMapCandidate(place: Place, candidate: MapCandidate, nearby: ResolvedPlace[] = []) {
  const candidateName = normalize(candidate.name);
  const candidateDisplayName = normalize(candidate.displayName);
  const names = [place.nameZh, place.nameLocal, place.nameEn].filter((name): name is string => Boolean(name)).map(normalize);
  let score = candidateName && names.includes(candidateName) ? 50 : 0;
  if (candidateName && [place.nameLocal, place.nameEn].filter((name): name is string => Boolean(name)).map(normalize).includes(candidateName)) score += 45;
  const containmentCandidates = candidateName ? [candidateName] : [candidateDisplayName];
  if (!score && names.some((name) => name.length >= 4 && containmentCandidates.some((candidateValue) => candidateValue && (candidateValue.includes(name) || name.includes(candidateValue))))) score += 25;
  if (normalize(place.city) && normalize(place.city) === normalize(candidate.city)) score += 20;
  if (normalize(place.region) && normalize(place.region) === normalize(candidate.region)) score += 10;
  if (typeCompatible(place, candidate)) score += 15;
  const point: [number, number] = [candidate.longitude, candidate.latitude];
  if (nearby.some((entry) => { const anchor = coordinate(entry); return anchor !== null && distanceKm(point, anchor) <= 80; })) score += 10;
  return score;
}

export function rankMapCandidates(place: Place, candidates: MapCandidate[], nearby: ResolvedPlace[] = []) {
  return candidates.map((candidate) => ({ candidate, score: scoreMapCandidate(place, candidate, nearby) })).sort((left, right) => right.score - left.score || left.candidate.providerPlaceId.localeCompare(right.candidate.providerPlaceId));
}

export function chooseAutomatically(place: Place, candidates: MapCandidate[], nearby: ResolvedPlace[] = []): ScoredCandidate | null {
  // Without the target country code, code cannot prove a candidate belongs to the intended country.
  if (!place.countryCode) return null;
  const country = place.countryCode.toLowerCase();
  const eligible = deduplicateMapCandidates(candidates).filter((candidate) => candidate.countryCode === country && (exactNameMatch(place, candidate) || typeCompatible(place, candidate)));
  const exact = eligible.filter((candidate) => exactNameMatch(place, candidate));
  const scored = rankMapCandidates(place, exact.length ? exact : eligible, nearby);
  if (exact.length === 1) return { ...scored[0], score: Math.max(AUTO_SELECT_MIN_SCORE, scored[0].score) };
  if (scored.length === 1 && scored[0].score >= AUTO_SELECT_MIN_SCORE) return scored[0];
  if (scored.length > 1 && scored[0].score >= AUTO_SELECT_MIN_SCORE && scored[0].score - scored[1].score >= AUTO_SELECT_MIN_MARGIN) return scored[0];
  return null;
}

export function routeCacheKey(mode: string, from: [number, number], to: [number, number]) {
  return `${mode}:${from[0].toFixed(6)},${from[1].toFixed(6)}:${to[0].toFixed(6)},${to[1].toFixed(6)}:${ROUTING_PROFILE_VERSION}`;
}

export function straightGeometry(from: [number, number], to: [number, number]) {
  let destination = to[0];
  if (destination - from[0] > 180) destination -= 360;
  if (destination - from[0] < -180) destination += 360;
  return { type: "LineString", coordinates: [[from[0], from[1]], [destination, to[1]]] };
}

function snapshot(value: unknown): DerivedMapSnapshot | null {
  const parsed = DerivedMapSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function resolvedFromCandidate(place: Place, candidate: MapCandidate, resolution: ResolvedPlace["resolution"], confidence: number | null): ResolvedPlace {
  return { placeId: place.id, geoFingerprint: geoFingerprint(place), provider: "nominatim", providerPlaceId: candidate.providerPlaceId, lat: candidate.latitude, lng: candidate.longitude, timezone: candidate.timezone, resolution, confidence, resolvedAt: new Date().toISOString() };
}

export class MapPipeline {
  private readonly tokens = new Map<string, symbol>();

  constructor(private readonly options: { store: TravelStore; maps: MapService; decideCandidate?: Decision; onChanged: ChangeListener }) {}

  async sync(tripId: string, generation: number, changedDayIds: string[]) {
    const token = Symbol(tripId); this.tokens.set(tripId, token);
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== generation) return;
    const prior = this.options.store.getMapState(tripId);
    const graph = deriveMapGraph(trip.itinerary);
    const reusable = new Map((prior?.resolvedPlaces ?? []).filter((entry) => entry.resolution !== "unresolved" && trip.itinerary.places.some((place) => place.id === entry.placeId && geoFingerprint(place) === entry.geoFingerprint)).map((entry) => [entry.placeId, entry]));
    const initial: DerivedMapSnapshot = { ...graph, routes: [] };
    this.commit(tripId, generation, changedDayIds, token, { resolvedPlaces: [...reusable.values()], map: initial, status: "syncing", warnings: [] }, "正在同步地图派生数据");
    try {
      const resolved = new Map(reusable);
      for (const place of trip.itinerary.places) {
        if (!resolved.has(place.id)) resolved.set(place.id, await this.resolvePlace(place, [...resolved.values()]));
        if (!this.current(tripId, generation, token)) return;
      }
      const places = new Map(trip.itinerary.places.map((place) => [place.id, place]));
      const routes = await this.resolveRoutes(graph, resolved, snapshot(prior?.map), places);
      if (!this.current(tripId, generation, token)) return;
      const values = [...resolved.values()];
      const placeWarnings = values.filter((entry) => entry.resolution !== "exact").map((entry) => {
        const place = places.get(entry.placeId); const name = placeLabel(place);
        if (entry.resolution === "unresolved") return `${name}：未能可靠定位，地图暂不显示此地点。`;
        const center = place?.city ?? place?.region ?? "所在城市或区域";
        return place?.kind === "port" ? `${name}：未找到可确认的港口坐标，暂以${center}城镇中心显示（大致位置）。` : `${name}：暂以${center}中心显示（大致位置）。`;
      });
      const routeWarnings = routes.filter((route) => route.status === "attention").flatMap((route) => route.warning ? [route.warning] : []);
      const warnings = [...new Set([...placeWarnings, ...routeWarnings])];
      const status = warnings.length ? "attention" : "ready";
      const map: DerivedMapSnapshot = { ...graph, routes };
      this.commit(tripId, generation, changedDayIds, token, { resolvedPlaces: values, map, status, warnings }, status === "ready" ? "地图已同步" : "地图已同步，部分地点或路线需要注意");
    } catch (error) {
      if (!this.current(tripId, generation, token)) return;
      const warning = error instanceof Error ? error.message : "地图同步失败。";
      this.commit(tripId, generation, changedDayIds, token, { resolvedPlaces: [...reusable.values()], map: initial, status: "attention", warnings: [warning] }, "地图同步未完成");
    }
  }

  private current(tripId: string, generation: number, token: symbol) {
    return this.tokens.get(tripId) === token && this.options.store.requireTrip(tripId).contentGeneration === generation;
  }

  private commit(tripId: string, generation: number, changedDayIds: string[], token: symbol, state: { resolvedPlaces: ResolvedPlace[]; map: DerivedMapSnapshot; status: "syncing" | "ready" | "attention"; warnings: string[] }, summary: string) {
    if (!this.current(tripId, generation, token)) return;
    this.options.store.setMapState(tripId, { generation, ...state }, generation);
    this.options.onChanged({ tripId, generation, changedDayIds: [...new Set(changedDayIds)].slice(0, 90), status: state.status, summary });
  }

  private async resolvePlace(place: Place, nearby: ResolvedPlace[]) {
    const all = new Map<string, MapCandidate>();
    for (const query of buildMapQueries(place)) {
      for (const candidate of await this.options.maps.search(query, place.countryCode)) all.set(candidate.providerPlaceId, candidate);
      const automatic = chooseAutomatically(place, filterMapCandidates(place, [...all.values()]), nearby);
      if (automatic) return resolvedFromCandidate(place, automatic.candidate, "exact", Math.min(1, automatic.score / 100));
    }
    const candidates = filterMapCandidates(place, [...all.values()]);
    const ranked = rankMapCandidates(place, candidates, nearby);
    if (candidates.length && this.options.decideCandidate) {
      const decisionCandidates = ranked.slice(0, 5).map((entry) => entry.candidate);
      const decision = await this.options.decideCandidate({ place, candidates: decisionCandidates });
      const chosen = decision?.providerPlaceId ? decisionCandidates.find((candidate) => candidate.providerPlaceId === decision.providerPlaceId) : undefined;
      if (chosen) return resolvedFromCandidate(place, chosen, "exact", 0.6);
    }
    return this.approximateOrUnresolved(place);
  }

  private async approximateOrUnresolved(place: Place): Promise<ResolvedPlace> {
    const centerName = place.city ?? place.region ?? primaryName(place);
    const settlementNamedPort = place.kind === "port" && Boolean(place.city) && normalize(place.nameZh) === normalize(place.city);
    if (place.kind !== "city" && place.kind !== "lodging" && !settlementNamedPort) return { placeId: place.id, geoFingerprint: geoFingerprint(place), provider: "nominatim", providerPlaceId: null, lat: null, lng: null, timezone: null, resolution: "unresolved", confidence: null, resolvedAt: null };
    const preserveSettlementNames = place.kind !== "lodging" && normalize(place.nameZh) === normalize(centerName);
    const centerTarget: Place = { ...place, nameZh: centerName, nameLocal: preserveSettlementNames ? place.nameLocal : null, nameEn: preserveSettlementNames ? place.nameEn : null, kind: "city", approximate: true };
    try {
      const all = new Map<string, MapCandidate>();
      for (const query of buildMapQueries(centerTarget)) {
        for (const candidate of await this.options.maps.search(query, place.countryCode)) all.set(candidate.providerPlaceId, candidate);
        const selected = chooseAutomatically(centerTarget, filterMapCandidates(centerTarget, [...all.values()]));
        if (selected) return resolvedFromCandidate(place, selected.candidate, "approximate", Math.min(0.5, selected.score / 100));
      }
    } catch { /* The unresolved result below keeps the failure visible without inventing a location. */ }
    return { placeId: place.id, geoFingerprint: geoFingerprint(place), provider: "nominatim", providerPlaceId: null, lat: null, lng: null, timezone: null, resolution: "unresolved", confidence: null, resolvedAt: null };
  }

  private async resolveRoutes(graph: Pick<DerivedMapSnapshot, "visits" | "edges">, resolved: Map<string, ResolvedPlace>, prior: DerivedMapSnapshot | null, places: Map<string, Place>) {
    const visits = new Map(graph.visits.map((visit) => [visit.id, visit])); const existing = new Map((prior?.routes ?? []).map((route) => [route.routeKey, route]));
    const routes: DerivedMapRoute[] = [];
    for (const edge of graph.edges) {
      const from = visits.get(edge.fromVisitId); const to = visits.get(edge.toVisitId);
      if (!from || !to) continue;
      const fromPlace = resolved.get(from.placeId); const toPlace = resolved.get(to.placeId);
      const fromCoordinate = fromPlace ? coordinate(fromPlace) : null; const toCoordinate = toPlace ? coordinate(toPlace) : null;
      if (edge.mode === "none") { routes.push({ edgeId: edge.id, routeKey: `none:${edge.id}:${ROUTING_PROFILE_VERSION}`, geometry: null, status: "ready", warning: null }); continue; }
      if (from.placeId === to.placeId) { routes.push({ edgeId: edge.id, routeKey: `same:${from.placeId}:${edge.mode}:${ROUTING_PROFILE_VERSION}`, geometry: null, status: "ready", warning: "同一地点内移动。" }); continue; }
      if (!fromCoordinate || !toCoordinate) { routes.push({ edgeId: edge.id, routeKey: `${edge.mode}:unresolved:${edge.id}:${ROUTING_PROFILE_VERSION}`, geometry: null, status: "attention", warning: `${placeLabel(places.get(from.placeId))} → ${placeLabel(places.get(to.placeId))}：路线端点尚未可靠定位。` }); continue; }
      const key = routeCacheKey(edge.mode, fromCoordinate, toCoordinate); const previous = existing.get(key);
      if (previous?.status === "ready") { routes.push({ ...previous, edgeId: edge.id }); continue; }
      if (edge.mode === "flight") { routes.push({ edgeId: edge.id, routeKey: key, geometry: straightGeometry(fromCoordinate, toCoordinate), status: "ready", warning: null }); continue; }
      if (edge.mode === "walk" || edge.mode === "drive" || edge.mode === "bike") {
        const result = await this.options.maps.route(edge.mode, fromCoordinate, toCoordinate, key);
        routes.push({ edgeId: edge.id, routeKey: key, geometry: result.geometry, status: result.warning ? "attention" : "ready", warning: result.warning }); continue;
      }
      const warning = edge.mode === "ferry" ? "渡轮仅显示直线建议连线，班次与航线尚未实时核验。" : "公共交通仅显示建议连线，尚未实时核验。";
      routes.push({ edgeId: edge.id, routeKey: key, geometry: straightGeometry(fromCoordinate, toCoordinate), status: "attention", warning });
    }
    return routes;
  }
}
