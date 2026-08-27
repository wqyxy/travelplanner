import { randomUUID } from "node:crypto";
import {
  PlanCommandBatchRequestSchema,
  PlanCommandSchema,
  ProposalScopeSchema,
  TravelPlanDocumentSchema,
  type CandidatePreference,
  type Day,
  type DayStop,
  type PlanCommand,
  type ProposalScope,
  type TravelPlanDocument,
  type TripCandidate,
} from "./contracts-v2.js";
import type { TravelStoreV2, TripDetailV2 } from "./travel-store-v2.js";

type MutablePlan = TravelPlanDocument & { days: Day[] };
type CommandRecord = Record<string, unknown>;

export type PlanCommandEffects = {
  changedCandidateIds: string[];
  changedPlaceIds: string[];
  changedDayIds: string[];
  routeDirtyDayIds: string[];
  removedCandidateIds: string[];
  removedPlaceIds: string[];
};

export type ApplyPlanCommandsResult = {
  plan: TravelPlanDocument;
  idMappings: Record<string, string>;
  effects: PlanCommandEffects;
};

export type ApplyPlanCommandsToStoreResult = ApplyPlanCommandsResult & {
  trip: TripDetailV2;
  generation: number;
  version: number;
};

const clone = <T>(value: T): T => structuredClone(value);
const asRecords = (commands: PlanCommand[]) => commands as unknown as CommandRecord[];
const normalized = (value: string | null | undefined) => (value ?? "").normalize("NFKC").trim().toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");

export function semanticPlaceKey(place: TravelPlanDocument["places"][number]) {
  const name = place.nameLocal ?? place.nameEn ?? place.nameZh;
  return [normalized(name), place.kind, normalized(place.city), normalized(place.region), normalized(place.countryCode ?? place.country)].join("|");
}

function allIds(plan: TravelPlanDocument) {
  return new Set([
    ...plan.places.map((place) => place.id),
    ...plan.candidates.map((candidate) => candidate.id),
    ...plan.days.flatMap((day) => [day.id, day.startAnchor.id, day.endAnchor.id, ...day.stops.map((stop) => stop.id)]),
  ]);
}

function createIdMapper(existing: Set<string>) {
  const mappings = new Map<string, string>();
  const registered = new Set<string>();
  const register = (source: unknown) => {
    const id = typeof source === "string" ? source.trim() : "";
    if (!id) throw new Error("新增实体必须提供本轮临时 ID。");
    if (existing.has(id) || registered.has(id)) throw new Error(`新增实体 ID 重复或覆盖正式 ID：${id}`);
    registered.add(id);
    mappings.set(id, randomUUID());
  };
  const resolve = (source: unknown) => {
    const id = typeof source === "string" ? source : "";
    return mappings.get(id) ?? id;
  };
  return { mappings, register, resolve };
}

function collectTemporaryIds(records: CommandRecord[], mapper: ReturnType<typeof createIdMapper>) {
  for (const command of records) {
    if (command.type === "add_candidate") {
      const place = command.place as Record<string, unknown> | undefined;
      const candidate = command.candidate as Record<string, unknown> | undefined;
      mapper.register(place?.id);
      mapper.register(candidate?.id);
    }
    if (command.type === "add_day_stop") {
      const stop = command.stop as Record<string, unknown> | undefined;
      mapper.register(stop?.id);
    }
  }
}

function findDay(plan: MutablePlan, dayId: string) {
  const index = plan.days.findIndex((day) => day.id === dayId);
  if (index < 0) throw new Error(`未知 Day：${dayId}`);
  return { day: plan.days[index], index };
}

function findStop(plan: MutablePlan, stopId: string) {
  for (const [dayIndex, day] of plan.days.entries()) {
    const stopIndex = day.stops.findIndex((stop) => stop.id === stopId);
    if (stopIndex >= 0) return { day, dayIndex, stop: day.stops[stopIndex], stopIndex };
  }
  throw new Error(`未知 Stop：${stopId}`);
}

function requireCandidate(plan: MutablePlan, candidateId: string) {
  const candidate = plan.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`未知 Candidate：${candidateId}`);
  return candidate;
}

