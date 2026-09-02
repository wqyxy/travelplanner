import {
  ConversationStageSchema,
  WorkspaceSelectionV3Schema,
  type ConversationStage,
  type WorkspaceSelectionV3,
} from "./ai-stage-contracts-v3.js";
import type { PlaceResolution } from "./contracts-v2.js";
import { buildSkeletonContextV3 } from "./planning-context-v3.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";
import { resolutionIsCurrent } from "./place-resolver-v2.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

export const STAGE_CONTEXT_MAX_BYTES = 64 * 1024;
export const STAGE_CONTEXT_MAX_PLACES = 240;
export const STAGE_CONTEXT_MAX_DAYS = 90;
const ITINERARY_DETAIL_WINDOW_RADIUS = 1;
const ITINERARY_FALLBACK_STOPS = 20;

function clip(value: string | null, max = 600) { return value && value.length > max ? `${value.slice(0, max)}…` : value; }

function placeSummary(place: TripDetailV3["plan"]["places"][number]) {
  return {
    id: place.id,
    nameZh: place.nameZh,
    nameLocal: place.nameLocal,
    nameEn: place.nameEn,
    kind: place.kind,
    city: place.city,
    region: place.region,
    country: place.country,
    approximate: place.approximate,
  };
}

function candidateSummary(trip: TripDetailV3, candidate: TripDetailV3["plan"]["candidates"][number]) {
  const place = trip.plan.places.find((item) => item.id === candidate.placeId);
  return {
    id: candidate.id,
    planningAreaCandidateId: candidate.planningAreaCandidateId,
    planningRole: place ? effectivePlanningRole(candidate, place) : candidate.planningRole ?? null,
    preference: candidate.preference,
    source: candidate.source,
    aiReason: clip(candidate.aiReason),
    aiScore: candidate.aiScore,
    suggestedDurationMinutes: candidate.suggestedDurationMinutes,
    tags: candidate.tags.slice(0, 20),
    place: place ? placeSummary(place) : null,
  };
}

function routeSummary(route: any) {
  if (!route) return null;
  return {
    dayId: route.dayId,
    status: route.status,
    distanceKm: route.distanceKm,
    durationMinutes: route.durationMinutes,
    warnings: Array.isArray(route.warnings) ? route.warnings.slice(0, 20) : [],
    calculatedAt: route.calculatedAt,
  };
}

function selectedItineraryDayId(trip: TripDetailV3, selection: WorkspaceSelectionV3) {
  if (selection.type === "day") return selection.id;
  if (selection.type === "stop") return trip.plan.days.find((day) => day.stops.some((stop) => stop.id === selection.id))?.id ?? null;
  return null;
}

function dayDetail(trip: TripDetailV3, day: TripDetailV3["plan"]["days"][number], routeMap: Map<string, any>, compact = false) {
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const stops = compact ? day.stops.slice(0, ITINERARY_FALLBACK_STOPS) : day.stops;
  return {
    id: day.id,
    dayNumber: day.dayNumber,
    date: day.date,
    title: day.title,
    stayBlockId: day.stayBlockId ?? null,
    transferMode: day.transferMode,
    detailLevel: day.detailLevel,
    detailStatus: day.detailStatus,
    startAnchor: day.startAnchor,
    stops: stops.map((stop) => ({
      id: stop.id,
      candidateId: stop.candidateId,
      placeId: stop.placeId,
      place: places.get(stop.placeId) ? placeSummary(places.get(stop.placeId)!) : null,
      activity: clip(stop.activity, compact ? 300 : 1200),
      period: stop.period,
      startTime: stop.startTime,
      endTime: stop.endTime,
      durationMinutes: stop.durationMinutes,
      transportFromPrevious: stop.transportFromPrevious,
      scheduleVerification: stop.scheduleVerification,
      costNote: clip(stop.costNote, compact ? 300 : 1000),
      costVerification: stop.costVerification,
      notes: clip(stop.notes, compact ? 300 : 1200),
    })),
    ...(compact && day.stops.length > stops.length ? { omittedStopCount: day.stops.length - stops.length } : {}),
    endAnchor: day.endAnchor,
    route: routeMap.has(day.id) ? { dirty: routeMap.get(day.id)!.dirty, route: routeSummary(routeMap.get(day.id)!.route) } : null,
  };
}

function byteSize(value: unknown) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

function candidateRole(trip: TripDetailV3, candidateId: string) {
  const candidate = trip.plan.candidates.find((item) => item.id === candidateId);
  if (!candidate) return null;
  const place = trip.plan.places.find((item) => item.id === candidate.placeId);
  return place ? effectivePlanningRole(candidate, place) : null;
}

