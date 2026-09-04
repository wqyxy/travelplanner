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
import {
  DestinationGenerateOutputSchema,
  type DestinationGenerateOutput,
} from "./ai-action-contracts-v3.js";
import { AiLedMicroCandidateDiscoveryOutputSchema } from "./ai-led-micro-contract-v2.js";
import { semanticPlaceKey } from "./plan-commands-v2.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";
import type { TravelStoreV2, TripDetailV2 } from "./travel-store-v2.js";

export type CandidateDiscoveryApplyResult = {
  plan: TravelPlanDocument;
  output: CandidateDiscoveryOutput | DestinationGenerateOutput;
  idMappings: Record<string, string>;
  addedCandidateIds: string[];
  updatedCandidateIds: string[];
  addedPlaceIds: string[];
  mergedDuplicateCount: number;
};

export type BackboneDiscoveryApplyResult = {
  plan: TravelPlanDocument;
  output: DestinationGenerateOutput;
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

function candidateMetadata(output: {
  aiReason: string;
  aiScore: number;
  suggestedDurationMinutes: number | null;
  tags: string[];
}) {
  return {
    aiReason: output.aiReason,
    aiScore: output.aiScore,
    suggestedDurationMinutes: output.suggestedDurationMinutes,
    tags: output.tags,
  };
}

function updateAiMetadata(existing: TripCandidate, source: {
  aiReason: string;
  aiScore: number;
  suggestedDurationMinutes: number | null;
  tags: string[];
}) {
  const previousScore = existing.aiScore ?? -1;
  if (source.aiScore >= previousScore) {
    existing.aiReason = source.aiReason;
    existing.aiScore = source.aiScore;
    existing.suggestedDurationMinutes = source.suggestedDurationMinutes;
  }
  existing.tags = mergeTags(existing.tags, source.tags);
}

export function applyBackboneDiscoveryV3(current: TravelPlanDocument, value: unknown): BackboneDiscoveryApplyResult {
  const output = DestinationGenerateOutputSchema.parse(value);
  const plan = clone(current);
  const idMappings = new Map<string, string>();
  const placesByTemporaryId = new Map(output.places.map((place) => [place.id, place]));
  const existingPlaceByKey = new Map(plan.places.map((place) => [semanticPlaceKey(place), place]));
  const canonicalPlaceByKey = new Map(existingPlaceByKey);
  const addedPlaceIds: string[] = [];
  let mergedDuplicateCount = 0;

  for (const temporaryPlaceId of new Set(output.candidates.map((candidate) => candidate.placeTemporaryId))) {
    const source = placesByTemporaryId.get(temporaryPlaceId);
    if (!source) throw new Error(`Backbone Discovery 引用未知临时 Place：${temporaryPlaceId}`);
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
  const canonicalCandidateById = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const sourceByTemporaryId = new Map(output.candidates.map((candidate) => [candidate.temporaryId, candidate]));
  const addedCandidateIds: string[] = [];
  const updatedCandidateIds = new Set<string>();

  const requirePlanningAreaParent = (candidateId: string) => {
    const parent = canonicalCandidateById.get(candidateId);
    const parentPlace = parent ? plan.places.find((place) => place.id === parent.placeId) : null;
    if (!parent || !parentPlace || effectivePlanningRole(parent, parentPlace) !== "planning_area") {
      throw new Error(`Core Visit 引用无效 Planning Area Candidate：${candidateId}`);
    }
    if (parent.preference === "excluded") throw new Error(`Core Visit 不能绑定已排除 Planning Area：${candidateId}`);
    return parent;
  };

  const formalizeCandidate = (
    source: DestinationGenerateOutput["candidates"][number],
    parentId: string | null,
  ) => {
    const placeId = idMappings.get(source.placeTemporaryId);
    if (!placeId) throw new Error(`Backbone Discovery 未能正式化 Place：${source.placeTemporaryId}`);
    const place = plan.places.find((item) => item.id === placeId);
    if (!place) throw new Error(`Backbone Discovery 找不到正式 Place：${placeId}`);
    if (source.planningRole === "planning_area" && parentId !== null) throw new Error("Planning Area 不得绑定父 Candidate。");
    if (source.planningRole === "core_visit" && !parentId) throw new Error("Core Visit 必须绑定 Planning Area。");

    const existing = candidateByPlaceId.get(placeId);
    if (existing) {
      idMappings.set(source.temporaryId, existing.id);
      const existingRole = effectivePlanningRole(existing, place);

      if (source.planningRole === "planning_area") {
        if (existingRole !== "planning_area") throw new Error(`同一地点已存在其他规划角色，拒绝静默改为 Planning Area：${existing.id}`);
      } else {
        if (existingRole === "planning_area") throw new Error(`Planning Area 不得静默降为 Core Visit：${existing.id}`);
        if (existing.planningAreaCandidateId && existing.planningAreaCandidateId !== parentId) {
          throw new Error(`Candidate 已归属其他 Planning Area，拒绝静默 reparent：${existing.id}`);
        }
        if (existingRole === "detail_interest") {
          existing.planningRole = "core_visit";
          existing.planningAreaCandidateId = parentId;
          updatedCandidateIds.add(existing.id);
        } else if (existingRole === "core_visit" && existing.planningAreaCandidateId !== parentId) {
          throw new Error(`Core Visit 已归属其他 Planning Area，拒绝静默 reparent：${existing.id}`);
        }
      }

      updateAiMetadata(existing, source);
      updatedCandidateIds.add(existing.id);
      mergedDuplicateCount += 1;
      return existing;
    }

    const candidate: TripCandidate = {
      id: randomUUID(),
      placeId,
      planningAreaCandidateId: parentId,
      planningRole: source.planningRole,
      preference: source.defaultPreference,
      source: "ai",
      ...candidateMetadata(source),
    };
    plan.candidates.push(candidate);
    candidateByPlaceId.set(placeId, candidate);
    canonicalCandidateById.set(candidate.id, candidate);
    idMappings.set(source.temporaryId, candidate.id);
    addedCandidateIds.push(candidate.id);
    return candidate;
  };

  // Phase A: formalize all Planning Areas first. Generated parent references in Phase B
  // can then resolve to canonical Candidate IDs, including semantic duplicates that map
  // onto an already-existing Planning Area.
  for (const source of output.candidates.filter((candidate) => candidate.planningRole === "planning_area")) {
    formalizeCandidate(source, null);
  }

  // Phase B: formalize Core Visits only after every possible generated parent is known.
  for (const source of output.candidates.filter((candidate) => candidate.planningRole === "core_visit")) {
    const parentRef = source.parentCandidateRef;
    if (!parentRef) throw new Error(`Core Visit 缺少 parentCandidateRef：${source.temporaryId}`);
    let parentId: string;
    if (parentRef.type === "existing") {
      parentId = parentRef.candidateId;
    } else {
      const parentSource = sourceByTemporaryId.get(parentRef.temporaryCandidateId);
      if (!parentSource || parentSource.planningRole !== "planning_area") {
        throw new Error(`generated parent 不是本轮 Planning Area：${parentRef.temporaryCandidateId}`);
      }
      const mapped = idMappings.get(parentRef.temporaryCandidateId);
      if (!mapped) throw new Error(`generated parent 尚未正式化：${parentRef.temporaryCandidateId}`);
      parentId = mapped;
    }
    requirePlanningAreaParent(parentId);
    formalizeCandidate(source, parentId);
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

function normalizedBackboneInput(value: unknown): DestinationGenerateOutput | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.candidates) || !record.candidates.length) return null;
  const candidates = record.candidates as Array<Record<string, unknown>>;
  if (!candidates.every((candidate) => candidate.planningRole === "planning_area" || candidate.planningRole === "core_visit")) return null;
  return DestinationGenerateOutputSchema.parse({
    ...record,
    schemaVersion: 2,
    candidates: candidates.map(({ planningAreaCandidateId: _legacyParent, ...candidate }) => candidate),
  });
}

function parseCandidateDiscoveryOutput(value: unknown): CandidateDiscoveryOutput {
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).areaTargets)) {
    return AiLedMicroCandidateDiscoveryOutputSchema.parse(value) as CandidateDiscoveryOutput;
  }
  return CandidateDiscoveryOutputSchema.parse(value);
}

