import { randomUUID } from "node:crypto";
import { DetailedDaySchema, ItinerarySchema, PlannerOutputSchema, type Day, type Itinerary, type PlannerMutation, type PlannerOutput, type Stop, type Verification } from "./contracts.js";
import type { TravelStore, TripDetail } from "./travel-store.js";

type MutationRecord = Record<string, unknown>;
type MutableItinerary = Itinerary & { days: Day[] };
export type PlannerApplyResult = {
  trip: TripDetail;
  output: PlannerOutput;
  saved: boolean;
  startDetailing: boolean;
  idMappings: Record<string, string>;
  changedDayIds: string[];
  invalidatedFacts: string[];
};

const clone = <T>(value: T): T => structuredClone(value);
const asMutations = (value: PlannerMutation[]) => value as unknown as MutationRecord[];
const invalidVerification = (): Verification => ({ status: "unverified", checkedAt: null });

function findDay(itinerary: MutableItinerary, id: string) {
  const index = itinerary.days.findIndex((day) => day.id === id);
  if (index < 0) throw new Error(`未知 Day：${id}`);
  return { day: itinerary.days[index], index };
}

function findStop(itinerary: MutableItinerary, id: string) {
  for (const [dayIndex, day] of itinerary.days.entries()) {
    const stopIndex = day.stops.findIndex((stop) => stop.id === id);
    if (stopIndex >= 0) return { day, dayIndex, stop: day.stops[stopIndex], stopIndex };
  }
  throw new Error(`未知 Stop：${id}`);
}

function formalIds(itinerary: Itinerary) {
  return new Set([...
    itinerary.places.map((place) => place.id),
    ...itinerary.days.map((day) => day.id),
    ...itinerary.days.flatMap((day) => day.stops.map((stop) => stop.id)),
  ]);
}

function createIdMapper(existing: Set<string>) {
  const mappings = new Map<string, string>();
  const definitions = new Set<string>();
  const register = (source: unknown) => {
    const id = String(source || "");
    if (!id) throw new Error("新增实体缺少临时 ID。");
    if (existing.has(id) || definitions.has(id)) throw new Error(`新增实体 ID 重复或覆盖既有实体：${id}`);
    definitions.add(id); mappings.set(id, randomUUID());
  };
  const resolve = (source: unknown) => {
    const id = String(source || "");
    return mappings.get(id) ?? id;
  };
  return { mappings, register, resolve };
}

