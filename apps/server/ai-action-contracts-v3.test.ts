import { describe, expect, it } from "vitest";
import { ItineraryGenerateOutputSchema, ItineraryVerifyOutputSchema } from "./ai-action-contracts-v3.js";

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
});
