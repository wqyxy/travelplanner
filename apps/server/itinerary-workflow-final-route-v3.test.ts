import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type Place,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { inspectDerivedDayWriteV3 } from "./derived-day-integrity-v3.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";
import { applySkeletonPlanV3 } from "./itinerary-workflow-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

const place = (id: string): Place => ({
  id,
  nameZh: id.toUpperCase(),
  nameLocal: null,
  nameEn: null,
  kind: "city",
  city: null,
  region: null,
  country: "新西兰",
  countryCode: "NZ",
  approximate: false,
});

function plan(): TravelPlanDocument {
  const base = emptyTravelPlan();
  return TravelPlanDocumentSchema.parse({
    ...base,
    trip: {
      ...base.trip,
      originPlaceId: "origin",
      dates: { start: "2026-10-01", end: null, requestedDurationDays: 3 },
    },
    places: [place("origin"), place("a"), place("b"), place("inactive")],
    candidates: [
      {
        id: "area-a",
        placeId: "a",
        planningAreaCandidateId: null,
        planningRole: "planning_area",
        preference: "must_go",
        source: "user",
        aiReason: null,
        aiScore: null,
        suggestedDurationMinutes: null,
        tags: [],
      },
      {
        id: "area-b",
        placeId: "b",
        planningAreaCandidateId: null,
        planningRole: "planning_area",
        preference: "must_go",
        source: "user",
        aiReason: null,
        aiScore: null,
        suggestedDurationMinutes: null,
        tags: [],
      },
    ],
  });
}

function trip(planValue = plan()): TripDetailV3 {
  return {
    id: "trip",
    title: "initial skeleton canonical route",
    state: "active",
    planLanguage: "zh",
    contentGeneration: 1,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    plan: planValue,
  } as TripDetailV3;
}

