import { randomUUID } from "node:crypto";
import {
  CandidateDiscoveryOutputSchema,
  PlanGenerationOutputSchema,
  TravelPlanDocumentSchema,
  type CandidateDiscoveryOutput,
  type Day,
  type PlanGenerationOutput,
  type Place,
  type TravelPlanDocument,
  type TripCandidate,
} from "./contracts-v2.js";
import { semanticPlaceKey } from "./plan-commands-v2.js";
import { buildPlanningAreaContext, fulfilledMacroCityCandidateIds } from "./planning-areas-v2.js";
import type { TravelStoreV2, TripDetailV2 } from "./travel-store-v2.js";

export type CandidateDiscoveryApplyResult = {
  plan: TravelPlanDocument;
  output: CandidateDiscoveryOutput;
  idMappings: Record<string, string>;
  addedCandidateIds: string[];
  updatedCandidateIds: string[];
  addedPlaceIds: string[];
  mergedDuplicateCount: number;
};

export type PlanGenerationApplyResult = {
  plan: TravelPlanDocument;
  output: PlanGenerationOutput;
  idMappings: Record<string, string>;
  scheduledCandidateIds: string[];
  unscheduledCandidateIds: string[];
  changedDayIds: string[];
};

export type StoredCandidateDiscoveryResult = CandidateDiscoveryApplyResult & { trip: TripDetailV2; generation: number; version: number };
export type StoredPlanGenerationResult = PlanGenerationApplyResult & { trip: TripDetailV2; generation: number; version: number };

const clone = <T>(value: T): T => structuredClone(value);

function mergeTags(left: string[], right: string[]) {
  return [...new Set([...left, ...right])].slice(0, 30);
}

function candidateMetadata(output: CandidateDiscoveryOutput["candidates"][number]) {
  return {
    aiReason: output.aiReason,
    aiScore: output.aiScore,
    suggestedDurationMinutes: output.suggestedDurationMinutes,
    tags: output.tags,
  };
}

export function applyCandidateDiscovery(current: TravelPlanDocument, value: unknown): CandidateDiscoveryApplyResult {
  const output = CandidateDiscoveryOutputSchema.parse(value);
  const plan = clone(current);
  const idMappings = new Map<string, string>();
  const placesById = new Map(output.places.map((place) => [place.id, place]));
  const existingPlaceByKey = new Map(plan.places.map((place) => [semanticPlaceKey(place), place]));
  const canonicalPlaceByKey = new Map(existingPlaceByKey);
  const addedPlaceIds: string[] = [];
  let mergedDuplicateCount = 0;

  const referencedTemporaryPlaceIds = new Set(output.candidates.map((candidate) => candidate.placeTemporaryId));
  for (const temporaryPlaceId of referencedTemporaryPlaceIds) {
    const source = placesById.get(temporaryPlaceId);
    if (!source) throw new Error(`Candidate Discovery 引用未知临时 Place：${temporaryPlaceId}`);
    const key = semanticPlaceKey(source);
    const existing = canonicalPlaceByKey.get(key);
    if (existing) {
      idMappings.set(temporaryPlaceId, existing.id);
      if (!existingPlaceByKey.has(key)) mergedDuplicateCount += 1;
      continue;
    }
    const place: Place = { ...clone(source), id: randomUUID() };
    plan.places.push(place);
    canonicalPlaceByKey.set(key, place);
    idMappings.set(temporaryPlaceId, place.id);
    addedPlaceIds.push(place.id);
  }

  const candidateByPlaceId = new Map(plan.candidates.map((candidate) => [candidate.placeId, candidate]));
  const addedCandidateIds: string[] = [];
  const updatedCandidateIds = new Set<string>();

  for (const source of output.candidates) {
    const placeId = idMappings.get(source.placeTemporaryId);
    if (!placeId) throw new Error(`Candidate Discovery 未能正式化 Place：${source.placeTemporaryId}`);
    const existing = candidateByPlaceId.get(placeId);
    if (existing) {
      idMappings.set(source.temporaryId, existing.id);
      const previousScore = existing.aiScore ?? -1;
      if (source.aiScore >= previousScore) {
        existing.aiReason = source.aiReason;
        existing.aiScore = source.aiScore;
        existing.suggestedDurationMinutes = source.suggestedDurationMinutes;
      }
      existing.tags = mergeTags(existing.tags, source.tags);
      updatedCandidateIds.add(existing.id);
      mergedDuplicateCount += 1;
      continue;
    }
    const candidate: TripCandidate = {
      id: randomUUID(),
      placeId,
      preference: "optional",
      source: "ai",
      ...candidateMetadata(source),
    };
    plan.candidates.push(candidate);
    candidateByPlaceId.set(placeId, candidate);
    idMappings.set(source.temporaryId, candidate.id);
    addedCandidateIds.push(candidate.id);
  }

  return {
    plan: TravelPlanDocumentSchema.parse(plan),
    output,
    idMappings: Object.fromEntries(idMappings),
    addedCandidateIds,
    updatedCandidateIds: [...updatedCandidateIds],
    addedPlaceIds,
    mergedDuplicateCount,
  };
}

