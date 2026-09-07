import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type Place,
  type TravelPlanDocument,
} from "./contracts-v2.js";
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
    places: [place("origin"), place("a"), place("b")],
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
});