function normalize(itinerary: MutableItinerary) {
  const start = itinerary.trip.dates.start;
  itinerary.days.forEach((day, index) => {
    day.dayNumber = index + 1;
    if (start) day.date = new Date(Date.parse(`${start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10);
    day.stops.forEach((stop, stopIndex) => {
      stop.role = stopIndex === 0 ? "start" : stopIndex === day.stops.length - 1 ? "end" : "visit";
      if (stopIndex === 0) stop.transportFromPrevious = null;
    });
  });
}

function invalidateStopTransport(stop: Stop, facts: string[]) {
  if (!stop.transportFromPrevious) return;
  stop.transportFromPrevious = { ...stop.transportFromPrevious, durationMinutes: null, verification: invalidVerification() };
  facts.push(`Stop ${stop.id} 的相邻交通已失效，需重新估算或核验。`);
}

function invalidateDayFacts(day: Day, facts: string[]) {
  for (const stop of day.stops) {
    if (stop.scheduleVerification) stop.scheduleVerification = invalidVerification();
    if (stop.costVerification) stop.costVerification = invalidVerification();
    invalidateStopTransport(stop, facts);
  }
  facts.push(`Day ${day.id} 的日期相关核验已失效。`);
}

function topology(itinerary: Itinerary) {
  const values = new Map<string, { dayId: string; previousStopId: string | null; placeId: string; previousPlaceId: string | null; mode: string | null }>();
  for (const day of itinerary.days) for (const [index, stop] of day.stops.entries()) {
    const previous = index ? day.stops[index - 1] : null;
    values.set(stop.id, { dayId: day.id, previousStopId: previous?.id ?? null, placeId: stop.placeId, previousPlaceId: previous?.placeId ?? null, mode: stop.transportFromPrevious?.mode ?? null });
  }
  return values;
}

function collectAddIds(mutations: MutationRecord[], mapper: ReturnType<typeof createIdMapper>) {
  for (const mutation of mutations) {
    if (mutation.type !== "add_entity") continue;
    const value = mutation.value as Record<string, unknown>;
    mapper.register(value?.id);
    if (mutation.entity === "day") for (const stop of (value?.stops as Array<Record<string, unknown>> | undefined) ?? []) mapper.register(stop.id);
  }
}

function mapNewDay(value: Record<string, unknown>, resolve: (id: unknown) => string): Day {
  const day = clone(value) as unknown as Day;
  day.id = resolve(day.id); day.dayNumber = 0;
  day.stops = day.stops.map((stop) => ({ ...stop, id: resolve(stop.id), placeId: resolve(stop.placeId) }));
  return day;
}

function mapNewStop(value: Record<string, unknown>, resolve: (id: unknown) => string): Stop {
  const stop = clone(value) as unknown as Stop;
  return { ...stop, id: resolve(stop.id), placeId: resolve(stop.placeId) };
}

function clearUnreferencedPlaces(itinerary: MutableItinerary) {
  const referenced = new Set<string>([
    ...[itinerary.trip.originPlaceId].filter((id): id is string => Boolean(id)),
    ...itinerary.trip.destinationPlaceIds,
    ...itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId)),
  ]);
  itinerary.places = itinerary.places.filter((place) => referenced.has(place.id));
}

function degradeIncompleteDetailedDays(itinerary: MutableItinerary) {
  for (const day of itinerary.days) if (day.detailLevel === "detailed" && !DetailedDaySchema.safeParse(day).success) {
    day.detailLevel = "draft";
    day.detailStatus = "needs_review";
  }
}

function applyExplicitInvalidation(itinerary: MutableItinerary, mutation: MutationRecord, resolve: (id: unknown) => string, facts: string[]) {
  const entity = String(mutation.entity || ""); const id = resolve(mutation.id);
  if (entity === "day") { invalidateDayFacts(findDay(itinerary, id).day, facts); return; }
  if (entity === "stop") { const found = findStop(itinerary, id); if (found.stop.scheduleVerification) found.stop.scheduleVerification = invalidVerification(); if (found.stop.costVerification) found.stop.costVerification = invalidVerification(); invalidateStopTransport(found.stop, facts); facts.push(`Stop ${id} 的指定依赖已失效。`); return; }
  if (entity === "place") { for (const day of itinerary.days) if (day.stops.some((stop) => stop.placeId === id)) for (const stop of day.stops) invalidateStopTransport(stop, facts); facts.push(`Place ${id} 的指定依赖已失效。`); }
  if (entity === "edge") facts.push(`路线边 ${id} 已标记为需要重新派生。`);
}

export function applyPlannerMutations(current: Itinerary, mutations: PlannerMutation[]) {
  const before = clone(current); const next = clone(current) as MutableItinerary;
  const mapper = createIdMapper(formalIds(current)); const records = asMutations(mutations); const facts: string[] = [];
  collectAddIds(records, mapper);
  for (const mutation of records) {
    const type = String(mutation.type || ""); const entity = String(mutation.entity || "");
    if (type === "update_fields") {
      const changes = clone(mutation.changes) as Record<string, unknown>; const id = mutation.id === null ? null : mapper.resolve(mutation.id);
      if (entity === "trip") {
        if (id !== null) throw new Error("trip mutation 的 id 必须为 null。");
        if ("originPlaceId" in changes && changes.originPlaceId !== null) changes.originPlaceId = mapper.resolve(changes.originPlaceId);
        if (Array.isArray(changes.destinationPlaceIds)) changes.destinationPlaceIds = changes.destinationPlaceIds.map(mapper.resolve);
        Object.assign(next.trip, changes);
      }
      else if (entity === "place") Object.assign(next.places.find((place) => place.id === id) ?? (() => { throw new Error(`未知 Place：${id}`); })(), changes);
      else if (entity === "day") Object.assign(findDay(next, id!).day, changes);
      else if (entity === "stop") Object.assign(findStop(next, id!).stop, changes);
      else throw new Error(`未知 mutation entity：${entity}`);
    } else if (type === "add_entity") {
      const value = mutation.value as Record<string, unknown>;
      if (entity === "place") next.places.push({ ...(clone(value) as any), id: mapper.resolve(value.id) });
      else if (entity === "day") { if (next.stage === "planning") throw new Error("未经确认不能在 planning 阶段创建 Day。"); next.days.push(mapNewDay(value, mapper.resolve)); }
      else if (entity === "stop") { const parent = findDay(next, mapper.resolve(mutation.parentId)).day; const stop = mapNewStop(value, mapper.resolve); parent.stops.splice(Math.max(0, parent.stops.length - 1), 0, stop); }
      else throw new Error(`未知新增实体类型：${entity}`);
    } else if (type === "remove_entity") {
      const id = mapper.resolve(mutation.id);
      if (entity === "place") next.places = next.places.filter((place) => place.id !== id);
      else if (entity === "day") next.days.splice(findDay(next, id).index, 1);
      else if (entity === "stop") { const found = findStop(next, id); found.day.stops.splice(found.stopIndex, 1); }
      else throw new Error(`未知删除实体类型：${entity}`);
    } else if (type === "move_entity") {
      const id = mapper.resolve(mutation.id); const position = mutation.position === null ? null : Number(mutation.position);
      if (entity === "day") { const { day, index } = findDay(next, id); next.days.splice(index, 1); next.days.splice(Math.min(Math.max(position ?? next.days.length, 0), next.days.length), 0, day); }
      else if (entity === "stop") { const found = findStop(next, id); found.day.stops.splice(found.stopIndex, 1); const target = findDay(next, mapper.resolve(mutation.targetParentId)).day; const insertion = position === null ? Math.max(0, target.stops.length - 1) : Math.min(Math.max(position, 0), target.stops.length); target.stops.splice(insertion, 0, found.stop); }
      else throw new Error(`未知移动实体类型：${entity}`);
    } else if (type === "replace_reference") {
      const id = mapper.resolve(mutation.id); const replacement = mapper.resolve(mutation.newReferenceId);
      if (!next.places.some((place) => place.id === replacement)) throw new Error(`替换引用指向未知 Place：${replacement}`);
      if (entity === "place") { if (next.trip.originPlaceId === id) next.trip.originPlaceId = replacement; next.trip.destinationPlaceIds = next.trip.destinationPlaceIds.map((item) => item === id ? replacement : item); for (const day of next.days) for (const stop of day.stops) if (stop.placeId === id) stop.placeId = replacement; }
      else if (entity === "stop") findStop(next, id).stop.placeId = replacement;
      else throw new Error(`未知引用替换实体类型：${entity}`);
    } else if (type === "invalidate_dependencies") applyExplicitInvalidation(next, mutation, mapper.resolve, facts);
    else throw new Error(`未知 mutation 类型：${type}`);
  }
  normalize(next);
  const beforeDays = new Map(before.days.map((day) => [day.id, day]));
  for (const day of next.days) if (beforeDays.get(day.id)?.date !== day.date) invalidateDayFacts(day, facts);
  const beforeTopology = topology(before); const afterTopology = topology(next);
  for (const [stopId, value] of afterTopology) {
    const previous = beforeTopology.get(stopId);
    if (!previous || previous.previousStopId !== value.previousStopId || previous.placeId !== value.placeId || previous.previousPlaceId !== value.previousPlaceId || previous.mode !== value.mode) invalidateStopTransport(findStop(next, stopId).stop, facts);
  }
  clearUnreferencedPlaces(next); degradeIncompleteDetailedDays(next);
  const itinerary = ItinerarySchema.parse(next);
  const changedDayIds = [...new Set([...itinerary.days.filter((day) => JSON.stringify(beforeDays.get(day.id)) !== JSON.stringify(day)).map((day) => day.id), ...before.days.filter((day) => !itinerary.days.some((nextDay) => nextDay.id === day.id)).map((day) => day.id)])];
  return { itinerary, idMappings: Object.fromEntries(mapper.mappings), changedDayIds, invalidatedFacts: [...new Set(facts)] };
}

function formalizeDraft(value: Itinerary) {
  const mapper = createIdMapper(new Set());
  for (const place of value.places) mapper.register(place.id);
  for (const day of value.days) { mapper.register(day.id); for (const stop of day.stops) mapper.register(stop.id); }
  const draft = clone(value) as MutableItinerary;
  draft.stage = "draft";
  draft.places = draft.places.map((place) => ({ ...place, id: mapper.resolve(place.id) }));
  draft.trip.originPlaceId = draft.trip.originPlaceId ? mapper.resolve(draft.trip.originPlaceId) : null;
  draft.trip.destinationPlaceIds = draft.trip.destinationPlaceIds.map(mapper.resolve);
  draft.days = draft.days.map((day) => ({ ...day, id: mapper.resolve(day.id), detailLevel: "draft", detailStatus: undefined, stops: day.stops.map((stop) => ({ ...stop, id: mapper.resolve(stop.id), placeId: mapper.resolve(stop.placeId), transportFromPrevious: stop.transportFromPrevious })) }));
  normalize(draft); clearUnreferencedPlaces(draft);
  return { itinerary: ItinerarySchema.parse(draft), idMappings: Object.fromEntries(mapper.mappings) };
}

export function applyPlannerOutput(store: TravelStore, tripId: string, value: unknown): PlannerApplyResult {
  const output = PlannerOutputSchema.parse(value); const trip = store.requireTrip(tripId);
  if (output.operation === "reply") return { trip, output, saved: false, startDetailing: false, idMappings: {}, changedDayIds: [], invalidatedFacts: [] };
  if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
  if (output.operation === "create_draft") {
    if (trip.itinerary.stage !== "planning" || !output.draftItinerary) throw new Error("create_draft 只能从 planning 阶段生成。");
    const created = formalizeDraft(output.draftItinerary);
    const written = store.writeItinerary(tripId, created.itinerary, trip.contentGeneration, { revision: { source: "draft", summary: "首次生成初稿" } });
    return { trip: written.trip, output, saved: true, startDetailing: false, idMappings: created.idMappings, changedDayIds: written.trip.itinerary.days.map((day) => day.id), invalidatedFacts: [] };
  }
  if (output.operation === "mutate_itinerary") {
    if (!output.mutations?.length) throw new Error("mutation 不能为空。");
    const applied = applyPlannerMutations(trip.itinerary, output.mutations);
    const written = store.writeItinerary(tripId, applied.itinerary, trip.contentGeneration, { revision: { source: "mutation", summary: "聊天修改行程" } });
    return { trip: written.trip, output, saved: true, startDetailing: false, ...applied };
  }
  if (trip.itinerary.stage === "planning" || !trip.itinerary.days.some((day) => day.detailLevel === "draft")) throw new Error("start_detailing 只能用于仍有 draft Day 的行程。");
  return { trip, output, saved: false, startDetailing: true, idMappings: {}, changedDayIds: [], invalidatedFacts: [] };
}
