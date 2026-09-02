import { createHash } from "node:crypto";
import type { TravelPlanDocument } from "./contracts-v2.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";

export type MacroBasisStateV3 = "current" | "dirty" | "needs_confirmation";

export function deriveMacroBasisStateV3(
  macroBasisFingerprint: string | null | undefined,
  currentMacroDependencyFingerprint: string,
): MacroBasisStateV3 {
  if (!macroBasisFingerprint) return "needs_confirmation";
  return macroBasisFingerprint === currentMacroDependencyFingerprint ? "current" : "dirty";
}

export function isMacroDirtyV3(
  macroBasisFingerprint: string | null | undefined,
  currentMacroDependencyFingerprint: string,
): boolean {
  return deriveMacroBasisStateV3(macroBasisFingerprint, currentMacroDependencyFingerprint) === "dirty";
}

export function macroDependencyFingerprintInputV3(plan: TravelPlanDocument) {
  const places = new Map(plan.places.map((place) => [place.id, place]));
  const planningAreas: Array<Record<string, unknown>> = [];
  const coreVisits: Array<Record<string, unknown>> = [];

  for (const candidate of plan.candidates) {
    const place = places.get(candidate.placeId);
    if (!place) continue;
    const role = effectivePlanningRole(candidate, place);
    if (role === "planning_area") {
      planningAreas.push({
        candidateId: candidate.id,
        placeId: candidate.placeId,
        preference: candidate.preference,
        role,
      });
    } else if (role === "core_visit") {
      coreVisits.push({
        candidateId: candidate.id,
        placeId: candidate.placeId,
        planningAreaCandidateId: candidate.planningAreaCandidateId,
        preference: candidate.preference,
        suggestedDurationMinutes: candidate.suggestedDurationMinutes,
        role,
      });
    }
  }

  planningAreas.sort((left, right) => String(left.candidateId).localeCompare(String(right.candidateId)));
  coreVisits.sort((left, right) => String(left.candidateId).localeCompare(String(right.candidateId)));

  return {
    dates: plan.trip.dates,
    originPlaceId: plan.trip.originPlaceId,
    transportPreference: plan.trip.brief.transport,
    pace: plan.trip.pace,
    travelers: plan.trip.travelers,
    themes: [...plan.trip.themes],
    preferences: [...plan.trip.preferences],
    constraints: [...plan.trip.constraints],
    additionalRequirements: plan.trip.brief.additionalRequirements,
    planningAreas,
    coreVisits,
  };
}

export function computeMacroDependencyFingerprintV3(plan: TravelPlanDocument): string {
  const serialized = JSON.stringify(macroDependencyFingerprintInputV3(plan));
  return `macro-v1:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

export function derivePlanMacroBasisStateV3(plan: TravelPlanDocument): MacroBasisStateV3 {
  return deriveMacroBasisStateV3(
    plan.planningState?.macroBasisFingerprint,
    computeMacroDependencyFingerprintV3(plan),
  );
}
