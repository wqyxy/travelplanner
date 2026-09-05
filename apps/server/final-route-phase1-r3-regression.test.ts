import { describe, expect, it } from "vitest";
import { emptyTravelPlan, TravelPlanDocumentSchema, type DayStop, type TravelPlanDocument } from "./contracts-v2.js";
import type { DetailedDayUpdate } from "./ai-action-contracts-v3.js";
import { detailedReplacementCommandsPhase5V3 } from "./detail-itinerary-v3.js";
import { syncFinalRouteForLegacyWriteV3 } from "./final-route-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

const place = (id: string) => ({
  id,
  nameZh: id.toUpperCase(),
  nameLocal: null,
  nameEn: null,
  kind: "attraction" as const,
  city: null,
  region: null,
  country: "Test",
  countryCode: "NZ",
  approximate: false,
});

const candidate = (id: string) => ({
  id: `candidate-${id}`,
  placeId: `place-${id}`,
  planningAreaCandidateId: null,
  preference: "optional" as const,
  source: "user" as const,
  aiReason: null,
  aiScore: null,
  suggestedDurationMinutes: 60,
  tags: [],
});

const stop = (id: string): DayStop => ({
  id: `stop-${id}`,
  candidateId: `candidate-${id}`,
  placeId: `place-${id}`,
  activity: id.toUpperCase(),
  period: null,
  startTime: null,
  endTime: null,
  durationMinutes: 60,
  transportFromPrevious: null,
  scheduleVerification: null,
  costNote: null,
  costVerification: null,
  notes: null,
});

function stopOnlyBase() {
  return TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    stage: "itinerary_planning",
    places: [place("place-a"), place("place-b"), place("place-c")],
    candidates: [candidate("a"), candidate("b"), candidate("c")],
    finalRoute: { version: 1, nodes: [] },
  });
}

function trip(plan: TravelPlanDocument): TripDetailV3 {
  return {
    id: "trip",
    title: plan.trip.title,
    state: "active",
    updatedAt: "2026-09-05T00:00:00.000Z",
    planLanguage: "zh",
    contentGeneration: 1,
    plan,
  } as TripDetailV3;
}

describe("Phase 1 R3 bridge regressions", () => {
  it("keeps every Stop in a null-anchor Day and supports appending another Stop", () => {
    const base = stopOnlyBase();
    const submitted = TravelPlanDocumentSchema.parse({
      ...base,
      days: [{
        id: "day-1",
        dayNumber: 1,
        date: null,
        title: "Day 1",
        transferMode: "none",
        detailLevel: "planned",
        detailStatus: null,
        startAnchor: { id: "start-1", placeId: null, label: null, notes: null },
        stops: [stop("a"), stop("b")],
        endAnchor: { id: "end-1", placeId: null, label: null, notes: null },
      }],
    });

    const first = syncFinalRouteForLegacyWriteV3(base, submitted);
    expect(first.finalRoute.nodes.map((node) => [node.id, node.placeId])).toEqual([
      ["stop-a", "place-a"],
      ["stop-b", "place-b"],
      ["day-1", "place-b"],
    ]);
    expect(first.days[0].startAnchor.placeId).toBeNull();
    expect(first.days[0].endAnchor.placeId).toBeNull();
    expect(first.days[0].stops.map((item) => item.candidateId)).toEqual(["candidate-a", "candidate-b"]);

    const appended = structuredClone(first);
    appended.days[0].stops.push(stop("c"));
    const second = syncFinalRouteForLegacyWriteV3(first, appended);

    expect(second.days[0].startAnchor.placeId).toBeNull();
    expect(second.days[0].endAnchor.placeId).toBeNull();
    expect(second.days[0].stops.map((item) => item.candidateId)).toEqual(["candidate-a", "candidate-b", "candidate-c"]);
    expect(second.finalRoute.nodes.find((node) => node.id === "day-1")?.placeId).toBe("place-c");
    expect(second.finalRoute.nodes.some((node) => node.id === "stop-c" && node.placeId === "place-c")).toBe(true);
  });

  it("treats null detailed transport as sticky when the first Stop owns the Day arrival transport", () => {
    const rail = {
      mode: "rail" as const,
      durationMinutes: null,
      note: null,
      verification: { status: "unverified" as const, checkedAt: null },
    };
    const base = TravelPlanDocumentSchema.parse({
      ...emptyTravelPlan(),
      stage: "itinerary_refinement",
      places: [
        { ...place("city-a"), kind: "city" as const },
        { ...place("city-b"), kind: "city" as const },
        place("core-b-place"),
      ],
      candidates: [{
        id: "core-b",
        placeId: "core-b-place",
        planningAreaCandidateId: null,
        planningRole: "core_visit" as const,
        preference: "must_go" as const,
        source: "user" as const,
        aiReason: null,
        aiScore: null,
        suggestedDurationMinutes: 120,
        tags: [],
      }],
      finalRoute: { version: 1, nodes: [] },
      days: [{
        id: "day-b",
        dayNumber: 1,
        date: null,
        title: "乙城",
        transferMode: "rail",
        detailLevel: "detailed",
        detailStatus: "needs_review",
        startAnchor: { id: "start-b", placeId: "city-a", label: null, notes: null },
        stops: [{
          id: "stop-core-b",
          candidateId: "core-b",
          placeId: "core-b-place",
          activity: "乙核心",
          period: "morning",
          startTime: "09:00",
          endTime: "11:00",
          durationMinutes: 120,
          transportFromPrevious: rail,
          scheduleVerification: { status: "estimated", checkedAt: null },
          costNote: null,
          costVerification: null,
          notes: null,
        }],
        endAnchor: { id: "end-b", placeId: "city-b", label: null, notes: null },
      }],
    });
    const update: DetailedDayUpdate = {
      dayId: "day-b",
      stops: [{
        candidateId: "core-b",
        activity: "乙核心",
        period: "morning",
        startTime: "09:00",
        endTime: "11:00",
        durationMinutes: 120,
        transportFromPrevious: null,
        scheduleVerification: { status: "estimated", checkedAt: null },
        costNote: null,
        costVerification: null,
        notes: null,
      }],
    };

    const result = detailedReplacementCommandsPhase5V3(trip(base), [update]);
    expect(result.commands).toEqual([]);
    expect(result.plan.days[0].stops[0].transportFromPrevious?.mode).toBe("rail");
  });
});
