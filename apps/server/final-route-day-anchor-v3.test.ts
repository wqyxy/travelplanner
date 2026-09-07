import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3, syncFinalRouteForLegacyWriteV3 } from "./final-route-v3.js";
import { tryApplyLegacyDayAnchorPlacesV3 } from "./final-route-day-anchor-v3.js";

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
  const base = TravelPlanDocumentSchema.parse({
    ...emptyTravelPlan(),
    trip: { ...emptyTravelPlan().trip, originPlaceId: "origin" },
    places: ["origin", "a", "b", "c", "d"].map(place),
    finalRoute: {
      version: 1,
      nodes: [node("day-1", "a", { endsDay: true }), node("day-2", "b")],
    },
  });
  return rebuildFinalRouteDaysV3(base);
}

describe("legacy Day anchors -> canonical finalRoute", () => {
  it("maps first-Day start to trip origin", () => {
    const before = plan();
    const incoming = structuredClone(before);
    incoming.days[0].startAnchor = { ...incoming.days[0].startAnchor, placeId: "c", label: "新起点", notes: "用户修改" };

    const direct = tryApplyLegacyDayAnchorPlacesV3(before, incoming);
    expect(direct).not.toBeNull();
    expect(direct!.trip.originPlaceId).toBe("c");
    expect(direct!.days[0].startAnchor).toMatchObject({ placeId: "c", label: "新起点", notes: "用户修改" });
  });

  it("maps a later Day start to the previous boundary node", () => {
    const before = plan();
    const incoming = structuredClone(before);
    incoming.days[1].startAnchor.placeId = "c";

    const direct = tryApplyLegacyDayAnchorPlacesV3(before, incoming);
    expect(direct).not.toBeNull();
    expect(direct!.finalRoute.nodes.find((item) => item.id === "day-1")?.placeId).toBe("c");
    expect(direct!.days[0].endAnchor.placeId).toBe("c");
    expect(direct!.days[1].startAnchor.placeId).toBe("c");
  });

  it("maps Day end to the same Day boundary with legacy-equivalent continuity", () => {
    const before = plan();
    const incoming = structuredClone(before);
    incoming.days[0].endAnchor.placeId = "d";

    const legacy = syncFinalRouteForLegacyWriteV3(before, incoming);
    const direct = tryApplyLegacyDayAnchorPlacesV3(before, incoming);
    expect(direct).not.toBeNull();
    expect(direct!.finalRoute.nodes).toEqual(legacy.finalRoute.nodes);
    expect(direct!.days.map((day) => [day.startAnchor.placeId, day.endAnchor.placeId])).toEqual(
      legacy.days.map((day) => [day.startAnchor.placeId, day.endAnchor.placeId]),
    );
  });

  it("falls back for null anchors or conflicting requests on the same boundary", () => {
    const before = plan();
    const nullIncoming = structuredClone(before);
    nullIncoming.days[1].startAnchor.placeId = null;
    expect(tryApplyLegacyDayAnchorPlacesV3(before, nullIncoming)).toBeNull();

    const conflict = structuredClone(before);
    conflict.days[0].endAnchor.placeId = "c";
    conflict.days[1].startAnchor.placeId = "d";
    expect(tryApplyLegacyDayAnchorPlacesV3(before, conflict)).toBeNull();
  });
});