import { describe, expect, it } from "vitest";
import { emptyTravelPlan, type Day, type TravelPlanDocument } from "./contracts-v2.js";
import { assertProposalCommandsWithinScope } from "./proposal-scope-policy-v2.js";

function day(id: string, dayNumber: number, stopId: string): Day {
  return {
    id,
    dayNumber,
    date: null,
    title: id,
    transferMode: "none",
    detailLevel: "detailed",
    detailStatus: "ready",
    startAnchor: { id: `${id}-start`, placeId: null, label: null, notes: null },
    stops: [{
      id: stopId,
      candidateId: null,
      placeId: "place-a",
      activity: id,
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
    }],
    endAnchor: { id: `${id}-end`, placeId: null, label: null, notes: null },
  };
}

function plan(): TravelPlanDocument {
  const value = emptyTravelPlan();
  value.places = [{ id: "place-a", nameZh: "A", nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: true }];
  value.days = [day("d1", 1, "s1"), day("d2", 2, "s2"), day("d3", 3, "s3")];
  return value;
}

describe("User Control Correction multi-day Proposal Scope", () => {
  it("allows updates inside explicitly scoped days", () => {
    const value = plan();
    expect(() => assertProposalCommandsWithinScope(value, { type: "days", ids: ["d1", "d2"] }, [
      { type: "update_day", dayId: "d1", changes: { title: "D1 updated" } },
      { type: "update_day_stop", stopId: "s2", changes: { activity: "D2 updated" } },
    ])).not.toThrow();
  });

  it("rejects commands that touch a day outside the scoped set", () => {
    const value = plan();
    expect(() => assertProposalCommandsWithinScope(value, { type: "days", ids: ["d1", "d2"] }, [
      { type: "update_day_stop", stopId: "s3", changes: { activity: "out of scope" } },
    ])).toThrow(/Days Scope/);
  });

  it("allows stop moves only when both source and target are scoped", () => {
    const value = plan();
    expect(() => assertProposalCommandsWithinScope(value, { type: "days", ids: ["d1", "d2"] }, [
      { type: "move_day_stop", stopId: "s1", targetDayId: "d2", targetIndex: 1 },
    ])).not.toThrow();
    expect(() => assertProposalCommandsWithinScope(value, { type: "days", ids: ["d1", "d2"] }, [
      { type: "move_day_stop", stopId: "s1", targetDayId: "d3", targetIndex: 1 },
    ])).toThrow(/Days Scope/);
  });

  it("rejects whole-trip day reordering from a local multi-day scope", () => {
    const value = plan();
    expect(() => assertProposalCommandsWithinScope(value, { type: "days", ids: ["d1", "d2"] }, [
      { type: "move_day", dayId: "d1", targetIndex: 1 },
    ])).toThrow(/整趟|Days Scope/);
  });
});