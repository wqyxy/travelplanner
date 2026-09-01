import { describe, expect, it } from "vitest";
import { dispatchTravelApiV3 } from "./travel-api-v3.js";
import type { TravelPlannerRuntimeV3 } from "./planner-runtime-v3.js";
import type { TravelStoreV3 } from "./travel-store-v3.js";

function deps() {
  const providerCandidate = {
    provider: "nominatim", providerPlaceId: "place-1", name: "Picton", displayName: "Picton, Marlborough, New Zealand",
    latitude: -41.2907, longitude: 174.006, category: "place", placeType: "town", countryCode: "nz", region: "Marlborough", city: "Picton",
  };
  const store = {
    listTrips: () => [],
    createTrip: () => ({ id: "trip-1" }),
    requireTrip: () => ({ id: "trip-1" }),
    listMessages: () => [],
    listActions: () => [],
  } as unknown as TravelStoreV3;
  const runtime = {
    startConversation: (_tripId: string, stage: string, input: any) => ({ taskId: `dialogue:${stage}`, messageId: input.message }),
    createCtaAction: (input: any) => ({ action: { id: "action-1", actionType: input.actionType }, taskId: "action-task-1" }),
    searchResolutionCandidates: () => [{ candidate: providerCandidate, score: 95 }],
    previewGoogleMapsLink: (_tripId: string, _placeId: string, input: any) => ({ ...input, latitude: 35, longitude: 135 }),
    applyGoogleMapsLink: (_tripId: string, _placeId: string, input: any) => ({ ...input, generation: 2 }),
    recalculateMacroRoute: (tripId: string, dayId: string, generation: number) => ({ tripId, dayId: `macro:${dayId}`, generation }),
    recalculateDirtyMacroRoutes: (tripId: string, input: any) => ({ tripId, expectedGeneration: input.expectedGeneration, routes: [] }),
  } as unknown as TravelPlannerRuntimeV3;
  return { store, runtime, providerCandidate };
}

describe("travel API v3", () => {
  it("routes dialogue by explicit ConversationStage", async () => {
    const result = await dispatchTravelApiV3("POST", "/api/trips/trip-1/stages/interests/turns", new URLSearchParams(), { message: "再推荐几个景点", selection: { type: "candidate_pool", id: null } }, deps());
    expect(result?.status).toBe(202);
    expect(result?.data).toMatchObject({ taskId: "dialogue:interests", messageId: "再推荐几个景点" });
  });

  it("routes CTA through the unified action endpoint", async () => {
    const result = await dispatchTravelApiV3("POST", "/api/trips/trip-1/actions/cta", new URLSearchParams(), { stage: "itinerary", actionType: "itinerary.generate", requestKey: "click-1", parameters: {}, targetIds: [] }, deps());
    expect(result?.status).toBe(202);
    expect(result?.data).toMatchObject({ action: { id: "action-1", actionType: "itinerary.generate" } });
  });

  it("does not expose the old direct plan-generation endpoint", async () => {
    const result = await dispatchTravelApiV3("POST", "/api/trips/trip-1/plan/generate", new URLSearchParams(), {}, deps());
    expect(result).toBeNull();
  });

  it("returns flat provider candidates for the map selection dialog", async () => {
    const dependencies = deps();
    const result = await dispatchTravelApiV3("GET", "/api/trips/trip-1/resolutions/place-1/candidates", new URLSearchParams({ expectedGeneration: "1" }), {}, dependencies);
    expect(result).toEqual({ status: 200, data: { candidates: [dependencies.providerCandidate] } });
  });

  it("keeps Google Maps preview and commit behind dedicated place endpoints", async () => {
    const preview = await dispatchTravelApiV3("POST", "/api/trips/trip-1/places/place-1/google-maps", new URLSearchParams(), { expectedGeneration: 1, url: "https://www.google.com/maps/?q=35,135" }, deps());
    expect(preview?.data).toMatchObject({ latitude: 35, longitude: 135 });
    const commit = await dispatchTravelApiV3("PUT", "/api/trips/trip-1/places/place-1/google-maps", new URLSearchParams(), { expectedGeneration: 1, url: "https://www.google.com/maps/?q=35,135", changes: { nameZh: "测试地点" } }, deps());
    expect(commit?.data).toMatchObject({ generation: 2 });
  });

  it("exposes separate Macro Route recalculation endpoints", async () => {
    const one = await dispatchTravelApiV3("POST", "/api/trips/trip-1/macro-routes/day-2/recalculate", new URLSearchParams(), { expectedGeneration: 7 }, deps());
    expect(one?.data).toMatchObject({ route: { tripId: "trip-1", dayId: "macro:day-2", generation: 7 } });
    const dirty = await dispatchTravelApiV3("POST", "/api/trips/trip-1/macro-routes/recalculate", new URLSearchParams(), { expectedGeneration: 7 }, deps());
    expect(dirty?.data).toMatchObject({ tripId: "trip-1", expectedGeneration: 7, routes: [] });
  });
});
