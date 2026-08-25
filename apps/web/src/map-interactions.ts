import type { DerivedMapRoute, Itinerary, MapState, TransportMode } from "./types";

export const mapCategoryLegend = [
  ["city", "城市"],
  ["attraction", "景点"],
  ["lodging", "住宿"],
  ["meal", "餐饮"],
  ["stop", "交通/停靠"],
  ["waypoint", "途经点"],
] as const;

export type MapCategory = (typeof mapCategoryLegend)[number][0];
export type CategoryVisibility = Record<MapCategory, boolean>;
export type RouteHover = { id: string; dayNumber: number } | null;
type RouteMode = "walk" | "drive" | "bike" | "transit" | "rail" | "flight" | "ferry" | "none";
export const dashedRouteModes = ["flight", "ferry"] as const;
export const routeLayerIds = ["travel-routes-solid", "travel-routes-dashed"] as const;
export const routeHitLayerIds = ["travel-route-hit-solid", "travel-route-hit-dashed"] as const;
export const routeHoverHaloLayerIds = ["travel-route-hover-solid-halo", "travel-route-hover-dashed-halo"] as const;
export const routeHoverCoreLayerIds = ["travel-route-hover-solid-core", "travel-route-hover-dashed-core"] as const;
export const routeHoverLayerIds = [...routeHoverHaloLayerIds, ...routeHoverCoreLayerIds] as const;

export function routeHighlightFeatureCollection<T>(feature: T | null) {
  return { type: "FeatureCollection" as const, features: feature ? [feature] : [] };
}

export function routeColorExpression(property: "dayNumber" | "mode", entries: ReadonlyArray<readonly [string | number, string]>, fallback = "#64748b") {
  return entries.length
    ? ["match", ["get", property], ...entries.flatMap(([key, color]) => [key, color]), fallback]
    : fallback;
}

export const routeLayerForMode = (mode: string) =>
  (dashedRouteModes as readonly string[]).includes(mode) ? "dashed" as const : "solid" as const;

export const defaultCategoryVisibility = (): CategoryVisibility =>
  Object.fromEntries(mapCategoryLegend.map(([kind]) => [kind, true])) as CategoryVisibility;

export const visibleCategories = (visibility: CategoryVisibility): MapCategory[] =>
  mapCategoryLegend
    .map(([kind]) => kind)
    .filter((kind) => visibility[kind]);

export const routeHoverFromFeature = (feature: {
  id?: string | number;
  properties?: { id?: string; dayNumber?: string | number };
}): RouteHover => {
  const id = feature.properties?.id || feature.id;
  const dayNumber = Number(feature.properties?.dayNumber);
  return id !== undefined && Number.isInteger(dayNumber) && dayNumber > 0
    ? { id: String(id), dayNumber }
    : null;
};

const coordinate = (value: unknown): [number, number] | null => {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = Number(value[0]); const latitude = Number(value[1]);
  return Number.isFinite(longitude) && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    ? [longitude, latitude]
    : null;
};

const segmentDistanceKm = (from: [number, number], to: [number, number]) => {
  const radians = (value: number) => value * Math.PI / 180;
  const latitude = radians(to[1] - from[1]);
  const longitudeDelta = ((to[0] - from[0] + 540) % 360) - 180;
  const longitude = radians(longitudeDelta);
  const value = Math.sin(latitude / 2) ** 2 + Math.cos(radians(from[1])) * Math.cos(radians(to[1])) * Math.sin(longitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
};

const lineDistanceKm = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  const points = value.map(coordinate);
  if (points.length < 2 || points.some((point) => point === null)) return null;
  return points.slice(1).reduce((total, point, index) => total + segmentDistanceKm(points[index]!, point!), 0);
};

export function geometryDistanceKm(geometry: { type?: unknown; coordinates?: unknown } | null | undefined): number | null {
  if (geometry?.type === "LineString") return lineDistanceKm(geometry.coordinates);
  if (geometry?.type !== "MultiLineString" || !Array.isArray(geometry.coordinates)) return null;
  const distances = geometry.coordinates.map(lineDistanceKm);
  return distances.some((distance) => distance === null) ? null : distances.reduce<number>((total, distance) => total + distance!, 0);
}

const approximateSpeedsKmh: Record<Exclude<RouteMode, "none">, number> = {
  walk: 4.5,
  drive: 45,
  bike: 15,
  transit: 25,
  rail: 90,
  flight: 700,
  ferry: 30,
};

