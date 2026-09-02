import type { TravelPlanDocument } from "./contracts-v2.js";
import { deriveExistingStayBlocksV3 } from "./itinerary-workflow-v3.js";
import {
  activeCoreVisits,
  activePlanningAreas,
  effectivePlanningRole,
} from "./planning-roles-v3.js";
import {
  computeMacroDependencyFingerprintV3,
  derivePlanMacroBasisStateV3,
} from "./planning-state-v3.js";

function candidateSummary(plan: TravelPlanDocument, candidate: TravelPlanDocument["candidates"][number]) {
  const place = plan.places.find((item) => item.id === candidate.placeId);
  if (!place) return null;
  return {
    id: candidate.id,
    planningAreaCandidateId: candidate.planningAreaCandidateId,
    planningRole: effectivePlanningRole(candidate, place),
    preference: candidate.preference,
    suggestedDurationMinutes: candidate.suggestedDurationMinutes,
    tags: candidate.tags.slice(0, 20),
    place: {
      id: place.id,
      kind: place.kind,
      nameZh: place.nameZh,
      nameLocal: place.nameLocal,
      nameEn: place.nameEn,
      city: place.city,
      region: place.region,
      country: place.country,
      approximate: place.approximate,
    },
  };
}

export function buildBackboneContextV3(plan: TravelPlanDocument) {
  return {
    tripFacts: plan.trip,
    planningAreas: activePlanningAreas(plan.candidates, plan.places).map((candidate) => candidateSummary(plan, candidate)).filter(Boolean),
    coreVisits: activeCoreVisits(plan.candidates, plan.places).map((candidate) => candidateSummary(plan, candidate)).filter(Boolean),
  };
}

export function buildSkeletonContextV3(plan: TravelPlanDocument) {
  const blocks = deriveExistingStayBlocksV3(plan);
  const candidates = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const places = new Map(plan.places.map((place) => [place.id, place]));
  return {
    ...buildBackboneContextV3(plan),
    currentStays: blocks.map((block) => {
      const candidate = candidates.get(block.planningAreaCandidateId);
      const place = candidate ? places.get(candidate.placeId) : null;
      const firstDay = block.days[0];
      return {
        planningAreaCandidateId: block.planningAreaCandidateId,
        stayBlockId: block.stayBlockId,
        stayDays: block.days.length,
        transferModeFromPrevious: firstDay?.transferMode ?? "none",
        placeName: place?.nameZh ?? block.planningAreaCandidateId,
      };
    }),
    macroBasisState: plan.days.length ? derivePlanMacroBasisStateV3(plan) : "needs_confirmation",
    currentMacroDependencyFingerprint: computeMacroDependencyFingerprintV3(plan),
    macroBasisFingerprint: plan.planningState?.macroBasisFingerprint ?? null,
  };
}
