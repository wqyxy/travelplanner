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

  it("rejects independent Day route structure once finalRoute is canonical", () => {
    const before = canonicalPlan();
    const incoming = structuredClone(before);
    incoming.days[0].endAnchor.placeId = "other";

    expect(() => canonicalizePlanWriteV3(before, incoming)).toThrow("DERIVED_DAY_ROUTE_WRITE_REJECTED");
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
