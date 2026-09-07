import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";
import { applyPlanCommands } from "./plan-commands-v2.js";

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

function oneDayPlan(): TravelPlanDocument {
  const base = emptyTravelPlan();
  const parsed = TravelPlanDocumentSchema.parse({
    ...base,
    trip: { ...base.trip, originPlaceId: "origin" },
    places: ["origin", "x", "z", "end"].map(place),
    candidates: [candidate("cx", "x"), candidate("cz", "z")],
    finalRoute: {
      version: 1,
      nodes: [
        node("stop-x", "x", { activity: "原活动" }),
        node("day-end", "end", { endsDay: true }),
      ],
    },
  });
  return rebuildFinalRouteDaysV3(parsed);
}

function twoDayPlan(): TravelPlanDocument {
  const base = emptyTravelPlan();
  const parsed = TravelPlanDocumentSchema.parse({
    ...base,
    trip: { ...base.trip, originPlaceId: "origin" },
    places: ["origin", "x", "y", "inactive", "end-1", "end-2"].map(place),
    candidates: [candidate("cx", "x"), candidate("cy", "y")],
    finalRoute: {
      version: 1,
      nodes: [
        node("stop-x", "x"),
        node("day-1", "end-1", { endsDay: true }),
        node("inactive-node", "inactive", { status: "tentative" }),
        node("stop-y", "y"),
        node("day-2", "end-2", { endsDay: true }),
      ],
    },
  });
  return rebuildFinalRouteDaysV3(parsed);
}

describe("PlanCommand legacy Stop bridge", () => {
  it("updates canonical finalRoute and preserves needs_review semantics", () => {
    const result = applyPlanCommands(oneDayPlan(), [{
      type: "update_day_stop",
      stopId: "stop-x",
      changes: { activity: "更新后的活动", durationMinutes: 80 },
    }]);

    expect(result.plan.finalRoute.nodes.find((item) => item.id === "stop-x")).toMatchObject({
      activity: "更新后的活动",
      durationMinutes: 80,
    });
    expect(result.plan.days[0].stops[0]).toMatchObject({ activity: "更新后的活动", durationMinutes: 80 });
    expect(result.plan.days[0].detailStatus).toBe("needs_review");
  });

  it("adds a temporary Stop as a canonical route node using the mapped formal ID", () => {
    const result = applyPlanCommands(oneDayPlan(), [{
      type: "add_day_stop",
      dayId: "day-end",
      index: 1,
      stop: {
        id: "tmp-stop-z",
        candidateId: "cz",
        placeId: "z",
        activity: "游览 Z",
        period: null,
        scheduleText: null,
        startTime: null,
        endTime: null,
        durationMinutes: 60,
        transportFromPrevious: null,
        scheduleVerification: null,
        costNote: null,
        costVerification: null,
        notes: null,
      },
    }]);

    const mappedId = result.idMappings["tmp-stop-z"];
    expect(mappedId).toBeTruthy();
    expect(result.plan.finalRoute.nodes.map((item) => item.id)).toEqual(["stop-x", mappedId, "day-end"]);
    expect(result.plan.days[0].stops.map((stop) => stop.id)).toEqual(["stop-x", mappedId]);
  });

  it("moves a Stop canonically while preserving inactive node anchoring", () => {
    const result = applyPlanCommands(twoDayPlan(), [{
      type: "move_day_stop",
      stopId: "stop-x",
      targetDayId: "day-2",
      targetIndex: 0,
    }]);

    expect(result.plan.finalRoute.nodes.map((item) => item.id)).toEqual([
      "day-1",
      "stop-x",
      "inactive-node",
      "stop-y",
      "day-2",
    ]);
    expect(result.plan.days[0].stops).toEqual([]);
    expect(result.plan.days[1].stops.map((stop) => stop.id)).toEqual(["stop-x", "stop-y"]);
  });

  it("removes a Stop from canonical finalRoute", () => {
    const result = applyPlanCommands(oneDayPlan(), [{ type: "remove_day_stop", stopId: "stop-x" }]);
    expect(result.plan.finalRoute.nodes.map((item) => item.id)).toEqual(["day-end"]);
    expect(result.plan.days[0].stops).toEqual([]);
  });
});
