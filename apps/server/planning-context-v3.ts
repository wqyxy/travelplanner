import type { PlaceResolution, TravelPlanDocument } from "./contracts-v2.js";
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
import { resolutionIsCurrent } from "./place-resolver-v2.js";

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

function planningAreaCandidateForPlace(plan: TravelPlanDocument, placeId: string | null) {
  if (!placeId) return null;
  const places = new Map(plan.places.map((place) => [place.id, place]));
  return plan.candidates.find((candidate) => {
    const place = places.get(candidate.placeId);
    return candidate.placeId === placeId && place && effectivePlanningRole(candidate, place) === "planning_area";
  }) ?? null;
}

function currentResolutionByPlace(plan: TravelPlanDocument, resolutions: PlaceResolution[]) {
  const places = new Map(plan.places.map((place) => [place.id, place]));
  return new Map(resolutions.flatMap((resolution) => {
    const place = places.get(resolution.placeId);
    return place && resolutionIsCurrent(place, resolution) ? [[resolution.placeId, resolution] as const] : [];
  }));
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
    // Kept as informational compatibility state. A false value is no longer a
    // permission gate for an explicitly targeted interest action.
    ready: plan.days.length > 0 && macroBasisState === "current" && adoptedPlanningAreaIds.length > 0,
    macroBasisState,
    adoptedPlanningAreaIds,
  };
}

export function buildInterestAreaContextV3(plan: TravelPlanDocument, planningAreaCandidateId: string) {
  const readiness = interestDiscoveryReadinessV3(plan);
  const candidate = plan.candidates.find((item) => item.id === planningAreaCandidateId);
  const place = candidate ? plan.places.find((item) => item.id === candidate.placeId) : null;
  if (!candidate || !place || effectivePlanningRole(candidate, place) !== "planning_area") {
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
    planningAreaAdopted: readiness.adoptedPlanningAreaIds.includes(planningAreaCandidateId),
    totalStayDays: stayBlocks.reduce((sum, block) => sum + block.stayDays, 0),
    arrivalTransferDayCount: stayBlocks.filter((block) => block.arrivalTransfer?.hasArrivalTransfer).length,
    stayBlocks,
    coreVisits: children.filter((item) => item.role === "core_visit").map((item) => candidateSummary(plan, item.candidate)).filter(Boolean),
    existingDetailInterests: children.filter((item) => item.role === "detail_interest").map((item) => candidateSummary(plan, item.candidate)).filter(Boolean),
    macroBasisState: readiness.macroBasisState,
  };
}

export type DetailPlanningIssueV3 = {
  type: "anchor_unresolved" | "must_go_unresolved";
  dayIds: string[];
  placeId: string;
  candidateId: string | null;
  planningRole: "core_visit" | "detail_interest" | null;
};

export function detailPlanningReadinessV3(
  plan: TravelPlanDocument,
  resolutions: PlaceResolution[],
  requestedDayIds: string[] = plan.days.map((day) => day.id),
) {
  const macroBasisState = plan.days.length ? derivePlanMacroBasisStateV3(plan) : "needs_confirmation" as const;
  const knownDayIds = new Set(plan.days.map((day) => day.id));
  const targetIds = [...new Set(requestedDayIds)];
  for (const dayId of targetIds) if (!knownDayIds.has(dayId)) throw new Error(`详细行程引用未知 Day：${dayId}`);
  const targetDays = plan.days.filter((day) => targetIds.includes(day.id));
  const currentResolutions = currentResolutionByPlace(plan, resolutions);
  const advisoryIssues: DetailPlanningIssueV3[] = [];

  for (const day of targetDays) {
    for (const placeId of new Set([day.startAnchor.placeId, day.endAnchor.placeId].filter((value): value is string => Boolean(value)))) {
      if (currentResolutions.get(placeId)?.status === "resolved") continue;
      advisoryIssues.push({ type: "anchor_unresolved", dayIds: [day.id], placeId, candidateId: null, planningRole: null });
    }
  }

  const ownerAreaByDay = new Map(targetDays.map((day) => [day.id, planningAreaCandidateForPlace(plan, day.endAnchor.placeId)]));
  const targetAreaIds = new Set([...ownerAreaByDay.values()].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate)).map((candidate) => candidate.id));
  const places = new Map(plan.places.map((place) => [place.id, place]));
  for (const candidate of plan.candidates) {
    const place = places.get(candidate.placeId);
    if (!place || candidate.preference !== "must_go" || !candidate.planningAreaCandidateId || !targetAreaIds.has(candidate.planningAreaCandidateId)) continue;
    const role = effectivePlanningRole(candidate, place);
    if (role !== "core_visit" && role !== "detail_interest") continue;
    if (currentResolutions.get(candidate.placeId)?.status === "resolved") continue;
    const dayIds = targetDays.filter((day) => ownerAreaByDay.get(day.id)?.id === candidate.planningAreaCandidateId).map((day) => day.id);
    advisoryIssues.push({ type: "must_go_unresolved", dayIds, placeId: candidate.placeId, candidateId: candidate.id, planningRole: role });
  }

  return {
    ready: plan.days.length > 0,
    macroBasisState,
    requiresWorkflowStep: plan.days.length === 0 ? "skeleton" as const : null,
    targetDayIds: targetIds,
    blockingIssues: [] as DetailPlanningIssueV3[],
    advisoryIssues,
  };
}

