import { describe, expect, it } from "vitest";
import { validateAiActionOutputAgainstStateV3 } from "./ai-action-state-validation-v3.js";

function state() {
  return {
    baseGeneration: 13,
    targetDayIds: ["day-1"],
    days: [{
      id: "day-1",
      startAnchor: { placeId: "place-auckland" },
      endAnchor: { placeId: "place-auckland" },
    }],
    planningAreas: [{ id: "area-auckland", place: { id: "place-auckland" } }],
    candidates: [
      { id: "candidate-museum", planningAreaCandidateId: "area-auckland", preference: "must_go", resolved: true },
      { id: "candidate-lookout", planningAreaCandidateId: "area-auckland", preference: "want_to_go", resolved: true },
      { id: "candidate-unresolved", planningAreaCandidateId: "area-auckland", preference: "optional", resolved: false },
    ],
    requiredMustGoCandidateIds: ["candidate-museum"],
    priorityCoreCandidateIds: ["candidate-lookout"],
    unavailableCandidateIds: ["candidate-unresolved"],
  };
}

function output(candidateId = "candidate-museum") {
  return {
    schemaVersion: 1,
    baseGeneration: 13,
    result: {
      type: "success",
      assistantMessage: "done",
      dayUpdates: [{ dayId: "day-1", stops: [{ candidateId }] }],
      unscheduledCandidates: [{ candidateId: "candidate-lookout", reason: "capacity" }],
    },
  };
}

function replanState() {
  return {
    baseGeneration: 16,
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

function replanOutput(wanakaDays: number, queenstownDays: number, omitWanaka = false) {
  return {
    schemaVersion: 1,
    baseGeneration: 16,
    result: {
      type: "success",
      assistantMessage: "done",
      title: "更新路线",
      explanation: "按明确天数调整",
      stays: [
        { planningAreaCandidateId: "area-auckland", stayDays: 18, transferModeFromPrevious: "none" },
        ...(wanakaDays > 0 ? [{ planningAreaCandidateId: "area-wanaka", stayDays: wanakaDays, transferModeFromPrevious: "drive" }] : []),
        ...(queenstownDays > 0 ? [{ planningAreaCandidateId: "area-queenstown", stayDays: queenstownDays, transferModeFromPrevious: "drive" }] : []),
      ],
      omittedPlanningAreas: omitWanaka ? [{ candidateId: "area-wanaka", reason: "optional" }] : [],
    },
  };
}

describe("detailed itinerary AI semantic validation", () => {
  it("accepts only current resolved candidates and scoped unscheduled core visits", () => {
    const value = output();
    expect(validateAiActionOutputAgainstStateV3("itinerary.detail.generate", state(), value)).toBe(value);
  });

  it("rejects a hallucinated or excluded candidate before persistence", () => {
    expect(() => validateAiActionOutputAgainstStateV3("itinerary.detail.generate", state(), output("candidate-old-or-hallucinated")))
      .toThrow(/不在本轮 Candidate 白名单/);
  });

  it("rejects an unresolved candidate before persistence", () => {
    expect(() => validateAiActionOutputAgainstStateV3("itinerary.detail.generate", state(), output("candidate-unresolved")))
      .toThrow(/尚未定位/);
  });

  it("requires every target Day and every scoped must-go candidate", () => {
    const value = output();
    value.result.dayUpdates = [];
    expect(() => validateAiActionOutputAgainstStateV3("itinerary.detail.generate", state(), value))
      .toThrow(/恰好返回本轮 targetDayIds/);
  });
});

describe("itinerary replan AI semantic validation", () => {
  it("rejects a replan that omits Wanaka and leaves Queenstown unchanged despite explicit +1/-1 instructions", () => {
    expect(() => validateAiActionOutputAgainstStateV3("itinerary.replan", replanState(), replanOutput(0, 2, true)))
      .toThrow(/瓦纳卡.*应为 1 天/);
  });

  it("accepts a replan that applies Wanaka +1 and Queenstown -1 exactly", () => {
    const value = replanOutput(1, 1);
    expect(validateAiActionOutputAgainstStateV3("itinerary.replan", replanState(), value)).toBe(value);
  });

  it("leaves unrelated action outputs unchanged", () => {
    const value = { arbitrary: true };
    expect(validateAiActionOutputAgainstStateV3("destination.generate", state(), value)).toBe(value);
  });
});
