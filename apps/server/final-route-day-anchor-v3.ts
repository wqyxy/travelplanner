import { TravelPlanDocumentSchema, type Day, type TravelPlanDocument } from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function routeShapeWithoutAnchorPlaces(day: Day) {
  return {
    id: day.id,
    dayNumber: day.dayNumber,
    transferMode: day.transferMode,
    startAnchorId: day.startAnchor.id,
    stops: day.stops.map((stop) => ({
      id: stop.id,
      placeId: stop.placeId,
      activity: stop.activity,
      period: stop.period,
      scheduleText: stop.scheduleText ?? null,
      startTime: stop.startTime,
      endTime: stop.endTime,
      durationMinutes: stop.durationMinutes,
      transportFromPrevious: stop.transportFromPrevious,
      scheduleVerification: stop.scheduleVerification,
      costNote: stop.costNote,
      costVerification: stop.costVerification,
      notes: stop.notes,
    })),
    endAnchorId: day.endAnchor.id,
    endTransportFromPrevious: day.endTransportFromPrevious ?? null,
  };
}

function dayStartPlaceId(day: Day) {
  return day.startAnchor.placeId ?? day.stops[0]?.placeId ?? day.endAnchor.placeId ?? null;
}

function dayEndPlaceId(day: Day) {
  return day.endAnchor.placeId ?? day.stops.at(-1)?.placeId ?? day.startAnchor.placeId ?? null;
}

type AnchorUpdate = {
  key: "origin" | `node:${string}`;
  placeId: string | null;
};

/**
 * Canonicalize legacy Day anchor Place edits.
 *
 * Mapping:
 * - first Day start anchor -> trip.originPlaceId, including null;
 * - later Day start anchor -> previous Day boundary node Place. When the visible
 *   anchor is null, use the same stop/end fallback Place as the legacy bridge
 *   while keeping the derived Day anchor metadata null;
 * - Day end anchor -> that Day boundary node Place, with the same last-stop/start
 *   fallback when the visible end anchor is null.
 *
 * Conflicting edits that target the same canonical boundary fall back instead of
 * guessing. A boundary with no representable fallback Place also falls back.
 */
export function tryApplyLegacyDayAnchorPlacesV3(
  beforeValue: TravelPlanDocument,
  incomingValue: TravelPlanDocument,
): TravelPlanDocument | null {
  const before = TravelPlanDocumentSchema.parse(clone(beforeValue));
  const incoming = TravelPlanDocumentSchema.parse(clone(incomingValue));
  if (before.days.length !== incoming.days.length) return null;

  const updates: AnchorUpdate[] = [];
  for (let index = 0; index < before.days.length; index += 1) {
    const previous = before.days[index];
    const requested = incoming.days[index];
    if (previous.id !== requested.id) return null;
    if (!same(routeShapeWithoutAnchorPlaces(previous), routeShapeWithoutAnchorPlaces(requested))) return null;

    if (previous.startAnchor.placeId !== requested.startAnchor.placeId) {
      if (index === 0) {
        if (before.trip.originPlaceId !== incoming.trip.originPlaceId && incoming.trip.originPlaceId !== requested.startAnchor.placeId) return null;
        updates.push({ key: "origin", placeId: requested.startAnchor.placeId });
      } else {
        const canonicalPlaceId = dayStartPlaceId(requested);
        if (!canonicalPlaceId) return null;
        updates.push({ key: `node:${incoming.days[index - 1].id}`, placeId: canonicalPlaceId });
      }
    }

    if (previous.endAnchor.placeId !== requested.endAnchor.placeId) {
      const canonicalPlaceId = dayEndPlaceId(requested);
      if (!canonicalPlaceId) return null;
      updates.push({ key: `node:${requested.id}`, placeId: canonicalPlaceId });
    }
  }
  if (!updates.length) return null;

  const byTarget = new Map<AnchorUpdate["key"], string | null>();
  for (const update of updates) {
    if (byTarget.has(update.key) && byTarget.get(update.key) !== update.placeId) return null;
    byTarget.set(update.key, update.placeId);
  }

  for (const placeId of byTarget.values()) {
    if (placeId && !incoming.places.some((place) => place.id === placeId)) throw new Error(`未知 Place：${placeId}`);
  }

  const nodes = clone(incoming.finalRoute.nodes);
  let trip = clone(incoming.trip);
  for (const [key, placeId] of byTarget) {
    if (key === "origin") {
      trip = { ...trip, originPlaceId: placeId };
      continue;
    }
    if (!placeId) return null;
    const nodeId = key.slice("node:".length);
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || node.status !== "normal") return null;
    node.placeId = placeId;
  }

  return rebuildFinalRouteDaysV3({
    ...clone(incoming),
    trip,
    finalRoute: { version: 1, nodes },
  });
}