import { TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import {
  hasIndependentDerivedRouteWriteV3,
  inspectDerivedDayWriteV3,
} from "./derived-day-integrity-v3.js";
import {
  rebuildFinalRouteDaysV3,
  syncFinalRouteForLegacyWriteV3,
} from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function restoreExplicitDayMetadataV3(
  before: TravelPlanDocument,
  incoming: TravelPlanDocument,
  derived: TravelPlanDocument,
) {
  const beforeById = new Map(before.days.map((day) => [day.id, day]));
  const incomingById = new Map(incoming.days.map((day) => [day.id, day]));
  return TravelPlanDocumentSchema.parse({
    ...derived,
    days: derived.days.map((day) => {
      const previous = beforeById.get(day.id);
      const requested = incomingById.get(day.id);
      if (!requested) return day;
      return {
        ...day,
        ...(!previous || requested.title !== previous.title ? { title: requested.title } : {}),
        ...(!previous || requested.date !== previous.date ? { date: requested.date } : {}),
      };
    }),
  });
}

/**
 * Normalize an incoming V3 plan at the persistence boundary.
 *
 * Canonical rules:
 * - finalRoute changes are authoritative and Days are re-derived forward;
 * - Day-only metadata is allowed; explicit title/date edits are restored after
 *   route derivation without turning Day back into a second route model;
 * - a stale Day view caused by other canonical data changes is replaced by the
 *   newly derived Day view rather than rejected;
 * - independent Day route/node writes are rejected once finalRoute exists;
 * - legacy Day-only plans keep the temporary reverse bridge until old fixtures/
 *   bootstrap callers are retired.
 */
export function canonicalizePlanWriteV3(
  beforeValue: TravelPlanDocument,
  incomingValue: TravelPlanDocument,
): TravelPlanDocument {
  const before = TravelPlanDocumentSchema.parse(clone(beforeValue));
  const incoming = TravelPlanDocumentSchema.parse(clone(incomingValue));

  if (!same(before.finalRoute, incoming.finalRoute)) {
    return restoreExplicitDayMetadataV3(before, incoming, rebuildFinalRouteDaysV3(incoming));
  }

  if (before.finalRoute.nodes.length || incoming.finalRoute.nodes.length) {
    const inspection = inspectDerivedDayWriteV3(incoming);
    if (!inspection.matchesCanonicalDays && hasIndependentDerivedRouteWriteV3(before, incoming)) {
      throw new Error("DERIVED_DAY_ROUTE_WRITE_REJECTED");
    }
    return restoreExplicitDayMetadataV3(before, incoming, inspection.plan);
  }

  return syncFinalRouteForLegacyWriteV3(before, incoming);
}