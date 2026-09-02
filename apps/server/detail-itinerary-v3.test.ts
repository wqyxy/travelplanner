import { describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema, emptyTravelPlan, type TravelPlanDocument } from "./contracts-v2.js";
import { applyDetailedUpdatesPhase5V3, detailedReplacementCommandsPhase5V3, validateDetailedSchedulingOutcomeV3 } from "./detail-itinerary-v3.js";
import { computeMacroDependencyFingerprintV3 } from "./planning-state-v3.js";
import type { DetailedDayUpdate } from "./ai-action-contracts-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

function plan(): TravelPlanDocument {
  const base = TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    stage: "itinerary_refinement",
    trip: { ...emptyTravelPlan().trip, title: "详细行程测试", originPlaceId: "city-a", dates: { start: null, end: null, requestedDurationDays: 2 } },
    places: [
      { id: "city-a", nameZh: "甲城", nameLocal: null, nameEn: null, kind: "city", city: null, region: null, country: "测试", countryCode: "NZ", approximate: false },
      { id: "city-b", nameZh: "乙城", nameLocal: null, nameEn: null, kind: "city", city: null, region: null, country: "测试", countryCode: "NZ", approximate: false },
      { id: "core-a-place", nameZh: "甲核心", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "测试", countryCode: "NZ", approximate: false },
      { id: "detail-a-place", nameZh: "甲必去", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "测试", countryCode: "NZ", approximate: false },
      { id: "want-a-place", nameZh: "甲想去核心", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "测试", countryCode: "NZ", approximate: false },
      { id: "core-b-place", nameZh: "乙核心", nameLocal: null, nameEn: null, kind: "attraction", city: "乙城", region: null, country: "测试", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "area-a", placeId: "city-a", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "area-b", placeId: "city-b", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "core-a", placeId: "core-a-place", planningAreaCandidateId: "area-a", planningRole: "core_visit", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 120, tags: [] },
      { id: "detail-a", placeId: "detail-a-place", planningAreaCandidateId: "area-a", planningRole: "detail_interest", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 60, tags: [] },
      { id: "want-a", placeId: "want-a-place", planningAreaCandidateId: "area-a", planningRole: "core_visit", preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 120, tags: [] },
      { id: "core-b", placeId: "core-b-place", planningAreaCandidateId: "area-b", planningRole: "core_visit", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 120, tags: [] },
    ],
    days: [
      { id: "day-a", dayNumber: 1, date: null, title: "甲城", stayBlockId: "block-a", transferMode: "none", detailLevel: "detailed", detailStatus: "needs_review", startAnchor: { id: "start-a", placeId: "city-a", label: null, notes: null }, stops: [
        { id: "stop-core-a", candidateId: "core-a", placeId: "core-a-place", activity: "甲核心", period: "morning", startTime: "09:00", endTime: "11:00", durationMinutes: 120, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: "保留" },
        { id: "stop-detail-a", candidateId: "detail-a", placeId: "detail-a-place", activity: "甲必去", period: "afternoon", startTime: "13:00", endTime: "14:00", durationMinutes: 60, transportFromPrevious: { mode: "walk", durationMinutes: null, note: null, verification: { status: "estimated", checkedAt: null } }, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null },
      ], endAnchor: { id: "end-a", placeId: "city-a", label: null, notes: null } },
      { id: "day-b", dayNumber: 2, date: null, title: "乙城", stayBlockId: "block-b", transferMode: "drive", detailLevel: "detailed", detailStatus: "ready", startAnchor: { id: "start-b", placeId: "city-a", label: null, notes: null }, stops: [], endAnchor: { id: "end-b", placeId: "city-b", label: null, notes: null } },
    ],
  });
  return TravelPlanDocumentSchema.parse({ ...base, planningState: { macroBasisVersion: 1, macroBasisFingerprint: computeMacroDependencyFingerprintV3(base) } });
}

