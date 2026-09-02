import { describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema, emptyTravelPlan, type TravelPlanDocument } from "./contracts-v2.js";
import {
  applyDetailedUpdatesV3,
  applySkeletonPlanV3,
  deriveItineraryUpdateStateV3,
  inspectSkeletonEditDraftV3,
} from "./itinerary-workflow-v3.js";
import { computeMacroDependencyFingerprintV3, derivePlanMacroBasisStateV3 } from "./planning-state-v3.js";
import type { SkeletonPlanDraft } from "./skeleton-contracts-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

function basePlan(durationDays = 5): TravelPlanDocument {
  return TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    trip: {
      ...emptyTravelPlan().trip,
      title: `${durationDays} 天测试旅行`,
      originPlaceId: "city-a",
      destinationPlaceIds: ["city-a", "city-b", "city-c"],
      dates: { start: null, end: null, requestedDurationDays: durationDays },
    },
    places: [
      { id: "city-a", nameZh: "奥克兰", nameLocal: null, nameEn: "Auckland", kind: "city", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
      { id: "city-b", nameZh: "罗托鲁瓦", nameLocal: null, nameEn: "Rotorua", kind: "city", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
      { id: "city-c", nameZh: "陶波", nameLocal: null, nameEn: "Taupo", kind: "city", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "macro-a", placeId: "city-a", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "macro-b", placeId: "city-b", planningAreaCandidateId: null, planningRole: "planning_area", preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "macro-c", placeId: "city-c", planningAreaCandidateId: null, planningRole: "planning_area", preference: "optional", source: "ai", aiReason: "可选", aiScore: 70, suggestedDurationMinutes: null, tags: [] },
    ],
  });
}

function tripDetail(planValue: TravelPlanDocument, generation = 0): TripDetailV3 {
  return {
    id: "trip-1",
    title: planValue.trip.title,
    state: "active",
    planLanguage: "zh",
    contentGeneration: generation,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    plan: planValue,
  } as TripDetailV3;
}

function ringDraft(): SkeletonPlanDraft {
  return {
    stays: [
      { planningAreaCandidateId: "macro-a", stayDays: 1, transferModeFromPrevious: "none" },
      { planningAreaCandidateId: "macro-b", stayDays: 2, transferModeFromPrevious: "drive" },
      { planningAreaCandidateId: "macro-a", stayDays: 2, transferModeFromPrevious: "drive" },
    ],
    omittedPlanningAreas: [{ candidateId: "macro-c", reason: "总天数有限，优先保留必去与想去区域。" }],
  };
}

