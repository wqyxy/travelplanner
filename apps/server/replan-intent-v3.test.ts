import { describe, expect, it } from "vitest";
import { deriveExplicitReplanStayConstraintsV3, recoverReplanCtaParametersV3 } from "./replan-intent-v3.js";

function history() {
  return {
    listActions: () => [
      {
        actionType: "destination.add",
        status: "applied",
        sourceMessageId: "message-wanaka",
        updatedAt: "2026-09-03T07:30:00.000Z",
        completedAt: "2026-09-03T07:30:00.000Z",
      },
      {
        actionType: "destination.edit",
        status: "applied",
        sourceMessageId: "message-core",
        updatedAt: "2026-09-03T07:20:00.000Z",
        completedAt: "2026-09-03T07:20:00.000Z",
      },
      {
        actionType: "itinerary.generate",
        status: "completed",
        sourceMessageId: null,
        updatedAt: "2026-09-03T07:00:00.000Z",
        completedAt: "2026-09-03T07:00:00.000Z",
      },
    ],
    listMessages: () => [
      { id: "message-core", role: "user", content: "这个地方很重要，我想单独留半天。", createdAt: "2026-09-03T07:19:00.000Z" },
      { id: "message-wanaka", role: "user", content: "我想把瓦纳卡多留一天，皇后镇少一天，总天数仍然保持20天。", createdAt: "2026-09-03T07:29:00.000Z" },
    ],
  };
}

function replanState() {
  return {
    parameters: { request: "我想把瓦纳卡多留一天，皇后镇少一天，总天数仍然保持20天。" },
    currentStays: [
      { planningAreaCandidateId: "area-auckland", stayDays: 18 },
      { planningAreaCandidateId: "area-queenstown", stayDays: 2 },
    ],
    planningAreas: [
      { id: "area-wanaka", place: { nameZh: "瓦纳卡", nameLocal: "Wānaka", nameEn: "Wanaka" } },
      { id: "area-queenstown", place: { nameZh: "皇后镇", nameLocal: "Queenstown", nameEn: "Queenstown" } },
      { id: "area-auckland", place: { nameZh: "奥克兰", nameLocal: "Auckland", nameEn: "Auckland" } },
    ],
  };
}

describe("replan causal intent continuity", () => {
  it("recovers the newest causal user request after the last successful Skeleton action", () => {
    const parameters = recoverReplanCtaParametersV3(history(), "trip-1", "itinerary.replan", {});
    expect(parameters).toEqual({ request: "我想把瓦纳卡多留一天，皇后镇少一天，总天数仍然保持20天。" });
  });

  it("never overwrites an explicit replan request", () => {
    const parameters = { request: "直接重新安排，但总天数不变。" };
    expect(recoverReplanCtaParametersV3(history(), "trip-1", "itinerary.replan", parameters)).toBe(parameters);
  });

  it("turns explicit +1/-1 language into exact stay-day constraints from the current baseline", () => {
    expect(deriveExplicitReplanStayConstraintsV3(replanState())).toEqual([
      {
        candidateId: "area-wanaka",
        placeName: "瓦纳卡",
        baselineDays: 0,
        expectedDays: 1,
        kind: "delta",
        deltaDays: 1,
      },
      {
        candidateId: "area-queenstown",
        placeName: "皇后镇",
        baselineDays: 2,
        expectedDays: 1,
        kind: "delta",
        deltaDays: -1,
      },
    ]);
  });
});
