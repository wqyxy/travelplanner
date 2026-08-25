import { randomUUID } from "node:crypto";
import {
  DetailBatchOutputSchema,
  DetailCanonicalFeedbackSchema,
  ItinerarySchema,
  detailTimingReviewIssues,
  type Day,
  type DetailBatchOutput,
  type DetailCanonicalFeedback,
  type DetailTimingReviewIssue,
  type Itinerary,
  type Place,
  type Stop,
  type Verification,
} from "./contracts.js";
import type { TravelStore, TripDetail } from "./travel-store.js";

export type DetailBatchRequest = {
  batchId: string;
  dayIds: string[];
};

export type DetailBatchApplyResult = {
  trip: TripDetail;
  output: DetailBatchOutput;
  feedback: DetailCanonicalFeedback;
  changedDayIds: string[];
  completedDayIds: string[];
  allDetailed: boolean;
  timingReviewIssues: DetailTimingReviewIssue[];
};

const clone = <T>(value: T): T => structuredClone(value);
const invalidVerification = (): Verification => ({ status: "unverified", checkedAt: null });
const placeIdentityFields: Array<keyof Place> = ["kind", "city", "region", "country", "countryCode", "approximate"];
const normalizedNames = (place: Place) => new Set([place.nameZh, place.nameLocal, place.nameEn].filter((name): name is string => Boolean(name)).map((name) => name.normalize("NFKC").trim().toLocaleLowerCase()));
function placeIdentityChanged(previous: Place, next: Place) {
  if (placeIdentityFields.some((field) => previous[field] !== next[field])) return true;
  const before = normalizedNames(previous); const after = normalizedNames(next);
  return before.size > 0 && after.size > 0 && [...before].every((name) => !after.has(name));
}

export function remainingDetailDayIds(itinerary: Itinerary) {
  return itinerary.days.filter((day) => day.detailLevel !== "detailed").map((day) => day.id);
}

export function nextDetailBatch(itinerary: Itinerary): DetailBatchRequest | null {
  const dayIds = remainingDetailDayIds(itinerary).slice(0, 2);
  return dayIds.length ? { batchId: randomUUID(), dayIds } : null;
}

function equalIds(actual: string[], expected: string[]) {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function allFormalIds(itinerary: Itinerary) {
  return new Set([
    ...itinerary.places.map((place) => place.id),
    ...itinerary.days.map((day) => day.id),
    ...itinerary.days.flatMap((day) => day.stops.map((stop) => stop.id)),
  ]);
}

function createTemporaryIdMapper(existing: Set<string>) {
  const mappings = new Map<string, string>();
  const register = (id: string) => {
    if (!id || existing.has(id) || mappings.has(id)) throw new Error(`新增实体临时 ID 重复或覆盖正式 ID：${id}`);
    mappings.set(id, randomUUID());
  };
  const resolve = (id: string) => mappings.get(id) ?? id;
  return { mappings, register, resolve };
}

function assertPreservedRoute(current: Day, returned: Day, existingStopOwner: Map<string, string>) {
  if (returned.dayNumber !== current.dayNumber || returned.date !== current.date) throw new Error(`细化不得修改 Day ${current.id} 的日期或 dayNumber。`);
  const currentIds = current.stops.map((stop) => stop.id);
  const returnedFormal = returned.stops.filter((stop) => existingStopOwner.has(stop.id));
  if (!equalIds(returnedFormal.map((stop) => stop.id), currentIds)) throw new Error(`细化必须按原顺序保留 Day ${current.id} 的全部正式 Stop。`);
  if (returned.stops[0]?.id !== currentIds[0] || returned.stops.at(-1)?.id !== currentIds.at(-1)) throw new Error(`细化不得替换 Day ${current.id} 的开始或结束 Stop。`);
  const currentStops = new Map(current.stops.map((stop) => [stop.id, stop]));
  for (const stop of returnedFormal) {
    if (existingStopOwner.get(stop.id) !== current.id) throw new Error(`Stop ${stop.id} 不属于指定 Day。`);
    if (currentStops.get(stop.id)?.placeId !== stop.placeId) throw new Error(`细化不得替换既有 Stop ${stop.id} 的 Place 引用。`);
  }
}

function invalidatePlaceDependents(itinerary: Itinerary, placeId: string, protectedDayIds: Set<string>, facts: string[], changedDayIds: Set<string>) {
  for (const day of itinerary.days) {
    if (protectedDayIds.has(day.id) || !day.stops.some((stop) => stop.placeId === placeId)) continue;
    let changed = false;
    for (const [index, stop] of day.stops.entries()) {
      if (stop.placeId === placeId) {
        if (stop.scheduleVerification) { stop.scheduleVerification = invalidVerification(); changed = true; }
        if (stop.costVerification) { stop.costVerification = invalidVerification(); changed = true; }
        if (stop.transportFromPrevious) { stop.transportFromPrevious = { ...stop.transportFromPrevious, durationMinutes: null, verification: invalidVerification() }; changed = true; }
        const next = day.stops[index + 1];
        if (next?.transportFromPrevious) { next.transportFromPrevious = { ...next.transportFromPrevious, durationMinutes: null, verification: invalidVerification() }; changed = true; }
      }
    }
    if (!changed) continue;
    if (day.detailLevel === "detailed") { day.detailLevel = "draft"; day.detailStatus = "needs_review"; }
    changedDayIds.add(day.id);
    facts.push(`Place ${placeId} 的身份信息变化；Day ${day.id} 的相关核验和相邻交通已失效。`);
  }
}

function clearUnreferencedPlaces(itinerary: Itinerary) {
  const referenced = new Set([
    ...[itinerary.trip.originPlaceId].filter((id): id is string => Boolean(id)),
    ...itinerary.trip.destinationPlaceIds,
    ...itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId)),
  ]);
  itinerary.places = itinerary.places.filter((place) => referenced.has(place.id));
}