export function buildDetailPlanningContextV3(
  plan: TravelPlanDocument,
  resolutions: PlaceResolution[],
  requestedDayIds: string[] = plan.days.map((day) => day.id),
) {
  const readiness = detailPlanningReadinessV3(plan, resolutions, requestedDayIds);
  const targetSet = new Set(readiness.targetDayIds);
  const targetDays = plan.days.filter((day) => targetSet.has(day.id));
  const places = new Map(plan.places.map((place) => [place.id, place]));
  const currentResolutions = currentResolutionByPlace(plan, resolutions);
  const accessibleAreaIds = new Set<string>();
  const ownerAreaIds = new Set<string>();

  for (const day of targetDays) {
    const owner = planningAreaCandidateForPlace(plan, day.endAnchor.placeId);
    if (owner) ownerAreaIds.add(owner.id);
    for (const placeId of [day.startAnchor.placeId, day.endAnchor.placeId]) {
      const area = planningAreaCandidateForPlace(plan, placeId);
      if (area) accessibleAreaIds.add(area.id);
    }
  }

  const concreteCandidates = plan.candidates.flatMap((candidate) => {
    const place = places.get(candidate.placeId);
    if (!place) return [];
    const role = effectivePlanningRole(candidate, place);
    if (role !== "core_visit" && role !== "detail_interest") return [];
    const belongsToAccessibleArea = Boolean(candidate.planningAreaCandidateId && accessibleAreaIds.has(candidate.planningAreaCandidateId));
    const alreadyScheduledInTarget = targetDays.some((day) => day.stops.some((stop) => stop.candidateId === candidate.id));
    const unparented = candidate.planningAreaCandidateId === null;
    if (!belongsToAccessibleArea && !alreadyScheduledInTarget && !unparented) return [];
    const summary = candidateSummary(plan, candidate);
    if (!summary) return [];
    const resolution = currentResolutions.get(candidate.placeId) ?? null;
    return [{
      ...summary,
      resolutionStatus: resolution?.status ?? "unresolved",
      resolved: resolution?.status === "resolved",
    }];
  });

  const blocks = deriveExistingStayBlocksV3(plan).filter((block) => block.days.some((day) => targetSet.has(day.id)));
  return {
    tripFacts: plan.trip,
    pace: plan.trip.pace,
    detailReadiness: readiness,
    targetDayIds: readiness.targetDayIds,
    stayBlocks: blocks.map((block) => ({
      stayBlockId: block.stayBlockId,
      occurrence: block.occurrence,
      planningAreaCandidateId: block.planningAreaCandidateId,
      dayIds: block.days.map((day) => day.id),
      stayDays: block.days.length,
    })),
    days: targetDays.map((day) => ({
      id: day.id,
      dayNumber: day.dayNumber,
      date: day.date,
      title: day.title,
      stayBlockId: day.stayBlockId ?? null,
      transferMode: day.transferMode,
      startAnchor: day.startAnchor,
      endAnchor: day.endAnchor,
      planningAreaCandidateId: planningAreaCandidateForPlace(plan, day.endAnchor.placeId)?.id ?? null,
      detailLevel: day.detailLevel,
      detailStatus: day.detailStatus,
      stickyBaseline: day.stops.map((stop) => structuredClone(stop)),
    })),
    planningAreas: plan.candidates.filter((candidate) => accessibleAreaIds.has(candidate.id)).map((candidate) => candidateSummary(plan, candidate)).filter(Boolean),
    candidates: concreteCandidates,
    // These are prioritization hints for the AI, not canonical requirements.
    preferredMustGoCandidateIds: concreteCandidates.filter((candidate) => candidate.preference === "must_go" && candidate.planningAreaCandidateId && ownerAreaIds.has(candidate.planningAreaCandidateId)).map((candidate) => candidate.id),
    priorityCoreCandidateIds: concreteCandidates.filter((candidate) => candidate.planningRole === "core_visit" && candidate.preference === "want_to_go" && candidate.planningAreaCandidateId && ownerAreaIds.has(candidate.planningAreaCandidateId)).map((candidate) => candidate.id),
    unresolvedCandidateIds: concreteCandidates.filter((candidate) => !candidate.resolved).map((candidate) => candidate.id),
    requiredMustGoCandidateIds: [] as string[],
    unavailableCandidateIds: [] as string[],
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