describe("Phase 2 skeleton workflow", () => {
  it("allows Auckland -> Rotorua -> Auckland with two stable Stay Blocks", () => {
    const source = basePlan();
    const applied = applySkeletonPlanV3(tripDetail(source), ringDraft());

    expect(applied.plan.days).toHaveLength(5);
    expect(applied.formalizedStays.map((stay) => stay.planningAreaCandidateId)).toEqual(["macro-a", "macro-b", "macro-a"]);
    expect(applied.formalizedStays[0].stayBlockId).not.toBe(applied.formalizedStays[2].stayBlockId);
    expect(applied.plan.days[0].stayBlockId).toBe(applied.formalizedStays[0].stayBlockId);
    expect(applied.plan.days.slice(3).every((day) => day.stayBlockId === applied.formalizedStays[2].stayBlockId)).toBe(true);
  });

  it("counts the transfer day as the arriving Stay Block first day", () => {
    const applied = applySkeletonPlanV3(tripDetail(basePlan()), ringDraft());
    const days = applied.plan.days;

    expect(days[1].startAnchor.placeId).toBe("city-a");
    expect(days[1].endAnchor.placeId).toBe("city-b");
    expect(days[1].transferMode).toBe("drive");
    expect(days[1].stayBlockId).toBe(applied.formalizedStays[1].stayBlockId);
    expect(days[2].startAnchor.placeId).toBe("city-b");
    expect(days[2].endAnchor.placeId).toBe("city-b");
    expect(days[2].transferMode).toBe("none");
  });

  it("validates must/want/optional coverage without forcing want or optional into the route", () => {
    const source = basePlan();
    const allowed = {
      stays: [{ planningAreaCandidateId: "macro-a", stayDays: 5, transferModeFromPrevious: "none" }],
      omittedPlanningAreas: [
        { candidateId: "macro-b", reason: "五天不足以加入罗托鲁瓦并保持合理节奏。" },
        { candidateId: "macro-c", reason: "可选区域本轮不采用。" },
      ],
    } satisfies SkeletonPlanDraft;
    expect(inspectSkeletonEditDraftV3(source, allowed).canSave).toBe(true);
    expect(() => applySkeletonPlanV3(tripDetail(source), allowed)).not.toThrow();

    const invalid = {
      stays: [{ planningAreaCandidateId: "macro-b", stayDays: 5, transferModeFromPrevious: "none" }],
      omittedPlanningAreas: [
        { candidateId: "macro-a", reason: "错误地省略必去区域" },
        { candidateId: "macro-c", reason: "可选" },
      ],
    } satisfies SkeletonPlanDraft;
    expect(inspectSkeletonEditDraftV3(source, invalid).canSave).toBe(false);
    expect(() => applySkeletonPlanV3(tripDetail(source), invalid)).toThrow(/必去/);
  });

  it("keeps an incomplete 19/20 day edit as an unsavable draft with one day remaining", () => {
    const source = basePlan(20);
    const draft = {
      stays: [
        { planningAreaCandidateId: "macro-a", stayDays: 10, transferModeFromPrevious: "none" },
        { planningAreaCandidateId: "macro-b", stayDays: 9, transferModeFromPrevious: "drive" },
      ],
      omittedPlanningAreas: [{ candidateId: "macro-c", reason: "可选区域暂不采用。" }],
    } satisfies SkeletonPlanDraft;
    const inspection = inspectSkeletonEditDraftV3(source, draft);
    expect(inspection.allocatedDays).toBe(19);
    expect(inspection.expectedDays).toBe(20);
    expect(inspection.remainingDays).toBe(1);
    expect(inspection.canSave).toBe(false);
    expect(() => applySkeletonPlanV3(tripDetail(source), draft)).toThrow(/19 天.*20 天/);
  });

  it("atomically expands a 90 day Skeleton without PlanCommand batching", () => {
    const source = basePlan(90);
    const draft = {
      stays: [{ planningAreaCandidateId: "macro-a", stayDays: 90, transferModeFromPrevious: "none" }],
      omittedPlanningAreas: [
        { candidateId: "macro-b", reason: "本测试仅采用必去区域。" },
        { candidateId: "macro-c", reason: "本测试仅采用必去区域。" },
      ],
    } satisfies SkeletonPlanDraft;
    const applied = applySkeletonPlanV3(tripDetail(source), draft);
    expect(applied.plan.days).toHaveLength(90);
    expect(applied.newDayIds).toHaveLength(90);
    expect(applied.plan.days.every((day) => Boolean(day.stayBlockId))).toBe(true);
  });

  it("reuses Stay Block IDs and Day IDs when the saved Skeleton is unchanged", () => {
    const first = applySkeletonPlanV3(tripDetail(basePlan()), ringDraft());
    const second = applySkeletonPlanV3(tripDetail(first.plan, 1), ringDraft());

    expect(second.formalizedStays.map((stay) => stay.stayBlockId)).toEqual(first.formalizedStays.map((stay) => stay.stayBlockId));
    expect(second.plan.days.map((day) => day.id)).toEqual(first.plan.days.map((day) => day.id));
    expect(second.affectedDayIds).toEqual([]);
    expect(second.newDayIds).toEqual([]);
  });

  it("keeps the surviving tail repeated Planning Area Block and Day identity after deleting the earlier occurrence", () => {
    const first = applySkeletonPlanV3(tripDetail(basePlan()), ringDraft());
    const rotoruaBlockId = first.formalizedStays[1].stayBlockId;
    const tailAucklandBlockId = first.formalizedStays[2].stayBlockId;
    const tailAucklandDayIds = first.plan.days
      .filter((day) => day.stayBlockId === tailAucklandBlockId)
      .map((day) => day.id);

    const revisedDraft = {
      stays: [
        { planningAreaCandidateId: "macro-b", stayDays: 3, transferModeFromPrevious: "drive" },
        { planningAreaCandidateId: "macro-a", stayDays: 2, transferModeFromPrevious: "drive" },
      ],
      omittedPlanningAreas: [{ candidateId: "macro-c", reason: "可选区域仍不采用。" }],
    } satisfies SkeletonPlanDraft;
    const second = applySkeletonPlanV3(tripDetail(first.plan, 1), revisedDraft);

    expect(second.formalizedStays[0].stayBlockId).toBe(rotoruaBlockId);
    expect(second.formalizedStays[1].stayBlockId).toBe(tailAucklandBlockId);
    expect(second.plan.days.slice(-2).map((day) => day.id)).toEqual(tailAucklandDayIds);
    expect(second.formalizedStays[1].stayBlockId).not.toBe(first.formalizedStays[0].stayBlockId);
  });

  it("establishes stable Stay Block IDs only when a legacy Skeleton is explicitly saved", () => {
    const source = basePlan();
    const legacyDays = applySkeletonPlanV3(tripDetail(source), ringDraft()).plan.days.map(({ stayBlockId: _stayBlockId, ...day }) => day);
    const legacyPlan = TravelPlanDocumentSchema.parse({ ...source, stage: "itinerary_planning", days: legacyDays });
    expect(legacyPlan.days.every((day) => day.stayBlockId === undefined)).toBe(true);

    const saved = applySkeletonPlanV3(tripDetail(legacyPlan, 1), ringDraft());
    expect(saved.plan.days.every((day) => Boolean(day.stayBlockId))).toBe(true);
    expect(saved.plan.days.map((day) => day.id)).toEqual(legacyPlan.days.map((day) => day.id));
  });

  it("stores the current Macro dependency fingerprint and becomes current after save", () => {
    const applied = applySkeletonPlanV3(tripDetail(basePlan()), ringDraft());
    expect(applied.plan.planningState).toEqual({
      macroBasisVersion: 1,
      macroBasisFingerprint: computeMacroDependencyFingerprintV3(applied.plan),
    });
    expect(derivePlanMacroBasisStateV3(applied.plan)).toBe("current");
  });

  it("does not require Place Resolution to create a semantic Skeleton", () => {
    const source = basePlan();
    const applied = applySkeletonPlanV3(tripDetail(source), ringDraft());
    expect(applied.plan.days).toHaveLength(5);
    expect(applied.plan.days[1].startAnchor.placeId).toBe("city-a");
    expect(applied.plan.days[1].endAnchor.placeId).toBe("city-b");
  });
});

