import type { FinalRouteNode, PlanCommand, TravelPlanDocument } from "./contracts-v2.js";
import {
  materializeLegacyFinalRouteV3,
  rebuildFinalRouteDaysV3,
  removeFinalRouteNodeV3,
  type FinalRouteMutationResultV3,
} from "./final-route-v3.js";

type UpdateDayStopCommandV3 = Extract<PlanCommand, { type: "update_day_stop" }>;
type AddDayStopCommandV3 = Extract<PlanCommand, { type: "add_day_stop" }>;
export type LegacyDayStopChangesV3 = UpdateDayStopCommandV3["changes"];
export type LegacyDayStopV3 = AddDayStopCommandV3["stop"];

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

/** Temporary copy of the legacy bridge's inactive-node anchoring rule. */
function mergeInactiveNodes(beforeNodes: FinalRouteNode[], desiredActive: FinalRouteNode[]) {
  const desiredIds = new Set(desiredActive.map((node) => node.id));
  const beforeBuckets = new Map<string, FinalRouteNode[]>();
  const afterBuckets = new Map<string, FinalRouteNode[]>();
  const tail: FinalRouteNode[] = [];

  for (let index = 0; index < beforeNodes.length; index += 1) {
    const node = beforeNodes[index];
    if (node.status === "normal") continue;

    let previousActiveId: string | null = null;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (beforeNodes[previous].status !== "normal") continue;
      if (desiredIds.has(beforeNodes[previous].id)) {
        previousActiveId = beforeNodes[previous].id;
        break;
      }
    }

    let nextActiveId: string | null = null;
    for (let next = index + 1; next < beforeNodes.length; next += 1) {
      if (beforeNodes[next].status !== "normal") continue;
      if (desiredIds.has(beforeNodes[next].id)) {
        nextActiveId = beforeNodes[next].id;
        break;
      }
    }

    if (nextActiveId) {
      const bucket = beforeBuckets.get(nextActiveId) ?? [];
      bucket.push(clone(node));
      beforeBuckets.set(nextActiveId, bucket);
    } else if (previousActiveId) {
      const bucket = afterBuckets.get(previousActiveId) ?? [];
      bucket.push(clone(node));
      afterBuckets.set(previousActiveId, bucket);
    } else {
      tail.push(clone(node));
    }
  }

  const merged: FinalRouteNode[] = [];
  for (const node of desiredActive) {
    merged.push(...(beforeBuckets.get(node.id) ?? []));
    merged.push(clone(node));
    merged.push(...(afterBuckets.get(node.id) ?? []));
  }
  merged.push(...tail);
  return merged;
}

