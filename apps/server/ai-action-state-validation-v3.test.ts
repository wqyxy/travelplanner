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

  it("leaves unrelated action outputs unchanged", () => {
    const value = { arbitrary: true };
    expect(validateAiActionOutputAgainstStateV3("destination.generate", state(), value)).toBe(value);
  });
});
