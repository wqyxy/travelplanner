import type { TripFacts } from "./v2-types";

export function hasTravelRequirements(facts: TripFacts) { return facts.brief.destination.trim().length > 0; }