describe("detail compatibility after Skeleton save", () => {
  it("keeps Macro anchors and stable Day identity during Detail generation", () => {
    const source = basePlan();
    const skeleton = applySkeletonPlanV3(tripDetail(source), ringDraft()).plan;
    const poi = { id: "poi-a", nameZh: "必去景点", nameLocal: null, nameEn: null, kind: "attraction" as const, city: "奥克兰", region: null, country: "新西兰", countryCode: "NZ", approximate: false };
    const micro = { id: "micro-a", placeId: poi.id, planningAreaCandidateId: "macro-a", planningRole: "detail_interest" as const, preference: "must_go" as const, source: "user" as const, aiReason: null, aiScore: null, suggestedDurationMinutes: 60, tags: [] };
    const macroPlan = TravelPlanDocumentSchema.parse({ ...skeleton, places: [...skeleton.places, poi], candidates: [...skeleton.candidates, micro] });
    const macroTrip = tripDetail(macroPlan, 1);
    const emptyUpdates = macroPlan.days.map((day) => ({ dayId: day.id, stops: [] }));
    expect(() => applyDetailedUpdatesV3(macroTrip, emptyUpdates, true)).toThrow(/必去/);

    const updates = emptyUpdates.map((update, index) => index === 0 ? { ...update, stops: [{ candidateId: micro.id, activity: "参观", period: "morning" as const, startTime: "09:00", endTime: "10:00", durationMinutes: 60, transportFromPrevious: null, scheduleVerification: { status: "estimated" as const, checkedAt: null }, costNote: null, costVerification: null, notes: null }] } : update);
    const detailed = applyDetailedUpdatesV3(macroTrip, updates, true);
    expect(detailed.days.every((day) => day.detailLevel === "detailed" && day.detailStatus === "ready")).toBe(true);
    expect(detailed.days.map((day) => [day.id, day.stayBlockId, day.startAnchor, day.endAnchor])).toEqual(macroPlan.days.map((day) => [day.id, day.stayBlockId, day.startAnchor, day.endAnchor]));
  });

  it("marks an old Skeleton without fingerprint as needing confirmation", () => {
    const first = applySkeletonPlanV3(tripDetail(basePlan()), ringDraft()).plan;
    const legacy = TravelPlanDocumentSchema.parse({ ...first, planningState: undefined });
    expect(deriveItineraryUpdateStateV3(legacy).macro.status).toBe("needs_update");
  });
});
