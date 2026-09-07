import type { AiActionRecord } from "./ai-stage-contracts-v3.js";
import type { PlaceResolution } from "./contracts-v2.js";
import type { DayRouteServiceV2 } from "./day-route-v2.js";
import { deriveItineraryUpdateStateV3 } from "./itinerary-workflow-v3.js";
import {
  buildBackboneContextV3,
  buildDetailPlanningContextV3,
  buildSkeletonContextV3,
  interestDiscoveryReadinessV3,
} from "./planning-context-v3.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";
import { currentResolvedPlaces } from "./planner-resolution-state-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

type RouteStatesV3 = ReturnType<DayRouteServiceV2["workspaceRouteState"]>;
type MacroRouteStatesV3 = ReturnType<DayRouteServiceV2["workspaceMacroRouteState"]>;

function assertDetailPlanningBlockers(_context: ReturnType<typeof buildDetailPlanningContextV3>) {
  // Planning readiness is advisory-only. Structural target/reference checks are
  // performed by the concrete action and canonical schemas.
}

export function buildPlannerActionStateV3(input: {
  action: AiActionRecord;
  trip: TripDetailV3;
  resolutions: PlaceResolution[];
  routeStates: () => RouteStatesV3;
  macroRouteStates: () => MacroRouteStatesV3;
}) {
  const { action, trip, resolutions } = input;
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const currentResolutions = currentResolvedPlaces(trip, resolutions);
  const resolutionByPlace = new Map(currentResolutions.map((resolution) => [resolution.placeId, resolution]));
  const candidateState = (candidate: TripDetailV3["plan"]["candidates"][number]) => ({
    ...candidate,
    place: places.get(candidate.placeId) ?? null,
    resolution: resolutionByPlace.get(candidate.placeId) ?? null,
  });
  const base = {
    actionType: action.actionType,
    baseGeneration: action.baseGeneration,
    planLanguage: trip.planLanguage,
    parameters: action.parameters,
    targetIds: action.targetIds,
  };

  if (action.actionType.startsWith("destination.")) {
    const backbone = buildBackboneContextV3(trip.plan);
    const backboneCandidates = trip.plan.candidates.filter((candidate) => {
      const place = places.get(candidate.placeId);
      return Boolean(place && effectivePlanningRole(candidate, place) !== "detail_interest");
    }).map(candidateState);
    return { ...base, ...backbone, backboneCandidates };
  }

  if (action.actionType.startsWith("interest.")) {
    const capacityAware = action.actionType === "interest.discover" || action.actionType === "interest.supplement";
    if (capacityAware) {
      const readiness = interestDiscoveryReadinessV3(trip.plan);
      const targetIds = action.targetIds.length ? [...new Set(action.targetIds)] : readiness.adoptedPlanningAreaIds;
      return {
        ...base,
        tripFacts: trip.plan.trip,
        targetMacroCandidateIds: targetIds,
        interestDiscoveryReadiness: readiness,
      };
    }
    const targetIds = action.targetIds.length
      ? action.targetIds
      : trip.plan.candidates.filter((candidate) => {
          const place = places.get(candidate.placeId);
          return candidate.preference !== "excluded"
            && Boolean(place)
            && effectivePlanningRole(candidate, place!) === "planning_area";
        }).map((candidate) => candidate.id);
    return { ...base, tripFacts: trip.plan.trip, targetMacroCandidateIds: targetIds };
  }

  if (action.actionType === "itinerary.generate" || action.actionType === "itinerary.replan") {
    const skeleton = buildSkeletonContextV3(trip.plan);
    return {
      ...base,
      ...skeleton,
      stage: trip.plan.stage,
      macroUpdateState: deriveItineraryUpdateStateV3(trip.plan).macro,
    };
  }

  if (action.actionType === "itinerary.detail.generate") {
    const detail = buildDetailPlanningContextV3(trip.plan, resolutions);
    assertDetailPlanningBlockers(detail);
    const targetSet = new Set(detail.targetDayIds);
    return {
      ...base,
      ...detail,
      stage: trip.plan.stage,
      allMacroDays: trip.plan.days.map((day) => ({
        id: day.id,
        dayNumber: day.dayNumber,
        date: day.date,
        title: day.title,
        stayBlockId: day.stayBlockId ?? null,
        transferMode: day.transferMode,
        startAnchor: day.startAnchor,
        endAnchor: day.endAnchor,
      })),
      routeStates: input.routeStates().filter((route) => targetSet.has(route.dayId)),
      macroRouteStates: input.macroRouteStates().filter((route) => targetSet.has(route.dayId)),
    };
  }

  if (action.actionType === "itinerary.day.optimize" || action.actionType === "itinerary.refine") {
    const requested = action.actionType === "itinerary.day.optimize"
      ? [String(action.parameters.dayId ?? action.targetIds[0] ?? "")].filter(Boolean)
      : (Array.isArray(action.parameters.dayIds) && action.parameters.dayIds.length
          ? action.parameters.dayIds.map(String).slice(0, 2)
          : action.targetIds.length
            ? action.targetIds.slice(0, 2)
            : trip.plan.days
                .filter((day) => day.detailLevel !== "detailed" || day.detailStatus !== "ready")
                .slice(0, 2)
                .map((day) => day.id));
    if (!requested.length) throw new Error("单日 AI Action 缺少目标 Day。");
    const targetDays = requested.map((dayId) => {
      const day = trip.plan.days.find((item) => item.id === dayId);
      if (!day) throw new Error(`未知 Day：${dayId}`);
      return day;
    });
    const targetIndexes = targetDays.map((day) => trip.plan.days.findIndex((item) => item.id === day.id));
    const adjacentIds = new Set<string>();
    for (const index of targetIndexes) {
      if (trip.plan.days[index - 1]) adjacentIds.add(trip.plan.days[index - 1].id);
      if (trip.plan.days[index + 1]) adjacentIds.add(trip.plan.days[index + 1].id);
    }
    for (const day of targetDays) adjacentIds.delete(day.id);
    const candidateIds = new Set(targetDays.flatMap((day) => day.stops
      .map((stop) => stop.candidateId)
      .filter((id): id is string => Boolean(id))));
    const routeStates = input.routeStates();
    return {
      ...base,
      tripFacts: trip.plan.trip,
      stage: trip.plan.stage,
      targetDayIds: targetDays.map((day) => day.id),
      days: targetDays,
      adjacentDays: trip.plan.days.filter((day) => adjacentIds.has(day.id)).map((day) => ({
        id: day.id,
        dayNumber: day.dayNumber,
        date: day.date,
        title: day.title,
        startPlaceId: day.startAnchor.placeId,
        endPlaceId: day.endAnchor.placeId,
        stopPlaceIds: day.stops.map((stop) => stop.placeId),
      })),
      candidates: trip.plan.candidates.filter((candidate) => candidateIds.has(candidate.id)).map(candidateState),
      routeStates: routeStates.filter((route) => requested.includes(route.dayId) || adjacentIds.has(route.dayId)),
    };
  }

  if (action.actionType === "itinerary.detail.update") {
    const derived = deriveItineraryUpdateStateV3(trip.plan).detail.affectedDayIds;
    const requested = Array.isArray(action.parameters.dayIds) && action.parameters.dayIds.length
      ? action.parameters.dayIds.map(String)
      : action.targetIds.length
        ? action.targetIds
        : derived;
    if (!requested.length) throw new Error("当前没有需要局部更新的 Day。");
    const detail = buildDetailPlanningContextV3(trip.plan, resolutions, requested);
    assertDetailPlanningBlockers(detail);
    const requestedSet = new Set(requested);
    return {
      ...base,
      ...detail,
      stage: trip.plan.stage,
      affectedDayIds: requested,
      allMacroDays: trip.plan.days.map((day) => ({
        id: day.id,
        dayNumber: day.dayNumber,
        date: day.date,
        title: day.title,
        stayBlockId: day.stayBlockId ?? null,
        transferMode: day.transferMode,
        startAnchor: day.startAnchor,
        endAnchor: day.endAnchor,
      })),
      routeStates: input.routeStates().filter((route) => requestedSet.has(route.dayId)),
      macroRouteStates: input.macroRouteStates().filter((route) => requestedSet.has(route.dayId)),
    };
  }

  if (action.actionType.startsWith("itinerary.")) {
    return {
      ...base,
      tripFacts: trip.plan.trip,
      stage: trip.plan.stage,
      candidates: trip.plan.candidates.map(candidateState),
      days: trip.plan.days,
      routeStates: input.routeStates(),
      macroRouteStates: input.macroRouteStates(),
      itineraryUpdateState: deriveItineraryUpdateStateV3(trip.plan),
    };
  }

  return base;
}
