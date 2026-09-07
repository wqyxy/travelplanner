import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3, syncFinalRouteForLegacyWriteV3 } from "./final-route-v3.js";
import { tryApplyLegacyDayReorderV3 } from "./final-route-day-reorder-v3.js";

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
    places: ["origin", "a", "b", "c", "s1", "s2", "s3", "inactive"].map(place),
    finalRoute: {
      version: 1,
      nodes: [
        node("stop-1", "s1"),
        node("day-1", "a", { endsDay: true }),
        node("inactive-node", "inactive", { status: "tentative" }),
        node("stop-2", "s2"),
        node("day-2", "b", { endsDay: true }),
        node("stop-3", "s3"),
        node("day-3", "c", { endsDay: false }),
      ],
    },
  });
  return rebuildFinalRouteDaysV3(base);
}

function reordered(before: TravelPlanDocument, ids: string[]) {
  const byId = new Map(before.days.map((day) => [day.id, structuredClone(day)]));
  const incoming = structuredClone(before);
  incoming.days = ids.map((id, index) => ({ ...byId.get(id)!, dayNumber: index + 1 }));
  return incoming;
}

describe("legacy Day reorder -> canonical finalRoute segments", () => {
  it("matches legacy conversion when moving first Day to the end", () => {
    const before = plan();
    const incoming = reordered(before, ["day-2", "day-3", "day-1"]);
    const legacy = syncFinalRouteForLegacyWriteV3(before, incoming);
    const direct = tryApplyLegacyDayReorderV3(before, incoming);

    expect(direct).not.toBeNull();
    expect(direct!.finalRoute.nodes).toEqual(legacy.finalRoute.nodes);
    expect(direct!.days).toEqual(legacy.days);
  });

  it("matches legacy conversion when moving last Day to the front", () => {
    const before = plan();
    const incoming = reordered(before, ["day-3", "day-1", "day-2"]);
    const legacy = syncFinalRouteForLegacyWriteV3(before, incoming);
    const direct = tryApplyLegacyDayReorderV3(before, incoming);

    expect(direct).not.toBeNull();
    expect(direct!.finalRoute.nodes).toEqual(legacy.finalRoute.nodes);
    expect(direct!.days).toEqual(legacy.days);
  });

  it("returns null when the same write also changes Day content", () => {
    const before = plan();
    const incoming = reordered(before, ["day-2", "day-1", "day-3"]);
    incoming.days[0].endAnchor.placeId = "a";
    expect(tryApplyLegacyDayReorderV3(before, incoming)).toBeNull();
  });
});