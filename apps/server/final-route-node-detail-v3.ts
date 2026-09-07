import type { FinalRouteNode, TravelPlanDocument } from "./contracts-v2.js";
import {
  materializeLegacyFinalRouteV3,
  rebuildFinalRouteDaysV3,
  type FinalRouteMutationResultV3,
} from "./final-route-v3.js";

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
] as const satisfies readonly (keyof FinalRouteNode)[];

type DetailField = (typeof DETAIL_FIELDS)[number];

export type FinalRouteNodeDetailChangesV3 = Partial<Pick<FinalRouteNode, DetailField>>;

const clone = <T>(value: T): T => structuredClone(value);

function changedDayIds(before: TravelPlanDocument["days"], after: TravelPlanDocument["days"]) {
  const beforeById = new Map(before.map((day) => [day.id, day]));
  const afterById = new Map(after.map((day) => [day.id, day]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  return [...ids].filter((id) => JSON.stringify(beforeById.get(id) ?? null) !== JSON.stringify(afterById.get(id) ?? null));
}

/**
 * Canonical mutation for itinerary detail that belongs to a finalRoute node.
 *
 * Deliberately excluded here:
 * - placeId / id: node identity
 * - status: separate route-status mutation
 * - endsDay: separate day-boundary mutation
 * - transportFromPrevious: separate user-selected transport mutation
 *
 * Provider route geometry/distance/duration are not FinalRouteNode fields and can
 * never be written through this helper.
 */
export function updateFinalRouteNodeDetailV3(
  planValue: TravelPlanDocument,
  nodeId: string,
  changesValue: FinalRouteNodeDetailChangesV3,
): FinalRouteMutationResultV3 {
  const plan = materializeLegacyFinalRouteV3(planValue);
  const changes = Object.fromEntries(
    DETAIL_FIELDS.flatMap((field) => changesValue[field] === undefined ? [] : [[field, clone(changesValue[field])]]),
  ) as FinalRouteNodeDetailChangesV3;
  if (!Object.keys(changes).length) throw new Error("最终线路节点详细信息没有可更新字段。");

  const beforeDays = clone(plan.days);
  const nodes = clone(plan.finalRoute.nodes);
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`未知最终线路节点：${nodeId}`);
  Object.assign(node, changes);

  const next = rebuildFinalRouteDaysV3({
    ...clone(plan),
    finalRoute: { version: 1, nodes },
  });
  return { plan: next, affectedDayIds: changedDayIds(beforeDays, next.days) };
}
