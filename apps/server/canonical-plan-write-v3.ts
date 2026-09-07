import { TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import {
  classifyIndependentDerivedRouteWriteV3,
  hasIndependentDerivedRouteWriteV3,
  inspectDerivedDayWriteV3,
} from "./derived-day-integrity-v3.js";
import { tryApplyLegacyDayAnchorPlacesV3 } from "./final-route-day-anchor-v3.js";
import { tryApplyLegacyDayReorderV3 } from "./final-route-day-reorder-v3.js";
import { tryApplyLegacyDayTransferModesV3 } from "./final-route-day-transfer-v3.js";
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

function canUseKnownLegacyDayFallback(before: TravelPlanDocument, incoming: TravelPlanDocument) {
  const kinds = classifyIndependentDerivedRouteWriteV3(before, incoming);
  if (kinds.daySet || kinds.anchorIdentity || kinds.stops || kinds.endTransport) return false;
  return kinds.dayOrder || kinds.transferMode || kinds.anchorPlace;
}

/**
 * Normalize an incoming V3 plan at the TravelStoreV3 persistence boundary.
 *
 * Canonical rules:
 * - finalRoute changes are authoritative and Days are re-derived forward;
 * - stale Day views caused by other canonical data changes are overwritten by
 *   the newly derived Day view;
 * - a legacy Day-only transferMode edit maps directly to the first canonical
 *   route node of that Day segment;
 * - nullable Day start/end Place edits map directly to trip origin or canonical
 *   boundary nodes using the same fallback Place semantics as the legacy bridge;
 * - a pure legacy Day reorder moves whole canonical route segments directly;
 * - only known registered mixed legacy Day shapes (order/dayNumber,
 *   transferMode, anchor Place) may still use the compatibility translator;
 *   Stop/node/endTransport/Day-ID writes are rejected;
 * - Day-only metadata remains allowed; explicit title/date edits are persisted
 *   as metadata without becoming a second route model;
 * - Day-only legacy/bootstrap callers keep the compatibility path until those
 *   fixtures/callers are retired.
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
      const transferOnly = tryApplyLegacyDayTransferModesV3(before, incoming);
      if (transferOnly) return restoreExplicitDayMetadataV3(before, incoming, transferOnly);
      const anchorOnly = tryApplyLegacyDayAnchorPlacesV3(before, incoming);
      if (anchorOnly) return restoreExplicitDayMetadataV3(before, incoming, anchorOnly);
      const reorderOnly = tryApplyLegacyDayReorderV3(before, incoming);
      if (reorderOnly) return restoreExplicitDayMetadataV3(before, incoming, reorderOnly);
      if (!canUseKnownLegacyDayFallback(before, incoming)) throw new Error("DERIVED_DAY_ROUTE_WRITE_UNSUPPORTED");
      return syncFinalRouteForLegacyWriteV3(before, incoming);
    }
    return restoreExplicitDayMetadataV3(before, incoming, inspection.plan);
  }

  return syncFinalRouteForLegacyWriteV3(before, incoming);
}