import type { PlanCommand, TravelPlanDocument } from "./contracts-v2.js";
import {
  materializeLegacyFinalRouteV3,
  rebuildFinalRouteDaysV3,
  type FinalRouteMutationResultV3,
} from "./final-route-v3.js";

type UpdateDayStopCommandV3 = Extract<PlanCommand, { type: "update_day_stop" }>;
export type LegacyDayStopChangesV3 = UpdateDayStopCommandV3["changes"];

const DETAIL_FIELDS = [
  "activity",
  "period",
  "scheduleText",
  "startTime",
  "endTime",
  "durationMinutes",
  "scheduleVerification",
  "costNote",
  "costVerification",
  "notes",
] as const satisfies readonly (keyof LegacyDayStopChangesV3)[];

const clone = <T>(value: T): T => structuredClone(value);

function changedDayIds(before: TravelPlanDocument["days"], after: TravelPlanDocument["days"]) {
  const beforeById = new Map(before.map((day) => [day.id, day]));
  const afterById = new Map(after.map((day) => [day.id, day]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  return [...ids].filter((id) => JSON.stringify(beforeById.get(id) ?? null) !== JSON.stringify(afterById.get(id) ?? null));
}

function derivedStopExists(plan: TravelPlanDocument, stopId: string) {
  return plan.days.some((day) => day.stops.some((stop) => stop.id === stopId));
}

/**
 * Translate an existing legacy `update_day_stop` mutation into a canonical
 * finalRoute node mutation when the old Day semantics are losslessly
 * representable by finalRoute.
 *
 * Returns null for legacy-only semantics that finalRoute intentionally does not
 * store, so callers can keep a temporary fallback while write paths migrate.
 */
export function updateDerivedStopViaFinalRouteV3(
  planValue: TravelPlanDocument,
  stopId: string,
  changes: LegacyDayStopChangesV3,
): FinalRouteMutationResultV3 | null {
  const plan = materializeLegacyFinalRouteV3(planValue);
  if (!derivedStopExists(plan, stopId)) return null;

  const nodes = clone(plan.finalRoute.nodes);
  const node = nodes.find((item) => item.id === stopId);
  if (!node || node.status !== "normal" || node.endsDay) return null;

  // candidateId is derived from the canonical node Place. A request that only
  // clears/rebinds candidateId without a representable Place identity change
  // has no canonical finalRoute equivalent and must stay on the temporary path.
  if (Object.hasOwn(changes, "candidateId")) {
    if (changes.candidateId === null) return null;
    const candidate = plan.candidates.find((item) => item.id === changes.candidateId);
    if (!candidate) throw new Error(`未知 Candidate：${changes.candidateId}`);
    if (changes.placeId !== undefined && changes.placeId !== candidate.placeId) {
      throw new Error(`Stop Candidate 与 Place 不一致：${candidate.id}`);
    }
    node.placeId = candidate.placeId;
  } else if (changes.placeId !== undefined) {
    // The old Day command implicitly detached candidateId for a place-only edit.
    // finalRoute derives candidateId from Place, so that behavior is not lossless.
    return null;
  }

  for (const field of DETAIL_FIELDS) {
    if (changes[field] !== undefined) (node as any)[field] = clone(changes[field]);
  }
  if (Object.hasOwn(changes, "transportFromPrevious")) {
    node.transportFromPrevious = clone(changes.transportFromPrevious ?? null);
  }

  const next = rebuildFinalRouteDaysV3({
    ...clone(plan),
    finalRoute: { version: 1, nodes },
  });
  return { plan: next, affectedDayIds: changedDayIds(plan.days, next.days) };
}
