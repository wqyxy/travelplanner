import { TravelPlanDocumentSchema, type FinalRouteNode, type TravelPlanDocument } from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function dayContentWithoutNumber(day: TravelPlanDocument["days"][number]) {
  const { dayNumber: _dayNumber, ...rest } = day;
  return rest;
}

function activeSegments(nodes: FinalRouteNode[]) {
  const segments: Array<{ nodes: FinalRouteNode[]; originalEndFlag: boolean }> = [];
  let current: FinalRouteNode[] = [];
  for (const node of nodes) {
    if (node.status !== "normal") continue;
    current.push(clone(node));
    if (node.endsDay) {
      segments.push({ nodes: current, originalEndFlag: node.endsDay });
      current = [];
    }
  }
  if (current.length) {
    const end = current.at(-1)!;
    segments.push({ nodes: current, originalEndFlag: end.endsDay });
  }
  return segments;
}

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

/**
 * Canonicalize a pure legacy Day reorder by reordering whole active finalRoute
 * segments. The final segment keeps its boundary's original `endsDay` value,
 * matching `rebuildFinalRouteFromDayViewV3`; earlier segments end explicitly.
 *
 * Returns null when the incoming write changes anything besides Day order and
 * the corresponding dayNumber renumbering.
 */
export function tryApplyLegacyDayReorderV3(
  beforeValue: TravelPlanDocument,
  incomingValue: TravelPlanDocument,
): TravelPlanDocument | null {
  const before = TravelPlanDocumentSchema.parse(clone(beforeValue));
  const incoming = TravelPlanDocumentSchema.parse(clone(incomingValue));
  if (before.days.length !== incoming.days.length || !before.days.length) return null;

  const beforeById = new Map(before.days.map((day) => [day.id, day]));
  const incomingIds = incoming.days.map((day) => day.id);
  if (new Set(incomingIds).size !== incomingIds.length || incomingIds.some((id) => !beforeById.has(id))) return null;
  if (same(before.days.map((day) => day.id), incomingIds)) return null;

  for (let index = 0; index < incoming.days.length; index += 1) {
    const requested = incoming.days[index];
    const previous = beforeById.get(requested.id)!;
    if (!same(dayContentWithoutNumber(previous), dayContentWithoutNumber(requested))) return null;
    if (requested.dayNumber !== index + 1) return null;
  }

  const segments = activeSegments(incoming.finalRoute.nodes);
  const segmentByDayId = new Map(segments.map((segment) => [segment.nodes.at(-1)!.id, segment]));
  if (segmentByDayId.size !== incoming.days.length) return null;
  const ordered = incomingIds.map((id) => segmentByDayId.get(id));
  if (ordered.some((segment) => !segment)) return null;

  ordered.forEach((segment, segmentIndex) => {
    const nodes = segment!.nodes;
    nodes.forEach((node, nodeIndex) => {
      node.endsDay = nodeIndex === nodes.length - 1
        ? (segmentIndex < ordered.length - 1 ? true : segment!.originalEndFlag)
        : false;
    });
  });

  const desiredActive = ordered.flatMap((segment) => segment!.nodes);
  return rebuildFinalRouteDaysV3({
    ...clone(incoming),
    finalRoute: {
      version: 1,
      nodes: mergeInactiveNodes(incoming.finalRoute.nodes, desiredActive),
    },
  });
}