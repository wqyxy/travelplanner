import type { DayRoute, PlaceResolution, TravelPlanDocument } from "./contracts-v2.js";

export type ProviderTripViewV3 = {
  contentGeneration: number;
  plan: TravelPlanDocument;
};

export type ProviderWorkspaceViewV3 = {
  trip: ProviderTripViewV3;
  resolutions: PlaceResolution[];
  routes: DayRoute[];
};

export type PlaceResolutionStoreCapabilityV3 = {
  requireTrip(tripId: string): ProviderTripViewV3;
  listPlaceResolutions(tripId: string): PlaceResolution[];
  upsertPlaceResolution(tripId: string, value: unknown, expectedGeneration: number): PlaceResolution;
};

export type DayRouteStoreCapabilityV3 = {
  getWorkspace(tripId: string): ProviderWorkspaceViewV3;
  requireTrip(tripId: string): ProviderTripViewV3;
  listPlaceResolutions(tripId: string): PlaceResolution[];
  getDayRoute(tripId: string, dayId: string): DayRoute | null;
  setDayRoute(tripId: string, value: unknown, expectedGeneration: number): DayRoute;
};
