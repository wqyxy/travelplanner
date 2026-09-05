import type {
  DestinationGenerateOutput,
  ItineraryDayOptimizeOutput,
  ItineraryRepairOutput,
} from "./ai-action-contracts-v3.js";
import type { AiActionRecord } from "./ai-stage-contracts-v3.js";
import { TravelPlanDocumentSchema, type ProposalScope } from "./contracts-v2.js";
import {
  applyMainRouteGenerationFromOutputV3,
  finalRouteMoveCommandsForOrderedSubsetV3,
  finalRouteTargetNodeIdsForOptimizationV3,
  insertNewDetailCandidatesFromPlanV3,
  orderedAuthorizedRouteNodeIdsFromDaysV3,
} from "./final-route-ai-v3.js";
import { TravelPlannerRuntimeV3 } from "./planner-runtime-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const mainGenerationOutputs = new Map<string, DestinationGenerateOutput>();
const isRouteOptimizationAction = (actionType: string | undefined) => actionType === "itinerary.day.optimize" || actionType === "itinerary.repair";

const storePrototype = TravelStoreV3.prototype as any;
const originalWritePlan = storePrototype.writePlan as Function;
storePrototype.writePlan = function finalRouteAwareWritePlan(
  this: TravelStoreV3,
  id: string,
  value: unknown,
  expectedGeneration: number,
  revision: { source?: string; summary?: string } = { source: "edit", summary: "更新旅行计划" },
  options: { keepPendingProposalId?: string; keepActionId?: string } = {},
) {
  let nextValue = value;
  const source = revision?.source ?? "";
  const actionId = options?.keepActionId ?? null;

  if (source === "action:destination.generate" && actionId) {
    const output = mainGenerationOutputs.get(actionId);
    if (!output) throw new Error("FINAL_ROUTE_MAIN_GENERATION_CONTEXT_MISSING: 主地点生成缺少本轮 AI 输出上下文。");
    const before = this.requireTrip(id).plan;
    const discovered = TravelPlanDocumentSchema.parse(value);
    nextValue = applyMainRouteGenerationFromOutputV3(before, discovered, output);
  }

  if ((source === "action:interest.discover" || source === "action:interest.supplement") && actionId) {
    const before = this.requireTrip(id).plan;
    const discovered = TravelPlanDocumentSchema.parse(value);
    const action = this.getAction(actionId);
    const request = typeof action?.parameters?.request === "string" ? action.parameters.request : null;
    nextValue = insertNewDetailCandidatesFromPlanV3({ before, discoveredPlan: discovered, scopeRequest: request });
  }

  return originalWritePlan.call(this, id, nextValue, expectedGeneration, revision, options);
};

const runtimePrototype = TravelPlannerRuntimeV3.prototype as any;
const originalPersistDestinationGenerate = runtimePrototype.persistDestinationGenerate as Function;
runtimePrototype.persistDestinationGenerate = async function persistDestinationGenerateToFinalRoute(
  this: TravelPlannerRuntimeV3,
  action: AiActionRecord,
  output: DestinationGenerateOutput,
  taskId: string | null = null,
) {
  const runtime = this as any;
  const before = runtime.options.store.requireTrip(action.tripId);
  if (before.plan.finalRoute.nodes.length) {
    throw new Error("FINAL_ROUTE_MAIN_GENERATION_REQUIRES_EMPTY_ROUTE: 已有最终线路时不能重新生成主要地点覆盖用户线路。");
  }
  mainGenerationOutputs.set(action.id, output);
  try {
    const result = await originalPersistDestinationGenerate.call(this, action, output, taskId);
    const current = runtime.options.store.requireTrip(action.tripId);
    if (current.contentGeneration === action.baseGeneration + 1 && current.plan.days.length) {
      runtime.startRouteBatch(action.tripId, current.contentGeneration, current.plan.days.map((day: any) => day.id));
    }
    return result;
  } finally {
    mainGenerationOutputs.delete(action.id);
  }
};

const originalPersistInterestDiscovery = runtimePrototype.persistInterestDiscovery as Function;
runtimePrototype.persistInterestDiscovery = async function persistInterestDiscoveryToFinalRoute(
  this: TravelPlannerRuntimeV3,
  action: AiActionRecord,
  taskId: string | null = null,
) {
  const runtime = this as any;
  const before = runtime.options.store.requireTrip(action.tripId);
  if (!before.plan.finalRoute.nodes.length) throw new Error("请先生成或手工建立主要最终线路，再生成详细地点。");
  const beforeNodeCount = before.plan.finalRoute.nodes.length;
  const result = await originalPersistInterestDiscovery.call(this, action, taskId);
  const current = runtime.options.store.requireTrip(action.tripId);
  if (current.plan.finalRoute.nodes.length > beforeNodeCount && current.plan.days.length) {
    runtime.startRouteBatch(action.tripId, current.contentGeneration, current.plan.days.map((day: any) => day.id));
  }
  return result;
};

