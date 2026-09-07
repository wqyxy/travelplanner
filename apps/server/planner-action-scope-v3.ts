import type { AiActionType } from "./ai-stage-contracts-v3.js";
import type { ProposalScope, TravelPlanDocument } from "./contracts-v2.js";

export function dayMutationScope(dayIds: string[]): ProposalScope {
  const ids = [...new Set(dayIds.filter(Boolean))];
  if (!ids.length) throw new Error("局部行程 Action 缺少目标 Day，不能自动扩大为整趟 Scope。");
  return ids.length === 1 ? { type: "day", id: ids[0] } : { type: "days", ids };
}

export function actionScope(
  actionType: AiActionType,
  targetIds: string[],
  parameters: Record<string, unknown>,
  plan: TravelPlanDocument,
): ProposalScope {
  if (actionType.startsWith("requirements.")) return { type: "trip", id: null };
  if (actionType.startsWith("destination.") || actionType.startsWith("interest.")) return { type: "candidate_pool", id: null };

  const requestedDayId = () => targetIds[0] || (typeof parameters.dayId === "string" ? parameters.dayId : "");
  const requestedStopId = () => targetIds[0] || (typeof parameters.stopId === "string" ? parameters.stopId : "");
  const ownerDayForStop = (stopId: string) => plan.days.find((day) => day.stops.some((stop) => stop.id === stopId))?.id ?? null;

  if (actionType === "itinerary.stop.add" || actionType === "itinerary.anchor.set") {
    const dayId = requestedDayId();
    if (!dayId || !plan.days.some((day) => day.id === dayId)) throw new Error(`局部行程 Action 引用未知 Day：${dayId || "(missing)"}`);
    return { type: "day", id: dayId };
  }

  if (actionType === "itinerary.stop.remove" || actionType === "itinerary.stop.replace") {
    const stopId = requestedStopId();
    const dayId = stopId ? ownerDayForStop(stopId) : null;
    if (!dayId) throw new Error(`局部行程 Action 引用未知 Stop：${stopId || "(missing)"}`);
    return { type: "day", id: dayId };
  }

  if (actionType === "itinerary.edit") {
    if (typeof parameters.stopId === "string" && parameters.stopId) {
      const dayId = ownerDayForStop(parameters.stopId);
      if (!dayId) throw new Error(`局部行程 Action 引用未知 Stop：${parameters.stopId}`);
      return { type: "day", id: dayId };
    }
    const dayId = requestedDayId();
    if (!dayId || !plan.days.some((day) => day.id === dayId)) throw new Error(`局部行程 Action 引用未知 Day：${dayId || "(missing)"}`);
    return { type: "day", id: dayId };
  }

  if (actionType === "itinerary.stop.move") {
    const stopId = requestedStopId();
    const sourceDayId = stopId ? ownerDayForStop(stopId) : null;
    const targetDayId = typeof parameters.targetDayId === "string" ? parameters.targetDayId : "";
    if (!sourceDayId) throw new Error(`局部行程 Action 引用未知 Stop：${stopId || "(missing)"}`);
    if (!targetDayId || !plan.days.some((day) => day.id === targetDayId)) throw new Error(`局部行程 Action 引用未知目标 Day：${targetDayId || "(missing)"}`);
    return dayMutationScope([sourceDayId, targetDayId]);
  }

  if (actionType === "itinerary.day.optimize") {
    const parameterIds = Array.isArray(parameters.dayIds)
      ? parameters.dayIds.filter((value): value is string => typeof value === "string")
      : [];
    const id = targetIds[0] || (typeof parameters.dayId === "string" ? parameters.dayId : parameterIds.length === 1 ? parameterIds[0] : "");
    if (!id) throw new Error("单日优化缺少目标 Day，不能自动扩大为整趟 Scope。");
    return { type: "day", id };
  }

  if (actionType === "itinerary.refine" || actionType === "itinerary.detail.update") {
    const parameterIds = Array.isArray(parameters.dayIds)
      ? parameters.dayIds.filter((value): value is string => typeof value === "string")
      : [];
    return dayMutationScope([
      ...targetIds,
      ...parameterIds,
      ...(typeof parameters.dayId === "string" ? [parameters.dayId] : []),
    ]);
  }

  return { type: "trip", id: null };
}
