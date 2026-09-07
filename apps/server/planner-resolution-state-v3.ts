import type { PlaceResolution, TravelPlanDocument } from "./contracts-v2.js";
import { resolutionIsCurrent } from "./place-resolver-v2.js";

type TripPlanCarrier = { plan: TravelPlanDocument };

export function currentPlaceResolutions(trip: TripPlanCarrier, resolutions: PlaceResolution[]) {
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  return resolutions.filter((resolution) => {
    const place = places.get(resolution.placeId);
    return Boolean(place && resolutionIsCurrent(place, resolution));
  });
}

export function currentResolvedPlaces(trip: TripPlanCarrier, resolutions: PlaceResolution[]) {
  return currentPlaceResolutions(trip, resolutions).filter((resolution) => resolution.status === "resolved");
}