const originalBuildActionState = runtimePrototype.buildActionState as Function;
runtimePrototype.buildActionState = function buildFinalRouteActionState(this: TravelPlannerRuntimeV3, action: AiActionRecord) {
  if (action.actionType !== "itinerary.repair") return originalBuildActionState.call(this, action);
  const runtime = this as any;
  const trip = runtime.options.store.requireTrip(action.tripId);
  const places = new Map(trip.plan.places.map((place: any) => [place.id, place]));
  const optimizeScope = action.targetIds.length >= 2 ? "segment" as const : "trip" as const;
  const targetNodeIds = finalRouteTargetNodeIdsForOptimizationV3(trip.plan, {
    optimizeScope,
    fromNodeId: action.targetIds[0] ?? null,
    toNodeId: action.targetIds[1] ?? null,
  });
  if (targetNodeIds.length < 2) throw new Error("当前授权范围不足两个正常线路节点，无需优化顺序。");
  return {
    actionType: action.actionType,
    baseGeneration: action.baseGeneration,
    planLanguage: trip.planLanguage,
    parameters: action.parameters,
    targetIds: action.targetIds,
    tripFacts: trip.plan.trip,
    optimizeScope,
    targetNodeIds,
    finalRouteNodes: trip.plan.finalRoute.nodes.map((node: any) => ({ ...node, place: places.get(node.placeId) ?? null })),
    days: trip.plan.days,
    routeStates: runtime.options.routes.workspaceRouteState(action.tripId),
  };
};

runtimePrototype.persistDayOptimize = function persistFinalRouteDayOptimize(
  this: TravelPlannerRuntimeV3,
  action: AiActionRecord,
  output: ItineraryDayOptimizeOutput,
) {
  const runtime = this as any;
  const result = output.result as any;
  if (runtime.completeRequiresWorkflowStep(action, result)) return;
  if (result.type !== "success") throw new Error("单日优化结果类型无效。");
  const requestedDayId = String(action.parameters.dayId ?? action.targetIds[0] ?? "");
  if (!requestedDayId || result.dayId !== requestedDayId) {
    throw new Error(`FINAL_ROUTE_OPTIMIZE_SCOPE_VIOLATION: 单日优化只能返回用户授权的 Day ${requestedDayId || "(missing)"}。`);
  }
  const trip = runtime.options.store.requireTrip(action.tripId);
  const day = trip.plan.days.find((item: any) => item.id === requestedDayId);
  if (!day) throw new Error(`未知 Day：${requestedDayId}`);
  const allowedNodeIds = day.stops.map((stop: any) => stop.id);
  const commands = finalRouteMoveCommandsForOrderedSubsetV3(trip.plan, allowedNodeIds, result.orderedStopIds);
  if (!commands.length) {
    runtime.options.store.completeAction(action.id, "no-change");
    return;
  }
  const scope: ProposalScope = { type: "trip", id: null };
  return runtime.createProposalForAction(action, result.title, result.explanation, commands, scope, [day.id]);
};

runtimePrototype.persistItineraryRepair = function persistFinalRouteOptimization(
  this: TravelPlannerRuntimeV3,
  action: AiActionRecord,
  output: ItineraryRepairOutput,
) {
  const runtime = this as any;
  const result = output.result as any;
  if (runtime.completeRequiresWorkflowStep(action, result)) return;
  if (result.type !== "success") throw new Error("线路优化结果类型无效。");
  const trip = runtime.options.store.requireTrip(action.tripId);
  const optimizeScope = action.targetIds.length >= 2 ? "segment" as const : "trip" as const;
  const allowedNodeIds = finalRouteTargetNodeIdsForOptimizationV3(trip.plan, {
    optimizeScope,
    fromNodeId: action.targetIds[0] ?? null,
    toNodeId: action.targetIds[1] ?? null,
  });
  if (allowedNodeIds.length < 2) {
    runtime.options.store.completeAction(action.id, "no-change");
    return;
  }
  const orderedNodeIds = orderedAuthorizedRouteNodeIdsFromDaysV3(result.days, allowedNodeIds);
  const commands = finalRouteMoveCommandsForOrderedSubsetV3(trip.plan, allowedNodeIds, orderedNodeIds);
  if (!commands.length) {
    runtime.options.store.completeAction(action.id, "no-change");
    return;
  }
  const scope: ProposalScope = { type: "trip", id: null };
  return runtime.createProposalForAction(action, result.title, result.explanation, commands, scope);
};

const originalApplyProposal = runtimePrototype.applyProposal as Function;
runtimePrototype.applyProposal = async function applyFinalRouteOptimizationProposal(
  this: TravelPlannerRuntimeV3,
  tripId: string,
  proposalId: string,
) {
  const runtime = this as any;
  const linkedAction = runtime.options.store.listActions(tripId).find((action: AiActionRecord) => action.proposalId === proposalId);
  const result = await originalApplyProposal.call(this, tripId, proposalId);
  if (isRouteOptimizationAction(linkedAction?.actionType) && result?.trip?.plan?.days?.length) {
    runtime.startRouteBatch(tripId, result.generation, result.trip.plan.days.map((day: any) => day.id));
  }
  return result;
};

const originalUndoProposal = runtimePrototype.undoProposal as Function;
runtimePrototype.undoProposal = function undoFinalRouteOptimizationProposal(
  this: TravelPlannerRuntimeV3,
  tripId: string,
  proposalId: string,
) {
  const runtime = this as any;
  const linkedAction = runtime.options.store.listActions(tripId).find((action: AiActionRecord) => action.proposalId === proposalId);
  const result = originalUndoProposal.call(this, tripId, proposalId);
  if (isRouteOptimizationAction(linkedAction?.actionType) && result?.trip?.plan?.days?.length) {
    runtime.startRouteBatch(tripId, result.generation, result.trip.plan.days.map((day: any) => day.id));
  }
  return result;
};
