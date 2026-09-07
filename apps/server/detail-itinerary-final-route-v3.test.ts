import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import type { DetailedDayUpdate } from "./ai-action-contracts-v3.js";
import { applyDetailedUpdatesPhase5V3 } from "./detail-itinerary-v3.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

const place = (id: string): Place => ({
  id,
  nameZh: id.toUpperCase(),
  nameLocal: null,
  nameEn: null,
  kind: "attraction",
  city: null,
  region: null,
  country: "新西兰",
  countryCode: "NZ",
  approximate: false,
});

const candidate = (id: string, placeId: string) => ({
  id,
  placeId,
  planningAreaCandidateId: null,
  preference: "optional" as const,
  source: "user" as const,
  aiReason: null,
  aiScore: null,
  suggestedDurationMinutes: 60,
  tags: [],
});

const node = (id: string, placeId: string, patch: Partial<FinalRouteNode> = {}): FinalRouteNode => ({
  id,
  placeId,
  status: "normal",
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
  ...patch,
});

function plan(): TravelPlanDocument {
  const base = TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    trip: { ...emptyTravelPlan().trip, originPlaceId: "origin" },
    places: ["origin", "x", "y", "z", "end"].map(place),
    candidates: [candidate("cx", "x"), candidate("cy", "y"), candidate("cz", "z")],
    finalRoute: {
      version: 1,
      nodes: [
        node("stop-x", "x"),
        node("stop-y", "y"),
        node("day-end", "end", { endsDay: true }),
      ],
    },
  });
  return rebuildFinalRouteDaysV3(base);
}

function trip(planValue = plan()): TripDetailV3 {
  return {
    id: "trip",
    title: "detail canonical",
    state: "active",
    planLanguage: "zh",
    contentGeneration: 1,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    plan: planValue,
  } as TripDetailV3;
}

describe("detailed itinerary canonical finalRoute writes", () => {
  it("reorders, adds, removes and details Stops directly in finalRoute", () => {
    const source = plan();
    const update: DetailedDayUpdate = {
      dayId: "day-end",
      stops: [
        {
          candidateId: "cy",
          activity: "先游览 Y",
          period: "morning",
          scheduleText: "上午",
          startTime: "09:00",
          endTime: "10:00",
          durationMinutes: 60,
          transportFromPrevious: null,
          scheduleVerification: { status: "estimated", checkedAt: null },
          costNote: null,
          costVerification: null,
          notes: "保留 Y 的节点身份",
        },
        {
          candidateId: "cz",
          activity: "新增 Z",
          period: "afternoon",
          scheduleText: "下午",
          startTime: "14:00",
          endTime: "15:30",
          durationMinutes: 90,
          transportFromPrevious: { mode: "walk", durationMinutes: 20, note: null, verification: { status: "estimated", checkedAt: null } },
          scheduleVerification: { status: "estimated", checkedAt: null },
          costNote: null,
          costVerification: null,
          notes: null,
        },
      ],
    };

    const result = applyDetailedUpdatesPhase5V3(trip(source), [update], true);
    const active = result.finalRoute.nodes.filter((item) => item.status === "normal");

    expect(active.map((item) => item.placeId)).toEqual(["y", "z", "end"]);
    expect(active.some((item) => item.id === "stop-x")).toBe(false);
    expect(active[0]).toMatchObject({ id: "stop-y", placeId: "y", activity: "先游览 Y", period: "morning" });
    expect(active[1]).toMatchObject({ placeId: "z", activity: "新增 Z", durationMinutes: 90 });
    expect(result.days[0].stops.map((stop) => stop.placeId)).toEqual(["y", "z"]);
    expect(result.days[0].stops[0].id).toBe("stop-y");
    expect(result.days[0].detailLevel).toBe("detailed");
    expect(result.days[0].detailStatus).toBe("ready");
    expect(result.stage).toBe("itinerary_refinement");
  });
});
