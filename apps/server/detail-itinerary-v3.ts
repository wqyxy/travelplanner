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
import { effectivePlanningRole } from "./planning-roles-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

export type DetailedUnscheduledCandidateV3 = { candidateId: string; reason: string };

function planningAreaCandidateForPlace(plan: TravelPlanDocument, placeId: string | null) {
  if (!placeId) return null;
  const places = new Map(plan.places.map((place) => [place.id, place]));
  return plan.candidates.find((candidate) => {
    const place = places.get(candidate.placeId);
    return candidate.placeId === placeId && place && effectivePlanningRole(candidate, place) === "planning_area";
  }) ?? null;
}

function stopForDraft(trip: TripDetailV3, day: Day, draft: DetailedDayUpdate["stops"][number], existing: DayStop | undefined): DayStop {
  const candidates = new Map(trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const candidate = candidates.get(draft.candidateId);
  if (!candidate || candidate.preference === "excluded") throw new Error(`详细行程引用未知或已排除 Candidate：${draft.candidateId}`);
  const place = places.get(candidate.placeId);
  if (!place || place.kind === "city") throw new Error(`详细行程只能把具体兴趣点作为 Stop：${draft.candidateId}`);
  const role = effectivePlanningRole(candidate, place);
  if (role !== "core_visit" && role !== "detail_interest") throw new Error(`详细行程只能安排重要游览地或普通兴趣点：${draft.candidateId}`);
  const allowedAreaIds = new Set([day.startAnchor.placeId, day.endAnchor.placeId].flatMap((placeId) => {
    const area = planningAreaCandidateForPlace(trip.plan, placeId);
    return area ? [area.id] : [];
  }));
  if (!candidate.planningAreaCandidateId || !allowedAreaIds.has(candidate.planningAreaCandidateId)) {
    throw new Error(`Candidate ${draft.candidateId} 不属于 Day ${day.dayNumber} 的可用停留区域。`);
  }
  return {
    id: existing?.id ?? randomUUID(),
    candidateId: candidate.id,
    placeId: candidate.placeId,
    activity: draft.activity,
    period: draft.period,
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

function validateNoOverlap(day: Day) {
  for (let index = 1; index < day.stops.length; index += 1) {
    const previous = day.stops[index - 1];
    const current = day.stops[index];
    if (previous.endTime && current.startTime && current.startTime < previous.endTime) throw new Error(`Day ${day.dayNumber} 的 Stop 时间发生重叠。`);
  }
}

function ownerAreaIdsForDays(plan: TravelPlanDocument, targetDayIds: Set<string>) {
  const areaIds = new Set<string>();
  for (const day of plan.days) {
    if (!targetDayIds.has(day.id)) continue;
    const area = planningAreaCandidateForPlace(plan, day.endAnchor.placeId);
    if (area) areaIds.add(area.id);
  }
  return areaIds;
}

function assertScopedMustGoScheduled(plan: TravelPlanDocument, targetDayIds: Set<string>) {
  const places = new Map(plan.places.map((place) => [place.id, place]));
  const scheduled = new Set(plan.days.flatMap((day) => day.stops.map((stop) => stop.candidateId).filter((id): id is string => Boolean(id))));
  const areaIds = ownerAreaIdsForDays(plan, targetDayIds);
  const missing = plan.candidates.filter((candidate) => {
    const place = places.get(candidate.placeId);
    if (!place || candidate.preference !== "must_go" || scheduled.has(candidate.id) || !candidate.planningAreaCandidateId || !areaIds.has(candidate.planningAreaCandidateId)) return false;
    const role = effectivePlanningRole(candidate, place);
    return role === "core_visit" || role === "detail_interest";
  });
  if (missing.length) throw new Error(`以下“必去”地点尚未排入相关每日行程：${missing.map((candidate) => places.get(candidate.placeId)?.nameZh ?? candidate.id).join("、")}`);
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
    const detailed: Day = { ...structuredClone(day), detailLevel: "detailed", detailStatus: "ready", stops };
    validateNoOverlap(detailed);
    return detailed;
  });
  const plan = TravelPlanDocumentSchema.parse({ ...trip.plan, stage: "itinerary_refinement", days });
  const targetDayIds = requireAllDays ? new Set(plan.days.map((day) => day.id)) : new Set(updateByDay.keys());
  assertScopedMustGoScheduled(plan, targetDayIds);
  return plan;
}

export function validateDetailedSchedulingOutcomeV3(
  plan: TravelPlanDocument,
  unscheduledCandidates: DetailedUnscheduledCandidateV3[],
  targetDayIds: string[],
  unavailableCandidateIds: string[] = [],
) {
  const targetSet = new Set(targetDayIds);
  const unavailable = new Set(unavailableCandidateIds);
  const knownDayIds = new Set(plan.days.map((day) => day.id));
  for (const dayId of targetSet) if (!knownDayIds.has(dayId)) throw new Error(`详细排程结果引用未知 Day：${dayId}`);
  const ownerAreaIds = ownerAreaIdsForDays(plan, targetSet);
  const candidates = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const places = new Map(plan.places.map((place) => [place.id, place]));
  const scheduled = new Set(plan.days.flatMap((day) => day.stops.map((stop) => stop.candidateId).filter((id): id is string => Boolean(id))));
  const unscheduledIds = new Set<string>();

  for (const item of unscheduledCandidates) {
    if (unscheduledIds.has(item.candidateId)) throw new Error(`未安排原因重复：${item.candidateId}`);
    const candidate = candidates.get(item.candidateId);
    const place = candidate ? places.get(candidate.placeId) : null;
    if (!candidate || !place || candidate.preference === "excluded") throw new Error(`未安排原因引用未知或已排除 Candidate：${item.candidateId}`);
    const role = effectivePlanningRole(candidate, place);
    if (role !== "core_visit" && role !== "detail_interest") throw new Error(`Planning Area 不得进入详细行程未安排说明：${item.candidateId}`);
    if (!candidate.planningAreaCandidateId || !ownerAreaIds.has(candidate.planningAreaCandidateId)) throw new Error(`未安排原因超出当前 Detailed scope：${item.candidateId}`);
    if (candidate.preference === "must_go") throw new Error(`必去地点不得作为未安排结果：${item.candidateId}`);
    if (scheduled.has(candidate.id)) throw new Error(`Candidate 不能同时已安排和未安排：${item.candidateId}`);
    if (!item.reason.trim()) throw new Error(`未安排原因不能为空：${item.candidateId}`);
    unscheduledIds.add(item.candidateId);
  }

  for (const candidate of plan.candidates) {
    const place = places.get(candidate.placeId);
    if (!place || unavailable.has(candidate.id) || candidate.preference !== "want_to_go" || !candidate.planningAreaCandidateId || !ownerAreaIds.has(candidate.planningAreaCandidateId)) continue;
    if (effectivePlanningRole(candidate, place) !== "core_visit" || scheduled.has(candidate.id) || unscheduledIds.has(candidate.id)) continue;
    throw new Error(`想去的重要游览地未安排时必须说明原因：${place.nameZh}`);
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
        for (const key of ["activity", "period", "startTime", "endTime", "durationMinutes", "transportFromPrevious", "scheduleVerification", "costNote", "costVerification", "notes"] as const) {
          if (JSON.stringify(current[key]) !== JSON.stringify(desired[key])) changes[key] = structuredClone(desired[key]);
        }
        if (Object.keys(changes).length) commands.push(PlanCommandSchema.parse({ type: "update_day_stop", stopId: current.id, changes }));
      } else {
        commands.push(PlanCommandSchema.parse({ type: "add_day_stop", dayId: before.id, index, stop: desired }));
        working.splice(index, 0, desired);
      }
    }
    for (let index = working.length - 1; index >= after.stops.length; index -= 1) commands.push(PlanCommandSchema.parse({ type: "remove_day_stop", stopId: working[index].id }));
  }

  if (commands.length > 100) throw new Error(`详细行程局部更新需要 ${commands.length} 条命令，超过单次 Proposal 的 100 条上限；请缩小 affectedDayIds。`);
  return { commands, plan: next, affectedDayIds: [...targetIds] };
}
