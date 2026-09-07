import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { updateDerivedStopViaFinalRouteV3 } from "./final-route-day-stop-bridge-v3.js";

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
  const base = emptyTravelPlan();
  return TravelPlanDocumentSchema.parse({
    ...base,
    trip: { ...base.trip, originPlaceId: "origin" },
    places: [place("origin"), place("x"), place("y"), place("end")],
    candidates: [
      { id: "cx", placeId: "x", planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 60, tags: [] },
      { id: "cy", placeId: "y", planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 90, tags: [] },
    ],
    finalRoute: {
      version: 1,
      nodes: [node("stop-x", "x"), node("day-end", "end", { endsDay: true })],
    },
  });
}

describe("legacy Day stop -> finalRoute canonical bridge", () => {
  it("maps detail and itinerary transport changes onto the canonical node", () => {
    const result = updateDerivedStopViaFinalRouteV3(plan(), "stop-x", {
      activity: "步道散步",
      durationMinutes: 75,
      notes: "预留拍照时间",
      transportFromPrevious: {
        mode: "walk",
        durationMinutes: 15,
        note: "步行连接",
        verification: { status: "estimated", checkedAt: null },
      },
    });

    expect(result).not.toBeNull();
    const routeNode = result!.plan.finalRoute.nodes.find((item) => item.id === "stop-x");
    expect(routeNode).toMatchObject({ placeId: "x", activity: "步道散步", durationMinutes: 75, notes: "预留拍照时间" });
    expect(routeNode?.transportFromPrevious).toMatchObject({ mode: "walk", durationMinutes: 15 });
    expect(result!.plan.days[0].stops[0]).toMatchObject({ id: "stop-x", placeId: "x", candidateId: "cx", activity: "步道散步", durationMinutes: 75 });
  });

  it("maps stop replacement to the candidate's canonical Place identity", () => {
    const result = updateDerivedStopViaFinalRouteV3(plan(), "stop-x", {
      candidateId: "cy",
      placeId: "y",
      activity: "改去 Y",
    });

    expect(result).not.toBeNull();
    expect(result!.plan.finalRoute.nodes.find((item) => item.id === "stop-x")).toMatchObject({ placeId: "y", activity: "改去 Y" });
    expect(result!.plan.days[0].stops[0]).toMatchObject({ placeId: "y", candidateId: "cy", activity: "改去 Y" });
  });

  it("keeps legacy-only candidate detach/place-only semantics on the fallback path", () => {
    expect(updateDerivedStopViaFinalRouteV3(plan(), "stop-x", { candidateId: null })).toBeNull();
    expect(updateDerivedStopViaFinalRouteV3(plan(), "stop-x", { placeId: "y" })).toBeNull();
  });
});
