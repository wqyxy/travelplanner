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

function stableNodeId(prefix: string, source: string) {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

function dateAt(plan: TravelPlanDocument, index: number) {
  return plan.trip.dates.start
    ? new Date(Date.parse(`${plan.trip.dates.start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10)
    : null;
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
  // Existing Store call site retained temporarily; old route data is not converted.
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
    planningState: undefined,
  });
}

export function syncFinalRouteForLegacyWriteV3(_before: TravelPlanDocument, after: TravelPlanDocument): TravelPlanDocument {
  // Existing Store call site retained temporarily. Old Candidate / Day data is never converted.
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