import { z } from "zod";
import { applySkeletonPlanV3 } from "./itinerary-workflow-v3.js";
import { SkeletonEditDraftSchema } from "./skeleton-contracts-v3.js";
import type { TravelPlannerRuntimeV3 } from "./planner-runtime-v3.js";
import type { TravelStoreV3 } from "./travel-store-v3.js";

export const SkeletonEditSaveInputSchema = z.object({
  expectedGeneration: z.number().int().min(0),
  draft: SkeletonEditDraftSchema,
}).strict();

export async function saveSkeletonEditDraftV3(
  store: TravelStoreV3,
  runtime: TravelPlannerRuntimeV3,
  tripId: string,
  inputValue: unknown,
) {
  const input = SkeletonEditSaveInputSchema.parse(inputValue);
  const trip = store.requireTrip(tripId);
  if (trip.contentGeneration !== input.expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");

  const applied = applySkeletonPlanV3(trip, input.draft);
  const written = store.writePlan(
    tripId,
    applied.plan,
    input.expectedGeneration,
    { source: "ui:skeleton.edit", summary: "保存路线和天数调整" },
  );

  for (const day of written.trip.plan.days) {
    if (day.startAnchor.placeId === day.endAnchor.placeId) continue;
    void runtime.recalculateMacroRoute(tripId, day.id, written.generation).catch(() => undefined);
  }

  return {
    trip: written.trip,
    generation: written.generation,
    version: written.version,
    affectedDayIds: applied.affectedDayIds,
  };
}
