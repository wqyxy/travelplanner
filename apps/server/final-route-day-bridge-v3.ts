import type { FinalRouteNode, TravelPlanDocument } from "./contracts-v2.js";
import {
  materializeLegacyFinalRouteV3,
  rebuildFinalRouteDaysV3,
  type FinalRouteMutationResultV3,
} from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);

function changedDayIds(before: TravelPlanDocument["days"], after: TravelPlanDocument["days"]) {
  const beforeById = new Map(before.map((day) => [day.id, day]));
  const afterById = new Map(after.map((day) => [day.id, day]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  return [...ids].filter((id) => JSON.stringify(beforeById.get(id) ?? null) !== JSON.stringify(afterById.get(id) ?? null));
}

function activeSegments(nodes: FinalRouteNode[]) {
  const result: FinalRouteNode[][] = [];
  let current: FinalRouteNode[] = [];
  for (const node of nodes) {
    if (node.status !== "normal") continue;
    current.push(clone(node));
    if (node.endsDay) {
      result.push(current);
      current = [];
    }
  }
  if (current.length) result.push(current);
  return result;
}

/** Temporary copy of the legacy inactive-node anchoring rule. */
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
      if (beforeNodes[previous].status !== "normal" || !desiredIds.has(beforeNodes[previous].id)) continue;
      previousActiveId = beforeNodes[previous].id;
      break;
    }
    let nextActiveId: string | null = null;
    for (let next = index + 1; next < beforeNodes.length; next += 1) {
      if (beforeNodes[next].status !== "normal" || !desiredIds.has(beforeNodes[next].id)) continue;
      nextActiveId = beforeNodes[next].id;
      break;
    }
    if (nextActiveId) {
      const bucket = beforeBuckets.get(nextActiveId) ?? [];
      bucket.push(clone(node));
      beforeBuckets.set(nextActiveId, bucket);
    } else if (previousActiveId) {
      const bucket = afterBuckets.get(previousActiveId) ?? [];
      bucket.push(clone(node));
      afterBuckets.set(previousActiveId, bucket);
    } else tail.push(clone(node));
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

/**
 * Move one derived Day by moving its entire canonical active route segment.
 * The Day ID is the segment's final node ID. Segment boundary flags are
 * normalized after the move so only non-final segments end a Day explicitly.
 */
export function moveDerivedDayViaFinalRouteV3(
  planValue: TravelPlanDocument,
  dayId: string,
  targetIndex: number,
): FinalRouteMutationResultV3 | null {
  const plan = materializeLegacyFinalRouteV3(planValue);
  const beforeDays = clone(plan.days);
  const segments = activeSegments(plan.finalRoute.nodes);
  const sourceIndex = segments.findIndex((segment) => segment.at(-1)?.id === dayId);
  if (sourceIndex < 0) return null;

  const [moved] = segments.splice(sourceIndex, 1);
  if (targetIndex < 0 || targetIndex > segments.length) throw new Error("Day 目标位置超出范围。");
  segments.splice(targetIndex, 0, moved);
  segments.forEach((segment, index) => {
    segment.forEach((node, nodeIndex) => { node.endsDay = nodeIndex === segment.length - 1 && index < segments.length - 1; });
  });

  const desiredActive = segments.flat();
  const next = rebuildFinalRouteDaysV3({
    ...clone(plan),
    finalRoute: { version: 1, nodes: mergeInactiveNodes(plan.finalRoute.nodes, desiredActive) },
  });
  return { plan: next, affectedDayIds: changedDayIds(beforeDays, next.days) };
}
