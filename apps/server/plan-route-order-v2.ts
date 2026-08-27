import type { DayStop, PlaceResolution, PlanGenerationOutput, TravelPlanDocument } from "./contracts-v2.js";
import { buildPlanningAreaContext } from "./planning-areas-v2.js";

const LOCAL_ROUTE_KINDS = new Set(["attraction", "waypoint"]);
const LOCAL_ROUTE_MODES = new Set(["walk", "drive", "bike"]);
type Point = { latitude: number; longitude: number };

function distanceSquared(left: Point, right: Point) {
  const latitudeScale = Math.cos(((left.latitude + right.latitude) / 2) * Math.PI / 180);
  const dy = left.latitude - right.latitude;
  const dx = (left.longitude - right.longitude) * latitudeScale;
  return dx * dx + dy * dy;
}

function pointFor(placeId: string | null, resolutions: Map<string, PlaceResolution>): Point | null {
  if (!placeId) return null;
  const resolution = resolutions.get(placeId);
  if (!resolution || resolution.status !== "resolved" || resolution.latitude === null || resolution.longitude === null) return null;
  return { latitude: resolution.latitude, longitude: resolution.longitude };
}

function routeMode(stop: DayStop) {
  return stop.transportFromPrevious?.mode ?? "walk";
}

function resetProviderTime(stop: DayStop): DayStop {
  if (!stop.transportFromPrevious) return stop;
  return {
    ...stop,
    transportFromPrevious: {
      ...stop.transportFromPrevious,
      durationMinutes: null,
      verification: { status: "unverified", checkedAt: null },
    },
  };
}

function nearestNeighbor(stops: DayStop[], resolutions: Map<string, PlaceResolution>) {
  if (stops.length < 3) return stops;
  const remaining = [...stops];
  const first = remaining.shift()!;
  const ordered: DayStop[] = [first];
  let current = pointFor(first.placeId, resolutions);

  while (remaining.length) {
    if (!current) {
      ordered.push(...remaining);
      break;
    }
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    remaining.forEach((stop, index) => {
      const point = pointFor(stop.placeId, resolutions);
      if (!point) return;
      const distance = distanceSquared(current!, point);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    current = pointFor(next.placeId, resolutions) ?? current;
  }

  return ordered.map(resetProviderTime);
}

export function optimizeGeneratedSightseeingOrder(
  trip: TravelPlanDocument,
  output: PlanGenerationOutput,
  resolutions: PlaceResolution[],
): PlanGenerationOutput {
  const next = structuredClone(output);
  const areas = buildPlanningAreaContext(trip);
  const candidates = new Map(trip.candidates.map((candidate) => [candidate.id, candidate]));
  const places = new Map(trip.places.map((place) => [place.id, place]));
  const resolutionByPlace = new Map(resolutions.map((resolution) => [resolution.placeId, resolution]));

  const stopAreaKey = (stop: DayStop) => stop.candidateId ? areas.areaKeyByCandidateId.get(stop.candidateId) ?? null : null;
  const eligible = (stop: DayStop) => {
    if (!stop.candidateId || !pointFor(stop.placeId, resolutionByPlace) || !LOCAL_ROUTE_MODES.has(routeMode(stop))) return false;
    const candidate = candidates.get(stop.candidateId);
    const place = candidate ? places.get(candidate.placeId) : null;
    return Boolean(place && LOCAL_ROUTE_KINDS.has(place.kind));
  };

  next.days = next.days.map((day) => {
    const stops = [...day.stops];
    let index = 0;

    while (index < stops.length) {
      const current = stops[index];
      if (!eligible(current)) {
        index += 1;
        continue;
      }

      const areaKey = stopAreaKey(current);
      const mode = routeMode(current);
      let end = index + 1;
      while (end < stops.length && eligible(stops[end]) && stopAreaKey(stops[end]) === areaKey && routeMode(stops[end]) === mode) end += 1;
      const block = stops.slice(index, end);
      const optimized = nearestNeighbor(block, resolutionByPlace);
      stops.splice(index, block.length, ...optimized);
      index = end;
    }

    return { ...day, stops };
  });

  return next;
}
