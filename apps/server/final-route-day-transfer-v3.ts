import type { Day, Transport, TravelPlanDocument } from "./contracts-v2.js";
import { updateFinalRouteTransportV3 } from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function routeShapeWithoutDayTransferMode(day: Day) {
  return {
    id: day.id,
    dayNumber: day.dayNumber,
    startAnchor: { id: day.startAnchor.id, placeId: day.startAnchor.placeId },
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
    endAnchor: { id: day.endAnchor.id, placeId: day.endAnchor.placeId },
    endTransportFromPrevious: day.endTransportFromPrevious ?? null,
  };
}

function selectedTransport(mode: Day["transferMode"]): Transport | null {
  if (mode === "none") return null;
  return {
    mode,
    durationMinutes: null,
    note: null,
    verification: { status: "unverified", checkedAt: null },
  };
}

function firstActiveNodeIdForDay(plan: TravelPlanDocument, dayId: string) {
  let firstId: string | null = null;
  for (const node of plan.finalRoute.nodes) {
    if (node.status !== "normal") continue;
    if (!firstId) firstId = node.id;
    if (node.endsDay || node.id === dayId) {
      if (node.id === dayId) return firstId;
      firstId = null;
    }
  }
  return null;
}

/**
 * Canonicalize the legacy Day-level `transferMode` field without treating Day
 * as a second route model. The mode belongs to the first active finalRoute node
 * of that derived Day segment, because `deriveFinalRouteDaysV3()` reads it from
 * exactly that node.
 *
 * Returns null when the incoming Day change also modifies any other route/node
 * structure, so the caller can keep using the broader compatibility translator.
 */
export function tryApplyLegacyDayTransferModesV3(
  beforeValue: TravelPlanDocument,
  incomingValue: TravelPlanDocument,
): TravelPlanDocument | null {
  const before = clone(beforeValue);
  const incoming = clone(incomingValue);
  if (before.days.length !== incoming.days.length) return null;

  const changed: Array<{ dayId: string; mode: Day["transferMode"] }> = [];
  for (let index = 0; index < before.days.length; index += 1) {
    const previous = before.days[index];
    const requested = incoming.days[index];
    if (previous.id !== requested.id) return null;
    if (!same(routeShapeWithoutDayTransferMode(previous), routeShapeWithoutDayTransferMode(requested))) return null;
    if (previous.transferMode !== requested.transferMode) changed.push({ dayId: requested.id, mode: requested.transferMode });
  }
  if (!changed.length) return null;

  // Start from incoming so unrelated canonical changes in the same write
  // (trip/candidate/place metadata, etc.) are preserved.
  let working = incoming;
  for (const item of changed) {
    const nodeId = firstActiveNodeIdForDay(working, item.dayId);
    if (!nodeId) return null;
    working = updateFinalRouteTransportV3(working, nodeId, selectedTransport(item.mode)).plan;
  }
  return working;
}