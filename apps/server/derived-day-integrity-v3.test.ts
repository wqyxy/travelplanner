import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
} from "./contracts-v2.js";
import { inspectDerivedDayWriteV3 } from "./derived-day-integrity-v3.js";
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
      nodes: [
        node("stop-x", "x", { activity: "原活动" }),
        node("day-end", "end", { endsDay: true }),
      ],
    },
  });
  return rebuildFinalRouteDaysV3(base);
}

describe("derived Day write integrity", () => {
  it("accepts metadata-only detail status changes that round-trip through finalRoute derivation", () => {
    const incoming = canonicalPlan();
    incoming.days[0].detailStatus = "needs_review";
    const result = inspectDerivedDayWriteV3(incoming);
    expect(result.matchesCanonicalDays).toBe(true);
    expect(result.plan.days[0].detailStatus).toBe("needs_review");
  });

  it("rejects independent Stop detail writes when canonical finalRoute did not change", () => {
    const incoming = canonicalPlan();
    incoming.days[0].stops[0].activity = "只改 Day 的活动";
    const result = inspectDerivedDayWriteV3(incoming);
    expect(result.matchesCanonicalDays).toBe(false);
    expect(result.plan.days[0].stops[0].activity).toBe("原活动");
  });

  it("rejects independent route-structure writes", () => {
    const incoming = canonicalPlan();
    incoming.days[0].endAnchor.placeId = "other";
    const result = inspectDerivedDayWriteV3(incoming);
    expect(result.matchesCanonicalDays).toBe(false);
    expect(result.plan.days[0].endAnchor.placeId).toBe("end");
  });
});
