import { describe, expect, it } from "vitest";
import { buildAddStopCommand, buildMoveStopByOffsetCommand, buildMoveStopCommand, buildMoveStopToDayCommand, buildPlanCommandBatchRequest, findStopPosition } from "./editor-actions-v2";
import type { TravelPlanDocument } from "./v2-types";

const stop = (id: string, placeId = id) => ({
  id, candidateId: null, placeId, activity: id, period: null, startTime: null, endTime: null,
  durationMinutes: 60, transportFromPrevious: null, scheduleVerification: null,
  costNote: null, costVerification: null, notes: null,
});

const plan: TravelPlanDocument = {
  schemaVersion: 2,
  stage: "itinerary_planning",
  trip: {
    title: "测试",
    brief: { destination: "", origin: "", departureTime: "", duration: "2 天", travelers: "", transport: "", additionalRequirements: "" },
    originPlaceId: null, destinationPlaceIds: [],
    dates: { start: null, end: null, requestedDurationDays: 2 },
    travelers: { summary: "", adults: null, children: null },
    budget: { amount: null, currency: null, note: null }, pace: null, themes: [], preferences: [], constraints: [], assumptions: [],
  },
  places: ["p1", "p2", "p3", "p4"].map((id) => ({ id, nameZh: id, nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: false })),
  candidates: [{ id: "c4", placeId: "p4", planningAreaCandidateId: null, preference: "want_to_go", source: "ai", aiReason: null, aiScore: 80, suggestedDurationMinutes: 90, tags: [] }],
  days: [
    { id: "d1", dayNumber: 1, date: null, title: "第一天", transferMode: "none", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a1", placeId: null, label: null, notes: null }, stops: [stop("s1", "p1"), stop("s2", "p2"), stop("s3", "p3")], endAnchor: { id: "a2", placeId: null, label: null, notes: null } },
    { id: "d2", dayNumber: 2, date: null, title: "第二天", transferMode: "none", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a3", placeId: null, label: null, notes: null }, stops: [], endAnchor: { id: "a4", placeId: null, label: null, notes: null } },
  ],
  warnings: [],
};

describe("v2 deterministic editor actions", () => {
  it("finds a stop without duplicating itinerary state", () => {
    expect(findStopPosition(plan, "s2")).toEqual({ dayId: "d1", dayIndex: 0, stopIndex: 1 });
    expect(findStopPosition(plan, "missing")).toBeNull();
  });

  it("normalizes same-day drop indexes after removal", () => {
    expect(buildMoveStopCommand(plan, "s1", "d1", 3)).toEqual({ type: "move_day_stop", stopId: "s1", targetDayId: "d1", targetIndex: 2 });
    expect(buildMoveStopCommand(plan, "s2", "d1", 2)).toBeNull();
  });

  it("builds keyboard up and down commands", () => {
    expect(buildMoveStopByOffsetCommand(plan, "s2", -1)).toEqual({ type: "move_day_stop", stopId: "s2", targetDayId: "d1", targetIndex: 0 });
    expect(buildMoveStopByOffsetCommand(plan, "s2", 1)).toEqual({ type: "move_day_stop", stopId: "s2", targetDayId: "d1", targetIndex: 2 });
    expect(buildMoveStopByOffsetCommand(plan, "s1", -1)).toBeNull();
  });

  it("moves a stop to the end of another day", () => {
    expect(buildMoveStopToDayCommand(plan, "s2", "d2")).toEqual({ type: "move_day_stop", stopId: "s2", targetDayId: "d2", targetIndex: 0 });
  });

  it("creates a temporary stop from a selected candidate", () => {
    const command = buildAddStopCommand(plan, "d2", "p4", () => "fixed");
    expect(command).toMatchObject({ type: "add_day_stop", dayId: "d2", index: 0, stop: { id: "tmp-stop-fixed", candidateId: "c4", placeId: "p4", durationMinutes: 90 } });
  });

  it("wraps one deterministic command with generation CAS", () => {
    const command = { type: "remove_day_stop", stopId: "s1" } as const;
    expect(buildPlanCommandBatchRequest(7, command)).toEqual({ expectedGeneration: 7, commands: [command] });
    expect(() => buildPlanCommandBatchRequest(-1, command)).toThrow("expectedGeneration");
  });
});