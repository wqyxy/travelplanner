import { describe, expect, it } from "vitest";
import type { TravelPlanDocument } from "./contracts-v2.js";
import { normalizeDetailDayCtaActionV3 } from "./detail-day-cta-v3.js";

function planWithDay(input: { detailLevel: "planned" | "detailed"; detailStatus: "ready" | "needs_review" | null; stopCount: number }) {
  return {
    days: [{
      id: "day-18",
      detailLevel: input.detailLevel,
      detailStatus: input.detailStatus,
      stops: Array.from({ length: input.stopCount }, (_, index) => ({ id: `stop-${index}` })),
    }],
  } as unknown as TravelPlanDocument;
}

describe("normalizeDetailDayCtaActionV3", () => {
  it("routes a planned empty day from refine to detail.update", () => {
    const plan = planWithDay({ detailLevel: "planned", detailStatus: null, stopCount: 0 });
    expect(normalizeDetailDayCtaActionV3(plan, "itinerary.refine", { dayIds: ["day-18"] }, ["day-18"]))
      .toBe("itinerary.detail.update");
  });

  it("routes a needs_review day to detail.update even when it already has stops", () => {
    const plan = planWithDay({ detailLevel: "detailed", detailStatus: "needs_review", stopCount: 1 });
    expect(normalizeDetailDayCtaActionV3(plan, "itinerary.refine", { dayIds: ["day-18"] }, ["day-18"]))
      .toBe("itinerary.detail.update");
  });

  it("routes a detailed ready day with zero stops to detail.update", () => {
    const plan = planWithDay({ detailLevel: "detailed", detailStatus: "ready", stopCount: 0 });
    expect(normalizeDetailDayCtaActionV3(plan, "itinerary.refine", { dayIds: ["day-18"] }, ["day-18"]))
      .toBe("itinerary.detail.update");
  });

  it("keeps refine for a detailed ready day that has existing stops", () => {
    const plan = planWithDay({ detailLevel: "detailed", detailStatus: "ready", stopCount: 1 });
    expect(normalizeDetailDayCtaActionV3(plan, "itinerary.refine", { dayIds: ["day-18"] }, ["day-18"]))
      .toBe("itinerary.refine");
  });

  it("leaves unrelated actions unchanged", () => {
    const plan = planWithDay({ detailLevel: "planned", detailStatus: null, stopCount: 0 });
    expect(normalizeDetailDayCtaActionV3(plan, "itinerary.detail.update", { dayIds: ["day-18"] }, ["day-18"]))
      .toBe("itinerary.detail.update");
  });
});