export function approximateRouteDurationMinutes(mode: RouteMode, distanceKm: number | null, itineraryMinutes: number | null): number | null {
  if (itineraryMinutes !== null && Number.isFinite(itineraryMinutes) && itineraryMinutes >= 0) return Math.round(itineraryMinutes);
  if (distanceKm === null || !Number.isFinite(distanceKm) || distanceKm < 0 || mode === "none") return null;
  const travelMinutes = distanceKm / approximateSpeedsKmh[mode] * 60;
  const overheadMinutes = mode === "flight" ? 90 : mode === "ferry" ? 20 : 0;
  const rawMinutes = travelMinutes + overheadMinutes;
  return rawMinutes < 5 ? Math.max(1, Math.round(rawMinutes)) : Math.max(5, Math.round(rawMinutes / 5) * 5);
}

export function formatRouteDistance(distanceKm: number | null): string | null {
  if (distanceKm === null || !Number.isFinite(distanceKm) || distanceKm < 0) return null;
  const value = distanceKm < 1 ? Number(distanceKm.toFixed(2)) : distanceKm < 10 ? Number(distanceKm.toFixed(1)) : Math.round(distanceKm);
  return `${value} km`;
}

export function formatRouteDuration(durationMinutes: number | null): string | null {
  if (durationMinutes === null || !Number.isFinite(durationMinutes) || durationMinutes < 0) return null;
  const minutes = Math.round(durationMinutes);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60); const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

export type RouteTravelMetrics = { distanceKm: number | null; durationMinutes: number | null; estimated: boolean; pending: boolean };
const metric = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function routeTravelMetrics(route: DerivedMapRoute | null | undefined, mode: TransportMode, itineraryMinutes: number | null): RouteTravelMetrics {
  if (!route) return { distanceKm: null, durationMinutes: null, estimated: false, pending: true };
  const providerDistance = metric(route.distanceKm); const providerDuration = metric(route.durationMinutes);
  const geometryDistance = providerDistance === null ? geometryDistanceKm(route.geometry) : null;
  const distanceKm = providerDistance ?? geometryDistance;
  const durationMinutes = providerDuration ?? approximateRouteDurationMinutes(mode, distanceKm, itineraryMinutes);
  return { distanceKm, durationMinutes, estimated: providerDistance === null || providerDuration === null, pending: distanceKm === null || durationMinutes === null };
}

export type DrivingMetrics = { byStopId: Map<string, RouteTravelMetrics>; byDayId: Map<string, RouteTravelMetrics & { routeCount: number }> };
export function drivingMetricsForItinerary(itinerary: Itinerary, state: MapState | null, expectedGeneration?: number): DrivingMetrics {
  const currentState = expectedGeneration === undefined || state?.generation === expectedGeneration ? state : null;
  const visits = new Map((currentState?.map?.visits ?? []).map((visit) => [visit.id, visit]));
  const edgesByDestinationStop = new Map((currentState?.map?.edges ?? []).flatMap((edge) => {
    const stopId = visits.get(edge.toVisitId)?.stopId;
    return stopId ? [[stopId, edge] as const] : [];
  }));
  const routes = new Map((currentState?.map?.routes ?? []).map((route) => [route.edgeId, route]));
  const byStopId = new Map<string, RouteTravelMetrics>(); const byDayId = new Map<string, RouteTravelMetrics & { routeCount: number }>();
  for (const day of itinerary.days) {
    const values = day.stops.flatMap((stop) => {
      if (stop.transportFromPrevious?.mode !== "drive") return [];
      const edge = edgesByDestinationStop.get(stop.id); const value = routeTravelMetrics(edge ? routes.get(edge.id) : null, "drive", stop.transportFromPrevious.durationMinutes);
      byStopId.set(stop.id, value); return [value];
    });
    if (!values.length) continue;
    const pending = values.some((value) => value.pending);
    byDayId.set(day.id, {
      routeCount: values.length,
      distanceKm: pending ? null : values.reduce((total, value) => total + value.distanceKm!, 0),
      durationMinutes: pending ? null : values.reduce((total, value) => total + value.durationMinutes!, 0),
      estimated: values.some((value) => value.estimated),
      pending,
    });
  }
  return { byStopId, byDayId };
}