function trip(planValue = plan()): TripDetailV3 {
  return { id: "trip", title: planValue.trip.title, state: "active", planLanguage: "zh", contentGeneration: 1, createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", plan: planValue } as TripDetailV3;
}

function stickyUpdate(source: TravelPlanDocument): DetailedDayUpdate {
  const day = source.days.find((item) => item.id === "day-a")!;
  return {
    dayId: day.id,
    stops: day.stops.map((stop) => ({
      candidateId: stop.candidateId!, activity: stop.activity, period: stop.period, startTime: stop.startTime!, endTime: stop.endTime!, durationMinutes: stop.durationMinutes!, transportFromPrevious: stop.transportFromPrevious, scheduleVerification: stop.scheduleVerification!, costNote: stop.costNote, costVerification: stop.costVerification, notes: stop.notes,
    })),
  };
}

describe("Phase 5 detailed itinerary policy", () => {
  it("requires resolved must-go Core and Detail in the affected owner area but not an unrelated area's must-go", () => {
    const source = plan();
    const missingDetail: DetailedDayUpdate = { dayId: "day-a", stops: [stickyUpdate(source).stops[0]] };
    expect(() => applyDetailedUpdatesPhase5V3(trip(source), [missingDetail], false)).toThrow(/甲必去/);

    const unchanged = applyDetailedUpdatesPhase5V3(trip(source), [stickyUpdate(source)], false);
    expect(unchanged.days.find((day) => day.id === "day-a")?.detailStatus).toBe("ready");
    expect(unchanged.days.find((day) => day.id === "day-b")?.stops).toEqual([]);
  });

  it("requires a reason when a want-to-go Core Visit is not scheduled", () => {
    const source = plan();
    expect(() => validateDetailedSchedulingOutcomeV3(source, [], ["day-a"])).toThrow(/想去的重要游览地/);
    expect(() => validateDetailedSchedulingOutcomeV3(source, [{ candidateId: "want-a", reason: "当天已有两处必去，继续加入会超过轻松节奏容量。" }], ["day-a"])).not.toThrow();
    expect(() => validateDetailedSchedulingOutcomeV3(source, [{ candidateId: "core-a", reason: "放不下" }], ["day-a"])).toThrow(/必去地点不得作为未安排结果/);
  });

  it("keeps sticky Stop identity and emits no commands when affected content is unchanged", () => {
    const source = plan();
    const result = detailedReplacementCommandsPhase5V3(trip(source), [stickyUpdate(source)]);
    expect(result.commands).toEqual([]);
    expect(result.plan.days.find((day) => day.id === "day-a")?.stops.map((stop) => stop.id)).toEqual(["stop-core-a", "stop-detail-a"]);
    expect(result.plan.days.find((day) => day.id === "day-a")?.startAnchor).toEqual(source.days[0].startAnchor);
    expect(result.plan.days.find((day) => day.id === "day-a")?.endAnchor).toEqual(source.days[0].endAnchor);
    expect(result.plan.days.find((day) => day.id === "day-a")?.stayBlockId).toBe("block-a");
  });

  it("uses move/update instead of remove-add when the same Candidates are reordered or retimed", () => {
    const source = plan();
    const sticky = stickyUpdate(source);
    const changed: DetailedDayUpdate = {
      dayId: "day-a",
      stops: [
        { ...sticky.stops[1], startTime: "09:00", endTime: "10:00" },
        { ...sticky.stops[0], period: "afternoon", startTime: "13:00", endTime: "15:00", notes: "保留并调整时间" },
      ],
    };
    const result = detailedReplacementCommandsPhase5V3(trip(source), [changed]);
    expect(result.commands.some((command) => command.type === "move_day_stop")).toBe(true);
    expect(result.commands.some((command) => command.type === "update_day_stop")).toBe(true);
    expect(result.commands.some((command) => command.type === "remove_day_stop" || command.type === "add_day_stop")).toBe(false);
    expect(result.plan.days[0].stops.map((stop) => stop.id)).toEqual(["stop-detail-a", "stop-core-a"]);
  });
});