function placeRole(trip: TripDetailV3, placeId: string) {
  const candidate = trip.plan.candidates.find((item) => item.placeId === placeId);
  return candidate ? candidateRole(trip, candidate.id) : null;
}

export function validateSelectionForStage(trip: TripDetailV3, stageValue: unknown, selectionValue: unknown): WorkspaceSelectionV3 {
  const stage = ConversationStageSchema.parse(stageValue);
  const selection = WorkspaceSelectionV3Schema.parse(selectionValue);
  if (stage === "requirements") {
    if (selection.type !== "trip" && selection.type !== "candidate_pool") throw new Error("需求阶段 selection 只能指向整趟旅行。");
    return selection;
  }

  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const candidates = new Map(trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  if (selection.type === "candidate") {
    const candidate = candidates.get(selection.id);
    if (!candidate) throw new Error("selection 引用了未知 Candidate。");
    const role = candidateRole(trip, candidate.id);
    if (stage === "destinations" && role !== "planning_area" && role !== "core_visit") throw new Error("想去哪些地方 / 路线和天数阶段只能选择停留区域或重要游览地。");
    if (stage === "itinerary") throw new Error("行程阶段 selection 不接受 Candidate。");
  }
  if (selection.type === "place") {
    const place = places.get(selection.id);
    if (!place) throw new Error("selection 引用了未知 Place。");
    const role = placeRole(trip, place.id);
    if (stage === "destinations" && role !== "planning_area" && role !== "core_visit") throw new Error("想去哪些地方 / 路线和天数阶段只能选择停留区域或重要游览地。");
    if (stage === "itinerary") throw new Error("行程阶段 selection 不接受独立 Place。");
  }
  if (selection.type === "day") {
    if (stage !== "itinerary" || !trip.plan.days.some((day) => day.id === selection.id)) throw new Error("当前阶段不能选择该 Day。");
  }
  if (selection.type === "stop") {
    if (stage !== "itinerary" || !trip.plan.days.some((day) => day.stops.some((stop) => stop.id === selection.id))) throw new Error("当前阶段不能选择该 Stop。");
  }
  if (stage === "destinations" && selection.type !== "trip" && selection.type !== "candidate_pool" && selection.type !== "candidate" && selection.type !== "place") throw new Error("目的地阶段 selection 越界。");
  if (stage === "interests" && selection.type !== "trip" && selection.type !== "candidate_pool" && selection.type !== "candidate" && selection.type !== "place") throw new Error("兴趣点阶段 selection 越界。");
  if (stage === "itinerary" && selection.type !== "trip" && selection.type !== "day" && selection.type !== "stop") throw new Error("行程阶段 selection 越界。");
  return selection;
}

export function buildStageContext(input: {
  trip: TripDetailV3;
  stage: ConversationStage;
  selection: WorkspaceSelectionV3;
  resolutions?: PlaceResolution[];
  routeStates?: Array<{ dayId: string; dirty: boolean; route: unknown | null }>;
}) {
  const { trip, stage, selection } = input;
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const planningAreas = trip.plan.candidates.filter((candidate) => {
    const place = places.get(candidate.placeId);
    return Boolean(place && effectivePlanningRole(candidate, place) === "planning_area");
  });
  const coreVisits = trip.plan.candidates.filter((candidate) => {
    const place = places.get(candidate.placeId);
    return Boolean(place && effectivePlanningRole(candidate, place) === "core_visit");
  });
  const detailInterests = trip.plan.candidates.filter((candidate) => {
    const place = places.get(candidate.placeId);
    return Boolean(place && effectivePlanningRole(candidate, place) === "detail_interest");
  });
  let state: Record<string, unknown>;

  if (stage === "requirements") {
    state = { stage, baseGeneration: trip.contentGeneration, planLanguage: trip.planLanguage, tripFacts: trip.plan.trip, selection };
  } else if (stage === "destinations") {
    const skeleton = buildSkeletonContextV3(trip.plan);
    state = {
      stage,
      baseGeneration: trip.contentGeneration,
      planLanguage: trip.planLanguage,
      tripFacts: trip.plan.trip,
      destinations: [...planningAreas, ...coreVisits].slice(0, STAGE_CONTEXT_MAX_PLACES).map((candidate) => candidateSummary(trip, candidate)),
      planningAreas: planningAreas.slice(0, STAGE_CONTEXT_MAX_PLACES).map((candidate) => candidateSummary(trip, candidate)),
      coreVisits: coreVisits.slice(0, STAGE_CONTEXT_MAX_PLACES).map((candidate) => candidateSummary(trip, candidate)),
      currentStays: skeleton.currentStays,
      macroBasisState: skeleton.macroBasisState,
      selection,
    };
  } else if (stage === "interests") {
    const resolutionMap = new Map((input.resolutions ?? []).map((resolution) => [resolution.placeId, resolution]));
    const selectedPlanningAreaId = selection.type === "candidate" && planningAreas.some((candidate) => candidate.id === selection.id)
      ? selection.id
      : selection.type === "candidate"
        ? trip.plan.candidates.find((candidate) => candidate.id === selection.id)?.planningAreaCandidateId ?? null
        : null;
    const prioritizedDetails = selectedPlanningAreaId
      ? detailInterests.filter((candidate) => candidate.planningAreaCandidateId === selectedPlanningAreaId)
      : detailInterests;
    state = {
      stage,
      baseGeneration: trip.contentGeneration,
      planLanguage: trip.planLanguage,
      tripFacts: trip.plan.trip,
      destinations: planningAreas.slice(0, 60).map((candidate) => candidateSummary(trip, candidate)),
      coreVisits: coreVisits.slice(0, 120).map((candidate) => candidateSummary(trip, candidate)),
      interests: prioritizedDetails.slice(0, STAGE_CONTEXT_MAX_PLACES).map((candidate) => {
        const place = places.get(candidate.placeId);
        const resolution = place ? resolutionMap.get(place.id) : null;
        return {
          ...candidateSummary(trip, candidate),
          locationStatus: place && resolution?.status === "resolved" && resolutionIsCurrent(place, resolution) ? "resolved" : "unresolved",
        };
      }),
      selection,
      ...(selectedPlanningAreaId ? { focusedMacroCandidateId: selectedPlanningAreaId } : {}),
    };
  } else {
    const routeMap = new Map((input.routeStates ?? []).map((item) => [item.dayId, item]));
    const focusId = selectedItineraryDayId(trip, selection);
    const focusIndex = focusId ? trip.plan.days.findIndex((day) => day.id === focusId) : -1;
    const start = focusIndex >= 0 ? Math.max(0, focusIndex - ITINERARY_DETAIL_WINDOW_RADIUS) : 0;
    const end = focusIndex >= 0 ? Math.min(trip.plan.days.length, focusIndex + ITINERARY_DETAIL_WINDOW_RADIUS + 1) : Math.min(trip.plan.days.length, 3);
    const window = trip.plan.days.slice(start, end);
    state = {
      stage,
      baseGeneration: trip.contentGeneration,
      planLanguage: trip.planLanguage,
      tripFacts: trip.plan.trip,
      planningState: trip.plan.planningState ?? null,
      dayIndex: trip.plan.days.slice(0, STAGE_CONTEXT_MAX_DAYS).map((day) => ({ id: day.id, dayNumber: day.dayNumber, date: day.date, title: day.title, stayBlockId: day.stayBlockId ?? null, detailLevel: day.detailLevel, detailStatus: day.detailStatus, stopCount: day.stops.length })),
      days: window.map((day) => dayDetail(trip, day, routeMap)),
      selection,
      ...(focusId ? { focusedDayId: focusId } : {}),
    };

    if (byteSize(state) > STAGE_CONTEXT_MAX_BYTES) {
      const fallbackDays = focusIndex >= 0 ? [trip.plan.days[focusIndex]] : trip.plan.days.slice(0, 1);
      state = {
        stage,
        baseGeneration: trip.contentGeneration,
        planLanguage: trip.planLanguage,
        tripFacts: trip.plan.trip,
        planningState: trip.plan.planningState ?? null,
        dayIndex: trip.plan.days.slice(0, STAGE_CONTEXT_MAX_DAYS).map((day) => ({ id: day.id, dayNumber: day.dayNumber, date: day.date, title: day.title, stayBlockId: day.stayBlockId ?? null, stopCount: day.stops.length })),
        days: fallbackDays.filter(Boolean).map((day) => dayDetail(trip, day, routeMap, true)),
        selection,
        contextWindowed: true,
      };
    }
  }

  const bytes = byteSize(state);
  if (bytes > STAGE_CONTEXT_MAX_BYTES) throw new Error(`阶段 AI 上下文超过 ${STAGE_CONTEXT_MAX_BYTES} bytes；当前 selection 已窗口化，但核心旅行事实仍超出安全预算。`);
  return { state, inputBytes: bytes };
}
