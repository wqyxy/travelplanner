import { describe, expect, it } from "vitest";
import { DetailedDayUpdateSchema } from "./ai-action-contracts-v3.js";
import { parseActionParametersV3 } from "./ai-action-input-contracts-v3.js";
import { PlanCommandSchema, emptyTravelPlan } from "./contracts-v2.js";
import { buildBackboneContextV3 } from "./planning-context-v3.js";

describe("User Control Correction size and read-context boundaries", () => {
  it("accepts travel duration and affected-day counts beyond the former business caps", () => {
    expect(() => parseActionParametersV3(
      "requirements.update",
      "requirements.mutation.input",
      "cta",
      { changes: { dates: { start: null, end: null, requestedDurationDays: 1200 } } },
    )).not.toThrow();

    const dayIds = Array.from({ length: 120 }, (_, index) => `day-${index + 1}`);
    expect(() => parseActionParametersV3(
      "itinerary.detail.update",
      "itinerary.action.input",
      "cta",
      { dayIds },
    )).not.toThrow();
  });

  it("accepts more than 80 stops in one canonical detailed day draft", () => {
    const stops = Array.from({ length: 81 }, (_, index) => ({
      candidateId: `candidate-${index + 1}`,
      activity: `Activity ${index + 1}`,
      period: null,
      scheduleText: null,
      startTime: null,
      endTime: null,
      durationMinutes: null,
      transportFromPrevious: null,
      scheduleVerification: null,
      costNote: null,
      costVerification: null,
      notes: null,
    }));
    expect(() => DetailedDayUpdateSchema.parse({ dayId: "day-1", stops })).not.toThrow();
  });

  it("accepts bulk candidate operations beyond the former 1800-item trip cap", () => {
    const candidateIds = Array.from({ length: 1801 }, (_, index) => `candidate-${index + 1}`);
    expect(() => PlanCommandSchema.parse({
      type: "bulk_set_candidate_preference",
      candidateIds,
      preference: "optional",
    })).not.toThrow();
  });

  it("keeps excluded planning areas and core visits visible to AI read context", () => {
    const plan = emptyTravelPlan();
    plan.places = [
      { id: "area-place", nameZh: "区域", nameLocal: null, nameEn: null, kind: "airport", city: null, region: null, country: null, countryCode: null, approximate: true },
      { id: "core-place", nameZh: "核心游览地", nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: true },
    ];
    plan.candidates = [
      { id: "area", placeId: "area-place", planningAreaCandidateId: null, planningRole: "planning_area", preference: "excluded", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "core", placeId: "core-place", planningAreaCandidateId: "area", planningRole: "core_visit", preference: "excluded", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
    ];

    const context = buildBackboneContextV3(plan);
    expect(context.planningAreas.map((item) => item?.id)).toContain("area");
    expect(context.coreVisits.map((item) => item?.id)).toContain("core");
    expect(context.planningAreas.find((item) => item?.id === "area")?.preference).toBe("excluded");
  });
});
