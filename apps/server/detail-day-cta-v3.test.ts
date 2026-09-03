import { describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema, emptyTravelPlan } from "./contracts-v2.js";
import { normalizeDetailDayCtaActionV3 } from "./detail-day-cta-v3.js";

function planWithDay(input: { detailLevel: "planned" | "detailed"; detailStatus: "ready" | "needs_review" | null; stopCount: number }) {
  const base = emptyTravelPlan();
  return TravelPlanDocumentSchema.parse({
    ...base,
    days: [{
      id: "day-18",
      dayNumber: 18,
      date: null,
      title: "Wanaka",
      stayBlockId: "stay-wanaka",
      transferMode: "drive",
      detailLevel: input.detailLevel,
      detailStatus: input.detailStatus,
      startAnchor: { id: "start-18", placeId: null, label: "Wanaka", notes: null },
      stops: Array.from({ length: input.stopCount }, (_, index) => ({
        id: `stop-${index}`,
        candidateId: null,
        placeId: `place-${index}`,
        activity: "existing",
        period: null,
        startTime: null,
        endTime: null,
        durationMinutes: null,
        transportFromPrevious: null,
        scheduleVerification: null,
        costNote: null,
        costVerification: null,
        notes: null,
      })),
      endAnchor: { id: "end-18", placeId: null, label: "Wanaka", notes: null },
    }],
  });
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
