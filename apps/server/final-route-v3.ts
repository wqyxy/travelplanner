import { createHash, randomUUID } from "node:crypto";
import {
  TravelPlanDocumentSchema,
  type Day,
  type FinalRouteNode,
  type FinalRouteNodeStatus,
  type Transport,
  type TransportMode,
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

function unverifiedTransport(mode: TransportMode): Transport | null {
  if (mode === "none") return null;
  return {
    mode,
    durationMinutes: null,
    note: null,
    verification: { status: "unverified", checkedAt: null },
  };
}

function legacyStatus(preference: TravelPlanDocument["candidates"][number]["preference"]): FinalRouteNodeStatus {
  if (preference === "optional") return "tentative";
  if (preference === "excluded") return "no_go";
  return "normal";
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

function nodeFromLegacyStop(stop: TravelPlanDocument["days"][number]["stops"][number]): FinalRouteNode {
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

export function deriveLegacyFinalRouteNodesV3(plan: TravelPlanDocument): FinalRouteNode[] {
  if (plan.finalRoute.nodes.length) return clone(plan.finalRoute.nodes);

  if (plan.days.length) {
    const nodes: FinalRouteNode[] = [];
    const firstDay = plan.days[0];
    if (firstDay?.startAnchor.placeId && firstDay.startAnchor.placeId !== plan.trip.originPlaceId) {
      nodes.push(emptyNode({
        id: firstDay.startAnchor.id,
        placeId: firstDay.startAnchor.placeId,
        status: "normal",
        endsDay: false,
      }));
    }

    plan.days.forEach((day, dayIndex) => {
      for (const stop of day.stops) nodes.push(nodeFromLegacyStop(stop));
      if (!day.endAnchor.placeId) return;
      nodes.push(emptyNode({
        id: day.endAnchor.id,
        placeId: day.endAnchor.placeId,
        status: "normal",
        endsDay: dayIndex < plan.days.length - 1,
        transportFromPrevious: day.stops.length ? null : unverifiedTransport(day.transferMode),
      }));
    });
    return nodes;
  }

  return plan.candidates.map((candidate) => emptyNode({
    id: candidate.id,
    placeId: candidate.placeId,
    status: legacyStatus(candidate.preference),
    endsDay: false,
  }));
}

export function ensureFinalRouteV3(plan: TravelPlanDocument): TravelPlanDocument {
  if (plan.finalRoute.nodes.length || (!plan.days.length && !plan.candidates.length)) return clone(plan);
  return TravelPlanDocumentSchema.parse({
    ...clone(plan),
    finalRoute: { nodes: deriveLegacyFinalRouteNodesV3(plan) },
  });
}

export function activeFinalRouteNodesV3(plan: TravelPlanDocument) {
  return ensureFinalRouteV3(plan).finalRoute.nodes.filter((node) => node.status === "normal");
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
  const plan = ensureFinalRouteV3(planValue);
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

export function migrateLegacyPlanToFinalRouteV3(plan: TravelPlanDocument, regenerateDays = true): TravelPlanDocument {
  const withRoute = ensureFinalRouteV3(plan);
  if (!regenerateDays) return withRoute;
  return TravelPlanDocumentSchema.parse({
    ...withRoute,
    days: deriveFinalRouteDaysV3(withRoute),
    planningState: undefined,
  });
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
  const plan = ensureFinalRouteV3(planValue);
  const beforeDays = clone(plan.days);
  const nodes = clone(plan.finalRoute.nodes);
  mutate(nodes);
  const nextBase = TravelPlanDocumentSchema.parse({
    ...clone(plan),
    finalRoute: { nodes },
  });
  const days = deriveFinalRouteDaysV3(nextBase);
  const next = TravelPlanDocumentSchema.parse({
    ...nextBase,
    days,
    planningState: undefined,
  });
  return { plan: next, affectedDayIds: changedDayIds(beforeDays, days) };
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
  newNodeId = randomUUID(),
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
