import type { Place, PlanningRole, TripCandidate } from "./contracts-v2.js";

export type PlanningRoleContextV3 = {
  places: Place[];
  candidates: TripCandidate[];
};

export function effectivePlanningRole(candidate: TripCandidate, place: Place): PlanningRole {
  if (candidate.planningRole) return candidate.planningRole;
  return place.kind === "city" ? "planning_area" : "detail_interest";
}

export function isPlanningAreaCandidate(candidate: TripCandidate, place: Place): boolean {
  return effectivePlanningRole(candidate, place) === "planning_area";
}

export function isCoreVisitCandidate(candidate: TripCandidate, place: Place): boolean {
  return effectivePlanningRole(candidate, place) === "core_visit";
}

export function isDetailInterestCandidate(candidate: TripCandidate, place: Place): boolean {
  return effectivePlanningRole(candidate, place) === "detail_interest";
}

export function planningAreaParent(candidate: TripCandidate, candidates: Iterable<TripCandidate>): TripCandidate | null {
  if (!candidate.planningAreaCandidateId) return null;
  for (const item of candidates) {
    if (item.id === candidate.planningAreaCandidateId) return item;
  }
  return null;
}

function normalizeRoleContext(
  contextOrCandidates: PlanningRoleContextV3 | TripCandidate[],
  places?: Place[],
): PlanningRoleContextV3 {
  if (Array.isArray(contextOrCandidates)) return { candidates: contextOrCandidates, places: places ?? [] };
  return contextOrCandidates;
}

function activeCandidatesByRole(
  contextOrCandidates: PlanningRoleContextV3 | TripCandidate[],
  role: PlanningRole,
  places?: Place[],
): TripCandidate[] {
  const context = normalizeRoleContext(contextOrCandidates, places);
  const placesById = new Map(context.places.map((place) => [place.id, place]));
  return context.candidates.filter((candidate) => {
    if (candidate.preference === "excluded") return false;
    const place = placesById.get(candidate.placeId);
    return Boolean(place && effectivePlanningRole(candidate, place) === role);
  });
}

export function activePlanningAreas(context: PlanningRoleContextV3): TripCandidate[];
export function activePlanningAreas(candidates: TripCandidate[], places: Place[]): TripCandidate[];
export function activePlanningAreas(contextOrCandidates: PlanningRoleContextV3 | TripCandidate[], places?: Place[]): TripCandidate[] {
  return activeCandidatesByRole(contextOrCandidates, "planning_area", places);
}

export function activeCoreVisits(context: PlanningRoleContextV3): TripCandidate[];
export function activeCoreVisits(candidates: TripCandidate[], places: Place[]): TripCandidate[];
export function activeCoreVisits(contextOrCandidates: PlanningRoleContextV3 | TripCandidate[], places?: Place[]): TripCandidate[] {
  return activeCandidatesByRole(contextOrCandidates, "core_visit", places);
}

export function activeDetailInterests(context: PlanningRoleContextV3): TripCandidate[];
export function activeDetailInterests(candidates: TripCandidate[], places: Place[]): TripCandidate[];
export function activeDetailInterests(contextOrCandidates: PlanningRoleContextV3 | TripCandidate[], places?: Place[]): TripCandidate[] {
  return activeCandidatesByRole(contextOrCandidates, "detail_interest", places);
}
