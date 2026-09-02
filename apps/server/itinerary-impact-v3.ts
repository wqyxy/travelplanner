import type { Day, Place, TravelPlanDocument, TripCandidate } from "./contracts-v2.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";
import { computeMacroDependencyFingerprintV3 } from "./planning-state-v3.js";

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

function roleOf(candidate: TripCandidate | undefined, place: Place | null | undefined) {
  return candidate && place ? effectivePlanningRole(candidate, place) : null;
}

function activePlanningAreas(plan: TravelPlanDocument) {
  const places = placeById(plan);
  return plan.candidates.filter((candidate) => {
    const place = places.get(candidate.placeId);
    return candidate.preference !== "excluded" && place && effectivePlanningRole(candidate, place) === "planning_area";
  });
}

function planningAreaCandidateForDay(plan: TravelPlanDocument, day: Day) {
  const candidates = activePlanningAreas(plan);
  return candidates.find((candidate) => candidate.placeId === day.endAnchor.placeId)
    ?? candidates.find((candidate) => candidate.placeId === day.startAnchor.placeId)
    ?? null;
}

function dayIdsForPlanningArea(plan: TravelPlanDocument, planningAreaCandidateId: string | null) {
  if (!planningAreaCandidateId) return [];
  const area = plan.candidates.find((candidate) => candidate.id === planningAreaCandidateId);
  if (!area) return [];
  return plan.days.filter((day) => day.startAnchor.placeId === area.placeId || day.endAnchor.placeId === area.placeId).map((day) => day.id);
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

function routeIdentity(place: Place | null | undefined) {
  return place ? {
    id: place.id,
    approximate: place.approximate,
    city: place.city,
    region: place.region,
    country: place.country,
  } : null;
}

function addParentDays(target: Set<string>, plan: TravelPlanDocument, parentId: string | null | undefined) {
  for (const dayId of dayIdsForPlanningArea(plan, parentId ?? null)) target.add(dayId);
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

  const beforeFingerprint = computeMacroDependencyFingerprintV3(before);
  const afterFingerprint = computeMacroDependencyFingerprintV3(after);
  if (beforeFingerprint !== afterFingerprint) macroReasons.add("影响路线和天数的规划依据发生变化");

  const candidateIds = new Set([...beforeCandidates.keys(), ...afterCandidates.keys()]);
  let foundSpecificMacroReason = false;

  for (const id of candidateIds) {
    const left = beforeCandidates.get(id);
    const right = afterCandidates.get(id);
    const leftPlace = left ? beforePlaces.get(left.placeId) : null;
    const rightPlace = right ? afterPlaces.get(right.placeId) : null;
    const leftRole = roleOf(left, leftPlace);
    const rightRole = roleOf(right, rightPlace);
    if (!candidateChanged(left, right) && same(leftPlace ?? null, rightPlace ?? null)) continue;

    const touchesMacroRole = leftRole === "planning_area" || leftRole === "core_visit" || rightRole === "planning_area" || rightRole === "core_visit";
    if (touchesMacroRole) {
      if (!left && right) macroReasons.add(rightRole === "core_visit" ? `新增重要游览地 ${id}` : `新增停留区域 ${id}`);
      else if (left && !right) macroReasons.add(leftRole === "core_visit" ? `移除重要游览地 ${id}` : `移除停留区域 ${id}`);
      else if (leftRole !== rightRole) macroReasons.add(`地点规划角色变化 ${id}`);
      else if (left?.preference !== right?.preference) macroReasons.add(`${rightRole === "core_visit" ? "重要游览地" : "停留区域"}优先级变化 ${id}`);
      else if (leftRole === "core_visit" && (left?.planningAreaCandidateId !== right?.planningAreaCandidateId || left?.suggestedDurationMinutes !== right?.suggestedDurationMinutes)) macroReasons.add(`重要游览地时间容量变化 ${id}`);
      foundSpecificMacroReason = true;

      if (leftRole === "planning_area") addParentDays(macroDayIds, before, left?.id);
      if (rightRole === "planning_area") addParentDays(macroDayIds, after, right?.id);
      if (leftRole === "core_visit") addParentDays(macroDayIds, before, left?.planningAreaCandidateId);
      if (rightRole === "core_visit") addParentDays(macroDayIds, after, right?.planningAreaCandidateId);
    }

    if (leftRole === "planning_area" || rightRole === "planning_area") {
      if (!same(routeIdentity(leftPlace), routeIdentity(rightPlace))) {
        if (left) addParentDays(macroRouteDayIds, before, left.id);
        if (right) addParentDays(macroRouteDayIds, after, right.id);
      }
    }

    const leftDetail = leftRole === "detail_interest";
    const rightDetail = rightRole === "detail_interest";
    if (!leftDetail && !rightDetail) continue;

    if (!left && right && rightDetail) {
      if (right.preference === "must_go") {
        detailReasons.add(`新增必去兴趣点 ${id}`);
        addParentDays(detailDayIds, after, right.planningAreaCandidateId);
      } else if (right.preference !== "excluded") {
        newOptionCandidateIds.add(id);
      }
    } else if (left && !right && leftDetail) {
      const usedDays = beforeScheduled.get(id) ?? new Set<string>();
      if (usedDays.size) detailReasons.add(`已排入行程的兴趣点被删除 ${id}`);
      for (const dayId of usedDays) detailDayIds.add(dayId);
    } else if (left && right && rightDetail) {
      if (right.preference === "excluded" && left.preference !== "excluded") {
        const usedDays = beforeScheduled.get(id) ?? new Set<string>();
        if (usedDays.size) detailReasons.add(`已排入行程的兴趣点改为不去 ${id}`);
        for (const dayId of usedDays) detailDayIds.add(dayId);
      } else if (right.preference === "must_go" && left.preference !== "must_go" && !(afterScheduled.get(id)?.size)) {
        detailReasons.add(`兴趣点改为必去 ${id}`);
        addParentDays(detailDayIds, after, right.planningAreaCandidateId);
      }
    }

    if (!same(routeIdentity(leftPlace), routeIdentity(rightPlace))) {
      for (const dayId of afterScheduled.get(id) ?? []) detailRouteDayIds.add(dayId);
    }
  }

  if (beforeFingerprint !== afterFingerprint && !foundSpecificMacroReason) {
    macroReasons.add("旅行天数、出发地、交通偏好、节奏、同行人或重要偏好发生变化");
    for (const day of after.days) macroDayIds.add(day.id);
  }

  if (macroReasons.size) {
    for (const day of after.days) {
      const area = planningAreaCandidateForDay(after, day);
      if (!area || macroDayIds.has(day.id)) continue;
      const beforeArea = beforeCandidates.get(area.id);
      if (!beforeArea) macroDayIds.add(day.id);
    }
  }

  for (const dayId of detailDayIds) detailRouteDayIds.add(dayId);

  return {
    macro: {
      status: beforeFingerprint !== afterFingerprint ? "needs_update" : "ready",
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
      macroDayIds: [...macroRouteDayIds],
      detailDayIds: [...detailRouteDayIds],
    },
  };
}