describe("initial skeleton canonical finalRoute", () => {
  it("represents stay nights as independent route nodes and re-derives Days", () => {
    const result = applySkeletonPlanV3(trip(), {
      stays: [
        { planningAreaCandidateId: "area-a", stayDays: 2, transferModeFromPrevious: "drive" },
        { planningAreaCandidateId: "area-b", stayDays: 1, transferModeFromPrevious: "drive" },
      ],
      omittedPlanningAreas: [],
    });

    const nodes = result.plan.finalRoute.nodes;
    expect(nodes.map((node) => node.placeId)).toEqual(["a", "a", "b"]);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(3);
    expect(nodes.map((node) => node.endsDay)).toEqual([true, true, false]);
    expect(nodes.map((node) => node.transportFromPrevious?.mode ?? "none")).toEqual(["drive", "none", "drive"]);

    expect(result.plan.days).toHaveLength(3);
    expect(result.plan.days.map((day) => day.id)).toEqual(nodes.map((node) => node.id));
    expect(result.plan.days.map((day) => [day.startAnchor.placeId, day.endAnchor.placeId])).toEqual([
      ["origin", "a"],
      ["a", "a"],
      ["a", "b"],
    ]);
    expect(result.plan.days.map((day) => day.transferMode)).toEqual(["drive", "none", "drive"]);
    expect(result.plan.days[0].stayBlockId).toBeTruthy();
    expect(result.plan.days[1].stayBlockId).toBe(result.plan.days[0].stayBlockId);
    expect(result.plan.days[2].stayBlockId).not.toBe(result.plan.days[0].stayBlockId);
  });

  it("canonicalizes replan before Store and preserves inactive route nodes", () => {
    const initial = applySkeletonPlanV3(trip(), {
      stays: [
        { planningAreaCandidateId: "area-a", stayDays: 2, transferModeFromPrevious: "drive" },
        { planningAreaCandidateId: "area-b", stayDays: 1, transferModeFromPrevious: "drive" },
      ],
      omittedPlanningAreas: [],
    }).plan;

    const withInactive = structuredClone(initial);
    withInactive.finalRoute.nodes.splice(1, 0, {
      id: "inactive-node",
      placeId: "inactive",
      status: "tentative",
      endsDay: false,
      transportFromPrevious: null,
      activity: null,
      period: null,
      scheduleText: null,
      startTime: null,
      endTime: null,
      durationMinutes: null,
      scheduleVerification: null,
      costNote: null,
      costVerification: null,
      notes: null,
    });
    const current = rebuildFinalRouteDaysV3(withInactive);

    const replanned = applySkeletonPlanV3(trip(current), {
      stays: [
        { planningAreaCandidateId: "area-b", stayDays: 1, transferModeFromPrevious: "drive" },
        { planningAreaCandidateId: "area-a", stayDays: 2, transferModeFromPrevious: "drive" },
      ],
      omittedPlanningAreas: [],
    }).plan;

    expect(replanned.finalRoute.nodes.filter((node) => node.status === "normal").map((node) => node.placeId)).toEqual(["b", "a", "a"]);
    expect(replanned.finalRoute.nodes.find((node) => node.id === "inactive-node")?.status).toBe("tentative");
    expect(replanned.days.map((day) => day.endAnchor.placeId)).toEqual(["b", "a", "a"]);
    expect(inspectDerivedDayWriteV3(replanned).matchesCanonicalDays).toBe(true);
    expect(replanned.finalRoute.nodes).not.toEqual(current.finalRoute.nodes);
  });

  it("keeps a reused detailed Stop when its Stay Block moves and marks the Day for review", () => {
    const initial = applySkeletonPlanV3(trip(), {
      stays: [
        { planningAreaCandidateId: "area-a", stayDays: 2, transferModeFromPrevious: "drive" },
        { planningAreaCandidateId: "area-b", stayDays: 1, transferModeFromPrevious: "drive" },
      ],
      omittedPlanningAreas: [],
    }).plan;

    const detailed = structuredClone(initial);
    detailed.places.push(place("poi"));
    const firstDayId = detailed.days[0].id;
    const firstBoundaryIndex = detailed.finalRoute.nodes.findIndex((node) => node.id === firstDayId);
    detailed.finalRoute.nodes.splice(firstBoundaryIndex, 0, {
      id: "detail-stop",
      placeId: "poi",
      status: "normal",
      endsDay: false,
      transportFromPrevious: {
        mode: "drive",
        durationMinutes: 37,
        note: "existing route fact",
        verification: { status: "estimated", checkedAt: "2026-09-07T00:00:00Z" },
      },
      activity: "保留的详细活动",
      period: "morning",
      scheduleText: "09:00 出发",
      startTime: "09:00",
      endTime: "10:00",
      durationMinutes: 60,
      scheduleVerification: { status: "estimated", checkedAt: "2026-09-07T00:00:00Z" },
      costNote: null,
      costVerification: null,
      notes: "用户已经编辑过",
    });
    const current = rebuildFinalRouteDaysV3(detailed);
    expect(current.days[0].detailLevel).toBe("detailed");

    const replanned = applySkeletonPlanV3(trip(current), {
      stays: [
        { planningAreaCandidateId: "area-b", stayDays: 1, transferModeFromPrevious: "drive" },
        { planningAreaCandidateId: "area-a", stayDays: 2, transferModeFromPrevious: "drive" },
      ],
      omittedPlanningAreas: [],
    }).plan;

    const stopNode = replanned.finalRoute.nodes.find((node) => node.id === "detail-stop");
    expect(stopNode).toMatchObject({
      placeId: "poi",
      status: "normal",
      activity: "保留的详细活动",
      scheduleText: "09:00 出发",
      durationMinutes: 60,
      notes: "用户已经编辑过",
    });
    expect(stopNode?.transportFromPrevious).toEqual({
      mode: "drive",
      durationMinutes: 37,
      note: "existing route fact",
      verification: { status: "estimated", checkedAt: "2026-09-07T00:00:00Z" },
    });
    const movedDay = replanned.days.find((day) => day.stops.some((stop) => stop.id === "detail-stop"));
    expect(movedDay?.detailLevel).toBe("detailed");
    expect(movedDay?.detailStatus).toBe("needs_review");
    expect(inspectDerivedDayWriteV3(replanned).matchesCanonicalDays).toBe(true);
  });
});
