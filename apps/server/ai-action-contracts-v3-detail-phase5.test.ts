import { describe, expect, it } from "vitest";
import { ItineraryDetailGenerateOutputSchema, ItineraryDetailUpdateOutputSchema } from "./ai-action-contracts-v3.js";

const stop = {
  candidateId: "core-1",
  activity: "游览核心地点",
  period: "morning" as const,
  startTime: "09:00",
  endTime: "11:00",
  durationMinutes: 120,
  transportFromPrevious: null,
  scheduleVerification: { status: "estimated" as const, checkedAt: null },
  costNote: null,
  costVerification: null,
  notes: null,
};

describe("Phase 5 detailed output ownership contracts", () => {
  it("accepts a successful Detail Generate with structured unscheduled reasons", () => {
    expect(() => ItineraryDetailGenerateOutputSchema.parse({
      schemaVersion: 1,
      baseGeneration: 7,
      result: {
        type: "success",
        assistantMessage: "已生成",
        dayUpdates: [{ dayId: "day-1", stops: [stop] }],
        unscheduledCandidates: [{ candidateId: "core-2", reason: "当天已有两处必去，继续加入会超出当前节奏容量。" }],
      },
    })).not.toThrow();
  });

  it("accepts the new workflow-step navigation result for a dirty Skeleton", () => {
    expect(() => ItineraryDetailGenerateOutputSchema.parse({
      schemaVersion: 1,
      baseGeneration: 7,
      result: {
        type: "requires_workflow_step",
        requiresWorkflowStep: "skeleton",
        assistantMessage: "请先更新路线和天数",
        reason: "Macro basis 已变化",
      },
    })).not.toThrow();
  });

  it("rejects the legacy requires_stage interests gate for Detail Generate and Update", () => {
    const legacy = {
      type: "requires_stage",
      requiresStage: "interests",
      assistantMessage: "请先补充兴趣点",
      reason: "旧流程要求",
    };
    expect(() => ItineraryDetailGenerateOutputSchema.parse({ schemaVersion: 1, baseGeneration: 7, result: legacy })).toThrow();
    expect(() => ItineraryDetailUpdateOutputSchema.parse({ schemaVersion: 1, baseGeneration: 7, result: legacy })).toThrow();
  });

  it("requires Detail Update to return exactly the requested affected day set", () => {
    expect(() => ItineraryDetailUpdateOutputSchema.parse({
      schemaVersion: 1,
      baseGeneration: 7,
      result: {
        type: "success",
        assistantMessage: "局部更新",
        title: "更新两天",
        explanation: "只调整受影响日期",
        affectedDayIds: ["day-1", "day-2"],
        dayUpdates: [{ dayId: "day-1", stops: [stop] }],
        unscheduledCandidates: [],
      },
    })).toThrow(/affectedDayIds/);
  });
});
