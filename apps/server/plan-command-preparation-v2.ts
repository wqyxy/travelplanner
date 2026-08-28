import {
  PlanCommandBatchRequestSchema,
  type PlanCommand,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { applyPlanCommands, type ApplyPlanCommandsToStoreResult } from "./plan-commands-v2.js";
import type { TravelStoreV2 } from "./travel-store-v2.js";

function stopOwner(plan: TravelPlanDocument, stopId: string) {
  return plan.days.find((day) => day.stops.some((stop) => stop.id === stopId))?.id ?? null;
}

function daysUsingPlace(plan: TravelPlanDocument, placeId: string) {
  return plan.days.filter((day) => day.startAnchor.placeId === placeId
    || day.endAnchor.placeId === placeId
    || day.stops.some((stop) => stop.placeId === placeId)).map((day) => day.id);
}

function daysUsingCandidate(plan: TravelPlanDocument, candidateId: string) {
  return plan.days.filter((day) => day.stops.some((stop) => stop.candidateId === candidateId)).map((day) => day.id);
}

function affectedDays(plan: TravelPlanDocument, commands: PlanCommand[]) {
  const values = new Set<string>();
  for (const command of commands) {
    if (command.type === "set_day_anchor" || command.type === "add_day_stop" || command.type === "update_day") values.add(command.dayId);
    if (command.type === "update_day_stop" || command.type === "remove_day_stop") {
      const dayId = stopOwner(plan, command.stopId);
      if (dayId) values.add(dayId);
    }
    if (command.type === "move_day_stop") {
      const sourceDayId = stopOwner(plan, command.stopId);
      if (sourceDayId) values.add(sourceDayId);
      values.add(command.targetDayId);
    }
    if (command.type === "move_day") plan.days.forEach((day) => values.add(day.id));
    if (command.type === "set_candidate_preference" || command.type === "remove_candidate" || command.type === "remove_candidate_tree" || command.type === "update_candidate") {
      daysUsingCandidate(plan, command.candidateId).forEach((dayId) => values.add(dayId));
      const placeId = plan.candidates.find((candidate) => candidate.id === command.candidateId)?.placeId;
      if ((command.type === "remove_candidate" || command.type === "remove_candidate_tree") && placeId) daysUsingPlace(plan, placeId).forEach((dayId) => values.add(dayId));
      if (command.type === "remove_candidate_tree") {
        const descendants = new Set<string>([command.candidateId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const candidate of plan.candidates) {
            if (!candidate.planningAreaCandidateId || !descendants.has(candidate.planningAreaCandidateId) || descendants.has(candidate.id)) continue;
            descendants.add(candidate.id);
            changed = true;
          }
        }
        descendants.forEach((candidateId) => {
          daysUsingCandidate(plan, candidateId).forEach((dayId) => values.add(dayId));
          const descendantPlaceId = plan.candidates.find((candidate) => candidate.id === candidateId)?.placeId;
          if (descendantPlaceId) daysUsingPlace(plan, descendantPlaceId).forEach((dayId) => values.add(dayId));
        });
      }
    }
    if (command.type === "bulk_set_candidate_preference") {
      command.candidateIds.forEach((candidateId) => daysUsingCandidate(plan, candidateId).forEach((dayId) => values.add(dayId)));
    }
    if (command.type === "update_place") daysUsingPlace(plan, command.placeId).forEach((dayId) => values.add(dayId));
  }
  return values;
}

export function preparePlanForCommands(plan: TravelPlanDocument, commands: PlanCommand[]) {
  const next = structuredClone(plan);
  const changedDayIds = affectedDays(plan, commands);
  for (const day of next.days) {
    if (!changedDayIds.has(day.id) || day.detailLevel !== "detailed") continue;
    day.detailLevel = "planned";
    day.detailStatus = "needs_review";
  }
  return next;
}

export function applyPreparedPlanCommandBatchToStore(
  store: TravelStoreV2,
  tripId: string,
  input: unknown,
  revision: { source?: string; summary?: string } = {},
): ApplyPlanCommandsToStoreResult {
  const request = PlanCommandBatchRequestSchema.parse(input);
  const trip = store.requireTrip(tripId);
  if (trip.contentGeneration !== request.expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
  const prepared = preparePlanForCommands(trip.plan, request.commands);
  const applied = applyPlanCommands(prepared, request.commands);
  const written = store.writePlan(tripId, applied.plan, request.expectedGeneration, {
    source: revision.source ?? "command",
    summary: revision.summary ?? "编辑旅行计划",
  });
  return { ...applied, trip: written.trip, generation: written.generation, version: written.version };
}
