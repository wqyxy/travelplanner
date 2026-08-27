import { describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema, type PlanGenerationOutput } from "./contracts-v2.js";
import { applyPlanGeneration } from "./candidate-workflow-v2.js";

const plan = TravelPlanDocumentSchema.parse({
  schemaVersion: 2,
  stage: "place_selection",
  trip: {
    title: "皇后镇测试",
    originPlaceId: null,
    destinationPlaceIds: [],
    dates: { start: null, end: null, requestedDurationDays: 1 },
    travelers: { summary: "", adults: null, children: null },
    budget: { amount: null, currency: null, note: null },
    pace: null,
    themes: [],
    preferences: [],
    constraints: [],
    assumptions: [],
  },
  places: [
    { id: "queenstown", nameZh: "皇后镇", nameLocal: "Queenstown", nameEn: "Queenstown", kind: "city", city: "Queenstown", region: "Otago", country: "新西兰", countryCode: "NZ", approximate: true },
    { id: "skyline", nameZh: "皇后镇天空缆车", nameLocal: "Skyline Queenstown", nameEn: "Skyline Queenstown", kind: "attraction", city: "Queenstown", region: "Otago", country: "新西兰", countryCode: "NZ", approximate: false },
  ],
  candidates: [
    { id: "queenstown-c", placeId: "queenstown", planningAreaCandidateId: null, preference: "must_go", source: "user", aiReason: "必须去皇后镇", aiScore: 95, suggestedDurationMinutes: null, tags: [] },
    { id: "skyline-c", placeId: "skyline", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: "代表景点", aiScore: 90, suggestedDurationMinutes: 120, tags: [] },
  ],
  days: [],
  warnings: [],
});

function output(candidateId: string, placeId: string): PlanGenerationOutput {
  return {
    schemaVersion: 1,
    baseGeneration: 0,
    assistantMessage: "完成",
    newPlaces: [],
    days: [{
      id: "tmp-day",
      dayNumber: 1,
      date: null,
      title: "皇后镇",
      detailLevel: "planned",
      detailStatus: null,
      startAnchor: { id: "tmp-start", placeId: null, label: null, notes: null },
      stops: [{
        id: "tmp-stop",
        candidateId,
        placeId,
        activity: "游览",
        period: "morning",
        startTime: null,
        endTime: null,
        durationMinutes: 120,
        transportFromPrevious: null,
        scheduleVerification: null,
        costNote: null,
        costVerification: null,
        notes: null,
      }],
      endAnchor: { id: "tmp-end", placeId: null, label: null, notes: null },
    }],
    unscheduledCandidates: [],
  };
}

describe("macro city plan generation", () => {
  it("fulfills a must-go city through a concrete stop inside that city", () => {
    const result = applyPlanGeneration(plan, output("skyline-c", "skyline"));
    expect(result.plan.stage).toBe("itinerary_planning");
    expect(result.scheduledCandidateIds).toEqual(["skyline-c"]);
  });

  it("rejects using the city candidate itself as a route stop", () => {
    const value = output("queenstown-c", "queenstown");
    value.unscheduledCandidates = [{ candidateId: "skyline-c", reason: "本次不安排" }];
    expect(() => applyPlanGeneration(plan, value)).toThrow(/城市级 Candidate 不应直接作为 Day Stop/);
  });
});
