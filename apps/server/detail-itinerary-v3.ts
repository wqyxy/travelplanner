import { randomUUID } from "node:crypto";
import {
  PlanCommandSchema,
  TravelPlanDocumentSchema,
  type Day,
  type DayStop,
  type PlanCommand,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import type { DetailedDayUpdate } from "./ai-action-contracts-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";
import {
  addDerivedStopViaFinalRouteV3,
  moveDerivedStopViaFinalRouteV3,
  removeDerivedStopViaFinalRouteV3,
  updateDerivedStopViaFinalRouteV3,
} from "./final-route-day-stop-bridge-v3.js";

export type DetailedUnscheduledCandidateV3 = { candidateId: string; reason: string };

function stopForDraft(trip: TripDetailV3, day: Day, draft: DetailedDayUpdate["stops"][number], existing: DayStop | undefined): DayStop {
  const candidates = new Map(trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const candidate = candidates.get(draft.candidateId);
  if (!candidate) throw new Error(`详细行程引用未知 Candidate：${draft.candidateId}`);
  const place = places.get(candidate.placeId);
  if (!place) throw new Error(`详细行程 Candidate 引用未知 Place：${draft.candidateId}`);

  const isFirstExistingStop = Boolean(existing && day.stops[0]?.id === existing.id);
  const preserveDayArrivalTransport = Boolean(
    draft.transportFromPrevious === null
      && isFirstExistingStop
      && day.transferMode !== "none"
      && existing?.transportFromPrevious?.mode === day.transferMode,
  );

  return {
    id: existing?.id ?? randomUUID(),
    candidateId: candidate.id,
    placeId: candidate.placeId,
    activity: draft.activity,
    period: draft.period,
    // `null` is an explicit AI instruction to clear a natural-language schedule.
    // Transport is different during the Phase 1 bridge: the first Stop can carry the Day-level
    // arrival transport. A null detailed draft must not erase that route-owned arrival fact.
    scheduleText: Object.hasOwn(draft, "scheduleText")
      ? draft.scheduleText ?? null
      : existing?.scheduleText ?? null,
    startTime: draft.startTime,
    endTime: draft.endTime,
    durationMinutes: draft.durationMinutes,
    transportFromPrevious: preserveDayArrivalTransport
      ? structuredClone(existing!.transportFromPrevious)
      : draft.transportFromPrevious,
    scheduleVerification: draft.scheduleVerification,
    costNote: draft.costNote,
    costVerification: draft.costVerification,
    notes: draft.notes,
  };
}

function syncDetailedDaysToFinalRouteV3(
  planValue: TravelPlanDocument,
  desiredDays: Day[],
  targetDayIds: Set<string>,
) {
  let working = structuredClone(planValue);
  const desiredByDay = new Map(desiredDays.filter((day) => targetDayIds.has(day.id)).map((day) => [day.id, day]));

  for (const originalDay of planValue.days) {
    if (!targetDayIds.has(originalDay.id)) continue;
    const desiredDay = desiredByDay.get(originalDay.id);
    if (!desiredDay) throw new Error(`详细行程缺少目标 Day：${originalDay.id}`);

    for (let index = 0; index < desiredDay.stops.length; index += 1) {
      const desired = desiredDay.stops[index];
      const currentDay = working.days.find((day) => day.id === originalDay.id);
      if (!currentDay) throw new Error(`详细行程引用未知 Day：${originalDay.id}`);
      const currentIndex = currentDay.stops.findIndex((stop) => stop.id === desired.id);

      if (currentIndex < 0) {
        const added = addDerivedStopViaFinalRouteV3(working, originalDay.id, index, desired);
        if (!added) throw new Error(`详细行程 Stop 无法映射到最终线路：${desired.id}`);
        working = added.plan;
      } else if (currentIndex !== index) {
        const moved = moveDerivedStopViaFinalRouteV3(working, desired.id, originalDay.id, index);
        if (!moved) throw new Error(`详细行程 Stop 无法在最终线路中移动：${desired.id}`);
        working = moved.plan;
      }

      const updated = updateDerivedStopViaFinalRouteV3(working, desired.id, {
        candidateId: desired.candidateId,
        placeId: desired.placeId,
        activity: desired.activity,
        period: desired.period,
        scheduleText: desired.scheduleText ?? null,
        startTime: desired.startTime,
        endTime: desired.endTime,
        durationMinutes: desired.durationMinutes,
        transportFromPrevious: structuredClone(desired.transportFromPrevious),
        scheduleVerification: structuredClone(desired.scheduleVerification),
        costNote: desired.costNote,
        costVerification: structuredClone(desired.costVerification),
        notes: desired.notes,
      });
      if (!updated) throw new Error(`详细行程 Stop 无法写入最终线路：${desired.id}`);
      working = updated.plan;
    }

    const desiredIds = new Set(desiredDay.stops.map((stop) => stop.id));
    const currentDay = working.days.find((day) => day.id === originalDay.id);
    if (!currentDay) throw new Error(`详细行程引用未知 Day：${originalDay.id}`);
    for (const stop of [...currentDay.stops].reverse()) {
      if (desiredIds.has(stop.id)) continue;
      const removed = removeDerivedStopViaFinalRouteV3(working, stop.id);
      if (!removed) throw new Error(`详细行程 Stop 无法从最终线路移除：${stop.id}`);
      working = removed.plan;
    }
  }

  return TravelPlanDocumentSchema.parse({
    ...working,
    stage: "itinerary_refinement",
    days: working.days.map((day) => targetDayIds.has(day.id)
      ? { ...day, detailLevel: "detailed", detailStatus: "ready" }
      : day),
  });
}

export function applyDetailedUpdatesPhase5V3(trip: TripDetailV3, updates: DetailedDayUpdate[], requireAllDays: boolean) {
  const updateByDay = new Map(updates.map((update) => [update.dayId, update]));
  if (updateByDay.size !== updates.length) throw new Error("详细行程重复返回了同一个 Day。");
  if (requireAllDays && (updateByDay.size !== trip.plan.days.length || trip.plan.days.some((day) => !updateByDay.has(day.id)))) throw new Error("首次生成详细行程必须恰好返回全部 Macro Day。");
  const knownDayIds = new Set(trip.plan.days.map((day) => day.id));
  for (const dayId of updateByDay.keys()) if (!knownDayIds.has(dayId)) throw new Error(`详细行程引用未知 Day：${dayId}`);

  const days = trip.plan.days.map((day): Day => {
    const update = updateByDay.get(day.id);
    if (!update) return structuredClone(day);
    const existingByCandidate = new Map(day.stops.filter((stop) => stop.candidateId).map((stop) => [stop.candidateId!, stop]));
    const stops = update.stops.map((draft) => stopForDraft(trip, day, draft, existingByCandidate.get(draft.candidateId)));
    return { ...structuredClone(day), detailLevel: "detailed", detailStatus: "ready", stops };
  });
  const desired = TravelPlanDocumentSchema.parse({ ...trip.plan, stage: "itinerary_refinement", days });
  // Transitional tests and old in-memory fixtures can still be Day-only. Keep
  // that narrow compatibility path until the P0 reverse bridge is fully removed.
  if (!trip.plan.finalRoute.nodes.length && trip.plan.days.length) return desired;
  return syncDetailedDaysToFinalRouteV3(trip.plan, desired.days, new Set(updateByDay.keys()));
}

/**
 * Planning completeness is advisory-only. This validator now protects only
 * reference integrity and contradictions in the AI result bookkeeping.
 */
export function validateDetailedSchedulingOutcomeV3(
  plan: ReturnType<typeof TravelPlanDocumentSchema.parse>,
  unscheduledCandidates: DetailedUnscheduledCandidateV3[],
  targetDayIds: string[],
  _unavailableCandidateIds: string[] = [],
) {
  const targetSet = new Set(targetDayIds);
  const knownDayIds = new Set(plan.days.map((day) => day.id));
  for (const dayId of targetSet) if (!knownDayIds.has(dayId)) throw new Error(`详细排程结果引用未知 Day：${dayId}`);
  const candidates = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const scheduled = new Set(plan.days.flatMap((day) => day.stops.map((stop) => stop.candidateId).filter((id): id is string => Boolean(id))));
  const unscheduledIds = new Set<string>();

  for (const item of unscheduledCandidates) {
    if (unscheduledIds.has(item.candidateId)) throw new Error(`未安排原因重复：${item.candidateId}`);
    if (!candidates.has(item.candidateId)) throw new Error(`未安排原因引用未知 Candidate：${item.candidateId}`);
    if (scheduled.has(item.candidateId)) throw new Error(`Candidate 不能同时已安排和未安排：${item.candidateId}`);
    if (!item.reason.trim()) throw new Error(`未安排原因不能为空：${item.candidateId}`);
    unscheduledIds.add(item.candidateId);
  }
}

export function detailedReplacementCommandsPhase5V3(trip: TripDetailV3, updates: DetailedDayUpdate[]) {
  const next = applyDetailedUpdatesPhase5V3(trip, updates, false);
  const nextByDay = new Map(next.days.map((day) => [day.id, day]));
  const targetIds = new Set(updates.map((update) => update.dayId));
  const commands: PlanCommand[] = [];

  for (const before of trip.plan.days) {
    if (!targetIds.has(before.id)) continue;
    const after = nextByDay.get(before.id)!;
    const working = before.stops.map((stop) => structuredClone(stop));
    for (let index = 0; index < after.stops.length; index += 1) {
      const desired = after.stops[index];
      const matchIndex = working.findIndex((stop, currentIndex) => currentIndex >= index && stop.candidateId === desired.candidateId);
      if (matchIndex >= 0) {
        if (matchIndex !== index) {
          const [moved] = working.splice(matchIndex, 1);
          working.splice(index, 0, moved);
          commands.push(PlanCommandSchema.parse({ type: "move_day_stop", stopId: moved.id, targetDayId: before.id, targetIndex: index }));
        }
        const current = working[index];
        const changes: Record<string, unknown> = {};
        for (const key of ["activity", "period", "scheduleText", "startTime", "endTime", "durationMinutes", "transportFromPrevious", "scheduleVerification", "costNote", "costVerification", "notes"] as const) {
          if (JSON.stringify(current[key] ?? null) !== JSON.stringify(desired[key] ?? null)) changes[key] = structuredClone(desired[key]);
        }
        if (Object.keys(changes).length) commands.push(PlanCommandSchema.parse({ type: "update_day_stop", stopId: current.id, changes }));
      } else {
        commands.push(PlanCommandSchema.parse({ type: "add_day_stop", dayId: before.id, index, stop: desired }));
        working.splice(index, 0, desired);
      }
    }
    for (let index = working.length - 1; index >= after.stops.length; index -= 1) commands.push(PlanCommandSchema.parse({ type: "remove_day_stop", stopId: working[index].id }));
  }

  if (commands.length > 100) throw new Error(`详细行程局部更新需要 ${commands.length} 条命令，超过单次 Proposal 的 100 条资源上限；请缩小 affectedDayIds。`);
  return { commands, plan: next, affectedDayIds: [...targetIds] };
}
