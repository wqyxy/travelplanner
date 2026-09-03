import type { AiActionType } from "./ai-stage-contracts-v3.js";
import type { TravelPlanDocument } from "./contracts-v2.js";

function requestedDayIds(parameters: Record<string, unknown>, targetIds: string[]) {
  if (Array.isArray(parameters.dayIds) && parameters.dayIds.length) return parameters.dayIds.map(String).slice(0, 90);
  if (typeof parameters.dayId === "string" && parameters.dayId.trim()) return [parameters.dayId.trim()];
  return targetIds.map(String).filter(Boolean).slice(0, 90);
}

export function normalizeDetailDayCtaActionV3(
  plan: TravelPlanDocument,
  actionType: AiActionType,
  parameters: Record<string, unknown>,
  targetIds: string[],
): AiActionType {
  if (actionType !== "itinerary.refine") return actionType;
  const dayIds = requestedDayIds(parameters, targetIds);
  if (!dayIds.length) return actionType;

  const days = dayIds.map((dayId) => plan.days.find((day) => day.id === dayId));
  if (days.some((day) => day && (day.detailLevel !== "detailed" || day.detailStatus === "needs_review" || day.stops.length === 0))) {
    return "itinerary.detail.update";
  }
  return actionType;
}
