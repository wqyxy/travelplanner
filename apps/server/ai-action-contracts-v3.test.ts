import { describe, expect, it } from "vitest";
import {
  ItineraryDetailGenerateOutputSchema,
  ItineraryDetailUpdateOutputSchema,
  ItineraryGenerateOutputSchema,
  ItineraryRefineOutputSchema,
  ItineraryVerifyOutputSchema,
} from "./ai-action-contracts-v3.js";

describe("V3 itinerary action contracts", () => {
  it("keeps step four macro-only", () => {
    expect(ItineraryGenerateOutputSchema.safeParse({
      schemaVersion: 1,
      baseGeneration: 0,
      result: {
        type: "success",
        assistantMessage: "骨架完成",
        destinations: [
          { destinationCandidateId: "macro-a", stayDays: 2, transferMode: "none" },
          { destinationCandidateId: "macro-b", stayDays: 3, transferMode: "drive" },
        ],
      },
    }).success).toBe(true);

    expect(ItineraryGenerateOutputSchema.safeParse({
      schemaVersion: 1,
      baseGeneration: 0,
      result: {
        type: "success",
        assistantMessage: "越界安排兴趣点",
        destinations: [{ destinationCandidateId: "macro-a", stayDays: 5, transferMode: "none", stops: [{ candidateId: "micro-a" }] }],
      },
    }).success).toBe(false);
  });

  it("keeps step five on stable day ids and forbids anchor rewrites", () => {
    const stop = {
      candidateId: "micro-a",
      activity: "参观博物馆",
      period: "morning" as const,
      startTime: "09:00",
      endTime: "10:00",
      durationMinutes: 60,
      transportFromPrevious: null,
      scheduleVerification: { status: "estimated" as const, checkedAt: null },
      costNote: null,
      costVerification: null,
      notes: null,
    };
    expect(ItineraryDetailGenerateOutputSchema.safeParse({
      schemaVersion: 1,
      baseGeneration: 2,
      result: { type: "success", assistantMessage: "详细行程完成", dayUpdates: [{ dayId: "day-1", stops: [stop] }], unscheduledCandidates: [] },
    }).success).toBe(true);
    expect(ItineraryDetailGenerateOutputSchema.safeParse({
      schemaVersion: 1,
      baseGeneration: 2,
      result: { type: "success", assistantMessage: "越界", dayUpdates: [{ dayId: "day-1", startAnchor: { placeId: "other" }, stops: [stop] }], unscheduledCandidates: [] },
    }).success).toBe(false);
  });

  it("requires detail patch output to exactly match affected day ids", () => {
    const stop = {
      candidateId: "micro-a",
      activity: "参观",
      period: null,
      startTime: "09:00",
      endTime: "10:00",
      durationMinutes: 60,
      transportFromPrevious: null,
      scheduleVerification: { status: "estimated" as const, checkedAt: null },
      costNote: null,
      costVerification: null,
      notes: null,
    };
    expect(ItineraryDetailUpdateOutputSchema.safeParse({
      schemaVersion: 1,
      baseGeneration: 4,
      result: { type: "success", assistantMessage: "局部更新", title: "更新两天", explanation: "只更新受影响日期", affectedDayIds: ["day-2", "day-4"], dayUpdates: [{ dayId: "day-2", stops: [stop] }, { dayId: "day-4", stops: [] }] },
    }).success).toBe(true);
    expect(ItineraryDetailUpdateOutputSchema.safeParse({
      schemaVersion: 1,
      baseGeneration: 4,
      result: { type: "success", assistantMessage: "越界", title: "越界", explanation: "返回了未授权日期", affectedDayIds: ["day-2"], dayUpdates: [{ dayId: "day-2", stops: [stop] }, { dayId: "day-3", stops: [] }] },
    }).success).toBe(false);
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
