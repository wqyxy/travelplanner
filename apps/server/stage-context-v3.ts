import {
  ConversationStageSchema,
  WorkspaceSelectionV3Schema,
  type ConversationStage,
  type WorkspaceSelectionV3,
} from "./ai-stage-contracts-v3.js";
import { resolutionIsCurrent } from "./place-resolver-v2.js";
import type { PlaceResolution } from "./contracts-v2.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

export const STAGE_CONTEXT_MAX_BYTES = 64 * 1024;
export const STAGE_CONTEXT_MAX_PLACES = 240;
export const STAGE_CONTEXT_MAX_DAYS = 90;

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
    preference: candidate.preference,
    source: candidate.source,
    aiReason: candidate.aiReason,
    aiScore: candidate.aiScore,
    suggestedDurationMinutes: candidate.suggestedDurationMinutes,
    tags: candidate.tags,
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
    const place = places.get(candidate.placeId);
    if (stage === "destinations" && place?.kind !== "city") throw new Error("目的地阶段只能选择 Macro Candidate。");
    if (stage === "interests" && place?.kind === "city") return selection;
    if (stage === "itinerary") throw new Error("行程阶段 selection 不接受 Candidate。");
  }
  if (selection.type === "place") {
    const place = places.get(selection.id);
    if (!place) throw new Error("selection 引用了未知 Place。");
    if (stage === "destinations" && place.kind !== "city") throw new Error("目的地阶段只能选择 Macro Place。");
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
  const macros = trip.plan.candidates.filter((candidate) => places.get(candidate.placeId)?.kind === "city");
  const micros = trip.plan.candidates.filter((candidate) => places.get(candidate.placeId)?.kind !== "city");
  let state: Record<string, unknown>;

  if (stage === "requirements") {
    state = {
      stage,
      baseGeneration: trip.contentGeneration,
      planLanguage: trip.planLanguage,
      tripFacts: trip.plan.trip,
      selection,
    };
  } else if (stage === "destinations") {
    state = {
      stage,
      baseGeneration: trip.contentGeneration,
      planLanguage: trip.planLanguage,
      tripFacts: trip.plan.trip,
      destinations: macros.slice(0, STAGE_CONTEXT_MAX_PLACES).map((candidate) => candidateSummary(trip, candidate)),
      selection,
    };
  } else if (stage === "interests") {
    const resolutionMap = new Map((input.resolutions ?? []).map((resolution) => [resolution.placeId, resolution]));
    state = {
      stage,
      baseGeneration: trip.contentGeneration,
      planLanguage: trip.planLanguage,
      tripFacts: trip.plan.trip,
      destinations: macros.slice(0, 60).map((candidate) => candidateSummary(trip, candidate)),
      interests: micros.slice(0, STAGE_CONTEXT_MAX_PLACES).map((candidate) => {
        const place = places.get(candidate.placeId);
        const resolution = place ? resolutionMap.get(place.id) : null;
        return {
          ...candidateSummary(trip, candidate),
          locationStatus: place && resolution?.status === "resolved" && resolutionIsCurrent(place, resolution) ? "resolved" : "unresolved",
        };
      }),
      selection,
    };
  } else {
    const routeMap = new Map((input.routeStates ?? []).map((item) => [item.dayId, item]));
    state = {
      stage,
      baseGeneration: trip.contentGeneration,
      planLanguage: trip.planLanguage,
      tripFacts: trip.plan.trip,
      days: trip.plan.days.slice(0, STAGE_CONTEXT_MAX_DAYS).map((day) => ({
        id: day.id,
        dayNumber: day.dayNumber,
        date: day.date,
        title: day.title,
        detailLevel: day.detailLevel,
        detailStatus: day.detailStatus,
        startAnchor: day.startAnchor,
        stops: day.stops.map((stop) => ({
          id: stop.id,
          candidateId: stop.candidateId,
          placeId: stop.placeId,
          place: places.get(stop.placeId) ? placeSummary(places.get(stop.placeId)!) : null,
          activity: stop.activity,
          period: stop.period,
          startTime: stop.startTime,
          endTime: stop.endTime,
          durationMinutes: stop.durationMinutes,
          transportFromPrevious: stop.transportFromPrevious,
          scheduleVerification: stop.scheduleVerification,
          costNote: stop.costNote,
          costVerification: stop.costVerification,
          notes: stop.notes,
        })),
        endAnchor: day.endAnchor,
        route: routeMap.has(day.id) ? { dirty: routeMap.get(day.id)!.dirty, route: routeSummary(routeMap.get(day.id)!.route) } : null,
      })),
      selection,
    };
  }

  const encoded = JSON.stringify(state);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > STAGE_CONTEXT_MAX_BYTES) throw new Error(`阶段 AI 上下文超过 ${STAGE_CONTEXT_MAX_BYTES} bytes；请缩小服务端白名单状态，而不是发送完整计划。`);
  return { state, inputBytes: bytes };
}
