import { randomUUID } from "node:crypto";
import {
  PlanCommandSchema,
  TravelPlanDocumentSchema,
  type Day,
  type DayStop,
  type PlanCommand,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import type { DetailedDayUpdate, ItineraryMacroVisit } from "./ai-action-contracts-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

function expectedDayCount(plan: TravelPlanDocument) {
  if (plan.trip.dates.start && plan.trip.dates.end) return Math.floor((Date.parse(`${plan.trip.dates.end}T00:00:00Z`) - Date.parse(`${plan.trip.dates.start}T00:00:00Z`)) / 86_400_000) + 1;
  return plan.trip.dates.requestedDurationDays;
}

function dateAt(plan: TravelPlanDocument, index: number) {
  return plan.trip.dates.start
    ? new Date(Date.parse(`${plan.trip.dates.start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10)
    : null;
}

function macroCandidates(plan: TravelPlanDocument) {
  const places = new Map(plan.places.map((place) => [place.id, place]));
  return plan.candidates.filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city");
}

function validateMacroVisits(plan: TravelPlanDocument, visits: ItineraryMacroVisit[]) {
  const macros = new Map(macroCandidates(plan).map((candidate) => [candidate.id, candidate]));
  const returned = new Set(visits.map((visit) => visit.destinationCandidateId));
  if (returned.size !== visits.length) throw new Error("行程骨架重复使用了同一个目的地。");
  for (const visit of visits) if (!macros.has(visit.destinationCandidateId)) throw new Error(`行程骨架引用未知或已排除目的地：${visit.destinationCandidateId}`);
  if (returned.size !== macros.size || [...macros.keys()].some((id) => !returned.has(id))) throw new Error("行程骨架必须覆盖全部当前有效目的地，且每个目的地只能出现一次。");
  const expected = expectedDayCount(plan);
  const actual = visits.reduce((sum, visit) => sum + visit.stayDays, 0);
  if (expected !== null && actual !== expected) throw new Error(`行程骨架停留天数合计为 ${actual} 天，但旅行要求为 ${expected} 天。`);
  return macros;
}

export function buildMacroDaysV3(trip: TripDetailV3, visits: ItineraryMacroVisit[]): Day[] {
  const macros = validateMacroVisits(trip.plan, visits);
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const result: Day[] = [];
  let previousPlaceId = trip.plan.trip.originPlaceId;

  for (const visit of visits) {
    const candidate = macros.get(visit.destinationCandidateId)!;
    const place = places.get(candidate.placeId)!;
    for (let localDay = 0; localDay < visit.stayDays; localDay += 1) {
      const arrivalDay = localDay === 0;
      const startPlaceId = arrivalDay ? (previousPlaceId ?? candidate.placeId) : candidate.placeId;
      const endPlaceId = candidate.placeId;
      const transferMode = startPlaceId !== endPlaceId ? visit.transferMode : "none";
      const index = result.length;
      result.push({
        id: randomUUID(),
        dayNumber: index + 1,
        date: dateAt(trip.plan, index),
        title: startPlaceId !== endPlaceId ? `前往${place.nameZh}` : place.nameZh,
        transferMode,
        detailLevel: "planned",
        detailStatus: null,
        startAnchor: { id: randomUUID(), placeId: startPlaceId, label: null, notes: null },
        stops: [],
        endAnchor: { id: randomUUID(), placeId: endPlaceId, label: null, notes: null },
      });
    }
    previousPlaceId = candidate.placeId;
  }
  return TravelPlanDocumentSchema.parse({ ...trip.plan, stage: "itinerary_planning", days: result }).days;
}

function macroSignature(day: Day) {
  return `${day.startAnchor.placeId ?? ""}|${day.endAnchor.placeId ?? ""}|${day.transferMode}`;
}

export function macroReplacementCommandsV3(trip: TripDetailV3, visits: ItineraryMacroVisit[]) {
  const desired = buildMacroDaysV3(trip, visits);
  if (desired.length !== trip.plan.days.length) throw new Error("更新行程骨架必须保持旅行总 Day 数不变。");

  const unused = [...trip.plan.days];
  const desiredIds: string[] = [];
  const desiredById = new Map<string, Day>();
  const affectedDayIds = new Set<string>();

  for (const target of desired) {
    let index = unused.findIndex((day) => macroSignature(day) === macroSignature(target));
    if (index < 0) index = unused.findIndex((day) => day.endAnchor.placeId === target.endAnchor.placeId);
    if (index < 0) index = 0;
    const [reused] = unused.splice(index, 1);
    desiredIds.push(reused.id);
    desiredById.set(reused.id, target);
    if (macroSignature(reused) !== macroSignature(target)) affectedDayIds.add(reused.id);
  }

  const workingIds = trip.plan.days.map((day) => day.id);
  const commands: PlanCommand[] = [];
  for (let index = 0; index < desiredIds.length; index += 1) {
    const id = desiredIds[index];
    const currentIndex = workingIds.indexOf(id);
    if (currentIndex !== index) {
      workingIds.splice(currentIndex, 1);
      workingIds.splice(index, 0, id);
      commands.push(PlanCommandSchema.parse({ type: "move_day", dayId: id, targetIndex: index }));
    }
  }

  const currentById = new Map(trip.plan.days.map((day) => [day.id, day]));
  for (const id of desiredIds) {
    const before = currentById.get(id)!;
    const after = desiredById.get(id)!;
    if (before.title !== after.title || before.transferMode !== after.transferMode) {
      commands.push(PlanCommandSchema.parse({ type: "update_day", dayId: id, changes: { ...(before.title !== after.title ? { title: after.title } : {}), ...(before.transferMode !== after.transferMode ? { transferMode: after.transferMode } : {}) } }));
    }
    if (before.startAnchor.placeId !== after.startAnchor.placeId) {
      commands.push(PlanCommandSchema.parse({ type: "set_day_anchor", dayId: id, anchor: "start", placeId: after.startAnchor.placeId, label: after.startAnchor.label, notes: after.startAnchor.notes }));
      affectedDayIds.add(id);
    }
    if (before.endAnchor.placeId !== after.endAnchor.placeId) {
      commands.push(PlanCommandSchema.parse({ type: "set_day_anchor", dayId: id, anchor: "end", placeId: after.endAnchor.placeId, label: after.endAnchor.label, notes: after.endAnchor.notes }));
      affectedDayIds.add(id);
    }
  }

  if (commands.length > 100) throw new Error(`行程骨架局部更新需要 ${commands.length} 条命令，超过单次 Proposal 的 100 条上限。`);
  return { commands, affectedDayIds: [...affectedDayIds] };
}

function stopForDraft(trip: TripDetailV3, day: Day, draft: DetailedDayUpdate["stops"][number], existing: DayStop | undefined): DayStop {
  const candidates = new Map(trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const candidate = candidates.get(draft.candidateId);
  if (!candidate || candidate.preference === "excluded") throw new Error(`详细行程引用未知或已排除 Candidate：${draft.candidateId}`);
  const place = places.get(candidate.placeId);
  if (!place || place.kind === "city") throw new Error(`详细行程只能把具体兴趣点作为 Stop：${draft.candidateId}`);
  const allowedMacroIds = new Set(trip.plan.candidates.filter((macro) => [day.startAnchor.placeId, day.endAnchor.placeId].includes(macro.placeId)).map((macro) => macro.id));
  if (candidate.planningAreaCandidateId && !allowedMacroIds.has(candidate.planningAreaCandidateId)) throw new Error(`Candidate ${draft.candidateId} 不属于 Day ${day.dayNumber} 的起点或终点目的地。`);
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

function assertMustGoScheduled(plan: TravelPlanDocument) {
  const places = new Map(plan.places.map((place) => [place.id, place]));
  const scheduled = new Set(plan.days.flatMap((day) => day.stops.map((stop) => stop.candidateId).filter((id): id is string => Boolean(id))));
  const missing = plan.candidates.filter((candidate) => candidate.preference === "must_go" && places.get(candidate.placeId)?.kind !== "city" && !scheduled.has(candidate.id));
  if (missing.length) throw new Error(`以下“必去”兴趣点尚未排入详细行程：${missing.map((candidate) => places.get(candidate.placeId)?.nameZh ?? candidate.id).join("、")}`);
}

export function applyDetailedUpdatesV3(trip: TripDetailV3, updates: DetailedDayUpdate[], requireAllDays: boolean) {
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
  assertMustGoScheduled(plan);
  return plan;
}

export function detailedReplacementCommandsV3(trip: TripDetailV3, updates: DetailedDayUpdate[]) {
  const next = applyDetailedUpdatesV3(trip, updates, false);
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

export function deriveItineraryUpdateStateV3(plan: TravelPlanDocument) {
  const macros = macroCandidates(plan);
  const macroPlaceIds = new Set(macros.map((candidate) => candidate.placeId));
  const represented = new Set(plan.days.map((day) => day.endAnchor.placeId).filter((id): id is string => Boolean(id) && macroPlaceIds.has(id)));
  const macroNeedsUpdate = Boolean(plan.days.length) && (represented.size !== macroPlaceIds.size || [...macroPlaceIds].some((id) => !represented.has(id)));

  const places = new Map(plan.places.map((place) => [place.id, place]));
  const scheduled = new Set(plan.days.flatMap((day) => day.stops.map((stop) => stop.candidateId).filter((id): id is string => Boolean(id))));
  const affected = new Set(plan.days.filter((day) => day.detailStatus === "needs_review").map((day) => day.id));
  for (const candidate of plan.candidates) {
    if (candidate.preference !== "must_go" || places.get(candidate.placeId)?.kind === "city" || scheduled.has(candidate.id)) continue;
    const parent = plan.candidates.find((item) => item.id === candidate.planningAreaCandidateId);
    if (!parent) continue;
    for (const day of plan.days) if (day.startAnchor.placeId === parent.placeId || day.endAnchor.placeId === parent.placeId) affected.add(day.id);
  }

  return {
    macro: { status: macroNeedsUpdate ? "needs_update" as const : "ready" as const },
    detail: { status: affected.size ? "needs_update" as const : "ready" as const, affectedDayIds: [...affected] },
  };
}
