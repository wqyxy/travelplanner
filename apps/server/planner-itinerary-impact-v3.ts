import { TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import { analyzeItineraryImpactV3 } from "./itinerary-impact-v3.js";

export function markImpact(before: TravelPlanDocument, after: TravelPlanDocument) {
  const impact = analyzeItineraryImpactV3(before, after);
  if (!impact.detail.affectedDayIds.length) return after;
  const affected = new Set(impact.detail.affectedDayIds);
  return TravelPlanDocumentSchema.parse({
    ...after,
    days: after.days.map((day) => affected.has(day.id) && day.detailLevel === "detailed"
      ? { ...day, detailStatus: "needs_review" }
      : day),
  });
}
