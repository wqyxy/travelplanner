import { createHash, randomUUID } from "node:crypto";
import {
  TravelPlanDocumentSchema,
  type Day,
  type FinalRouteNode,
  type FinalRouteNodeStatus,
  type Transport,
  type TravelPlanDocument,
} from "./contracts-v2.js";

export type FinalRouteMutationResultV3 = {
  plan: TravelPlanDocument;
  affectedDayIds: string[];
};

const clone = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function stableNodeId(prefix: string, source: string) {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

function dateAt(plan: TravelPlanDocument, index: number) {
  return plan.trip.dates.start
    ? new Date(Date.parse(`${plan.trip.dates.start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10)
    : null;
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

function emptyNode(input: Pick<FinalRouteNode, "id" | "placeId" | "status" | "endsDay"> & Partial<Pick<FinalRouteNode, "transportFromPrevious">>): FinalRouteNode {
  return {
    id: input.id,
    placeId: input.placeId,
    status: input.status,
    endsDay: input.endsDay,
    transportFromPrevious: input.transportFromPrevious ?? null,
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

function currentFinalRoutePlanV3(planValue: TravelPlanDocument): TravelPlanDocument {
  const plan = TravelPlanDocumentSchema.parse(clone(planValue));
  if (plan.finalRoute.version === 1) return plan;

  const isEmptyBootstrap = plan.finalRoute.nodes.length === 0
    && plan.places.length === 0
    && plan.candidates.length === 0
    && plan.days.length === 0;
  if (!isEmptyBootstrap) {
    throw new Error("OLD_TEST_PLAN_UNSUPPORTED: 当前测试数据不再迁移，请清空旧旅行后重新开始。");
  }

  return TravelPlanDocumentSchema.parse({
    ...plan,
    finalRoute: { version: 1, nodes: [] },
  });
}

export function materializeLegacyFinalRouteV3(plan: TravelPlanDocument): TravelPlanDocument {
  // Existing Store read call site is retained temporarily. Persisted old route data is never converted.
  return currentFinalRoutePlanV3(plan);
}

export function activeFinalRouteNodesV3(plan: TravelPlanDocument) {
  return currentFinalRoutePlanV3(plan).finalRoute.nodes.filter((node) => node.status === "normal");
}

function placeName(plan: TravelPlanDocument, placeId: string | null) {
  if (!placeId) return "未设置地点";
  return plan.places.find((place) => place.id === placeId)?.nameZh ?? "未命名地点";
}

function candidateIdForPlace(plan: TravelPlanDocument, placeId: string) {
  return plan.candidates.find((candidate) => candidate.placeId === placeId)?.id ?? null;
}

function dayStopFromNode(plan: TravelPlanDocument, node: FinalRouteNode): Day["stops"][number] {
  return {
    id: node.id,
    candidateId: candidateIdForPlace(plan, node.placeId),
    placeId: node.placeId,
    activity: node.activity?.trim() || placeName(plan, node.placeId),
    period: node.period,
    scheduleText: node.scheduleText,
    startTime: node.startTime,
    endTime: node.endTime,
    durationMinutes: node.durationMinutes,
    transportFromPrevious: clone(node.transportFromPrevious),
    scheduleVerification: clone(node.scheduleVerification),
    costNote: node.costNote,
    costVerification: clone(node.costVerification),
    notes: node.notes,
  };
}

function routeNodeFromDayStop(stop: Day["stops"][number]): FinalRouteNode {
  return {
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
}

function dayHasDetails(nodes: FinalRouteNode[]) {
  return nodes.some((node) => Boolean(
    node.activity
      || node.period
      || node.scheduleText
      || node.startTime
      || node.endTime
      || node.durationMinutes !== null
      || node.scheduleVerification
      || node.costNote
      || node.costVerification
      || node.notes,
  ));
}

export function deriveFinalRouteDaysV3(planValue: TravelPlanDocument): Day[] {
  const plan = currentFinalRoutePlanV3(planValue);
  const active = plan.finalRoute.nodes.filter((node) => node.status === "normal");
  if (!active.length) return [];

  const segments: FinalRouteNode[][] = [];
  let current: FinalRouteNode[] = [];
  for (const node of active) {
    current.push(node);
    if (node.endsDay) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);

  const result: Day[] = [];
  let previousBoundaryPlaceId = plan.trip.originPlaceId;

  segments.forEach((segment, index) => {
    const endNode = segment.at(-1)!;
    const startPlaceId = previousBoundaryPlaceId ?? segment[0]?.placeId ?? null;
    const endPlaceId = endNode.placeId;
    let stopNodes = segment.slice(0, -1);

    if (index === 0 && stopNodes.length && stopNodes[0].placeId === startPlaceId && !stopNodes[0].endsDay) {
      stopNodes = stopNodes.slice(1);
    }

    const detailNodes = [...stopNodes, endNode];
    const detailed = dayHasDetails(detailNodes);
    const transferMode = segment[0]?.transportFromPrevious?.mode ?? "none";
    const dayId = endNode.id;

    result.push({
      id: dayId,
      dayNumber: index + 1,
      date: dateAt(plan, index),
      title: startPlaceId && startPlaceId !== endPlaceId ? `前往${placeName(plan, endPlaceId)}` : placeName(plan, endPlaceId),
      transferMode,
      endTransportFromPrevious: clone(endNode.transportFromPrevious),
      detailLevel: detailed ? "detailed" : "planned",
      detailStatus: detailed ? "ready" : null,
      startAnchor: {
        id: stableNodeId("route-start", dayId),
        placeId: startPlaceId,
        label: null,
        notes: null,
      },
      stops: stopNodes.map((node) => dayStopFromNode(plan, node)),
      endAnchor: {
        id: stableNodeId("route-end", dayId),
        placeId: endPlaceId,
        label: null,
        notes: null,
      },
    });
    previousBoundaryPlaceId = endPlaceId;
  });

  return result;
}

export function rebuildFinalRouteDaysV3(plan: TravelPlanDocument): TravelPlanDocument {
  const base = currentFinalRoutePlanV3(plan);
  return TravelPlanDocumentSchema.parse({
    ...base,
    days: deriveFinalRouteDaysV3(base),
  });
}

function mergeInactiveNodesV3(beforeNodes: FinalRouteNode[], desiredActive: FinalRouteNode[]) {
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
      if (desiredIds.has(beforeNodes[previous].id)) previousActiveId = beforeNodes[previous].id;
      break;
    }

    let nextActiveId: string | null = null;
    for (let next = index + 1; next < beforeNodes.length; next += 1) {
      if (beforeNodes[next].status !== "normal") continue;
      if (desiredIds.has(beforeNodes[next].id)) nextActiveId = beforeNodes[next].id;
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
    merged.push(node);
    merged.push(...(afterBuckets.get(node.id) ?? []));
  }
  merged.push(...tail);
  return merged;
}

function normalizedDayViewForLinearRouteV3(before: TravelPlanDocument, after: TravelPlanDocument) {
  const days = clone(after.days);
  const beforeById = new Map(before.days.map((day) => [day.id, day]));
  let originPlaceId = after.trip.originPlaceId;

  const first = days[0];
  const previousFirst = first ? beforeById.get(first.id) : null;
  if (first && previousFirst && first.startAnchor.placeId !== previousFirst.startAnchor.placeId) {
    originPlaceId = first.startAnchor.placeId;
  }

  for (let index = 0; index < days.length - 1; index += 1) {
    const current = days[index];
    const next = days[index + 1];
    if (current.endAnchor.placeId === next.startAnchor.placeId) continue;

    const previousCurrent = beforeById.get(current.id);
    const previousNext = beforeById.get(next.id);
    const endChanged = Boolean(previousCurrent && current.endAnchor.placeId !== previousCurrent.endAnchor.placeId);
    const startChanged = Boolean(previousNext && next.startAnchor.placeId !== previousNext.startAnchor.placeId);

    if (startChanged && !endChanged) current.endAnchor.placeId = next.startAnchor.placeId;
    else next.startAnchor.placeId = current.endAnchor.placeId;
  }

  return { days, originPlaceId };
}

function rebuildFinalRouteFromDayViewV3(before: TravelPlanDocument, after: TravelPlanDocument) {
  const normalized = normalizedDayViewForLinearRouteV3(before, after);
  const existingById = new Map(before.finalRoute.nodes.map((node) => [node.id, node]));
  const desiredActive: FinalRouteNode[] = [];

  normalized.days.forEach((day, index) => {
    for (const stop of day.stops) desiredActive.push(routeNodeFromDayStop(stop));

    const endPlaceId = day.endAnchor.placeId;
    if (!endPlaceId) throw new Error(`FINAL_ROUTE_DAY_VIEW_UNREPRESENTABLE: Day ${day.id} 缺少终点地点。`);
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

  const finalRoute = {
    version: 1 as const,
    nodes: mergeInactiveNodesV3(before.finalRoute.nodes, desiredActive),
  };
  const base = TravelPlanDocumentSchema.parse({
    ...clone(after),
    trip: { ...clone(after.trip), originPlaceId: normalized.originPlaceId },
    finalRoute,
  });
  return rebuildFinalRouteDaysV3(base);
}

export function syncFinalRouteForLegacyWriteV3(beforeValue: TravelPlanDocument, afterValue: TravelPlanDocument): TravelPlanDocument {
  // Transitional write bridge only. Persisted old plans are still rejected by currentFinalRoutePlanV3.
  // While Phase 2/3 removes the old Day/Skeleton entry points, an in-memory caller that edits the Day view
  // is translated into final-route nodes before persistence, so days[] never becomes a second saved route.
  const before = currentFinalRoutePlanV3(beforeValue);
  const parsedAfter = TravelPlanDocumentSchema.parse(clone(afterValue));
  const after = parsedAfter.finalRoute.version === 1
    ? parsedAfter
    : TravelPlanDocumentSchema.parse({ ...parsedAfter, finalRoute: clone(before.finalRoute) });

  const finalRouteChanged = !same(before.finalRoute, after.finalRoute);
  const dayViewChanged = !same(before.days, after.days);
  if (!finalRouteChanged && dayViewChanged) return rebuildFinalRouteFromDayViewV3(before, after);
  return rebuildFinalRouteDaysV3(after);
}

function changedDayIds(before: Day[], after: Day[]) {
  const beforeById = new Map(before.map((day) => [day.id, day]));
  const afterById = new Map(after.map((day) => [day.id, day]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  return [...ids].filter((id) => JSON.stringify(beforeById.get(id) ?? null) !== JSON.stringify(afterById.get(id) ?? null));
}

function applyMutation(
  planValue: TravelPlanDocument,
  mutate: (nodes: FinalRouteNode[]) => void,
): FinalRouteMutationResultV3 {
  const plan = currentFinalRoutePlanV3(planValue);
  const beforeDays = clone(plan.days);
  const nodes = clone(plan.finalRoute.nodes);
  mutate(nodes);
  const nextBase = TravelPlanDocumentSchema.parse({
    ...clone(plan),
    finalRoute: { version: 1, nodes },
  });
  const next = rebuildFinalRouteDaysV3(nextBase);
  return { plan: next, affectedDayIds: changedDayIds(beforeDays, next.days) };
}

function requireNode(nodes: FinalRouteNode[], nodeId: string) {
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) throw new Error(`未知最终线路节点：${nodeId}`);
  return { node: nodes[index], index };
}

export function setFinalRouteNodeStatusV3(
  plan: TravelPlanDocument,
  nodeId: string,
  status: FinalRouteNodeStatus,
): FinalRouteMutationResultV3 {
  return applyMutation(plan, (nodes) => {
    requireNode(nodes, nodeId).node.status = status;
  });
}

export function setFinalRouteDayBoundaryV3(
  plan: TravelPlanDocument,
  nodeId: string,
  endsDay: boolean,
): FinalRouteMutationResultV3 {
  return applyMutation(plan, (nodes) => {
    const { node } = requireNode(nodes, nodeId);
    if (node.status !== "normal" && endsDay) throw new Error("只有正常地点可以新增当前生效的日程分界。");
    node.endsDay = endsDay;
  });
}

export function updateFinalRouteTransportV3(
  plan: TravelPlanDocument,
  nodeId: string,
  transportFromPrevious: Transport | null,
): FinalRouteMutationResultV3 {
  return applyMutation(plan, (nodes) => {
    requireNode(nodes, nodeId).node.transportFromPrevious = clone(transportFromPrevious);
  });
}

export function moveFinalRouteNodeV3(
  plan: TravelPlanDocument,
  nodeId: string,
  targetIndex: number,
): FinalRouteMutationResultV3 {
  return applyMutation(plan, (nodes) => {
    const { index } = requireNode(nodes, nodeId);
    if (targetIndex < 0 || targetIndex >= nodes.length) throw new Error("最终线路目标位置超出范围。");
    const [node] = nodes.splice(index, 1);
    nodes.splice(targetIndex, 0, node);
  });
}

export function removeFinalRouteNodeV3(plan: TravelPlanDocument, nodeId: string): FinalRouteMutationResultV3 {
  return applyMutation(plan, (nodes) => {
    const { index } = requireNode(nodes, nodeId);
    nodes.splice(index, 1);
  });
}

export function insertFinalRouteNodeV3(
  plan: TravelPlanDocument,
  index: number,
  node: FinalRouteNode,
): FinalRouteMutationResultV3 {
  return applyMutation(plan, (nodes) => {
    if (index < 0 || index > nodes.length) throw new Error("最终线路插入位置超出范围。");
    if (nodes.some((item) => item.id === node.id)) throw new Error(`最终线路节点 ID 重复：${node.id}`);
    if (!plan.places.some((place) => place.id === node.placeId)) throw new Error(`最终线路引用未知 Place：${node.placeId}`);
    nodes.splice(index, 0, clone(node));
  });
}

export function addNightAfterFinalRouteNodeV3(
  plan: TravelPlanDocument,
  nodeId: string,
  newNodeId: string = randomUUID(),
): FinalRouteMutationResultV3 {
  return applyMutation(plan, (nodes) => {
    const { node, index } = requireNode(nodes, nodeId);
    if (node.status !== "normal") throw new Error("只有正常地点可以多住一晚。");
    if (!node.endsDay) throw new Error("请先把当前地点设为住宿 / 日程结束点，再多住一晚。");
    if (nodes.some((item) => item.id === newNodeId)) throw new Error(`最终线路节点 ID 重复：${newNodeId}`);
    nodes.splice(index + 1, 0, emptyNode({
      id: newNodeId,
      placeId: node.placeId,
      status: "normal",
      endsDay: true,
      transportFromPrevious: null,
    }));
  });
}
