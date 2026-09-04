import { describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema, emptyTravelPlan, type TravelPlanDocument } from "./contracts-v2.js";
import { applyPlanCommands } from "./plan-commands-v2.js";
import { derivePlanningAdvisoriesV3 } from "./planning-advisories-v3.js";

function plan(): TravelPlanDocument {
  return emptyTravelPlan();
}

function place(id: string, kind: TravelPlanDocument["places"][number]["kind"] = "attraction") {
  return { id, nameZh: id, nameLocal: null, nameEn: null, kind, city: null, region: null, country: null, countryCode: null, approximate: true };
}

function candidate(id: string, placeId: string, extras: Partial<TravelPlanDocument["candidates"][number]> = {}) {
  return { id, placeId, planningAreaCandidateId: null, planningRole: "detail_interest" as const, preference: "optional" as const, source: "user" as const, aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [], ...extras };
}

function day(id: string, dayNumber: number, stops: TravelPlanDocument["days"][number]["stops"] = []) {
  return {
    id,
    dayNumber,
    date: null,
    title: `Day ${dayNumber}`,
    transferMode: "none" as const,
    detailLevel: "detailed" as const,
    detailStatus: "ready" as const,
    startAnchor: { id: `${id}-start`, placeId: null, label: null, notes: null },
    stops,
    endAnchor: { id: `${id}-end`, placeId: null, label: null, notes: null },
  };
}

