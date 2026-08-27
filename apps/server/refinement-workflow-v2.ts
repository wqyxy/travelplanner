import {
  DetailBatchOutputV2Schema,
  TravelPlanDocumentSchema,
  type Day,
  type DetailBatchOutputV2,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import type { TravelStoreV2, TripDetailV2 } from "./travel-store-v2.js";

export type StoredRefinementResult = {
  output: DetailBatchOutputV2;
  trip: TripDetailV2;
  generation: number;
  version: number;
  changedDayIds: string[];
};

function immutableDayStructure(day: Day) {
  return {
    id: day.id,
    dayNumber: day.dayNumber,
    date: day.date,
    startAnchor: { id: day.startAnchor.id, placeId: day.startAnchor.placeId },
    stops: day.stops.map((stop) => ({ id: stop.id, candidateId: stop.candidateId, placeId: stop.placeId })),
    endAnchor: { id: day.endAnchor.id, placeId: day.endAnchor.placeId },
  };
}

function replaceDetailedDays(plan: TravelPlanDocument, output: DetailBatchOutputV2) {
  if (output.newPlaces.length || output.newCandidates.length) {
    throw new Error("P0 行程细化不能新增或替换地点；请先在地点池中完成地点调整。");
  }
  const next = structuredClone(plan);
  const returned = new Map(output.days.map((day) => [day.id, day]));
  for (const dayId of output.dayIds) {
    const index = next.days.findIndex((day) => day.id === dayId);
    const detailed = returned.get(dayId);
    if (index < 0 || !detailed) throw new Error(`行程细化引用未知 Day：${dayId}`);
    const current = next.days[index];
    if (JSON.stringify(immutableDayStructure(current)) !== JSON.stringify(immutableDayStructure(detailed))) {
      throw new Error(`行程细化不得改变 Day ${current.dayNumber} 的地点、顺序、Anchor 或正式 ID。`);
    }
    next.days[index] = { ...structuredClone(detailed), detailLevel: "detailed", detailStatus: "ready" };
  }
  next.stage = "itinerary_refinement";
  return TravelPlanDocumentSchema.parse(next);
}

export function applyRefinementBatchToStore(store: TravelStoreV2, tripId: string, value: unknown): StoredRefinementResult {
  const output = DetailBatchOutputV2Schema.parse(value);
  const trip = store.requireTrip(tripId);
  if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
  const plan = replaceDetailedDays(trip.plan, output);
  const written = store.writePlan(tripId, plan, output.baseGeneration, {
    source: "refinement",
    summary: `细化 Day ${output.dayIds.map((id) => trip.plan.days.find((day) => day.id === id)?.dayNumber ?? "?").join("、")}`,
  });
  return { output, trip: written.trip, generation: written.generation, version: written.version, changedDayIds: output.dayIds };
}
