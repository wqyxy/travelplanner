import type { TripFacts } from "./v2-types";

export function hasTravelRequirements(facts: TripFacts) {
  return facts.title.trim() !== "未命名旅行"
    || facts.originPlaceId !== null
    || facts.destinationPlaceIds.length > 0
    || facts.dates.start !== null
    || facts.dates.end !== null
    || facts.dates.requestedDurationDays !== null
    || facts.travelers.summary.trim().length > 0
    || facts.travelers.adults !== null
    || facts.travelers.children !== null
    || facts.budget.amount !== null
    || facts.budget.currency !== null
    || facts.budget.note !== null
    || facts.pace !== null
    || facts.themes.length > 0
    || facts.preferences.length > 0
    || facts.constraints.length > 0
    || facts.assumptions.length > 0;
}
