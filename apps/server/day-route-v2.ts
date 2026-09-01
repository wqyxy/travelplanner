import { createHash, randomUUID } from "node:crypto";
import {
  DayRouteSchema,
  type Day,
  type DayRoute,
  type PlaceResolution,
  type RouteLeg,
  type TransportMode,
} from "./contracts-v2.js";
import type { MapService } from "./map-service.js";
import { resolutionIsCurrent } from "./place-resolver-v2.js";
import type { TravelStoreV2 } from "./travel-store-v2.js";

type Maps = Pick<MapService, "route">;
type RouteNode = { id: string; placeId: string; modeFromPrevious: TransportMode };
export const ROUTE_DAY_BATCH_CONCURRENCY = 3;

type QueuedJob<T> = { run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
class GlobalRouteDayPool {
  private active = 0;
  private readonly queued: QueuedJob<any>[] = [];
  enqueue<T>(run: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => { this.queued.push({ run, resolve, reject }); this.drain(); });
  }
  private drain() {
    while (this.active < ROUTE_DAY_BATCH_CONCURRENCY && this.queued.length) {
      const job = this.queued.shift()!; this.active += 1;
      void job.run().then(job.resolve, job.reject).finally(() => { this.active -= 1; this.drain(); });
    }
  }
}
const routeDayPool = new GlobalRouteDayPool();

const macroRouteId = (dayId: string) => `macro:${dayId}`;

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nodes(day: Day): RouteNode[] {
  const values: RouteNode[] = [];
  if (day.startAnchor.placeId) values.push({ id: day.startAnchor.id, placeId: day.startAnchor.placeId, modeFromPrevious: "none" });
  for (const stop of day.stops) values.push({ id: stop.id, placeId: stop.placeId, modeFromPrevious: stop.transportFromPrevious?.mode ?? "none" });
  // DayAnchor has no transport field. Reuse only an explicit last-stop mode;
  // without one this deliberately becomes attention rather than an implicit walk.
  if (day.endAnchor.placeId) {
    values.push({
      id: day.endAnchor.id,
      placeId: day.endAnchor.placeId,
      modeFromPrevious: day.stops.length ? day.stops.at(-1)?.transportFromPrevious?.mode ?? "none" : day.transferMode,
    });
  }
  return values;
}

function macroDay(day: Day): Day {
  return {
    ...structuredClone(day),
    stops: [],
    detailLevel: "planned",
    detailStatus: null,
  };
}

function macroRouteRequired(day: Day) {
  return Boolean(day.startAnchor.placeId && day.endAnchor.placeId && day.startAnchor.placeId !== day.endAnchor.placeId);
}

function currentResolution(placeId: string, planPlaces: Map<string, any>, resolutions: Map<string, PlaceResolution>) {
  const place = planPlaces.get(placeId);
  const resolution = resolutions.get(placeId);
  return place && resolutionIsCurrent(place, resolution) && resolution?.status === "resolved" ? resolution : null;
}

export function dayRouteInputFingerprint(day: Day, places: Map<string, any>, resolutions: PlaceResolution[]) {
  const byPlace = new Map(resolutions.map((resolution) => [resolution.placeId, resolution]));
  return hash(nodes(day).map((node) => {
    const resolution = currentResolution(node.placeId, places, byPlace);
    return {
      id: node.id,
      placeId: node.placeId,
      mode: node.modeFromPrevious,
      geoFingerprint: resolution?.geoFingerprint ?? null,
      latitude: resolution?.latitude ?? null,
      longitude: resolution?.longitude ?? null,
    };
  }));
}

export function routeIsDirty(day: Day, route: DayRoute | null | undefined, places: Map<string, any>, resolutions: PlaceResolution[]) {
  return !route || route.inputFingerprint !== dayRouteInputFingerprint(day, places, resolutions);
}