function requirePlace(plan: MutablePlan, placeId: string) {
  const place = plan.places.find((item) => item.id === placeId);
  if (!place) throw new Error(`未知 Place：${placeId}`);
  return place;
}

function dayRouteSignature(day: Day) {
  return JSON.stringify({
    start: day.startAnchor.placeId,
    stops: day.stops.map((stop) => ({ id: stop.id, placeId: stop.placeId, mode: stop.transportFromPrevious?.mode ?? null })),
    end: day.endAnchor.placeId,
  });
}

function markDayForReview(day: Day) {
  if (day.detailLevel === "detailed") day.detailStatus = "needs_review";
}

function removeCandidateStops(plan: MutablePlan, candidateId: string) {
  const changed = new Set<string>();
  for (const day of plan.days) {
    const next = day.stops.filter((stop) => stop.candidateId !== candidateId);
    if (next.length === day.stops.length) continue;
    day.stops = next;
    markDayForReview(day);
    changed.add(day.id);
  }
  return changed;
}

function setCandidatePreference(plan: MutablePlan, candidateId: string, preference: CandidatePreference) {
  const candidate = requireCandidate(plan, candidateId);
  candidate.preference = preference;
  return preference === "excluded" ? removeCandidateStops(plan, candidateId) : new Set<string>();
}

function mapNewStop(source: unknown, mapper: ReturnType<typeof createIdMapper>): DayStop {
  const stop = clone(source) as DayStop;
  stop.id = mapper.resolve(stop.id);
  stop.placeId = mapper.resolve(stop.placeId);
  if (stop.candidateId) stop.candidateId = mapper.resolve(stop.candidateId);
  return stop;
}

