import type { Day, PlaceResolution, TravelPlanDocument } from "./contracts-v2.js";

type TripPlanCarrier = { plan: TravelPlanDocument };

export function validateItineraryReferences(
  trip: TripPlanCarrier,
  sourceDays: Day[],
  _resolutions: PlaceResolution[],
) {
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const candidates = new Map(trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const checkPlace = (placeId: string | null) => {
    if (!placeId) return;
    if (!places.has(placeId)) throw new Error(`行程引用未知 Place：${placeId}`);
  };

  for (const day of sourceDays) {
    checkPlace(day.startAnchor.placeId);
    checkPlace(day.endAnchor.placeId);
    for (const stop of day.stops) {
      checkPlace(stop.placeId);
      if (!stop.candidateId) continue;
      const candidate = candidates.get(stop.candidateId);
      if (!candidate) throw new Error(`行程引用未知 Candidate：${stop.candidateId}`);
      if (candidate.placeId !== stop.placeId) throw new Error(`Stop Candidate 与 Place 不一致：${candidate.id}`);
    }
  }
}
