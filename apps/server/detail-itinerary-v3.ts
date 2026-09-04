import { randomUUID } from "node:crypto";
import {
  PlanCommandSchema,
  TravelPlanDocumentSchema,
  type Day,
  type DayStop,
  type PlanCommand,
} from "./contracts-v2.js";
import type { DetailedDayUpdate } from "./ai-action-contracts-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

export type DetailedUnscheduledCandidateV3 = { candidateId: string; reason: string };

function stopForDraft(trip: TripDetailV3, _day: Day, draft: DetailedDayUpdate["stops"][number], existing: DayStop | undefined): DayStop {
  const candidates = new Map(trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const candidate = candidates.get(draft.candidateId);
  if (!candidate) throw new Error(`详细行程引用未知 Candidate：${draft.candidateId}`);
  const place = places.get(candidate.placeId);
  if (!place) throw new Error(`详细行程 Candidate 引用未知 Place：${draft.candidateId}`);
  return {
    id: existing?.id ?? randomUUID(),
    candidateId: candidate.id,
    placeId: candidate.placeId,
    activity: draft.activity,
    period: draft.period,
    // `null` is an explicit AI instruction to clear a legacy natural-language
    // schedule.  Only an omitted field inherits the sticky value.
    scheduleText: Object.hasOwn(draft, "scheduleText")
      ? draft.scheduleText ?? null
      : existing?.scheduleText ?? null,
    startTime: draft.startTime,
    endTime: draft.endTime,
    durationMinutes: draft.durationMinutes,
    transportFromPrevious: draft.transportFromPrevious,
    scheduleVerification: draft.scheduleVerification,
    costNote: draft.costNote,
    costVerification: draft.costVerification,
    notes: draft.notes,
  };
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
  return TravelPlanDocumentSchema.parse({ ...trip.plan, stage: "itinerary_refinement", days });
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
