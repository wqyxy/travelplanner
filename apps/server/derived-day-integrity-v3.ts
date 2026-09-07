import { TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export type DerivedDayWriteInspectionV3 = {
  plan: TravelPlanDocument;
  matchesCanonicalDays: boolean;
};

export type DerivedDayRouteWriteKindsV3 = {
  daySet: boolean;
  dayOrder: boolean;
  dayNumber: boolean;
  transferMode: boolean;
  anchorIdentity: boolean;
  anchorPlace: boolean;
  stops: boolean;
  endTransport: boolean;
};

function canonicalStopProjection(stop: TravelPlanDocument["days"][number]["stops"][number]) {
  return {
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
  };
}

function canonicalDayProjection(day: TravelPlanDocument["days"][number]) {
  return {
    id: day.id,
    dayNumber: day.dayNumber,
    transferMode: day.transferMode,
    startAnchor: { id: day.startAnchor.id, placeId: day.startAnchor.placeId },
    stops: day.stops.map(canonicalStopProjection),
    endAnchor: { id: day.endAnchor.id, placeId: day.endAnchor.placeId },
    endTransportFromPrevious: day.endTransportFromPrevious ?? null,
  };
}

function canonicalDaysProjection(plan: TravelPlanDocument) {
  return plan.days.map(canonicalDayProjection);
}

/**
 * Re-derive Day from canonical finalRoute while using the incoming Day view only
 * as derivation metadata source. If the result is byte-equivalent to the
 * incoming Day view, the write is already canonical.
 */
export function inspectDerivedDayWriteV3(planValue: TravelPlanDocument): DerivedDayWriteInspectionV3 {
  const incoming = TravelPlanDocumentSchema.parse(clone(planValue));
  const plan = rebuildFinalRouteDaysV3(incoming);
  return {
    plan,
    matchesCanonicalDays: same(incoming.days, plan.days),
  };
}

/**
 * Detect whether the caller independently changed Day fields that belong to the
 * canonical route/node model while leaving finalRoute unchanged.
 *
 * Excluded from this projection on purpose:
 * - title/date/stayBlockId/detailLevel/detailStatus;
 * - anchor label/notes;
 * - stop candidateId, because it is derived from the canonical node Place and
 *   the current Candidate set.
 */
export function hasIndependentDerivedRouteWriteV3(
  beforeValue: TravelPlanDocument,
  incomingValue: TravelPlanDocument,
) {
  const before = TravelPlanDocumentSchema.parse(clone(beforeValue));
  const incoming = TravelPlanDocumentSchema.parse(clone(incomingValue));
  return !same(canonicalDaysProjection(before), canonicalDaysProjection(incoming));
}

/**
 * Classify route-structural Day deltas by stable Day ID. This is used to keep
 * the transitional compatibility path narrow: registered legacy Day actions
 * may still express order/dayNumber, transferMode and anchor Place edits, while
 * Stop/node identity and end-transport changes must already be canonical.
 */
export function classifyIndependentDerivedRouteWriteV3(
  beforeValue: TravelPlanDocument,
  incomingValue: TravelPlanDocument,
): DerivedDayRouteWriteKindsV3 {
  const before = TravelPlanDocumentSchema.parse(clone(beforeValue));
  const incoming = TravelPlanDocumentSchema.parse(clone(incomingValue));
  const beforeIds = before.days.map((day) => day.id);
  const incomingIds = incoming.days.map((day) => day.id);
  const beforeSet = new Set(beforeIds);
  const incomingSet = new Set(incomingIds);
  const daySet = beforeSet.size !== incomingSet.size
    || beforeIds.some((id) => !incomingSet.has(id))
    || incomingIds.some((id) => !beforeSet.has(id));

  const result: DerivedDayRouteWriteKindsV3 = {
    daySet,
    dayOrder: !daySet && !same(beforeIds, incomingIds),
    dayNumber: false,
    transferMode: false,
    anchorIdentity: false,
    anchorPlace: false,
    stops: false,
    endTransport: false,
  };
  if (daySet) return result;

  const beforeById = new Map(before.days.map((day) => [day.id, day]));
  for (const day of incoming.days) {
    const previous = beforeById.get(day.id)!;
    if (previous.dayNumber !== day.dayNumber) result.dayNumber = true;
    if (previous.transferMode !== day.transferMode) result.transferMode = true;
    if (previous.startAnchor.id !== day.startAnchor.id || previous.endAnchor.id !== day.endAnchor.id) result.anchorIdentity = true;
    if (previous.startAnchor.placeId !== day.startAnchor.placeId || previous.endAnchor.placeId !== day.endAnchor.placeId) result.anchorPlace = true;
    if (!same(previous.stops.map(canonicalStopProjection), day.stops.map(canonicalStopProjection))) result.stops = true;
    if (!same(previous.endTransportFromPrevious ?? null, day.endTransportFromPrevious ?? null)) result.endTransport = true;
  }
  return result;
}