export function applyCandidateDiscoveryToStore(store: TravelStoreV2, tripId: string, value: unknown): StoredCandidateDiscoveryResult {
  const output = CandidateDiscoveryOutputSchema.parse(value);
  const trip = store.requireTrip(tripId);
  if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
  const applied = applyCandidateDiscovery(trip.plan, output);
  const written = store.writePlan(tripId, applied.plan, output.baseGeneration, { source: "candidate_discovery", summary: "AI 发现候选地点" });
  return { ...applied, trip: written.trip, generation: written.generation, version: written.version };
}

function formalIdMapper(existingIds: Set<string>) {
  const mappings = new Map<string, string>();
  const register = (source: string) => {
    if (!source) throw new Error("生成行程的新增实体缺少临时 ID。");
    if (existingIds.has(source) || mappings.has(source)) throw new Error(`生成行程的临时 ID 重复或覆盖正式 ID：${source}`);
    mappings.set(source, randomUUID());
  };
  const resolve = (source: string | null) => source === null ? null : mappings.get(source) ?? source;
  return { mappings, register, resolve };
}

function currentFormalIds(plan: TravelPlanDocument) {
  return new Set([
    ...plan.places.map((place) => place.id),
    ...plan.candidates.map((candidate) => candidate.id),
    ...plan.days.flatMap((day) => [day.id, day.startAnchor.id, day.endAnchor.id, ...day.stops.map((stop) => stop.id)]),
  ]);
}

function formalizeGeneratedDays(output: PlanGenerationOutput, plan: TravelPlanDocument, placeMappings: Map<string, string>) {
  const mapper = formalIdMapper(currentFormalIds(plan));
  for (const day of output.days) {
    mapper.register(day.id);
    mapper.register(day.startAnchor.id);
    mapper.register(day.endAnchor.id);
    for (const stop of day.stops) mapper.register(stop.id);
  }
  const candidateIds = new Set(plan.candidates.map((candidate) => candidate.id));
  const placeIds = new Set(plan.places.map((place) => place.id));
  const resolvePlace = (id: string | null) => id === null ? null : placeMappings.get(id) ?? id;
  const days: Day[] = output.days.map((source) => {
    const day = clone(source);
    day.id = mapper.resolve(day.id)!;
    day.detailLevel = "planned";
    day.detailStatus = null;
    day.startAnchor = { ...day.startAnchor, id: mapper.resolve(day.startAnchor.id)!, placeId: resolvePlace(day.startAnchor.placeId) };
    day.endAnchor = { ...day.endAnchor, id: mapper.resolve(day.endAnchor.id)!, placeId: resolvePlace(day.endAnchor.placeId) };
    day.stops = day.stops.map((stop) => {
      const placeId = resolvePlace(stop.placeId)!;
      const candidateId = stop.candidateId;
      if (!placeIds.has(placeId)) throw new Error(`生成行程引用未知 Place：${stop.placeId}`);
      if (candidateId && !candidateIds.has(candidateId)) throw new Error(`生成行程引用未知 Candidate：${candidateId}`);
      return { ...stop, id: mapper.resolve(stop.id)!, placeId };
    });
    return day;
  });
  return { days, nodeMappings: mapper.mappings };
}

