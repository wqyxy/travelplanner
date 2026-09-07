import { TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export type DerivedDayWriteInspectionV3 = {
  plan: TravelPlanDocument;
  matchesCanonicalDays: boolean;
};

/**
 * Re-derive Day from canonical finalRoute while using the incoming Day view only
 * as derivation metadata source. If the result is byte-equivalent to the
 * incoming Day view, the write contains no independent route structure.
 *
 * Metadata that the canonical derivation intentionally preserves (for example
 * detailStatus/stayBlockId and matching anchor labels/notes) remains valid.
 * Stop identity/order/place/detail/transport and Day route structure must round
 * trip through finalRoute or this inspection returns false.
 */
export function inspectDerivedDayWriteV3(planValue: TravelPlanDocument): DerivedDayWriteInspectionV3 {
  const incoming = TravelPlanDocumentSchema.parse(clone(planValue));
  const plan = rebuildFinalRouteDaysV3(incoming);
  return {
    plan,
    matchesCanonicalDays: same(incoming.days, plan.days),
  };
}