function rebuildWithActiveOrder(plan: TravelPlanDocument, desiredActive: FinalRouteNode[]) {
  const next = rebuildFinalRouteDaysV3({
    ...clone(plan),
    finalRoute: { version: 1, nodes: mergeInactiveNodes(plan.finalRoute.nodes, desiredActive) },
  });
  return { plan: next, affectedDayIds: changedDayIds(plan.days, next.days) };
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

/**
 * A derived Day stop is represented by the same canonical finalRoute node ID.
 * Removing that stop is therefore losslessly representable as node removal.
 */
export function removeDerivedStopViaFinalRouteV3(
  planValue: TravelPlanDocument,
  stopId: string,
): FinalRouteMutationResultV3 | null {
  const plan = materializeLegacyFinalRouteV3(planValue);
  if (!derivedStopExists(plan, stopId)) return null;
  const node = plan.finalRoute.nodes.find((item) => item.id === stopId);
  if (!node || node.status !== "normal" || node.endsDay) return null;
  return removeFinalRouteNodeV3(plan, stopId);
}

/**
 * Insert a legacy Day stop by inserting an equivalent normal finalRoute node
 * immediately before the target Day stop (or the target Day boundary node).
 */
export function addDerivedStopViaFinalRouteV3(
  planValue: TravelPlanDocument,
  dayId: string,
  index: number,
  stop: LegacyDayStopV3,
): FinalRouteMutationResultV3 | null {
  const plan = materializeLegacyFinalRouteV3(planValue);
  const day = plan.days.find((item) => item.id === dayId);
  if (!day) throw new Error(`未知 Day：${dayId}`);
  if (index < 0 || index > day.stops.length) throw new Error(`Stop 插入位置超出 Day ${day.id} 范围。`);
  if (plan.finalRoute.nodes.some((item) => item.id === stop.id)) throw new Error(`最终线路节点 ID 重复：${stop.id}`);
  if (!plan.places.some((place) => place.id === stop.placeId)) throw new Error(`未知 Place：${stop.placeId}`);

  if (stop.candidateId) {
    const candidate = plan.candidates.find((item) => item.id === stop.candidateId);
    if (!candidate) throw new Error(`未知 Candidate：${stop.candidateId}`);
    if (candidate.placeId !== stop.placeId) throw new Error(`Stop Candidate 与 Place 不一致：${candidate.id}`);
  } else if (plan.candidates.some((candidate) => candidate.placeId === stop.placeId)) {
    // finalRoute would automatically re-attach that Candidate on derivation.
    return null;
  }

  const routeNode: FinalRouteNode = {
    id: stop.id,
    placeId: stop.placeId,
    status: "normal",
    endsDay: false,
    transportFromPrevious: clone(stop.transportFromPrevious),
    activity: stop.activity,
    period: stop.period,
    scheduleText: stop.scheduleText ?? null,
    startTime: stop.startTime,
    endTime: stop.endTime,
    durationMinutes: stop.durationMinutes,
    scheduleVerification: clone(stop.scheduleVerification),
    costNote: stop.costNote,
    costVerification: clone(stop.costVerification),
    notes: stop.notes,
  };

  const anchorId = day.stops[index]?.id ?? day.id;
  const desiredActive = plan.finalRoute.nodes.filter((node) => node.status === "normal").map(clone);
  const anchorIndex = desiredActive.findIndex((node) => node.id === anchorId);
  if (anchorIndex < 0) return null;
  desiredActive.splice(anchorIndex, 0, routeNode);
  return rebuildWithActiveOrder(plan, desiredActive);
}

/**
 * Move a derived Day stop across/within derived Day blocks by reordering only
 * active canonical route nodes. Inactive nodes are reattached with the same
 * anchoring rule as the transitional Day->finalRoute bridge.
 */
export function moveDerivedStopViaFinalRouteV3(
  planValue: TravelPlanDocument,
  stopId: string,
  targetDayId: string,
  targetIndex: number,
): FinalRouteMutationResultV3 | null {
  const plan = materializeLegacyFinalRouteV3(planValue);
  const days = clone(plan.days);
  let sourceDay = null as (typeof days)[number] | null;
  let sourceIndex = -1;
  for (const day of days) {
    const index = day.stops.findIndex((stop) => stop.id === stopId);
    if (index < 0) continue;
    sourceDay = day;
    sourceIndex = index;
    break;
  }
  if (!sourceDay) return null;

  const [movedStop] = sourceDay.stops.splice(sourceIndex, 1);
  const targetDay = days.find((day) => day.id === targetDayId);
  if (!targetDay) throw new Error(`未知 Day：${targetDayId}`);
  if (targetIndex < 0 || targetIndex > targetDay.stops.length) throw new Error(`Stop 目标位置超出 Day ${targetDay.id} 范围。`);
  targetDay.stops.splice(targetIndex, 0, movedStop);

  const desiredActive = plan.finalRoute.nodes.filter((node) => node.status === "normal").map(clone);
  const sourceNodeIndex = desiredActive.findIndex((node) => node.id === stopId);
  if (sourceNodeIndex < 0 || desiredActive[sourceNodeIndex].endsDay) return null;
  const [sourceNode] = desiredActive.splice(sourceNodeIndex, 1);

  const nextSiblingId = targetDay.stops[targetIndex + 1]?.id ?? targetDay.id;
  const anchorIndex = desiredActive.findIndex((node) => node.id === nextSiblingId);
  if (anchorIndex < 0) return null;
  desiredActive.splice(anchorIndex, 0, sourceNode);
  return rebuildWithActiveOrder(plan, desiredActive);
}