export function applyCandidateDiscovery(current: TravelPlanDocument, value: unknown): CandidateDiscoveryApplyResult {
  const backbone = normalizedBackboneInput(value);
  if (backbone) return applyBackboneDiscoveryV3(current, backbone);

  const output = parseCandidateDiscoveryOutput(value);
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
  const canonicalCandidateById = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const addedCandidateIds: string[] = [];
  const updatedCandidateIds = new Set<string>();

  for (const source of output.candidates) {
    const placeId = idMappings.get(source.placeTemporaryId);
    if (!placeId) throw new Error(`Candidate Discovery 未能正式化 Place：${source.placeTemporaryId}`);
    const parentId = source.planningAreaCandidateId;
    if (parentId) {
      const parent = canonicalCandidateById.get(parentId);
      const parentPlace = parent ? plan.places.find((place) => place.id === parent.placeId) : null;
      if (!parent || !parentPlace || effectivePlanningRole(parent, parentPlace) !== "planning_area") throw new Error(`Candidate Discovery 引用无效 Planning Area Candidate：${parentId}`);
    }
    const existing = candidateByPlaceId.get(placeId);
    if (existing) {
      idMappings.set(source.temporaryId, existing.id);
      if (parentId && existing.planningAreaCandidateId && existing.planningAreaCandidateId !== parentId) {
        throw new Error(`Candidate 已归属其他 Macro，拒绝静默重关联：${existing.id}`);
      }
      if (parentId && !existing.planningAreaCandidateId) {
        existing.planningAreaCandidateId = parentId;
        updatedCandidateIds.add(existing.id);
      }
      updateAiMetadata(existing, source);
      updatedCandidateIds.add(existing.id);
      mergedDuplicateCount += 1;
      continue;
    }
    const candidate: TripCandidate = {
      id: randomUUID(),
      placeId,
      planningAreaCandidateId: parentId,
      preference: "optional",
      source: "ai",
      ...candidateMetadata(source),
    };
    plan.candidates.push(candidate);
    candidateByPlaceId.set(placeId, candidate);
    canonicalCandidateById.set(candidate.id, candidate);
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
  const output = parseCandidateDiscoveryOutput(value);
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

  const scheduledCandidateIds = new Set(plan.days.flatMap((day) => day.stops.map((stop) => stop.candidateId).filter((id): id is string => Boolean(id))));
  const candidates = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));

  const unscheduledIds = new Set<string>();
  for (const item of output.unscheduledCandidates) {
    const candidate = candidates.get(item.candidateId);
    if (!candidate) throw new Error(`未排程原因引用未知 Candidate：${item.candidateId}`);
    if (scheduledCandidateIds.has(candidate.id)) throw new Error(`Candidate 不能同时已排程和未排程：${candidate.id}`);
    if (unscheduledIds.has(candidate.id)) throw new Error(`Candidate 未排程说明重复：${candidate.id}`);
    unscheduledIds.add(candidate.id);
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
