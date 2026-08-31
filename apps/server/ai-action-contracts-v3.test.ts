import { describe, expect, it } from "vitest";
import { InterestDiscoverOutputSchema, ItineraryGenerateOutputSchema, ItineraryRefineOutputSchema, ItineraryVerifyOutputSchema } from "./ai-action-contracts-v3.js";

function interestOutput() {
  return {
    schemaVersion: 1,
    baseGeneration: 3,
    assistantMessage: "已研究目标区域。",
    areaTargets: [{ planningAreaCandidateId: "macro-1", targetCount: 1, reason: "值得新增 1 个" }],
    places: [{ id: "tmp-place-1", nameZh: "测试景点", nameLocal: null, nameEn: "Test Attraction", kind: "attraction" as const, city: "Test City", region: null, country: "Test", countryCode: "TT", approximate: false }],
    candidates: [{ temporaryId: "tmp-candidate-1", placeTemporaryId: "tmp-place-1", planningAreaCandidateId: "macro-1", aiReason: "值得参观", aiScore: 90, suggestedDurationMinutes: 60, tags: [], defaultPreference: "optional" as const, prominence: "major" as const, experienceTypes: ["landmark" as const], visitPointType: "landmark" as const, researchBasis: ["multi_guide_consensus" as const] }],
  };
}

describe("V3 action contracts", () => {
  it("rejects source URLs, city Places and mismatched Macro parents from interest discovery", () => {
    const valid = interestOutput();
    expect(InterestDiscoverOutputSchema.safeParse(valid).success).toBe(true);

    const withUrl = structuredClone(valid);
    withUrl.candidates[0].aiReason = "来源：https://example.com/guide";
    expect(InterestDiscoverOutputSchema.safeParse(withUrl).success).toBe(false);

    const city = structuredClone(valid);
    city.places[0].kind = "city" as any;
    expect(InterestDiscoverOutputSchema.safeParse(city).success).toBe(false);

    const wrongParent = structuredClone(valid);
    wrongParent.candidates[0].planningAreaCandidateId = "macro-2";
    expect(InterestDiscoverOutputSchema.safeParse(wrongParent).success).toBe(false);
  });

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
