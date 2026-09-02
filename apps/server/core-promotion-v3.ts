import { ActionConfirmationInputSchema } from "./ai-stage-contracts-v3.js";
import { PlanCommandSchema, TravelPlanDocumentSchema } from "./contracts-v2.js";
import { analyzeItineraryImpactV3 } from "./itinerary-impact-v3.js";
import { applyPlanCommands } from "./plan-commands-v2.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";
import type { TravelStoreV3 } from "./travel-store-v3.js";

export function confirmDetailToCorePromotionV3(
  store: TravelStoreV3,
  tripId: string,
  actionId: string,
  inputValue: unknown,
): { action: NonNullable<ReturnType<TravelStoreV3["getAction"]>>; taskId: null } | null {
  const action = store.getAction(actionId);
  if (!action || action.tripId !== tripId) return null;
  if (action.origin !== "conversation" || action.stage !== "destinations" || action.actionType !== "destination.edit") return null;
  if (action.parameters.request !== "promote_to_core") return null;

  const trip = store.requireTrip(tripId);
  const targetCandidateId = String(action.parameters.candidateId ?? action.targetIds[0] ?? "");
  const target = trip.plan.candidates.find((candidate) => candidate.id === targetCandidateId);
  const targetPlace = target ? trip.plan.places.find((place) => place.id === target.placeId) : null;
  if (!target || !targetPlace || effectivePlanningRole(target, targetPlace) !== "detail_interest") return null;

  const input = ActionConfirmationInputSchema.parse(inputValue);
  if (action.baseGeneration !== input.expectedGeneration || trip.contentGeneration !== input.expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
  if (!target.planningAreaCandidateId) throw new Error("普通景点缺少所属停留地点，不能提升为重要游览地。");
  const parent = trip.plan.candidates.find((candidate) => candidate.id === target.planningAreaCandidateId);
  const parentPlace = parent ? trip.plan.places.find((place) => place.id === parent.placeId) : null;
  if (!parent || !parentPlace || effectivePlanningRole(parent, parentPlace) !== "planning_area") throw new Error("普通景点所属停留地点无效，不能提升为重要游览地。");
  if (action.parameters.placeChanges) throw new Error("提升为重要游览地时不能同时修改地点身份；请分开处理。");

  const claimed = store.claimActionForExecution(action.id, input.expectedGeneration);
  if (!claimed.claimed) return { action: claimed.action, taskId: null };

  try {
    const candidateChanges = action.parameters.candidateChanges;
    const commands = candidateChanges && typeof candidateChanges === "object" && !Array.isArray(candidateChanges)
      ? [PlanCommandSchema.parse({ type: "update_candidate", candidateId: target.id, changes: candidateChanges })]
      : [];
    const edited = commands.length ? applyPlanCommands(trip.plan, commands).plan : structuredClone(trip.plan);
    const promoted = structuredClone(edited);
    const promotedCandidate = promoted.candidates.find((candidate) => candidate.id === target.id);
    if (!promotedCandidate) throw new Error("找不到需要提升的重要游览地。");
    promotedCandidate.planningRole = "core_visit";
    promotedCandidate.planningAreaCandidateId = target.planningAreaCandidateId;

    const parsed = TravelPlanDocumentSchema.parse(promoted);
    const impact = analyzeItineraryImpactV3(trip.plan, parsed);
    const affected = new Set(impact.detail.affectedDayIds);
    const finalPlan = TravelPlanDocumentSchema.parse({
      ...parsed,
      days: parsed.days.map((day) => affected.has(day.id) && day.detailLevel === "detailed"
        ? { ...day, detailStatus: "needs_review" }
        : day),
    });
    const written = store.writePlan(
      tripId,
      finalPlan,
      input.expectedGeneration,
      { source: "action:destination.edit", summary: "将普通景点提升为重要游览地" },
      { keepActionId: action.id },
    );
    store.completeAction(action.id, `generation:${written.generation};promotedCore:${target.id};affected:${impact.detail.affectedDayIds.length}`);
    return { action: store.getAction(action.id)!, taskId: null };
  } catch (error) {
    store.failAction(action.id, error instanceof Error ? error.message : "提升重要游览地失败。");
    throw error;
  }
}
