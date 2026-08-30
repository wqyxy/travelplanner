import { describe, expect, it } from "vitest";
import { dispatchTravelApiV3 } from "./travel-api-v3.js";
import type { TravelPlannerRuntimeV3 } from "./planner-runtime-v3.js";
import type { TravelStoreV3 } from "./travel-store-v3.js";

function deps() {
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
  } as unknown as TravelPlannerRuntimeV3;
  return { store, runtime };
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
});
