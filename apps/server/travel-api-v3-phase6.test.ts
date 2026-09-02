import { describe, expect, it } from "vitest";
import { emptyTravelPlan } from "./contracts-v2.js";
import { dispatchTravelApiV3 } from "./travel-api-v3.js";

describe("Phase 6 travel API integration", () => {
  it("normalizes Step 1 duration text before creating the requirements update action", async () => {
    const plan = emptyTravelPlan();
    let captured: any = null;
    const result = await dispatchTravelApiV3(
      "POST",
      "/api/trips/trip/actions/cta",
      new URLSearchParams(),
      {
        stage: "requirements",
        actionType: "requirements.update",
        requestKey: "phase6-duration",
        parameters: { changes: { brief: { duration: "20 天左右" } } },
        targetIds: [],
      },
      {
        store: { requireTrip: () => ({ plan }) } as any,
        runtime: { createCtaAction: (input: unknown) => { captured = input; return { action: input }; } } as any,
      },
    );

    expect(result?.status).toBe(202);
    expect(captured.parameters).toEqual({
      changes: {
        brief: { duration: "20 天左右" },
        dates: { start: null, end: null, requestedDurationDays: 20 },
      },
    });
  });
});