export function applyPlanGeneration(current: TravelPlanDocument, value: unknown): PlanGenerationApplyResult {
  const output = PlanGenerationOutputSchema.parse(value);
  if (current.stage !== "place_selection" || current.days.length) throw new Error("Plan Generation 只能从尚未生成 Day 的地点选择阶段开始。");
  const plan = clone(current);
  const placeMappings = new Map<string, string>();
  const existingByKey = new Map(plan.places.map((place) => [semanticPlaceKey(place), place]));
  const newPlacesByKey = new Map<string, Place>();

  for (const source of output.newPlaces) {
    if (placeMappings.has(source.id)) throw new Error(`新增 Place 临时 ID 重复：${source.id}`);
    const key = semanticPlaceKey(source);
    const existing = existingByKey.get(key) ?? newPlacesByKey.get(key);
    if (existing) {
      placeMappings.set(source.id, existing.id);
      continue;
    }
    if (plan.places.some((place) => place.id === source.id) || plan.candidates.some((candidate) => candidate.id === source.id)) throw new Error(`新增 Place 临时 ID 覆盖正式 ID：${source.id}`);
    const place = { ...clone(source), id: randomUUID() };
    plan.places.push(place);
    newPlacesByKey.set(key, place);
    placeMappings.set(source.id, place.id);
  }

  const { days, nodeMappings } = formalizeGeneratedDays(output, plan, placeMappings);
  plan.days = days;
  plan.stage = "itinerary_planning";
  const start = plan.trip.dates.start;
  plan.days.forEach((day, index) => {
    day.dayNumber = index + 1;
    if (start) day.date = new Date(Date.parse(`${start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10);
  });

  const candidates = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const places = new Map(plan.places.map((place) => [place.id, place]));
  const areaContext = buildPlanningAreaContext(plan);
  const scheduledCandidateIds = new Set(plan.days.flatMap((day) => day.stops.map((stop) => stop.candidateId).filter((id): id is string => Boolean(id))));

  for (const candidateId of scheduledCandidateIds) {
    const candidate = candidates.get(candidateId);
    const place = candidate ? places.get(candidate.placeId) : null;
    if (place?.kind === "city") throw new Error(`城市级 Candidate 不应直接作为 Day Stop：${place.nameZh}。请排入该城市内具体地点。`);
    if (areaContext.suppressedCandidateIds.has(candidateId)) throw new Error(`所属城市已标记为“不去”，Candidate 不得排程：${candidateId}`);
  }

  const fulfilledMacroCities = fulfilledMacroCityCandidateIds(areaContext, scheduledCandidateIds);
  const unscheduledIds = new Set<string>();
  for (const item of output.unscheduledCandidates) {
    const candidate = candidates.get(item.candidateId);
    if (!candidate) throw new Error(`未排程原因引用未知 Candidate：${item.candidateId}`);
    if (candidate.preference === "excluded" || areaContext.suppressedCandidateIds.has(candidate.id)) throw new Error("不参与规划的 Candidate 不需要进入未排程说明。");
    if (fulfilledMacroCities.has(candidate.id)) throw new Error(`城市级 Candidate 已由城市内具体地点满足，不应同时标记未排程：${candidate.id}`);
    if (candidate.preference === "must_go") throw new Error(`must_go Candidate 不得未排程：${candidate.id}`);
    if (scheduledCandidateIds.has(candidate.id)) throw new Error(`Candidate 不能同时已排程和未排程：${candidate.id}`);
    if (unscheduledIds.has(candidate.id)) throw new Error(`Candidate 未排程说明重复：${candidate.id}`);
    unscheduledIds.add(candidate.id);
  }

  for (const candidate of plan.candidates) {
    if (candidate.preference === "excluded" || areaContext.suppressedCandidateIds.has(candidate.id)) {
      if (scheduledCandidateIds.has(candidate.id)) throw new Error(`不参与规划的 Candidate 不得排程：${candidate.id}`);
      continue;
    }
    if (fulfilledMacroCities.has(candidate.id)) continue;
    if (!scheduledCandidateIds.has(candidate.id) && !unscheduledIds.has(candidate.id)) throw new Error(`参与规划的 Candidate 缺少排程或未排程说明：${candidate.id}`);
  }

  const parsed = TravelPlanDocumentSchema.parse(plan);
  return {
    plan: parsed,
    output,
    idMappings: Object.fromEntries([...placeMappings, ...nodeMappings]),
    scheduledCandidateIds: [...scheduledCandidateIds],
    unscheduledCandidateIds: [...unscheduledIds],
    changedDayIds: parsed.days.map((day) => day.id),
  };
}

export function applyPlanGenerationToStore(store: TravelStoreV2, tripId: string, value: unknown): StoredPlanGenerationResult {
  const output = PlanGenerationOutputSchema.parse(value);
  const trip = store.requireTrip(tripId);
  if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
  const applied = applyPlanGeneration(trip.plan, output);
  const written = store.writePlan(tripId, applied.plan, output.baseGeneration, { source: "plan_generation", summary: "按城市与具体地点生成行程" });
  return { ...applied, trip: written.trip, generation: written.generation, version: written.version };
}
