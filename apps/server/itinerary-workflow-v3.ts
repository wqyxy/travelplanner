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
import {
  effectivePlanningRole,
  isPlanningAreaCandidate,
} from "./planning-roles-v3.js";
import {
  computeMacroDependencyFingerprintV3,
  derivePlanMacroBasisStateV3,
} from "./planning-state-v3.js";
import type {
  OmittedPlanningArea,
  SkeletonPlanDraft,
  SkeletonStayDraft,
} from "./skeleton-contracts-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

export type SkeletonDraftInspectionV3 = {
  expectedDays: number | null;
  allocatedDays: number;
  remainingDays: number | null;
  representedPlanningAreaIds: string[];
  omittedPlanningAreaIds: string[];
  issues: string[];
  blockingIssues: string[];
  advisoryIssues: string[];
  canSave: boolean;
};

export type FormalizedSkeletonStayV3 = SkeletonStayDraft & {
  stayBlockId: string;
  occurrence: number;
};

export type SkeletonMacroDiffV3 = {
  days: Day[];
  affectedDayIds: string[];
  reusedDayIds: string[];
  newDayIds: string[];
  removedDayIds: string[];
};

export function expectedDayCountV3(plan: TravelPlanDocument) {
  if (plan.trip.dates.start && plan.trip.dates.end) {
    const total = Math.floor((Date.parse(`${plan.trip.dates.end}T00:00:00Z`) - Date.parse(`${plan.trip.dates.start}T00:00:00Z`)) / 86_400_000) + 1;
    return total > 0 ? total : plan.trip.dates.requestedDurationDays;
  }
  return plan.trip.dates.requestedDurationDays;
}

