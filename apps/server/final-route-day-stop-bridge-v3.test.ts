import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type DayStop,
  type FinalRouteNode,
  type Place,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import {
  addDerivedStopViaFinalRouteV3,
  moveDerivedStopViaFinalRouteV3,
  removeDerivedStopViaFinalRouteV3,
  updateDerivedStopViaFinalRouteV3,
} from "./final-route-day-stop-bridge-v3.js";
import { syncFinalRouteForLegacyWriteV3 } from "./final-route-v3.js";

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
  const base = emptyTravelPlan();
  return TravelPlanDocumentSchema.parse({
    ...base,
    trip: { ...base.trip, originPlaceId: "origin" },
    places: [place("origin"), place("x"), place("y"), place("end")],
    candidates: [candidate("cx", "x"), candidate("cy", "y")],
    finalRoute: {
      version: 1,
      nodes: [node("stop-x", "x"), node("day-end", "end", { endsDay: true })],
    },
  });
}

function twoDayPlan(): TravelPlanDocument {
  const base = emptyTravelPlan();
  return TravelPlanDocumentSchema.parse({
    ...base,
    trip: { ...base.trip, originPlaceId: "origin" },
    places: ["origin", "x", "y", "z", "inactive", "end-1", "end-2"].map(place),
    candidates: [candidate("cx", "x"), candidate("cy", "y"), candidate("cz", "z")],
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
}

function newStop(): DayStop {
  return {
    id: "stop-z",
    candidateId: "cz",
    placeId: "z",
    activity: "游览 Z",
    period: "afternoon",
    scheduleText: null,
    startTime: null,
    endTime: null,
    durationMinutes: 60,
    transportFromPrevious: null,
    scheduleVerification: null,
    costNote: null,
    costVerification: null,
    notes: null,
  };
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

  it("treats candidate identity as derived instead of preserving a detach state", () => {
    const detached = updateDerivedStopViaFinalRouteV3(plan(), "stop-x", { candidateId: null });
    expect(detached).not.toBeNull();
    expect(detached!.plan.finalRoute.nodes.find((item) => item.id === "stop-x")?.placeId).toBe("x");
    expect(detached!.plan.days[0].stops[0].candidateId).toBe("cx");

    const placeOnly = updateDerivedStopViaFinalRouteV3(plan(), "stop-x", { candidateId: null, placeId: "y" });
    expect(placeOnly).not.toBeNull();
    expect(placeOnly!.plan.finalRoute.nodes.find((item) => item.id === "stop-x")?.placeId).toBe("y");
    expect(placeOnly!.plan.days[0].stops[0].candidateId).toBe("cy");
  });

  it("removes an ordinary derived Stop by removing the same canonical route node", () => {
    const result = removeDerivedStopViaFinalRouteV3(plan(), "stop-x");
    expect(result).not.toBeNull();
    expect(result!.plan.finalRoute.nodes.map((item) => item.id)).toEqual(["day-end"]);
    expect(result!.plan.days).toHaveLength(1);
    expect(result!.plan.days[0].stops).toEqual([]);
    expect(result!.affectedDayIds).toEqual(["day-end"]);
  });

  it("adds a Stop with the same active/inactive ordering as the legacy Day write bridge", () => {
    const before = twoDayPlan();
    const afterDayEdit = structuredClone(before);
    afterDayEdit.days[1].stops.splice(0, 0, newStop());
    const legacy = syncFinalRouteForLegacyWriteV3(before, afterDayEdit);

    const canonical = addDerivedStopViaFinalRouteV3(before, "day-2", 0, newStop());
    expect(canonical).not.toBeNull();
    expect(canonical!.plan.finalRoute.nodes).toEqual(legacy.finalRoute.nodes);
    expect(canonical!.plan.days).toEqual(legacy.days);
  });

  it("derives Candidate identity when a new Stop only specifies canonical Place identity", () => {
    const before = twoDayPlan();
    const stop = { ...newStop(), candidateId: null };
    const canonical = addDerivedStopViaFinalRouteV3(before, "day-2", 0, stop);
    expect(canonical).not.toBeNull();
    expect(canonical!.plan.finalRoute.nodes.find((item) => item.id === "stop-z")?.placeId).toBe("z");
    expect(canonical!.plan.days[1].stops.find((item) => item.id === "stop-z")?.candidateId).toBe("cz");
  });

  it("moves a Stop across Days with the same inactive-node anchoring as the legacy bridge", () => {
    const before = twoDayPlan();
    const afterDayEdit = structuredClone(before);
    const [moved] = afterDayEdit.days[0].stops.splice(0, 1);
    afterDayEdit.days[1].stops.splice(0, 0, moved);
    const legacy = syncFinalRouteForLegacyWriteV3(before, afterDayEdit);

    const canonical = moveDerivedStopViaFinalRouteV3(before, "stop-x", "day-2", 0);
    expect(canonical).not.toBeNull();
    expect(canonical!.plan.finalRoute.nodes).toEqual(legacy.finalRoute.nodes);
    expect(canonical!.plan.days).toEqual(legacy.days);
  });
});