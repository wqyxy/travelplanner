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
  const afterExistingIds = afterNodes.filter((node) => beforeIds.includes(node.id)).map((node) => node.id);
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

export function applyMainRouteGenerationV3(
  before: TravelPlanDocument,
  discoveredPlan: TravelPlanDocument,
  output: DestinationGenerateOutput,
  idMappings: Record<string, string>,
) {
  if (before.finalRoute.version !== 1 || before.finalRoute.nodes.length) {
    throw new Error("FINAL_ROUTE_MAIN_GENERATION_REQUIRES_EMPTY_ROUTE: 已有最终线路时不能重新生成并覆盖；请使用详细地点生成或显式优化。");
  }

  const seenCandidateIds = new Set<string>();
  const nodes: FinalRouteNode[] = [];
  for (const source of output.candidates) {
    const candidateId = idMappings[source.temporaryId];
    if (!candidateId || seenCandidateIds.has(candidateId)) continue;
    const candidate = discoveredPlan.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error(`主地点生成未能找到正式 Candidate：${source.temporaryId}`);
    seenCandidateIds.add(candidateId);
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
    if (working[index] === desiredId || !allowed.has(desiredId)) continue;
    const currentIndex = working.indexOf(desiredId);
    if (currentIndex < 0) throw new Error(`优化结果引用未知线路节点：${desiredId}`);
    working.splice(currentIndex, 1);
    working.splice(index, 0, desiredId);
    commands.push({ type: "move_final_route_node", nodeId: desiredId, targetIndex: index });
  }

  if (JSON.stringify(working) !== JSON.stringify(desired)) {
    throw new Error("FINAL_ROUTE_OPTIMIZE_COMMAND_BUILD_FAILED: 无法在不移动授权范围外节点的情况下应用优化结果。");
  }
  return commands;
}
