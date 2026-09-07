import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
} from "./contracts-v2.js";
import { canonicalizePlanWriteV3 } from "./canonical-plan-write-v3.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";

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

function canonicalPlan() {
  const base = TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    trip: { ...emptyTravelPlan().trip, originPlaceId: "origin" },
    places: [place("origin"), place("x"), place("end"), place("other")],
    finalRoute: {
      version: 1,
      nodes: [node("stop-x", "x", { activity: "原活动" }), node("day-end", "end", { endsDay: true })],
    },
  });
  return rebuildFinalRouteDaysV3(base);
}

function twoDayPlan() {
  const base = TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    trip: { ...emptyTravelPlan().trip, originPlaceId: "origin" },
    places: [place("origin"), place("a"), place("b")],
    finalRoute: {
      version: 1,
      nodes: [node("day-1", "a", { endsDay: true }), node("day-2", "b")],
    },
  });
  return rebuildFinalRouteDaysV3(base);
}

describe("canonical V3 plan write boundary", () => {
  it("treats finalRoute changes as authoritative and re-derives Days", () => {
    const before = canonicalPlan();
    const incoming = structuredClone(before);
    incoming.finalRoute.nodes.find((item) => item.id === "stop-x")!.activity = "canonical update";
    incoming.days[0].stops[0].activity = "stale Day value";

    const result = canonicalizePlanWriteV3(before, incoming);
    expect(result.days[0].stops[0].activity).toBe("canonical update");
  });

  it("allows metadata-only Day changes that round-trip through finalRoute", () => {
    const before = canonicalPlan();
    const incoming = structuredClone(before);
    incoming.days[0].detailStatus = "needs_review";

    const result = canonicalizePlanWriteV3(before, incoming);
    expect(result.days[0].detailStatus).toBe("needs_review");
  });

  it("preserves explicit Day title and date metadata at this boundary", () => {
    const before = canonicalPlan();
    const incoming = structuredClone(before);
    incoming.days[0].title = "用户自定义标题";
    incoming.days[0].date = "2026-10-05";

    const result = canonicalizePlanWriteV3(before, incoming);
    expect(result.days[0].title).toBe("用户自定义标题");
    expect(result.days[0].date).toBe("2026-10-05");
  });

  it("re-derives a stale Day start when the canonical trip origin changes", () => {
    const before = canonicalPlan();
    const incoming = structuredClone(before);
    incoming.trip.originPlaceId = "other";

    const result = canonicalizePlanWriteV3(before, incoming);
    expect(result.days[0].startAnchor.placeId).toBe("other");
  });

  it("re-derives Candidate links without treating them as independent Day route writes", () => {
    const before = canonicalPlan();
    const incoming = structuredClone(before);
    incoming.candidates.push({
      id: "candidate-x",
      placeId: "x",
      planningAreaCandidateId: null,
      preference: "optional",
      source: "user",
      aiReason: null,
      aiScore: null,
      suggestedDurationMinutes: null,
      tags: [],
    });

    const result = canonicalizePlanWriteV3(before, incoming);
    expect(result.days[0].stops[0].candidateId).toBe("candidate-x");
  });

  it("canonicalizes a non-null legacy Day anchor into finalRoute", () => {
    const before = canonicalPlan();
    const incoming = structuredClone(before);
    incoming.days[0].endAnchor.placeId = "other";

    const result = canonicalizePlanWriteV3(before, incoming);
    expect(result.finalRoute.nodes.find((item) => item.id === "day-end")?.placeId).toBe("other");
    expect(result.days[0].endAnchor.placeId).toBe("other");
  });

  it("canonicalizes legacy Day reorder while keeping stable Day IDs", () => {
    const before = twoDayPlan();
    const incoming = structuredClone(before);
    incoming.days = [incoming.days[1], incoming.days[0]];
    incoming.days.forEach((day, index) => { day.dayNumber = index + 1; });

    const result = canonicalizePlanWriteV3(before, incoming);
    expect(result.days.map((day) => day.id)).toEqual(["day-2", "day-1"]);
    const activeIds = result.finalRoute.nodes.filter((item) => item.status === "normal").map((item) => item.id);
    expect(activeIds.indexOf("day-2")).toBeLessThan(activeIds.indexOf("day-1"));
  });

  it("keeps null anchor edits on the known legacy compatibility path", () => {
    const before = canonicalPlan();
    const incoming = structuredClone(before);
    incoming.days[0].endAnchor.placeId = null;

    const result = canonicalizePlanWriteV3(before, incoming);
    expect(result.days[0].endAnchor.placeId).toBeNull();
  });

  it("rejects direct Stop structure writes when finalRoute is already canonical", () => {
    const before = canonicalPlan();
    const incoming = structuredClone(before);
    incoming.days[0].stops[0].activity = "绕过 canonical node 的修改";

    expect(() => canonicalizePlanWriteV3(before, incoming)).toThrow("DERIVED_DAY_ROUTE_WRITE_UNSUPPORTED");
  });

  it("rejects direct Day identity-set changes when finalRoute is already canonical", () => {
    const before = twoDayPlan();
    const incoming = structuredClone(before);
    incoming.days.pop();

    expect(() => canonicalizePlanWriteV3(before, incoming)).toThrow("DERIVED_DAY_ROUTE_WRITE_UNSUPPORTED");
  });

  it("temporarily keeps legacy Day-only plans on the reverse bridge", () => {
    const base = emptyTravelPlan();
    const before = TravelPlanDocumentSchema.parse({
      ...base,
      places: [place("x"), place("end")],
      days: [{
        id: "legacy-day",
        dayNumber: 1,
        date: null,
        title: "legacy",
        stayBlockId: null,
        transferMode: "none",
        detailLevel: "planned",
        detailStatus: null,
        startAnchor: { id: "start", placeId: "x", label: null, notes: null },
        stops: [],
        endAnchor: { id: "end-anchor", placeId: "end", label: null, notes: null },
      }],
    });
    const incoming = structuredClone(before);
    incoming.days[0].endAnchor.placeId = "x";

    const result = canonicalizePlanWriteV3(before, incoming);
    expect(result.finalRoute.nodes.length).toBeGreaterThan(0);
    expect(result.days[0].endAnchor.placeId).toBe("x");
  });
});