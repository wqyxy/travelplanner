import { describe, expect, it } from "vitest";
import { ItineraryGenerateOutputSchema, ItineraryRefineOutputSchema, ItineraryVerifyOutputSchema } from "./ai-action-contracts-v3.js";

describe("V3 itinerary action contracts", () => {
  it("keeps itinerary generation candidate-first without newPlaces/newCandidates", () => {
    const result = ItineraryGenerateOutputSchema.safeParse({ schemaVersion: 1, baseGeneration: 0, result: { type: "requires_stage", requiresStage: "interests", assistantMessage: "需要先补地点", reason: "缺少具体地点" }, newPlaces: [], newCandidates: [] });
    expect(result.success).toBe(false);
  });

  it("allows verification to update dynamic Stop facts only", () => {
    const checkedAt = new Date().toISOString();
    expect(ItineraryVerifyOutputSchema.safeParse({
      schemaVersion: 1,
      baseGeneration: 3,
      assistantMessage: "已核验",
      title: "核验结果",
      explanation: "更新时间",
      checkedAt,
      commands: [{ type: "update_day_stop", stopId: "stop-1", changes: { startTime: "09:00", endTime: "10:00", durationMinutes: 60, scheduleVerification: { status: "verified", checkedAt } } }],
    }).success).toBe(true);

    expect(ItineraryVerifyOutputSchema.safeParse({
      schemaVersion: 1,
      baseGeneration: 3,
      assistantMessage: "越权",
      title: "越权",
      explanation: "尝试换地点",
      checkedAt,
      commands: [{ type: "update_day_stop", stopId: "stop-1", changes: { candidateId: "candidate-2", placeId: "place-2" } }],
    }).success).toBe(false);
  });

  it("makes refine output patch-only so the model cannot emit Day or Anchor identity", () => {
    const valid = {
      schemaVersion: 1,
      baseGeneration: 5,
      result: {
        type: "success" as const,
        assistantMessage: "已细化",
        title: "Day 1 细化",
        explanation: "补充时间与说明",
        dayIds: ["day-1"],
        dayUpdates: [{
          dayId: "day-1",
          stops: [{
            stopId: "stop-1",
            activity: "参观博物馆",
            period: "morning" as const,
            startTime: "09:00",
            endTime: "10:00",
            durationMinutes: 60,
            transportFromPrevious: null,
            scheduleVerification: { status: "estimated" as const, checkedAt: null },
            costNote: null,
            costVerification: null,
            notes: "建议提前到达",
          }],
        }],
      },
    };
    expect(ItineraryRefineOutputSchema.safeParse(valid).success).toBe(true);
    expect(ItineraryRefineOutputSchema.safeParse({
      ...valid,
      result: {
        ...valid.result,
        dayUpdates: [{ ...valid.result.dayUpdates[0], startAnchor: { placeId: "other-place" } }],
      },
    }).success).toBe(false);
  });
});
