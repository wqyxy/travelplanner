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

export function adoptedPlanningAreaIdsV3(plan: TravelPlanDocument) {
  return [...new Set(deriveExistingStayBlocksV3(plan).map((block) => block.planningAreaCandidateId))];
}

export function interestDiscoveryReadinessV3(plan: TravelPlanDocument) {
  const macroBasisState = plan.days.length ? derivePlanMacroBasisStateV3(plan) : "needs_confirmation" as const;
  const adoptedPlanningAreaIds = adoptedPlanningAreaIdsV3(plan);
  return {
    ready: plan.days.length > 0 && macroBasisState === "current" && adoptedPlanningAreaIds.length > 0,
    macroBasisState,
    adoptedPlanningAreaIds,
  };
}

export function buildInterestAreaContextV3(plan: TravelPlanDocument, planningAreaCandidateId: string) {
  const readiness = interestDiscoveryReadinessV3(plan);
  if (!readiness.ready) throw new Error("路线和天数尚未处于可用于兴趣点研究的已确认状态。");
  if (!readiness.adoptedPlanningAreaIds.includes(planningAreaCandidateId)) throw new Error(`兴趣点研究只能针对路线中已采用的停留区域：${planningAreaCandidateId}`);

  const candidate = plan.candidates.find((item) => item.id === planningAreaCandidateId);
  const place = candidate ? plan.places.find((item) => item.id === candidate.placeId) : null;
  if (!candidate || !place || candidate.preference === "excluded" || effectivePlanningRole(candidate, place) !== "planning_area") {
    throw new Error(`兴趣点研究目标不是有效 Planning Area：${planningAreaCandidateId}`);
  }

  const blocks = deriveExistingStayBlocksV3(plan).filter((block) => block.planningAreaCandidateId === planningAreaCandidateId);
  const places = new Map(plan.places.map((item) => [item.id, item]));
  const children = plan.candidates.filter((item) => item.planningAreaCandidateId === planningAreaCandidateId).flatMap((item) => {
    const childPlace = places.get(item.placeId);
    return childPlace ? [{ candidate: item, place: childPlace, role: effectivePlanningRole(item, childPlace) }] : [];
  });

  const stayBlocks = blocks.map((block) => {
    const firstDay = block.days[0];
    const lastDay = block.days.at(-1)!;
    const hasArrivalTransfer = Boolean(firstDay && firstDay.startAnchor.placeId !== firstDay.endAnchor.placeId);
    return {
      stayBlockId: block.stayBlockId,
      occurrence: block.occurrence,
      stayDays: block.days.length,
      firstDayNumber: firstDay?.dayNumber ?? null,
      lastDayNumber: lastDay?.dayNumber ?? null,
      arrivalTransfer: firstDay ? {
        dayId: firstDay.id,
        dayNumber: firstDay.dayNumber,
        hasArrivalTransfer,
        transferMode: firstDay.transferMode,
        fromPlaceId: firstDay.startAnchor.placeId,
        toPlaceId: firstDay.endAnchor.placeId,
      } : null,
    };
  });

  return {
    tripFacts: plan.trip,
    pace: plan.trip.pace,
    planningArea: candidateSummary(plan, candidate),
    totalStayDays: stayBlocks.reduce((sum, block) => sum + block.stayDays, 0),
    arrivalTransferDayCount: stayBlocks.filter((block) => block.arrivalTransfer?.hasArrivalTransfer).length,
    stayBlocks,
    coreVisits: children.filter((item) => item.role === "core_visit").map((item) => candidateSummary(plan, item.candidate)).filter(Boolean),
    existingDetailInterests: children.filter((item) => item.role === "detail_interest").map((item) => candidateSummary(plan, item.candidate)).filter(Boolean),
    macroBasisState: readiness.macroBasisState,
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
