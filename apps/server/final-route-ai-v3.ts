import { randomUUID } from "node:crypto";
import {
  TravelPlanDocumentSchema,
  type FinalRouteNode,
  type PlanCommand,
  type TransportMode,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import type { DestinationGenerateOutput } from "./ai-action-contracts-v3.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";
import { semanticPlaceKey } from "./plan-commands-v2.js";

const clone = <T>(value: T): T => structuredClone(value);

function emptyRouteNode(input: {
  placeId: string;
  endsDay?: boolean;
  transportMode?: TransportMode | "none" | null;
}): FinalRouteNode {
  const mode = input.transportMode ?? "none";
  return {
    id: randomUUID(),
    placeId: input.placeId,
    status: "normal",
    endsDay: Boolean(input.endsDay),
    transportFromPrevious: mode === "none" ? null : {
      mode,
      durationMinutes: null,
      note: null,
      verification: { status: "unverified", checkedAt: null },
    },
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

function assertExistingNodeOrderPreserved(before: TravelPlanDocument, afterNodes: FinalRouteNode[]) {
  const beforeIds = before.finalRoute.nodes.map((node) => node.id);
  const beforeIdSet = new Set(beforeIds);
  const afterExistingIds = afterNodes.filter((node) => beforeIdSet.has(node.id)).map((node) => node.id);
  if (JSON.stringify(beforeIds) !== JSON.stringify(afterExistingIds)) {
    throw new Error("FINAL_ROUTE_AI_INSERT_REORDER_FORBIDDEN: 普通 AI 生成不得改变已有线路节点相对顺序。");
  }
  const afterById = new Map(afterNodes.map((node) => [node.id, node]));
  for (const node of before.finalRoute.nodes) {
    const after = afterById.get(node.id);
    if (!after || JSON.stringify(after) !== JSON.stringify(node)) {
      throw new Error(`FINAL_ROUTE_AI_EXISTING_NODE_MUTATION_FORBIDDEN: 普通 AI 生成不得修改已有线路节点 ${node.id}。`);
    }
  }
}

function formalPlaceIdForGeneratedPlace(discoveredPlan: TravelPlanDocument, sourcePlace: DestinationGenerateOutput["places"][number]) {
  const key = semanticPlaceKey(sourcePlace);
  return discoveredPlan.places.find((place) => semanticPlaceKey(place) === key)?.id ?? null;
}

export function applyMainRouteGenerationV3(
  before: TravelPlanDocument,
  discoveredPlan: TravelPlanDocument,
  output: DestinationGenerateOutput,
  idMappings: Record<string, string>,
) {
  if (before.finalRoute.version !== 1 || before.finalRoute.nodes.length) {
    throw new Error("FINAL_ROUTE_MAIN_GENERATION_REQUIRES_EMPTY_ROUTE: 已有最终线路时不能重新生成并覆盖；请使用详细地点生成或显式优化。");
  }

  const nodes: FinalRouteNode[] = [];
  for (const source of output.candidates) {
    const candidateId = idMappings[source.temporaryId];
    if (!candidateId) continue;
    const candidate = discoveredPlan.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error(`主地点生成未能找到正式 Candidate：${source.temporaryId}`);
    const suggestion = source.routeSuggestion;
    nodes.push(emptyRouteNode({
      placeId: candidate.placeId,
      endsDay: suggestion?.endsDay ?? false,
      transportMode: suggestion?.transportMode ?? "none",
    }));
  }
  if (!nodes.length) throw new Error("主地点生成没有产生可加入最终线路的新地点。");

  const plan = TravelPlanDocumentSchema.parse({
    ...clone(discoveredPlan),
    finalRoute: { version: 1, nodes },
  });
  return rebuildFinalRouteDaysV3(plan);
}

export function applyMainRouteGenerationFromOutputV3(
  before: TravelPlanDocument,
  discoveredPlan: TravelPlanDocument,
  output: DestinationGenerateOutput,
) {
  if (before.finalRoute.version !== 1 || before.finalRoute.nodes.length) {
    throw new Error("FINAL_ROUTE_MAIN_GENERATION_REQUIRES_EMPTY_ROUTE: 已有最终线路时不能重新生成并覆盖；请使用详细地点生成或显式优化。");
  }

  const sourcePlaces = new Map(output.places.map((place) => [place.id, place]));
  const nodes: FinalRouteNode[] = [];
  for (const source of output.candidates) {
    const sourcePlace = sourcePlaces.get(source.placeTemporaryId);
    if (!sourcePlace) throw new Error(`主地点生成引用未知临时 Place：${source.placeTemporaryId}`);
    const placeId = formalPlaceIdForGeneratedPlace(discoveredPlan, sourcePlace);
    if (!placeId) throw new Error(`主地点生成未能正式化 Place：${source.placeTemporaryId}`);
    const candidate = discoveredPlan.candidates.find((item) => item.placeId === placeId);
    if (!candidate) throw new Error(`主地点生成没有找到正式 Candidate：${source.temporaryId}`);
    const suggestion = source.routeSuggestion;
    nodes.push(emptyRouteNode({
      placeId,
      endsDay: suggestion?.endsDay ?? false,
      transportMode: suggestion?.transportMode ?? "none",
    }));
  }
  if (!nodes.length) throw new Error("主地点生成没有产生可加入最终线路的新地点。");

  return rebuildFinalRouteDaysV3(TravelPlanDocumentSchema.parse({
    ...clone(discoveredPlan),
    finalRoute: { version: 1, nodes },
  }));
}

export function insertDetailDiscoveryIntoFinalRouteV3(input: {
  before: TravelPlanDocument;
  discoveredPlan: TravelPlanDocument;
  outputCandidates: Array<{ temporaryId: string; placeTemporaryId: string }>;
  idMappings: Record<string, string>;
  addedCandidateIds: string[];
  planningAreaCandidateId: string;
  preferredAnchorNodeId?: string | null;
}) {
  const added = new Set(input.addedCandidateIds);
  const target = input.discoveredPlan.candidates.find((candidate) => candidate.id === input.planningAreaCandidateId);
  if (!target) throw new Error(`详细地点生成引用未知 Planning Area Candidate：${input.planningAreaCandidateId}`);

  const existingNodes = clone(input.before.finalRoute.nodes);
  const preferred = input.preferredAnchorNodeId
    ? existingNodes.find((node) => node.id === input.preferredAnchorNodeId && node.placeId === target.placeId && node.status === "normal")
    : null;
  const anchor = preferred ?? [...existingNodes].reverse().find((node) => node.placeId === target.placeId && node.status === "normal") ?? null;
  if (!anchor) {
    throw new Error("FINAL_ROUTE_DETAIL_SCOPE_UNREPRESENTABLE: 目标区域当前没有正常的最终线路节点，不能自动决定详细地点插入位置。");
  }

  const newNodes: FinalRouteNode[] = [];
  const seenCandidateIds = new Set<string>();
  for (const source of input.outputCandidates) {
    const candidateId = input.idMappings[source.temporaryId];
    if (!candidateId || !added.has(candidateId) || seenCandidateIds.has(candidateId)) continue;
    const candidate = input.discoveredPlan.candidates.find((item) => item.id === candidateId);
    if (!candidate) continue;
    seenCandidateIds.add(candidateId);
    newNodes.push(emptyRouteNode({ placeId: candidate.placeId }));
  }
  if (!newNodes.length) return rebuildFinalRouteDaysV3(input.discoveredPlan);

  const anchorIndex = existingNodes.findIndex((node) => node.id === anchor.id);
  const nodes = [...existingNodes.slice(0, anchorIndex), ...newNodes, ...existingNodes.slice(anchorIndex)];
  assertExistingNodeOrderPreserved(input.before, nodes);

  const plan = TravelPlanDocumentSchema.parse({
    ...clone(input.discoveredPlan),
    finalRoute: { version: 1, nodes },
  });
  return rebuildFinalRouteDaysV3(plan);
}

function detailInsertionPointV3(
  before: TravelPlanDocument,
  parentPlaceId: string,
  scopeRequest: string | null | undefined,
) {
  const nodes = before.finalRoute.nodes;
  const normalMatching = nodes.filter((node) => node.status === "normal" && node.placeId === parentPlaceId);
  if (!normalMatching.length) return null;

  const dayMatch = /^final-route-detail-scope:day:([^:]+)$/u.exec(scopeRequest ?? "");
  if (dayMatch) {
    const day = before.days.find((item) => item.id === dayMatch[1]);
    if (day) {
      if (day.endAnchor.placeId === parentPlaceId) {
        const endNode = nodes.find((node) => node.id === day.id && node.status === "normal" && node.placeId === parentPlaceId);
        if (endNode) return { nodeId: endNode.id, placement: "before" as const };
      }
      const stop = day.stops.find((item) => item.placeId === parentPlaceId);
      if (stop) {
        const stopNode = nodes.find((node) => node.id === stop.id && node.status === "normal");
        if (stopNode) return { nodeId: stopNode.id, placement: "before" as const };
      }
      if (day.startAnchor.placeId === parentPlaceId) {
        const previousDay = before.days[day.dayNumber - 2];
        const previousBoundary = previousDay
          ? nodes.find((node) => node.id === previousDay.id && node.status === "normal" && node.placeId === parentPlaceId)
          : null;
        if (previousBoundary) return { nodeId: previousBoundary.id, placement: "after" as const };
      }
    }
    return null;
  }

  const segmentMatch = /^final-route-detail-scope:segment:([^:]+):([^:]+)$/u.exec(scopeRequest ?? "");
  if (segmentMatch) {
    const fromIndex = nodes.findIndex((node) => node.id === segmentMatch[1]);
    const toIndex = nodes.findIndex((node) => node.id === segmentMatch[2]);
    if (fromIndex >= 0 && toIndex >= 0) {
      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      const matches = nodes.slice(start, end + 1).filter((node) => node.status === "normal" && node.placeId === parentPlaceId);
      const chosen = matches.at(-1);
      if (chosen) return { nodeId: chosen.id, placement: chosen.id === nodes[start]?.id ? "after" as const : "before" as const };
    }
    return null;
  }

  return { nodeId: normalMatching.at(-1)!.id, placement: "before" as const };
}

export function insertNewDetailCandidatesFromPlanV3(input: {
  before: TravelPlanDocument;
  discoveredPlan: TravelPlanDocument;
  scopeRequest?: string | null;
}) {
  const beforeCandidateIds = new Set(input.before.candidates.map((candidate) => candidate.id));
  const newlyAdded = input.discoveredPlan.candidates.filter((candidate) => !beforeCandidateIds.has(candidate.id));
  if (!newlyAdded.length) return rebuildFinalRouteDaysV3(input.discoveredPlan);

  const groups = new Map<string, typeof newlyAdded>();
  for (const candidate of newlyAdded) {
    if (!candidate.planningAreaCandidateId) continue;
    const values = groups.get(candidate.planningAreaCandidateId) ?? [];
    values.push(candidate);
    groups.set(candidate.planningAreaCandidateId, values);
  }
  if (!groups.size) return rebuildFinalRouteDaysV3(input.discoveredPlan);

  let nodes = clone(input.before.finalRoute.nodes);
  for (const [parentCandidateId, candidates] of groups) {
    const parent = input.discoveredPlan.candidates.find((candidate) => candidate.id === parentCandidateId);
    if (!parent) throw new Error(`详细地点生成引用未知 Planning Area Candidate：${parentCandidateId}`);
    const point = detailInsertionPointV3(input.before, parent.placeId, input.scopeRequest);
    if (!point) {
      throw new Error("FINAL_ROUTE_DETAIL_SCOPE_UNREPRESENTABLE: 目标区域当前没有正常的最终线路节点，不能自动决定详细地点插入位置。");
    }
    const index = nodes.findIndex((node) => node.id === point.nodeId);
    if (index < 0) throw new Error(`详细地点生成找不到线路锚点：${point.nodeId}`);
    const newNodes = candidates.map((candidate) => emptyRouteNode({ placeId: candidate.placeId }));
    const insertionIndex = point.placement === "after" ? index + 1 : index;
    nodes = [...nodes.slice(0, insertionIndex), ...newNodes, ...nodes.slice(insertionIndex)];
  }

  assertExistingNodeOrderPreserved(input.before, nodes);
  return rebuildFinalRouteDaysV3(TravelPlanDocumentSchema.parse({
    ...clone(input.discoveredPlan),
    finalRoute: { version: 1, nodes },
  }));
}

export function finalRouteTargetNodeIdsForOptimizationV3(
  plan: TravelPlanDocument,
  input: { optimizeScope: "segment" | "trip"; fromNodeId?: string | null; toNodeId?: string | null },
) {
  const nodes = plan.finalRoute.nodes;
  if (input.optimizeScope === "trip") return nodes.filter((node) => node.status === "normal").map((node) => node.id);

  const fromIndex = nodes.findIndex((node) => node.id === input.fromNodeId);
  const toIndex = nodes.findIndex((node) => node.id === input.toNodeId);
  if (fromIndex < 0 || toIndex < 0) throw new Error("优化这一段需要有效的起点和终点线路节点。");
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return nodes.slice(start, end + 1).filter((node) => node.status === "normal").map((node) => node.id);
}

export function finalRouteMoveCommandsForOrderedSubsetV3(
  plan: TravelPlanDocument,
  allowedNodeIds: string[],
  orderedNodeIds: string[],
): PlanCommand[] {
  const allowed = new Set(allowedNodeIds);
  if (allowed.size !== allowedNodeIds.length || orderedNodeIds.length !== allowedNodeIds.length || new Set(orderedNodeIds).size !== orderedNodeIds.length || orderedNodeIds.some((id) => !allowed.has(id))) {
    throw new Error("FINAL_ROUTE_OPTIMIZE_SCOPE_VIOLATION: AI 优化必须恰好重排授权范围内的现有线路节点。");
  }

  const original = plan.finalRoute.nodes.map((node) => node.id);
  const desiredIterator = orderedNodeIds[Symbol.iterator]();
  const desired = original.map((id) => allowed.has(id) ? desiredIterator.next().value as string : id);
  const working = [...original];
  const commands: PlanCommand[] = [];

  for (let index = 0; index < desired.length; index += 1) {
    const desiredId = desired[index];
    const currentId = working[index];
    if (currentId === desiredId) continue;

    if (allowed.has(desiredId)) {
      const currentIndex = working.indexOf(desiredId);
      if (currentIndex < 0) throw new Error(`优化结果引用未知线路节点：${desiredId}`);
      working.splice(currentIndex, 1);
      working.splice(index, 0, desiredId);
      commands.push({ type: "move_final_route_node", nodeId: desiredId, targetIndex: index });
      continue;
    }

    if (!allowed.has(currentId)) {
      throw new Error("FINAL_ROUTE_OPTIMIZE_COMMAND_BUILD_FAILED: 优化结果试图移动授权范围外节点。");
    }
    const targetIndex = desired.indexOf(currentId);
    if (targetIndex < 0) throw new Error(`优化结果遗漏线路节点：${currentId}`);
    working.splice(index, 1);
    working.splice(targetIndex, 0, currentId);
    commands.push({ type: "move_final_route_node", nodeId: currentId, targetIndex });
  }

  if (JSON.stringify(working) !== JSON.stringify(desired)) {
    throw new Error("FINAL_ROUTE_OPTIMIZE_COMMAND_BUILD_FAILED: 无法在不移动授权范围外节点的情况下应用优化结果。");
  }
  return commands;
}

export function orderedAuthorizedRouteNodeIdsFromDaysV3(
  days: Array<{ id: string; stops: Array<{ id: string }> }>,
  allowedNodeIds: string[],
) {
  const allowed = new Set(allowedNodeIds);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const day of days) {
    for (const id of [...day.stops.map((stop) => stop.id), day.id]) {
      if (!allowed.has(id)) continue;
      if (seen.has(id)) throw new Error(`FINAL_ROUTE_OPTIMIZE_SCOPE_VIOLATION: AI 优化重复返回线路节点 ${id}。`);
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}
