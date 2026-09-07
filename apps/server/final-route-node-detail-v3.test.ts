import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { updateFinalRouteNodeDetailV3 } from "./final-route-node-detail-v3.js";

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

function routePlan(nodes: FinalRouteNode[]): TravelPlanDocument {
  const base = emptyTravelPlan();
  return TravelPlanDocumentSchema.parse({
    ...base,
    trip: {
      ...base.trip,
      originPlaceId: "a",
      dates: { start: "2026-10-01", end: null, requestedDurationDays: 4 },
    },
    places: [place("a"), place("x"), place("b")],
    finalRoute: { version: 1, nodes },
  });
}

describe("final route node detail v3", () => {
  it("updates canonical node detail and re-derives the Day stop", () => {
    const plan = routePlan([
      node("x", "x"),
      node("b", "b", { endsDay: true }),
    ]);

    const result = updateFinalRouteNodeDetailV3(plan, "x", {
      activity: "湖边散步",
      period: "afternoon",
      durationMinutes: 90,
      notes: "保留弹性",
    });

    expect(result.plan.finalRoute.nodes.find((item) => item.id === "x")).toMatchObject({
      activity: "湖边散步",
      period: "afternoon",
      durationMinutes: 90,
      notes: "保留弹性",
    });
    expect(result.plan.days).toHaveLength(1);
    expect(result.plan.days[0].stops[0]).toMatchObject({
      id: "x",
      placeId: "x",
      activity: "湖边散步",
      period: "afternoon",
      durationMinutes: 90,
      notes: "保留弹性",
    });
    expect(result.affectedDayIds).toEqual(["b"]);
  });

  it("rejects an empty detail update", () => {
    const plan = routePlan([node("x", "x"), node("b", "b", { endsDay: true })]);
    expect(() => updateFinalRouteNodeDetailV3(plan, "x", {})).toThrow(/没有可更新字段/);
  });
});
