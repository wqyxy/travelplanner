import { createHash } from "node:crypto";
import {
  TravelPlanDocumentSchema,
  type Day,
  type FinalRouteNode,
  type Transport,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);

function stableNodeId(prefix: string, source: string) {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

function transportFromMode(mode: Day["transferMode"]): Transport | null {
  if (mode === "none") return null;
  return {
    mode,
    durationMinutes: null,
    note: null,
    verification: { status: "unverified", checkedAt: null },
  };
}

function boundaryTransport(day: Day): Transport | null {
  if (day.endTransportFromPrevious !== undefined) return clone(day.endTransportFromPrevious);
  if (day.transferMode === "none") return null;
  return transportFromMode(day.transferMode);
}

function boundaryNode(day: Day, index: number, total: number): FinalRouteNode {
  const placeId = day.endAnchor.placeId;
  if (!placeId) throw new Error(`INITIAL_SKELETON_UNREPRESENTABLE: Day ${day.id} 缺少结束地点。`);
  if (day.stops.length) throw new Error(`INITIAL_SKELETON_UNREPRESENTABLE: Day ${day.id} 不应包含详细 Stop。`);
  return {
    id: day.id,
    placeId,
    status: "normal",
    endsDay: index < total - 1,
    transportFromPrevious: boundaryTransport(day),
    activity: null,
    period: null,
    scheduleText: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    scheduleVerification: null,
    costNote: null,
    costVerification: null,
    notes: null,
  };
}

function emptyNode(input: Pick<FinalRouteNode, "id" | "placeId" | "status" | "endsDay">): FinalRouteNode {
  return {
    id: input.id,
    placeId: input.placeId,
    status: input.status,
    endsDay: input.endsDay,
    transportFromPrevious: null,
    activity: null,
    period: null,
    scheduleText: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    scheduleVerification: null,
    costNote: null,
    costVerification: null,
    notes: null,
  };
}

function stopHasExplicitDetail(stop: Day["stops"][number]) {
  return Boolean(
    stop.period
      || stop.scheduleText
      || stop.startTime
      || stop.endTime
      || stop.scheduleVerification
      || stop.costNote
      || stop.costVerification
      || stop.notes,
  );
}

function routeNodeFromDayStop(day: Day, stop: Day["stops"][number]): FinalRouteNode {
  const detailed = day.detailLevel === "detailed" || stopHasExplicitDetail(stop);
  return {
    id: stop.id,
    placeId: stop.placeId,
    status: "normal",
    endsDay: false,
    transportFromPrevious: clone(stop.transportFromPrevious),
    activity: detailed ? stop.activity : null,
    period: detailed ? stop.period : null,
    scheduleText: detailed ? stop.scheduleText ?? null : null,
    startTime: detailed ? stop.startTime : null,
    endTime: detailed ? stop.endTime : null,
    durationMinutes: detailed ? stop.durationMinutes : null,
    scheduleVerification: detailed ? clone(stop.scheduleVerification) : null,
    costNote: detailed ? stop.costNote : null,
    costVerification: detailed ? clone(stop.costVerification) : null,
    notes: detailed ? stop.notes : null,
  };
}

function dayStartPlaceId(day: Day) {
  return day.startAnchor.placeId ?? day.stops[0]?.placeId ?? day.endAnchor.placeId ?? null;
}

function dayEndPlaceId(day: Day) {
  return day.endAnchor.placeId ?? day.stops.at(-1)?.placeId ?? day.startAnchor.placeId ?? null;
}

function normalizeSkeletonDaysForLinearRoute(before: TravelPlanDocument, desired: TravelPlanDocument) {
  const days = clone(desired.days);
  const beforeById = new Map(before.days.map((day) => [day.id, day]));
  let originPlaceId = desired.trip.originPlaceId;

  const first = days[0];
  const previousFirst = first ? beforeById.get(first.id) : null;
  if (first && previousFirst && first.startAnchor.placeId !== previousFirst.startAnchor.placeId) {
    originPlaceId = first.startAnchor.placeId;
  }

  for (let index = 0; index < days.length - 1; index += 1) {
    const current = days[index];
    const next = days[index + 1];
    const currentEndPlaceId = dayEndPlaceId(current);
    const nextStartPlaceId = dayStartPlaceId(next);
    if (currentEndPlaceId === nextStartPlaceId) continue;

    const previousCurrent = beforeById.get(current.id);
    const previousNext = beforeById.get(next.id);
    const endChanged = Boolean(previousCurrent && current.endAnchor.placeId !== previousCurrent.endAnchor.placeId);
    const startChanged = Boolean(previousNext && next.startAnchor.placeId !== previousNext.startAnchor.placeId);

    if (startChanged && !endChanged) current.endAnchor.placeId = nextStartPlaceId;
    else next.startAnchor.placeId = currentEndPlaceId;
  }

  return { days, originPlaceId };
}

/** Preserve tentative/no_go nodes with the same anchoring semantics as the old bridge. */
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
    merged.push(node);
    merged.push(...(afterBuckets.get(node.id) ?? []));
  }
  merged.push(...tail);
  return merged;
}