export function applyDetailBatch(store: TravelStore, tripId: string, request: DetailBatchRequest, value: unknown, options: { forbiddenTemporaryIds?: string[] } = {}): DetailBatchApplyResult {
  const output = DetailBatchOutputSchema.parse(value);
  const timingReviewIssues = detailTimingReviewIssues(output.days);
  const trip = store.requireTrip(tripId);
  if (trip.itinerary.stage === "planning") throw new Error("01 不能细化 planning itinerary。");
  if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
  if (output.batchId !== request.batchId || !equalIds(output.dayIds, request.dayIds)) throw new Error("细化输出与服务端指定批次不一致。");

  const currentDays = new Map(trip.itinerary.days.map((day) => [day.id, day]));
  const requested = request.dayIds.map((id) => currentDays.get(id) ?? (() => { throw new Error(`指定 Day 不存在：${id}`); })());
  if (requested.some((day) => day.detailLevel === "detailed")) throw new Error("细化批次包含已经完成的 Day。");

  const existingIds = allFormalIds(trip.itinerary);
  const existingPlaceIds = new Set(trip.itinerary.places.map((place) => place.id));
  const existingDayIds = new Set(trip.itinerary.days.map((day) => day.id));
  const existingStopOwner = new Map(trip.itinerary.days.flatMap((day) => day.stops.map((stop) => [stop.id, day.id] as const)));
  const mapper = createTemporaryIdMapper(existingIds);
  const forbiddenTemporaryIds = new Set(options.forbiddenTemporaryIds ?? []);
  const seenPlaceUpserts = new Set<string>();
  for (const place of output.placeUpserts) {
    if (seenPlaceUpserts.has(place.id)) throw new Error(`Place upsert ID 重复：${place.id}`);
    seenPlaceUpserts.add(place.id);
    if (!existingPlaceIds.has(place.id)) { if (forbiddenTemporaryIds.has(place.id)) throw new Error(`细化输出重复使用已回灌的临时 ID：${place.id}`); mapper.register(place.id); }
  }
  for (const day of output.days) {
    if (!existingDayIds.has(day.id)) throw new Error(`细化不得创建或替换 Day ID：${day.id}`);
    for (const stop of day.stops) if (!existingStopOwner.has(stop.id)) { if (forbiddenTemporaryIds.has(stop.id)) throw new Error(`细化输出重复使用已回灌的临时 ID：${stop.id}`); mapper.register(stop.id); }
  }

  const returnedDays = new Map(output.days.map((day) => [day.id, day]));
  for (const day of requested) assertPreservedRoute(day, returnedDays.get(day.id)!, existingStopOwner);

  const next = clone(trip.itinerary);
  const targetIds = new Set(request.dayIds);
  const changedDayIds = new Set(request.dayIds);
  const invalidatedFacts: string[] = [];
  const canonicalPlaceChanges: Place[] = [];
  const placeIndex = new Map(next.places.map((place, index) => [place.id, index]));
  for (const source of output.placeUpserts) {
    const place = { ...clone(source), id: mapper.resolve(source.id) };
    const index = placeIndex.get(place.id);
    if (index === undefined) {
      placeIndex.set(place.id, next.places.length);
      next.places.push(place);
    } else {
      const previous = next.places[index];
      next.places[index] = place;
      if (placeIdentityChanged(previous, place)) invalidatePlaceDependents(next, place.id, targetIds, invalidatedFacts, changedDayIds);
    }
    canonicalPlaceChanges.push(place);
  }

  next.days = next.days.map((current) => {
    const returned = returnedDays.get(current.id);
    if (!returned) return current;
    const day = clone(returned);
    day.detailStatus = timingReviewIssues.some((issue) => issue.dayId === day.id) ? "needs_review" : "ready";
    day.stops = day.stops.map((stop): Stop => ({ ...stop, id: mapper.resolve(stop.id), placeId: mapper.resolve(stop.placeId) }));
    return day;
  });
  clearUnreferencedPlaces(next);
  const retainedPlaces = new Set(next.places.map((place) => place.id));
  const finalPlaceChanges = canonicalPlaceChanges.filter((place) => retainedPlaces.has(place.id));
  const allDetailed = next.days.length > 0 && next.days.every((day) => day.detailLevel === "detailed");
  next.stage = allDetailed ? "detailed" : trip.itinerary.stage;
  const itinerary = ItinerarySchema.parse(next);
  const written = store.writeItinerary(tripId, itinerary, trip.contentGeneration, allDetailed ? { revision: { source: "detail", summary: "完成全部日期细化" } } : {});
  const canonicalDays = request.dayIds.map((id) => written.trip.itinerary.days.find((day) => day.id === id)!);
  const feedback = DetailCanonicalFeedbackSchema.parse({
    appliedDayIds: request.dayIds,
    idMappings: Object.fromEntries(mapper.mappings),
    canonicalDays,
    canonicalPlaceChanges: finalPlaceChanges,
    invalidatedFacts: [...new Set(invalidatedFacts)],
    currentGeneration: written.generation,
  });
  return {
    trip: written.trip,
    output,
    feedback,
    changedDayIds: [...changedDayIds],
    completedDayIds: written.trip.itinerary.days.filter((day) => day.detailLevel === "detailed").map((day) => day.id),
    allDetailed,
    timingReviewIssues,
  };
}