function dateAt(plan: TravelPlanDocument, index: number) {
  return plan.trip.dates.start
    ? new Date(Date.parse(`${plan.trip.dates.start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10)
    : null;
}

function placesById(plan: TravelPlanDocument) {
  return new Map(plan.places.map((place) => [place.id, place]));
}

function planningAreaCandidates(plan: TravelPlanDocument) {
  const places = placesById(plan);
  return plan.candidates.filter((candidate) => {
    const place = places.get(candidate.placeId);
    return Boolean(place && effectivePlanningRole(candidate, place) === "planning_area");
  });
}

function planningAreaMap(plan: TravelPlanDocument) {
  const places = placesById(plan);
  return new Map(planningAreaCandidates(plan).map((candidate) => [candidate.id, {
    candidate,
    place: places.get(candidate.placeId)!,
  }]));
}

export function inspectSkeletonEditDraftV3(plan: TravelPlanDocument, draft: SkeletonPlanDraft): SkeletonDraftInspectionV3 {
  const expectedDays = expectedDayCountV3(plan);
  const allocatedDays = draft.stays.reduce((sum, stay) => sum + stay.stayDays, 0);
  const remainingDays = expectedDays === null ? null : expectedDays - allocatedDays;
  const areas = planningAreaMap(plan);
  const represented = new Set<string>();
  const omitted = new Set<string>();
  const blockingIssues: string[] = [];
  const advisoryIssues: string[] = [];

  for (const stay of draft.stays) {
    const area = areas.get(stay.planningAreaCandidateId);
    if (!area) {
      blockingIssues.push(`路线引用未知 Planning Area：${stay.planningAreaCandidateId}`);
      continue;
    }
    represented.add(stay.planningAreaCandidateId);
    if (area.candidate.preference === "excluded") {
      advisoryIssues.push(`已标记为“不考虑”的停留区域仍进入路线：${stay.planningAreaCandidateId}；内容将按用户当前方案保留。`);
    }
  }

  for (const item of draft.omittedPlanningAreas) {
    if (omitted.has(item.candidateId)) blockingIssues.push(`同一个停留区域只能省略一次：${item.candidateId}`);
    omitted.add(item.candidateId);
    if (represented.has(item.candidateId)) blockingIssues.push(`同一个停留区域不能在同一份提交中既进入路线又被声明省略：${item.candidateId}`);
    const area = areas.get(item.candidateId);
    if (!area) {
      blockingIssues.push(`省略列表引用未知 Planning Area：${item.candidateId}`);
      continue;
    }
    if (area.candidate.preference === "must_go") advisoryIssues.push(`“必去”停留区域当前被省略：${item.candidateId}；内容将保留并提示用户。`);
  }

  for (const [candidateId, area] of areas) {
    if (!represented.has(candidateId) && !omitted.has(candidateId)) {
      advisoryIssues.push(`停留区域尚未明确进入路线或省略：${candidateId}。`);
    }
    if (area.candidate.preference === "must_go" && !represented.has(candidateId)) {
      advisoryIssues.push(`“必去”停留区域尚未进入 Stay Block：${candidateId}。`);
    }
  }

  if (expectedDays === null) advisoryIssues.push("旅行总天数尚未明确，当前路线天数仍可保存。");
  else if (allocatedDays !== expectedDays) advisoryIssues.push(`当前分配 ${allocatedDays} 天，旅行计划参考天数为 ${expectedDays} 天；两者不一致但允许保存。`);

  const uniqueBlocking = [...new Set(blockingIssues)];
  const uniqueAdvisory = [...new Set(advisoryIssues)];
  return {
    expectedDays,
    allocatedDays,
    remainingDays,
    representedPlanningAreaIds: [...represented],
    omittedPlanningAreaIds: [...omitted],
    issues: [...uniqueBlocking, ...uniqueAdvisory],
    blockingIssues: uniqueBlocking,
    advisoryIssues: uniqueAdvisory,
    canSave: uniqueBlocking.length === 0,
  };
}

export function validateSkeletonCoverageV3(plan: TravelPlanDocument, draft: SkeletonPlanDraft) {
  const inspection = inspectSkeletonEditDraftV3(plan, draft);
  if (inspection.blockingIssues.length) throw new Error(inspection.blockingIssues[0]);
  return inspection;
}

type ExistingBlockV3 = {
  planningAreaCandidateId: string;
  stayBlockId: string | null;
  occurrence: number;
  days: Day[];
};

function planningAreaCandidateForPlace(plan: TravelPlanDocument, placeId: string | null) {
  if (!placeId) return null;
  const places = placesById(plan);
  return plan.candidates.find((candidate) => {
    const place = places.get(candidate.placeId);
    return candidate.placeId === placeId && place && isPlanningAreaCandidate(candidate, place);
  }) ?? null;
}

export function deriveExistingStayBlocksV3(plan: TravelPlanDocument): ExistingBlockV3[] {
  const blocks: ExistingBlockV3[] = [];
  const occurrences = new Map<string, number>();

  for (const day of plan.days) {
    const area = planningAreaCandidateForPlace(plan, day.endAnchor.placeId);
    if (!area) continue;
    const previous = blocks.at(-1);
    const canJoin = previous
      && previous.planningAreaCandidateId === area.id
      && ((day.stayBlockId && previous.stayBlockId === day.stayBlockId)
        || (!day.stayBlockId && !previous.stayBlockId));
    if (canJoin) {
      previous.days.push(day);
      continue;
    }
    const occurrence = occurrences.get(area.id) ?? 0;
    occurrences.set(area.id, occurrence + 1);
    blocks.push({
      planningAreaCandidateId: area.id,
      stayBlockId: day.stayBlockId ?? null,
      occurrence,
      days: [day],
    });
  }

  return blocks;
}

function stayNeighborArea(stays: SkeletonStayDraft[], index: number, offset: -1 | 1) {
  return stays[index + offset]?.planningAreaCandidateId ?? null;
}

function blockNeighborArea(blocks: ExistingBlockV3[], index: number, offset: -1 | 1) {
  return blocks[index + offset]?.planningAreaCandidateId ?? null;
}

function existingBlockTransferMode(block: ExistingBlockV3) {
  return block.days[0]?.transferMode ?? "none";
}

function stayBlockMatchScoreV3(
  existing: ExistingBlockV3[],
  existingIndex: number,
  stays: SkeletonStayDraft[],
  stayIndex: number,
) {
  const block = existing[existingIndex];
  const stay = stays[stayIndex];
  if (block.planningAreaCandidateId !== stay.planningAreaCandidateId) return null;

  let score = 100;
  const previousBlockArea = blockNeighborArea(existing, existingIndex, -1);
  const previousStayArea = stayNeighborArea(stays, stayIndex, -1);
  const nextBlockArea = blockNeighborArea(existing, existingIndex, 1);
  const nextStayArea = stayNeighborArea(stays, stayIndex, 1);

  if (previousBlockArea === previousStayArea) score += 80;
  else if (previousBlockArea && previousStayArea) score -= 20;
  if (nextBlockArea === nextStayArea) score += 80;
  else if (nextBlockArea && nextStayArea) score -= 20;

  const dayDelta = Math.abs(block.days.length - stay.stayDays);
  score += Math.max(0, 40 - dayDelta * 10);
  if (existingBlockTransferMode(block) === stay.transferModeFromPrevious) score += 20;
  if (block.stayBlockId) score += 5;
  score += Math.max(0, 10 - Math.abs(existingIndex - stayIndex));
  return score;
}

function matchExistingStayBlocksV3(existing: ExistingBlockV3[], stays: SkeletonStayDraft[]) {
  const pairs: Array<{ existingIndex: number; stayIndex: number; score: number }> = [];
  for (let existingIndex = 0; existingIndex < existing.length; existingIndex += 1) {
    for (let stayIndex = 0; stayIndex < stays.length; stayIndex += 1) {
      const score = stayBlockMatchScoreV3(existing, existingIndex, stays, stayIndex);
      if (score !== null) pairs.push({ existingIndex, stayIndex, score });
    }
  }
  pairs.sort((left, right) => right.score - left.score
    || Math.abs(left.existingIndex - left.stayIndex) - Math.abs(right.existingIndex - right.stayIndex)
    || left.existingIndex - right.existingIndex
    || left.stayIndex - right.stayIndex);

  const usedExisting = new Set<number>();
  const usedStays = new Set<number>();
  const matches = new Map<number, ExistingBlockV3>();
  for (const pair of pairs) {
    if (usedExisting.has(pair.existingIndex) || usedStays.has(pair.stayIndex)) continue;
    usedExisting.add(pair.existingIndex);
    usedStays.add(pair.stayIndex);
    matches.set(pair.stayIndex, existing[pair.existingIndex]);
  }
  return matches;
}

export function formalizeStayBlockIdsV3(plan: TravelPlanDocument, stays: SkeletonStayDraft[]): FormalizedSkeletonStayV3[] {
  const existing = deriveExistingStayBlocksV3(plan);
  const matches = matchExistingStayBlocksV3(existing, stays);
  const occurrences = new Map<string, number>();

  return stays.map((stay, index) => {
    const occurrence = occurrences.get(stay.planningAreaCandidateId) ?? 0;
    occurrences.set(stay.planningAreaCandidateId, occurrence + 1);
    const match = matches.get(index);
    return {
      ...stay,
      occurrence,
      stayBlockId: match?.stayBlockId ?? randomUUID(),
    };
  });
}

export function expandSkeletonDaysV3(plan: TravelPlanDocument, stays: FormalizedSkeletonStayV3[]): Day[] {
  const areas = planningAreaMap(plan);
  const result: Day[] = [];
  let previousPlaceId = plan.trip.originPlaceId;

  for (const stay of stays) {
    const area = areas.get(stay.planningAreaCandidateId);
    if (!area) throw new Error(`路线引用未知 Planning Area：${stay.planningAreaCandidateId}`);
    const place = area.place;
    for (let localDay = 0; localDay < stay.stayDays; localDay += 1) {
      const arrivalDay = localDay === 0;
      const startPlaceId = arrivalDay ? (previousPlaceId ?? area.candidate.placeId) : area.candidate.placeId;
      const endPlaceId = area.candidate.placeId;
      const transferMode = startPlaceId !== endPlaceId ? stay.transferModeFromPrevious : "none";
      const index = result.length;
      result.push({
        id: randomUUID(),
        dayNumber: index + 1,
        date: dateAt(plan, index),
        title: startPlaceId !== endPlaceId ? `前往${place.nameZh}` : place.nameZh,
        stayBlockId: stay.stayBlockId,
        transferMode,
        detailLevel: "planned",
        detailStatus: null,
        startAnchor: { id: randomUUID(), placeId: startPlaceId, label: null, notes: null },
        stops: [],
        endAnchor: { id: randomUUID(), placeId: endPlaceId, label: null, notes: null },
      });
    }
    previousPlaceId = area.candidate.placeId;
  }

  return result;
}

function macroSignature(day: Day) {
  return `${day.startAnchor.placeId ?? ""}|${day.endAnchor.placeId ?? ""}|${day.transferMode}`;
}

function dayBlockMetadata(plan: TravelPlanDocument, days: Day[]) {
  const occurrenceByArea = new Map<string, number>();
  const localIndexByBlock = new Map<string, number>();
  let previousAreaId: string | null = null;
  let previousBlockKey: string | null = null;
  return days.map((day) => {
    const area = planningAreaCandidateForPlace(plan, day.endAnchor.placeId);
    const areaId = area?.id ?? null;
    let occurrence = 0;
    let blockKey = day.stayBlockId ?? "";
    if (areaId) {
      const sameLegacyBlock = !day.stayBlockId && previousAreaId === areaId && previousBlockKey?.startsWith(`legacy:${areaId}:`);
      if (sameLegacyBlock) {
        blockKey = previousBlockKey!;
        occurrence = Number(blockKey.split(":").at(-1) ?? 0);
      } else {
        occurrence = occurrenceByArea.get(areaId) ?? 0;
        occurrenceByArea.set(areaId, occurrence + 1);
        if (!blockKey) blockKey = `legacy:${areaId}:${occurrence}`;
      }
    }
    const localIndex = localIndexByBlock.get(blockKey) ?? 0;
    localIndexByBlock.set(blockKey, localIndex + 1);
    previousAreaId = areaId;
    previousBlockKey = blockKey;
    return { day, areaId, occurrence, blockKey, localIndex };
  });
}

export function diffMacroDaysV3(plan: TravelPlanDocument, desired: Day[]): SkeletonMacroDiffV3 {
  const existingMeta = dayBlockMetadata(plan, plan.days);
  const desiredMeta = dayBlockMetadata({ ...plan, days: desired }, desired);
  const unused = new Set(plan.days.map((day) => day.id));
  const existingById = new Map(plan.days.map((day) => [day.id, day]));
  const existingIndex = new Map(plan.days.map((day, index) => [day.id, index]));
  const affected = new Set<string>();
  const reused = new Set<string>();
  const created = new Set<string>();

  const take = (predicate: (meta: (typeof existingMeta)[number]) => boolean) => {
    const match = existingMeta.find((meta) => unused.has(meta.day.id) && predicate(meta));
    if (match) unused.delete(match.day.id);
    return match ?? null;
  };

  const days = desiredMeta.map((target, index): Day => {
    let match = take((meta) => Boolean(target.day.stayBlockId) && meta.day.stayBlockId === target.day.stayBlockId && meta.localIndex === target.localIndex);
    if (!match) match = take((meta) => meta.areaId === target.areaId && meta.occurrence === target.occurrence && meta.localIndex === target.localIndex);
    if (!match) match = take((meta) => macroSignature(meta.day) === macroSignature(target.day));
    if (!match) match = take((meta) => meta.day.endAnchor.placeId === target.day.endAnchor.placeId);

    if (!match) {
      created.add(target.day.id);
      affected.add(target.day.id);
      return target.day;
    }

    const before = existingById.get(match.day.id)!;
    reused.add(before.id);
    const structureChanged = macroSignature(before) !== macroSignature(target.day)
      || before.stayBlockId !== target.day.stayBlockId
      || before.date !== target.day.date
      || existingIndex.get(before.id) !== index;
    if (structureChanged) affected.add(before.id);

    const sameStartPlace = before.startAnchor.placeId === target.day.startAnchor.placeId;
    const sameEndPlace = before.endAnchor.placeId === target.day.endAnchor.placeId;
    return {
      ...structuredClone(before),
      id: before.id,
      dayNumber: index + 1,
      date: target.day.date,
      title: target.day.title,
      stayBlockId: target.day.stayBlockId,
      transferMode: target.day.transferMode,
      detailStatus: structureChanged && before.detailLevel === "detailed" ? "needs_review" : before.detailStatus,
      startAnchor: sameStartPlace
        ? structuredClone(before.startAnchor)
        : { ...target.day.startAnchor, id: before.startAnchor.id },
      endAnchor: sameEndPlace
        ? structuredClone(before.endAnchor)
        : { ...target.day.endAnchor, id: before.endAnchor.id },
    };
  });

  return {
    days,
    affectedDayIds: [...affected],
    reusedDayIds: [...reused],
    newDayIds: [...created],
    removedDayIds: [...unused],
  };
}

export function applySkeletonPlanV3(trip: TripDetailV3, draft: SkeletonPlanDraft) {
  validateSkeletonCoverageV3(trip.plan, draft);
  const formalizedStays = formalizeStayBlockIdsV3(trip.plan, draft.stays);
  const desired = expandSkeletonDaysV3(trip.plan, formalizedStays);
  const diff = diffMacroDaysV3(trip.plan, desired);
  const stage = trip.plan.days.length && trip.plan.stage !== "place_selection"
    ? trip.plan.stage
    : "itinerary_planning";
  const plan = TravelPlanDocumentSchema.parse({
    ...trip.plan,
    stage,
    days: diff.days,
    planningState: {
      macroBasisVersion: 1,
      macroBasisFingerprint: computeMacroDependencyFingerprintV3(trip.plan),
    },
  });
  return { plan, formalizedStays, ...diff };
}

function legacyDraftFromVisits(plan: TravelPlanDocument, visits: ItineraryMacroVisit[]): SkeletonPlanDraft {
  const represented = new Set(visits.map((visit) => visit.destinationCandidateId));
  const omittedPlanningAreas: OmittedPlanningArea[] = planningAreaCandidates(plan)
    .filter((candidate) => !represented.has(candidate.id))
    .map((candidate) => ({ candidateId: candidate.id, reason: "兼容旧 Macro 输出时未采用该停留区域。" }));
  return {
    stays: visits.map((visit) => ({
      planningAreaCandidateId: visit.destinationCandidateId,
      stayDays: visit.stayDays,
      transferModeFromPrevious: visit.transferMode,
    })),
    omittedPlanningAreas,
  };
}

/** @deprecated Phase 2 keeps this adapter only for callers that still emit the legacy Macro visit shape. */
export function buildMacroDaysV3(trip: TripDetailV3, visits: ItineraryMacroVisit[]): Day[] {
  return applySkeletonPlanV3({ ...trip, plan: { ...trip.plan, days: [] } }, legacyDraftFromVisits(trip.plan, visits)).plan.days;
}

/** @deprecated Skeleton saves use applySkeletonPlanV3 directly and are not constrained by PlanCommand batch size. */
export function macroReplacementCommandsV3(trip: TripDetailV3, visits: ItineraryMacroVisit[]) {
  const next = applySkeletonPlanV3(trip, legacyDraftFromVisits(trip.plan, visits));
  const currentById = new Map(trip.plan.days.map((day) => [day.id, day]));
  const desiredIds = next.plan.days.map((day) => day.id);
  const workingIds = trip.plan.days.map((day) => day.id);
  const commands: PlanCommand[] = [];

  desiredIds.forEach((id, index) => {
    const currentIndex = workingIds.indexOf(id);
    if (currentIndex >= 0 && currentIndex !== index) {
      workingIds.splice(currentIndex, 1);
      workingIds.splice(index, 0, id);
      commands.push(PlanCommandSchema.parse({ type: "move_day", dayId: id, targetIndex: index }));
    }
  });

  for (const after of next.plan.days) {
    const before = currentById.get(after.id);
    if (!before) continue;
    if (before.title !== after.title || before.transferMode !== after.transferMode) {
      commands.push(PlanCommandSchema.parse({ type: "update_day", dayId: after.id, changes: {
        ...(before.title !== after.title ? { title: after.title } : {}),
        ...(before.transferMode !== after.transferMode ? { transferMode: after.transferMode } : {}),
      } }));
    }
    if (before.startAnchor.placeId !== after.startAnchor.placeId) commands.push(PlanCommandSchema.parse({ type: "set_day_anchor", dayId: after.id, anchor: "start", placeId: after.startAnchor.placeId, label: after.startAnchor.label, notes: after.startAnchor.notes }));
    if (before.endAnchor.placeId !== after.endAnchor.placeId) commands.push(PlanCommandSchema.parse({ type: "set_day_anchor", dayId: after.id, anchor: "end", placeId: after.endAnchor.placeId, label: after.endAnchor.label, notes: after.endAnchor.notes }));
  }

  if (commands.length > 100) throw new Error(`旧兼容 Proposal 需要 ${commands.length} 条命令；请改用 applySkeletonPlanV3 原子保存。`);
  return { commands, affectedDayIds: next.affectedDayIds };
}

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
    scheduleText: draft.scheduleText ?? existing?.scheduleText ?? null,
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
    return { ...structuredClone(day), detailLevel: "detailed", detailStatus: "ready", stops };
  });
  return TravelPlanDocumentSchema.parse({ ...trip.plan, stage: "itinerary_refinement", days });
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

export function deriveItineraryUpdateStateV3(plan: TravelPlanDocument) {
  const basisState = plan.days.length ? derivePlanMacroBasisStateV3(plan) : "current";
  const macroNeedsUpdate = Boolean(plan.days.length) && basisState !== "current";
  const affected = new Set(plan.days.filter((day) => day.detailStatus === "needs_review").map((day) => day.id));

  return {
    macro: { status: macroNeedsUpdate ? "needs_update" as const : "ready" as const },
    detail: { status: affected.size ? "needs_update" as const : "ready" as const, affectedDayIds: [...affected] },
  };
}