/**
 * First skeleton generation has no previous route to reconcile. Each generated
 * Day is represented by one independent canonical boundary node, including
 * repeated stays at the same Place. The supplied Day view is used only as
 * source metadata (stayBlockId/date/detail state) while `rebuildFinalRouteDaysV3`
 * immediately re-derives the saved Day view from finalRoute.
 */
export function applyInitialSkeletonToFinalRouteV3(
  planValue: TravelPlanDocument,
  desiredDays: Day[],
): TravelPlanDocument {
  const plan = TravelPlanDocumentSchema.parse(clone(planValue));
  if (plan.days.length || plan.finalRoute.nodes.length) {
    throw new Error("INITIAL_SKELETON_REQUIRES_EMPTY_ROUTE");
  }
  const nodes = desiredDays.map((day, index) => boundaryNode(day, index, desiredDays.length));
  const base = TravelPlanDocumentSchema.parse({
    ...plan,
    days: clone(desiredDays),
    finalRoute: { version: 1, nodes },
  });
  return rebuildFinalRouteDaysV3(base);
}

/**
 * Canonical skeleton-replan adapter.
 *
 * Skeleton planning still uses Day-shaped transient data to match/reuse stable
 * Stay Block and Day identities, but this function converts that transient
 * result into finalRoute explicitly before Store. It intentionally preserves
 * the previous bridge's mapping semantics while removing Skeleton replan from
 * the generic legacy Day-write fallback.
 */
export function applySkeletonReplanToFinalRouteV3(
  beforeValue: TravelPlanDocument,
  desiredPlanValue: TravelPlanDocument,
): TravelPlanDocument {
  const before = TravelPlanDocumentSchema.parse(clone(beforeValue));
  const desired = TravelPlanDocumentSchema.parse(clone(desiredPlanValue));
  if (!before.days.length || !before.finalRoute.nodes.length) return desired;

  const normalized = normalizeSkeletonDaysForLinearRoute(before, desired);
  const existingById = new Map(before.finalRoute.nodes.map((node) => [node.id, node]));
  const representedBeforeIds = new Set(before.days.flatMap((day) => [day.id, ...day.stops.map((stop) => stop.id)]));
  const desiredIds = new Set(normalized.days.flatMap((day) => [day.id, ...day.stops.map((stop) => stop.id)]));
  const desiredActive: FinalRouteNode[] = [];

  const firstDay = normalized.days[0];
  if (firstDay?.startAnchor.placeId && firstDay.startAnchor.placeId !== normalized.originPlaceId) {
    const existingStart = before.finalRoute.nodes.find((node) => node.status === "normal"
      && !representedBeforeIds.has(node.id)
      && node.placeId === firstDay.startAnchor.placeId) ?? null;
    let startId = existingStart?.id ?? firstDay.startAnchor.id;
    if (desiredIds.has(startId)) startId = stableNodeId("route-origin", firstDay.id);
    const startNode = existingStart ? clone(existingStart) : emptyNode({
      id: startId,
      placeId: firstDay.startAnchor.placeId,
      status: "normal",
      endsDay: false,
    });
    startNode.id = startId;
    startNode.placeId = firstDay.startAnchor.placeId;
    startNode.status = "normal";
    startNode.endsDay = false;
    desiredActive.push(startNode);
  }

  normalized.days.forEach((day, index) => {
    day.stops.forEach((stop, stopIndex) => {
      const node = routeNodeFromDayStop(day, stop);
      if (stopIndex === 0 && !node.transportFromPrevious && day.transferMode !== "none") {
        node.transportFromPrevious = transportFromMode(day.transferMode);
      }
      desiredActive.push(node);
    });

    const endPlaceId = dayEndPlaceId(day);
    if (!endPlaceId) throw new Error(`FINAL_ROUTE_DAY_VIEW_UNREPRESENTABLE: Day ${day.id} 没有可用于最终线路的地点。`);
    const existing = existingById.get(day.id);
    if (existing && existing.status !== "normal") {
      throw new Error(`FINAL_ROUTE_DAY_VIEW_CONFLICT: Day ${day.id} 对应的最终线路节点当前不是 normal。`);
    }

    const endNode = existing ? clone(existing) : emptyNode({
      id: day.id,
      placeId: endPlaceId,
      status: "normal",
      endsDay: false,
    });
    endNode.placeId = endPlaceId;
    endNode.status = "normal";
    endNode.endsDay = index < normalized.days.length - 1 ? true : (existing?.endsDay ?? false);
    endNode.transportFromPrevious = day.endTransportFromPrevious !== undefined
      ? clone(day.endTransportFromPrevious)
      : day.stops.length === 0
        ? transportFromMode(day.transferMode)
        : clone(existing?.transportFromPrevious ?? null);
    desiredActive.push(endNode);
  });

  const base = TravelPlanDocumentSchema.parse({
    ...clone(desired),
    trip: { ...clone(desired.trip), originPlaceId: normalized.originPlaceId },
    finalRoute: {
      version: 1,
      nodes: mergeInactiveNodes(before.finalRoute.nodes, desiredActive),
    },
  });
  return rebuildFinalRouteDaysV3(base);
}
