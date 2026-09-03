import { describe, expect, it } from "vitest";
import { dispatchTravelApiV3 } from "./travel-api-v3.js";

function depsForDay(day: { id: string; detailLevel: "planned" | "detailed"; detailStatus: "ready" | "needs_review" | null; stops: unknown[] }) {
  const calls: any[] = [];
  const plan = { days: [day] } as any;
  const deps = {
    store: {
      requireTrip: () => ({ plan }),
    },
    runtime: {
      createCtaAction: (input: unknown) => {
        calls.push(input);
        return { action: input };
      },
    },
  } as any;
  return { deps, calls };
}

async function dispatchRefine(deps: any) {
  return dispatchTravelApiV3(
    "POST",
    "/api/trips/trip/actions/cta",
    new URLSearchParams(),
    {
      stage: "itinerary",
      actionType: "itinerary.refine",
      parameters: { dayIds: ["day-18"] },
      targetIds: ["day-18"],
      requestKey: "detail-day-18",
    },
    deps,
  );
}

describe("detail day CTA API normalization", () => {
  it("turns the normal refine CTA into detail.update for a planned empty day", async () => {
    const { deps, calls } = depsForDay({ id: "day-18", detailLevel: "planned", detailStatus: null, stops: [] });
    const response = await dispatchRefine(deps);
    expect(response?.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tripId: "trip",
      stage: "itinerary",
      actionType: "itinerary.detail.update",
      parameters: { dayIds: ["day-18"] },
      targetIds: ["day-18"],
      requestKey: "detail-day-18",
    });
  });

  it("keeps refine for a detailed ready day with an existing stop", async () => {
    const { deps, calls } = depsForDay({ id: "day-18", detailLevel: "detailed", detailStatus: "ready", stops: [{ id: "stop-1" }] });
    const response = await dispatchRefine(deps);
    expect(response?.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0].actionType).toBe("itinerary.refine");
  });
});
