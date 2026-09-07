import { TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import { inspectDerivedDayWriteV3 } from "./derived-day-integrity-v3.js";
import {
  rebuildFinalRouteDaysV3,
  syncFinalRouteForLegacyWriteV3,
} from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Normalize an incoming V3 plan at the persistence boundary.
 *
 * Canonical rules:
 * - finalRoute changes are authoritative and Days are re-derived forward;
 * - Day-only metadata that round-trips through the unchanged finalRoute is kept;
 * - independent Day route structure is rejected once a canonical finalRoute exists;
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
    return rebuildFinalRouteDaysV3(incoming);
  }

  if (before.finalRoute.nodes.length || incoming.finalRoute.nodes.length) {
    const inspection = inspectDerivedDayWriteV3(incoming);
    if (!inspection.matchesCanonicalDays) {
      throw new Error("DERIVED_DAY_ROUTE_WRITE_REJECTED");
    }
    return inspection.plan;
  }

  return syncFinalRouteForLegacyWriteV3(before, incoming);
}