function providerMode(mode: TransportMode): "walk" | "drive" | "bike" | null {
  if (mode === "walk") return "walk";
  if (mode === "drive") return "drive";
  if (mode === "bike") return "bike";
  return null;
}

function featureCollection(legs: RouteLeg[]) {
  const features = legs.flatMap((leg) => {
    const value = leg.geometry as { type?: unknown; coordinates?: unknown } | null;
    return value?.type === "LineString" && Array.isArray(value.coordinates)
      ? [{ type: "Feature", properties: { legId: leg.id, mode: leg.mode }, geometry: value }]
      : [];
  });
  return features.length ? { type: "FeatureCollection", features } : null;
}

export class DayRouteServiceV2 {
  private readonly inFlight = new Map<string, Promise<DayRoute>>();
  constructor(private readonly options: { store: TravelStoreV2; maps: Maps }) {}

  workspaceRouteState(tripId: string) {
    const workspace = this.options.store.getWorkspace(tripId);
    const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place]));
    const routes = new Map(workspace.routes.map((route) => [route.dayId, route]));
    return workspace.trip.plan.days.map((day) => ({
      dayId: day.id,
      dirty: routeIsDirty(day, routes.get(day.id), places, workspace.resolutions),
      route: routes.get(day.id) ?? null,
    }));
  }

  workspaceMacroRouteState(tripId: string) {
    const workspace = this.options.store.getWorkspace(tripId);
    const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place]));
    const routes = new Map(workspace.routes.map((route) => [route.dayId, route]));
    return workspace.trip.plan.days.map((day) => {
      const routeDay = macroDay(day);
      const route = routes.get(macroRouteId(day.id)) ?? null;
      const required = macroRouteRequired(day);
      return {
        dayId: day.id,
        routeId: macroRouteId(day.id),
        required,
        dirty: required ? routeIsDirty(routeDay, route, places, workspace.resolutions) : false,
        route,
      };
    });
  }

  recalculate(tripId: string, dayId: string, expectedGeneration: number, signal?: AbortSignal) {
    const key = `${tripId}:${expectedGeneration}:${dayId}`;
    const existing = this.inFlight.get(key); if (existing) return existing;
    const job = routeDayPool.enqueue(async () => {
      if (signal?.aborted) throw new DOMException("任务已停止。", "AbortError");
      const trip = this.options.store.requireTrip(tripId);
      if (trip.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
      const day = trip.plan.days.find((item) => item.id === dayId);
      if (!day) throw new Error(`未知 Day：${dayId}`);
      return this.calculate(tripId, day, day.id, expectedGeneration, signal);
    });
    this.inFlight.set(key, job);
    void job.finally(() => this.inFlight.delete(key)).catch(() => undefined);
    return job;
  }

  async recalculateMacro(tripId: string, dayId: string, expectedGeneration: number, signal?: AbortSignal) {
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const day = trip.plan.days.find((item) => item.id === dayId);
    if (!day) throw new Error(`未知 Day：${dayId}`);
    if (!macroRouteRequired(day)) return null;
    const persistedDayId = macroRouteId(day.id);
    const key = `${tripId}:${expectedGeneration}:${persistedDayId}`;
    const existing = this.inFlight.get(key); if (existing) return existing;
    const job = routeDayPool.enqueue(() => this.calculate(tripId, macroDay(day), persistedDayId, expectedGeneration, signal));
    this.inFlight.set(key, job);
    void job.finally(() => this.inFlight.delete(key)).catch(() => undefined);
    return job;
  }

  private async calculate(tripId: string, day: Day, persistedDayId: string, expectedGeneration: number, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("任务已停止。", "AbortError");
    const trip = this.options.store.requireTrip(tripId);
    const placeMap = new Map(trip.plan.places.map((place) => [place.id, place]));
    const resolutionMap = new Map(this.options.store.listPlaceResolutions(tripId).map((resolution) => [resolution.placeId, resolution]));
    const routeNodes = nodes(day);
    const legs: RouteLeg[] = [];
    const warnings: string[] = [];

    for (let index = 1; index < routeNodes.length; index += 1) {
      if (signal?.aborted) throw new DOMException("任务已停止。", "AbortError");
      if (this.options.store.requireTrip(tripId).contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
      const from = routeNodes[index - 1];
      const to = routeNodes[index];
      const fromResolution = currentResolution(from.placeId, placeMap, resolutionMap);
      const toResolution = currentResolution(to.placeId, placeMap, resolutionMap);
      const mode = to.modeFromPrevious;
      const common = { id: randomUUID(), fromNodeId: from.id, toNodeId: to.id, fromPlaceId: from.placeId, toPlaceId: to.placeId, mode };
      if (!fromResolution || !toResolution) {
        const warning = "路线端点尚未正确定位。";
        warnings.push(warning);
        legs.push({ ...common, status: "attention", distanceKm: null, durationMinutes: null, geometry: null, warning });
        continue;
      }
      const supported = providerMode(mode);
      if (!supported) {
        const warning = mode === "none" ? "该路段未设置交通方式。" : `${mode} 路段暂不由当前路线服务计算。`;
        warnings.push(warning);
        legs.push({ ...common, status: "attention", distanceKm: null, durationMinutes: null, geometry: null, warning });
        continue;
      }
      const routeKey = hash({ supported, from: [fromResolution.longitude, fromResolution.latitude], to: [toResolution.longitude, toResolution.latitude] });
      const result = await this.options.maps.route(
        supported,
        [fromResolution.longitude!, fromResolution.latitude!],
        [toResolution.longitude!, toResolution.latitude!],
        routeKey,
        signal,
      );
      if (signal?.aborted) throw new DOMException("任务已停止。", "AbortError");
      if (this.options.store.requireTrip(tripId).contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
      if (result.warning) warnings.push(result.warning);
      legs.push({
        ...common,
        status: result.warning || !result.geometry ? "attention" : "ready",
        distanceKm: result.distanceKm,
        durationMinutes: result.durationMinutes,
        geometry: result.geometry,
        warning: result.warning,
      });
    }

    const previous = this.options.store.getDayRoute(tripId, persistedDayId);
    const distanceValues = legs.map((leg) => leg.distanceKm).filter((value): value is number => value !== null);
    const durationValues = legs.map((leg) => leg.durationMinutes).filter((value): value is number => value !== null);
    const route = DayRouteSchema.parse({
      tripId,
      dayId: persistedDayId,
      version: previous ? previous.version + 1 : 1,
      inputFingerprint: dayRouteInputFingerprint(day, placeMap, [...resolutionMap.values()]),
      status: warnings.length ? "attention" : "ready",
      distanceKm: distanceValues.length === legs.length ? distanceValues.reduce((sum, value) => sum + value, 0) : null,
      durationMinutes: durationValues.length === legs.length ? durationValues.reduce((sum, value) => sum + value, 0) : null,
      geometry: featureCollection(legs),
      legs,
      warnings: [...new Set(warnings)],
      calculatedAt: new Date().toISOString(),
    });
    this.options.store.setDayRoute(tripId, route, expectedGeneration);
    return route;
  }

  async recalculateAll(tripId: string, expectedGeneration: number, signal?: AbortSignal) {
    const trip = this.options.store.requireTrip(tripId);
    const routes: DayRoute[] = [];
    for (const day of trip.plan.days) routes.push(await this.recalculate(tripId, day.id, expectedGeneration, signal));
    return routes;
  }

  async recalculateAllMacro(tripId: string, expectedGeneration: number) {
    const trip = this.options.store.requireTrip(tripId);
    const routes: DayRoute[] = [];
    for (const day of trip.plan.days) {
      const route = await this.recalculateMacro(tripId, day.id, expectedGeneration);
      if (route) routes.push(route);
    }
    return routes;
  }
}