function normalizeDays(plan: MutablePlan) {
  const start = plan.trip.dates.start;
  plan.days.forEach((day, index) => {
    day.dayNumber = index + 1;
    if (start) day.date = new Date(Date.parse(`${start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10);
  });
}

function clearUnreferencedPlaces(plan: MutablePlan) {
  const referenced = new Set<string>([
    ...[plan.trip.originPlaceId].filter((id): id is string => Boolean(id)),
    ...plan.trip.destinationPlaceIds,
    ...plan.candidates.map((candidate) => candidate.placeId),
    ...plan.days.flatMap((day) => [
      ...[day.startAnchor.placeId, day.endAnchor.placeId].filter((id): id is string => Boolean(id)),
      ...day.stops.map((stop) => stop.placeId),
    ]),
  ]);
  plan.places = plan.places.filter((place) => referenced.has(place.id));
}

function existingStopOwner(plan: TravelPlanDocument, stopId: string) {
  return plan.days.find((day) => day.stops.some((stop) => stop.id === stopId))?.id ?? null;
}

function commandTargetsCandidate(plan: TravelPlanDocument, command: PlanCommand, candidateId: string) {
  if (command.type === "set_candidate_preference" || command.type === "remove_candidate" || command.type === "update_candidate") return command.candidateId === candidateId;
  if (command.type === "bulk_set_candidate_preference") return command.candidateIds.every((id) => id === candidateId);
  if (command.type === "update_place") return plan.candidates.find((candidate) => candidate.id === candidateId)?.placeId === command.placeId;
  const candidate = plan.candidates.find((item) => item.id === candidateId);
  if (!candidate) return false;
  if (command.type === "add_day_stop") return command.stop.candidateId === candidateId || command.stop.placeId === candidate.placeId;
  if (command.type === "update_day_stop" || command.type === "remove_day_stop" || command.type === "move_day_stop") {
    const stop = plan.days.flatMap((day) => day.stops).find((item) => item.id === command.stopId);
    return stop?.candidateId === candidateId;
  }
  return false;
}

function commandTargetsPlace(plan: TravelPlanDocument, command: PlanCommand, placeId: string) {
  if (command.type === "update_place") return command.placeId === placeId;
  if (command.type === "set_candidate_preference" || command.type === "remove_candidate" || command.type === "update_candidate") return plan.candidates.find((candidate) => candidate.id === command.candidateId)?.placeId === placeId;
  if (command.type === "bulk_set_candidate_preference") return command.candidateIds.every((id) => plan.candidates.find((candidate) => candidate.id === id)?.placeId === placeId);
  if (command.type === "set_day_anchor") return command.placeId === placeId || findDay(clone(plan) as MutablePlan, command.dayId).day[command.anchor === "start" ? "startAnchor" : "endAnchor"].placeId === placeId;
  if (command.type === "add_day_stop") return command.stop.placeId === placeId;
  if (command.type === "update_day_stop" || command.type === "remove_day_stop" || command.type === "move_day_stop") {
    const stop = plan.days.flatMap((day) => day.stops).find((item) => item.id === command.stopId);
    return stop?.placeId === placeId;
  }
  return false;
}

function commandTargetsDay(plan: TravelPlanDocument, command: PlanCommand, dayId: string) {
  if (command.type === "set_day_anchor" || command.type === "add_day_stop" || command.type === "update_day" || command.type === "move_day") return command.dayId === dayId;
  if (command.type === "update_day_stop" || command.type === "remove_day_stop") return existingStopOwner(plan, command.stopId) === dayId;
  if (command.type === "move_day_stop") return existingStopOwner(plan, command.stopId) === dayId && command.targetDayId === dayId;
  return false;
}

export function assertCommandsWithinScope(plan: TravelPlanDocument, scopeValue: unknown, commandsValue: unknown) {
  const scope = ProposalScopeSchema.parse(scopeValue);
  const commands = Array.isArray(commandsValue) ? commandsValue.map((value) => PlanCommandSchema.parse(value)) : [];
  if (!commands.length) throw new Error("Proposal 必须包含至少一条命令。");
  if (scope.type === "trip") return commands;
  if (scope.type === "candidate_pool") {
    const allowed = new Set(["set_candidate_preference", "bulk_set_candidate_preference", "add_candidate", "remove_candidate", "update_candidate", "update_place"]);
    if (commands.some((command) => !allowed.has(command.type))) throw new Error("Candidate Pool Scope 不能修改 Day、Anchor 或 Stop。");
    return commands;
  }
  if (scope.type === "candidate") {
    if (commands.some((command) => !commandTargetsCandidate(plan, command, scope.id))) throw new Error(`Proposal 命令超出 Candidate Scope：${scope.id}`);
    return commands;
  }
  if (scope.type === "place") {
    if (commands.some((command) => !commandTargetsPlace(plan, command, scope.id))) throw new Error(`Proposal 命令超出 Place Scope：${scope.id}`);
    return commands;
  }
  if (commands.some((command) => !commandTargetsDay(plan, command, scope.id))) throw new Error(`Proposal 命令超出 Day Scope：${scope.id}`);
  return commands;
}

export function applyPlanCommands(current: TravelPlanDocument, commandValues: unknown[]): ApplyPlanCommandsResult {
  const commands = commandValues.map((command) => PlanCommandSchema.parse(command));
  if (!commands.length) throw new Error("至少需要一条 PlanCommand。");
  const before = clone(current);
  const plan = clone(current) as MutablePlan;
  const records = asRecords(commands);
  const mapper = createIdMapper(allIds(current));
  collectTemporaryIds(records, mapper);
  const explicitChangedPlaces = new Set<string>();
  const explicitChangedCandidates = new Set<string>();
  const explicitlyChangedDays = new Set<string>();
  const removedCandidates = new Set<string>();

  for (const command of commands) {
    switch (command.type) {
      case "set_candidate_preference": {
        const id = mapper.resolve(command.candidateId);
        explicitChangedCandidates.add(id);
        for (const dayId of setCandidatePreference(plan, id, command.preference)) explicitlyChangedDays.add(dayId);
        break;
      }
      case "bulk_set_candidate_preference": {
        for (const sourceId of new Set(command.candidateIds)) {
          const id = mapper.resolve(sourceId);
          explicitChangedCandidates.add(id);
          for (const dayId of setCandidatePreference(plan, id, command.preference)) explicitlyChangedDays.add(dayId);
        }
        break;
      }
      case "add_candidate": {
        if (command.candidate.placeId !== command.place.id) throw new Error("新增 Candidate 必须引用同一命令中的 Place 临时 ID。");
        const place = { ...clone(command.place), id: mapper.resolve(command.place.id) };
        const candidate: TripCandidate = { ...clone(command.candidate), id: mapper.resolve(command.candidate.id), placeId: place.id };
        if (plan.places.some((item) => semanticPlaceKey(item) === semanticPlaceKey(place))) throw new Error(`地点已存在：${place.nameZh}`);
        plan.places.push(place);
        plan.candidates.push(candidate);
        explicitChangedPlaces.add(place.id);
        explicitChangedCandidates.add(candidate.id);
        break;
      }
      case "remove_candidate": {
        const id = mapper.resolve(command.candidateId);
        requireCandidate(plan, id);
        for (const dayId of removeCandidateStops(plan, id)) explicitlyChangedDays.add(dayId);
        plan.candidates = plan.candidates.filter((candidate) => candidate.id !== id);
        explicitChangedCandidates.add(id);
        removedCandidates.add(id);
        break;
      }
      case "update_candidate": {
        const id = mapper.resolve(command.candidateId);
        Object.assign(requireCandidate(plan, id), clone(command.changes));
        explicitChangedCandidates.add(id);
        break;
      }
      case "update_place": {
        const id = mapper.resolve(command.placeId);
        Object.assign(requirePlace(plan, id), clone(command.changes));
        explicitChangedPlaces.add(id);
        break;
      }
      case "set_day_anchor": {
        const day = findDay(plan, mapper.resolve(command.dayId)).day;
        const placeId = command.placeId ? mapper.resolve(command.placeId) : null;
        if (placeId) requirePlace(plan, placeId);
        const anchor = command.anchor === "start" ? day.startAnchor : day.endAnchor;
        anchor.placeId = placeId;
        anchor.label = command.label;
        anchor.notes = command.notes;
        markDayForReview(day);
        explicitlyChangedDays.add(day.id);
        break;
      }
      case "add_day_stop": {
        const day = findDay(plan, mapper.resolve(command.dayId)).day;
        if (command.index > day.stops.length) throw new Error(`Stop 插入位置超出 Day ${day.id} 范围。`);
        const stop = mapNewStop(command.stop, mapper);
        requirePlace(plan, stop.placeId);
        if (stop.candidateId) requireCandidate(plan, stop.candidateId);
        day.stops.splice(command.index, 0, stop);
        markDayForReview(day);
        explicitlyChangedDays.add(day.id);
        break;
      }
      case "update_day_stop": {
        const found = findStop(plan, mapper.resolve(command.stopId));
        const changes = clone(command.changes) as Partial<DayStop>;
        if (changes.placeId) changes.placeId = mapper.resolve(changes.placeId);
        if (changes.candidateId) changes.candidateId = mapper.resolve(changes.candidateId);
        if (changes.candidateId) {
          const candidate = requireCandidate(plan, changes.candidateId);
          if (!changes.placeId) changes.placeId = candidate.placeId;
        } else if (changes.placeId && !("candidateId" in changes)) {
          changes.candidateId = null;
        }
        if (changes.placeId) requirePlace(plan, changes.placeId);
        Object.assign(found.stop, changes);
        markDayForReview(found.day);
        explicitlyChangedDays.add(found.day.id);
        break;
      }
      case "move_day_stop": {
        const stopId = mapper.resolve(command.stopId);
        const found = findStop(plan, stopId);
        found.day.stops.splice(found.stopIndex, 1);
        const target = findDay(plan, mapper.resolve(command.targetDayId)).day;
        if (command.targetIndex > target.stops.length) throw new Error(`Stop 目标位置超出 Day ${target.id} 范围。`);
        target.stops.splice(command.targetIndex, 0, found.stop);
        markDayForReview(found.day);
        markDayForReview(target);
        explicitlyChangedDays.add(found.day.id);
        explicitlyChangedDays.add(target.id);
        break;
      }
      case "remove_day_stop": {
        const found = findStop(plan, mapper.resolve(command.stopId));
        found.day.stops.splice(found.stopIndex, 1);
        markDayForReview(found.day);
        explicitlyChangedDays.add(found.day.id);
        break;
      }
      case "move_day": {
        const found = findDay(plan, mapper.resolve(command.dayId));
        plan.days.splice(found.index, 1);
        if (command.targetIndex > plan.days.length) throw new Error("Day 目标位置超出范围。");
        plan.days.splice(command.targetIndex, 0, found.day);
        explicitlyChangedDays.add(found.day.id);
        break;
      }
      case "update_day": {
        const day = findDay(plan, mapper.resolve(command.dayId)).day;
        if ("date" in command.changes && plan.trip.dates.start) throw new Error("已有旅行开始日期时，Day 日期由服务端连续计算，不能单独修改。");
        Object.assign(day, clone(command.changes));
        markDayForReview(day);
        explicitlyChangedDays.add(day.id);
        break;
      }
    }
  }

  normalizeDays(plan);
  clearUnreferencedPlaces(plan);
  const parsed = TravelPlanDocumentSchema.parse(plan);

  const beforeCandidates = new Map(before.candidates.map((candidate) => [candidate.id, candidate]));
  const afterCandidates = new Map(parsed.candidates.map((candidate) => [candidate.id, candidate]));
  const changedCandidateIds = new Set(explicitChangedCandidates);
  for (const [id, candidate] of afterCandidates) if (JSON.stringify(beforeCandidates.get(id)) !== JSON.stringify(candidate)) changedCandidateIds.add(id);
  for (const id of beforeCandidates.keys()) if (!afterCandidates.has(id)) changedCandidateIds.add(id);

  const beforePlaces = new Map(before.places.map((place) => [place.id, place]));
  const afterPlaces = new Map(parsed.places.map((place) => [place.id, place]));
  const changedPlaceIds = new Set(explicitChangedPlaces);
  for (const [id, place] of afterPlaces) if (JSON.stringify(beforePlaces.get(id)) !== JSON.stringify(place)) changedPlaceIds.add(id);
  const removedPlaceIds = [...beforePlaces.keys()].filter((id) => !afterPlaces.has(id));
  for (const id of removedPlaceIds) changedPlaceIds.add(id);

  const beforeDays = new Map(before.days.map((day) => [day.id, day]));
  const changedDayIds = new Set(explicitlyChangedDays);
  const routeDirtyDayIds = new Set<string>();
  for (const day of parsed.days) {
    const previous = beforeDays.get(day.id);
    if (JSON.stringify(previous) !== JSON.stringify(day)) changedDayIds.add(day.id);
    if (!previous || dayRouteSignature(previous) !== dayRouteSignature(day)) routeDirtyDayIds.add(day.id);
    if ([...changedPlaceIds].some((placeId) => [day.startAnchor.placeId, day.endAnchor.placeId, ...day.stops.map((stop) => stop.placeId)].includes(placeId))) routeDirtyDayIds.add(day.id);
  }

  return {
    plan: parsed,
    idMappings: Object.fromEntries(mapper.mappings),
    effects: {
      changedCandidateIds: [...changedCandidateIds],
      changedPlaceIds: [...changedPlaceIds],
      changedDayIds: [...changedDayIds],
      routeDirtyDayIds: [...routeDirtyDayIds],
      removedCandidateIds: [...removedCandidates],
      removedPlaceIds,
    },
  };
}

export function applyPlanCommandBatchToStore(
  store: TravelStoreV2,
  tripId: string,
  input: unknown,
  revision: { source?: string; summary?: string } = {},
): ApplyPlanCommandsToStoreResult {
  const request = PlanCommandBatchRequestSchema.parse(input);
  const trip = store.requireTrip(tripId);
  if (trip.contentGeneration !== request.expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
  const applied = applyPlanCommands(trip.plan, request.commands);
  const written = store.writePlan(tripId, applied.plan, request.expectedGeneration, {
    source: revision.source ?? "command",
    summary: revision.summary ?? "编辑旅行计划",
  });
  return { ...applied, trip: written.trip, generation: written.generation, version: written.version };
}