describe("User Control Correction canonical boundary", () => {
  it("allows reversed dates and duration disagreement", () => {
    const value = plan();
    value.trip.dates = { start: "2026-10-10", end: "2026-10-05", requestedDurationDays: 20 };
    expect(() => TravelPlanDocumentSchema.parse(value)).not.toThrow();
    expect(derivePlanningAdvisoriesV3(value).map((item) => item.code)).toContain("TRIP_DATE_RANGE_REVERSED");
  });

  it("allows non-city planning areas and unparented detail interests", () => {
    const value = plan();
    value.places = [place("airport", "airport"), place("poi")];
    value.candidates = [
      candidate("area", "airport", { planningRole: "planning_area" }),
      candidate("poi-candidate", "poi", { planningAreaCandidateId: null, planningRole: "detail_interest" }),
    ];
    expect(() => TravelPlanDocumentSchema.parse(value)).not.toThrow();
    const codes = derivePlanningAdvisoriesV3(value).map((item) => item.code);
    expect(codes).toContain("ATYPICAL_PLANNING_ROLE_KIND");
    expect(codes).toContain("UNASSIGNED_CANDIDATE");
  });

  it("allows partial times, overnight-looking times, duration mismatch and overlap", () => {
    const value = plan();
    value.places = [place("a"), place("b"), place("c")];
    value.candidates = [candidate("ca", "a"), candidate("cb", "b"), candidate("cc", "c")];
    value.days = [day("d1", 1, [
      { id: "s1", candidateId: "ca", placeId: "a", activity: "A", period: null, scheduleText: "上午", startTime: "09:00", endTime: null, durationMinutes: null, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null },
      { id: "s2", candidateId: "cb", placeId: "b", activity: "B", period: null, scheduleText: "次日凌晨结束", startTime: "23:00", endTime: "01:00", durationMinutes: null, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null },
      { id: "s3", candidateId: "cc", placeId: "c", activity: "C", period: null, startTime: "10:00", endTime: "12:00", durationMinutes: 30, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null },
    ])];
    expect(() => TravelPlanDocumentSchema.parse(value)).not.toThrow();
    const codes = derivePlanningAdvisoriesV3(value).map((item) => item.code);
    expect(codes).toContain("STOP_PARTIAL_TIME");
    expect(codes).toContain("STOP_POSSIBLE_OVERNIGHT");
    expect(codes).toContain("STOP_DURATION_MISMATCH");
  });

  it("allows excluded candidates to remain scheduled and reports an advisory", () => {
    const value = plan();
    value.places = [place("a")];
    value.candidates = [candidate("ca", "a", { preference: "excluded" })];
    value.days = [day("d1", 1, [{ id: "s1", candidateId: "ca", placeId: "a", activity: "A", period: null, startTime: null, endTime: null, durationMinutes: null, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null }])];
    expect(() => TravelPlanDocumentSchema.parse(value)).not.toThrow();
    expect(derivePlanningAdvisoriesV3(value).map((item) => item.code)).toContain("EXCLUDED_CANDIDATE_SCHEDULED");
  });

  it("changing a scheduled candidate to excluded keeps the stop", () => {
    const value = plan();
    value.places = [place("a")];
    value.candidates = [candidate("ca", "a")];
    value.days = [day("d1", 1, [{ id: "s1", candidateId: "ca", placeId: "a", activity: "A", period: null, startTime: null, endTime: null, durationMinutes: null, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null }])];
    const applied = applyPlanCommands(value, [{ type: "set_candidate_preference", candidateId: "ca", preference: "excluded" }]);
    expect(applied.plan.days[0].stops.map((stop) => stop.id)).toEqual(["s1"]);
    expect(applied.plan.candidates[0].preference).toBe("excluded");
  });

  it("allows semantic duplicates while preserving exact Place identity rules", () => {
    const value = plan();
    value.places = [place("a")];
    value.candidates = [candidate("ca", "a")];
    const duplicatePlace = { ...place("tmp-place"), nameZh: "a" };
    const applied = applyPlanCommands(value, [{
      type: "add_candidate",
      place: duplicatePlace,
      candidate: candidate("tmp-candidate", "tmp-place"),
    }]);
    expect(applied.plan.candidates).toHaveLength(2);
    expect(derivePlanningAdvisoriesV3(applied.plan).map((item) => item.code)).toContain("POSSIBLE_DUPLICATE_PLACE");
  });

  it("does not rewrite Day dates after unrelated commands and allows direct date edits", () => {
    const value = plan();
    value.trip.dates = { start: "2026-10-01", end: "2026-10-10", requestedDurationDays: 10 };
    value.places = [place("a")];
    value.candidates = [candidate("ca", "a")];
    value.days = [day("d1", 1), day("d2", 2)];
    value.days[0].date = "2026-10-03";
    value.days[1].date = "2026-10-08";

    const preference = applyPlanCommands(value, [{ type: "set_candidate_preference", candidateId: "ca", preference: "want_to_go" }]);
    expect(preference.plan.days.map((item) => item.date)).toEqual(["2026-10-03", "2026-10-08"]);

    const dateEdit = applyPlanCommands(preference.plan, [{ type: "update_day", dayId: "d2", changes: { date: "2026-10-09" } }]);
    expect(dateEdit.plan.days[1].date).toBe("2026-10-09");
  });

  it("still rejects duplicate canonical Place identity across candidates", () => {
    const value = plan();
    value.places = [place("a")];
    value.candidates = [candidate("ca", "a"), candidate("cb", "a")];
    expect(() => TravelPlanDocumentSchema.parse(value)).toThrow(/同一 Place/);
  });

  it("still rejects missing parent references and parent cycles", () => {
    const missing = plan();
    missing.places = [place("a")];
    missing.candidates = [candidate("ca", "a", { planningAreaCandidateId: "missing" })];
    expect(() => TravelPlanDocumentSchema.parse(missing)).toThrow(/未知父 Candidate/);

    const cycle = plan();
    cycle.places = [place("a"), place("b")];
    cycle.candidates = [
      candidate("ca", "a", { planningAreaCandidateId: "cb" }),
      candidate("cb", "b", { planningAreaCandidateId: "ca" }),
    ];
    expect(() => TravelPlanDocumentSchema.parse(cycle)).toThrow(/形成循环/);
  });
});