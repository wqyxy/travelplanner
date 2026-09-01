import type { Day, TravelPlanDocument, TripCandidate } from "./contracts-v2.js";

export type PlanningUpdateStatusV3 = "ready" | "needs_update";

export type ItineraryImpactV3 = {
  macro: {
    status: PlanningUpdateStatusV3;
    reasons: string[];
    affectedDayIds: string[];
  };
  detail: {
    status: PlanningUpdateStatusV3;
    reasons: string[];
    affectedDayIds: string[];
    newOptionCandidateIds: string[];
  };
  routes: {
    macroDayIds: string[];
    detailDayIds: string[];
  };
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function placeById(plan: TravelPlanDocument) {
  return new Map(plan.places.map((place) => [place.id, place]));
}

function candidateById(plan: TravelPlanDocument) {
  return new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
}

function activeMacroCandidates(plan: TravelPlanDocument) {
  const places = placeById(plan);
  return plan.candidates.filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city");
}

function macroCandidateForDay(plan: TravelPlanDocument, day: Day) {
  const candidates = activeMacroCandidates(plan);
  return candidates.find((candidate) => candidate.placeId === day.endAnchor.placeId)
    ?? candidates.find((candidate) => candidate.placeId === day.startAnchor.placeId)
    ?? null;
}

function dayIdsForMacroCandidate(plan: TravelPlanDocument, macroCandidateId: string | null) {
  if (!macroCandidateId) return [];
  const macro = plan.candidates.find((candidate) => candidate.id === macroCandidateId);
  if (!macro) return [];
  return plan.days.filter((day) => day.startAnchor.placeId === macro.placeId || day.endAnchor.placeId === macro.placeId).map((day) => day.id);
}

function scheduledCandidateDays(plan: TravelPlanDocument) {
  const result = new Map<string, Set<string>>();
  for (const day of plan.days) {
    for (const stop of day.stops) {
      if (!stop.candidateId) continue;
      const days = result.get(stop.candidateId) ?? new Set<string>();
      days.add(day.id);
      result.set(stop.candidateId, days);
    }
  }
  return result;
}

function candidateChanged(before: TripCandidate | undefined, after: TripCandidate | undefined) {
  return !same(before ?? null, after ?? null);
}

export function analyzeItineraryImpactV3(before: TravelPlanDocument, after: TravelPlanDocument): ItineraryImpactV3 {
  const beforePlaces = placeById(before);
  const afterPlaces = placeById(after);
  const beforeCandidates = candidateById(before);
  const afterCandidates = candidateById(after);
  const beforeScheduled = scheduledCandidateDays(before);
  const afterScheduled = scheduledCandidateDays(after);

  const macroReasons = new Set<string>();
  const macroDayIds = new Set<string>();
  const detailReasons = new Set<string>();
  const detailDayIds = new Set<string>();
  const macroRouteDayIds = new Set<string>();
  const detailRouteDayIds = new Set<string>();
  const newOptionCandidateIds = new Set<string>();

  const beforeMacro = new Map(activeMacroCandidates(before).map((candidate) => [candidate.id, candidate]));
  const afterMacro = new Map(activeMacroCandidates(after).map((candidate) => [candidate.id, candidate]));
  const macroIds = new Set([...beforeMacro.keys(), ...afterMacro.keys()]);

  for (const id of macroIds) {
    const left = beforeMacro.get(id);
    const right = afterMacro.get(id);
    if (!left || !right) {
      macroReasons.add(!left ? `新增目的地 ${id}` : `移除目的地 ${id}`);
      for (const dayId of dayIdsForMacroCandidate(before, id)) macroDayIds.add(dayId);
      for (const dayId of dayIdsForMacroCandidate(after, id)) macroDayIds.add(dayId);
      continue;
    }
    if (left.preference !== right.preference) {
      macroReasons.add(`目的地优先级变化 ${id}`);
      for (const dayId of dayIdsForMacroCandidate(after, id)) macroDayIds.add(dayId);
    }
    const leftPlace = beforePlaces.get(left.placeId);
    const rightPlace = afterPlaces.get(right.placeId);
    if (!same(leftPlace ?? null, rightPlace ?? null)) {
      for (const dayId of dayIdsForMacroCandidate(after, id)) macroRouteDayIds.add(dayId);
    }
  }

  const candidateIds = new Set([...beforeCandidates.keys(), ...afterCandidates.keys()]);
  for (const id of candidateIds) {
    const left = beforeCandidates.get(id);
    const right = afterCandidates.get(id);
    const leftPlace = left ? beforePlaces.get(left.placeId) : null;
    const rightPlace = right ? afterPlaces.get(right.placeId) : null;
    const isMicro = (leftPlace?.kind !== "city" && Boolean(leftPlace)) || (rightPlace?.kind !== "city" && Boolean(rightPlace));
    if (!isMicro || !candidateChanged(left, right)) continue;

    if (!left && right) {
      if (right.preference === "must_go") {
        detailReasons.add(`新增必去兴趣点 ${id}`);
        for (const dayId of dayIdsForMacroCandidate(after, right.planningAreaCandidateId)) detailDayIds.add(dayId);
      } else if (right.preference !== "excluded") {
        newOptionCandidateIds.add(id);
      }
      continue;
    }

    if (left && !right) {
      const usedDays = beforeScheduled.get(id) ?? new Set<string>();
      if (usedDays.size) detailReasons.add(`已排入行程的兴趣点被删除 ${id}`);
      for (const dayId of usedDays) detailDayIds.add(dayId);
      continue;
    }

    if (!left || !right) continue;
    if (right.preference === "excluded" && left.preference !== "excluded") {
      const usedDays = beforeScheduled.get(id) ?? new Set<string>();
      if (usedDays.size) detailReasons.add(`已排入行程的兴趣点改为不去 ${id}`);
      for (const dayId of usedDays) detailDayIds.add(dayId);
    } else if (right.preference === "must_go" && left.preference !== "must_go" && !(afterScheduled.get(id)?.size)) {
      detailReasons.add(`兴趣点改为必去 ${id}`);
      for (const dayId of dayIdsForMacroCandidate(after, right.planningAreaCandidateId)) detailDayIds.add(dayId);
    }

    const leftResolvedIdentity = leftPlace ? { id: leftPlace.id, approximate: leftPlace.approximate, city: leftPlace.city, region: leftPlace.region, country: leftPlace.country } : null;
    const rightResolvedIdentity = rightPlace ? { id: rightPlace.id, approximate: rightPlace.approximate, city: rightPlace.city, region: rightPlace.region, country: rightPlace.country } : null;
    if (!same(leftResolvedIdentity, rightResolvedIdentity)) {
      for (const dayId of afterScheduled.get(id) ?? []) detailRouteDayIds.add(dayId);
    }
  }

  if (macroReasons.size) {
    for (const day of after.days) {
      const macro = macroCandidateForDay(after, day);
      if (!macro || macroDayIds.has(day.id)) continue;
      if (!beforeMacro.has(macro.id)) macroDayIds.add(day.id);
    }
  }

  for (const dayId of detailDayIds) detailRouteDayIds.add(dayId);

  return {
    macro: {
      status: macroReasons.size ? "needs_update" : "ready",
      reasons: [...macroReasons],
      affectedDayIds: [...macroDayIds],
    },
    detail: {
      status: detailReasons.size ? "needs_update" : "ready",
      reasons: [...detailReasons],
      affectedDayIds: [...detailDayIds],
      newOptionCandidateIds: [...newOptionCandidateIds],
    },
    routes: {
      macroDayIds: [...macroRouteDayIds, ...macroDayIds].filter((id, index, values) => values.indexOf(id) === index),
      detailDayIds: [...detailRouteDayIds],
    },
  };
}
