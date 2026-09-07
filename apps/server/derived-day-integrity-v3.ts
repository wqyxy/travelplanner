import { TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export type DerivedDayWriteInspectionV3 = {
  plan: TravelPlanDocument;
  matchesCanonicalDays: boolean;
};

function canonicalDayProjection(day: TravelPlanDocument["days"][number]) {
  return {
    id: day.id,
    dayNumber: day.dayNumber,
    transferMode: day.transferMode,
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
 *
 * Those values are metadata/derived relationships, not a second route model.
 */
export function hasIndependentDerivedRouteWriteV3(
  beforeValue: TravelPlanDocument,
  incomingValue: TravelPlanDocument,
) {
  const before = TravelPlanDocumentSchema.parse(clone(beforeValue));
  const incoming = TravelPlanDocumentSchema.parse(clone(incomingValue));
  return !same(canonicalDaysProjection(before), canonicalDaysProjection(incoming));
}
