import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
  type Transport,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import {
  addNightAfterFinalRouteNodeV3,
  deriveFinalRouteDaysV3,
  materializeLegacyFinalRouteV3,
  moveFinalRouteNodeV3,
  removeFinalRouteNodeV3,
  setFinalRouteDayBoundaryV3,
  setFinalRouteNodeStatusV3,
  syncFinalRouteForLegacyWriteV3,
  updateFinalRouteTransportV3,
} from "./final-route-v3.js";

const place = (id: string, nameZh = id): Place => ({
  id,
  nameZh,
  nameLocal: null,
  nameEn: null,
  kind: "city",
  city: null,
  region: null,
  country: "新西兰",
  countryCode: "NZ",
  approximate: false,
});

const transport = (mode: Transport["mode"]): Transport => ({
  mode,
  durationMinutes: null,
  note: null,
  verification: { status: "unverified", checkedAt: null },
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

function routePlan(nodes: FinalRouteNode[], originPlaceId = "a"): TravelPlanDocument {
  const base = emptyTravelPlan();
  const ids = new Set([originPlaceId, ...nodes.map((item) => item.placeId)]);
  return TravelPlanDocumentSchema.parse({
    ...base,
    trip: {
      ...base.trip,
      originPlaceId,
      dates: { start: "2026-10-01", end: null, requestedDurationDays: 8 },
    },
    places: [...ids].map((id) => place(id, id.toUpperCase())),
    finalRoute: { version: 1, nodes },
  });
}

describe("final route v3", () => {
  it("derives Day blocks mechanically from normal nodes and ignores tentative/no-go boundaries", () => {
    const plan = routePlan([
      node("x", "x", { status: "tentative", endsDay: true }),
      node("b", "b", { endsDay: true, transportFromPrevious: transport("drive") }),
      node("y", "y", { status: "no_go", endsDay: true }),
      node("c", "c", { transportFromPrevious: transport("walk") }),
    ]);

    const days = deriveFinalRouteDaysV3(plan);
    expect(days).toHaveLength(2);
    expect(days.map((day) => [day.startAnchor.placeId, day.endAnchor.placeId])).toEqual([["a", "b"], ["b", "c"]]);
    expect(days[0].endTransportFromPrevious?.mode).toBe("drive");
    expect(days[1].endTransportFromPrevious?.mode).toBe("walk");
  });

  it("temporarily disables a saved boundary when status becomes tentative and restores it in place", () => {
    const plan = routePlan([
      node("b", "b", { endsDay: true }),
      node("c", "c"),
    ]);
    expect(deriveFinalRouteDaysV3(plan)).toHaveLength(2);

    const tentative = setFinalRouteNodeStatusV3(plan, "b", "tentative").plan;
    expect(tentative.finalRoute.nodes.find((item) => item.id === "b")?.endsDay).toBe(true);
    expect(tentative.days).toHaveLength(1);
    expect(tentative.days[0].startAnchor.placeId).toBe("a");
    expect(tentative.days[0].endAnchor.placeId).toBe("c");

    const restored = setFinalRouteNodeStatusV3(tentative, "b", "normal").plan;
    expect(restored.days).toHaveLength(2);
    expect(restored.days[0].endAnchor.placeId).toBe("b");
  });

  it("uses the next active node's own transport when an intermediate node is skipped", () => {
    const plan = routePlan([
      node("x", "x", { transportFromPrevious: transport("drive") }),
      node("b", "b", { transportFromPrevious: transport("walk") }),
    ]);
    const skipped = setFinalRouteNodeStatusV3(plan, "x", "no_go").plan;
    expect(skipped.days).toHaveLength(1);
    expect(skipped.days[0].endAnchor.placeId).toBe("b");
    expect(skipped.days[0].endTransportFromPrevious?.mode).toBe("walk");
  });

  it("adds one empty same-place day for one more night without moving later places", () => {
    const plan = routePlan([
      node("b", "b", { endsDay: true }),
      node("c", "c"),
    ]);
    const result = addNightAfterFinalRouteNodeV3(plan, "b", "b-extra").plan;
    expect(result.finalRoute.nodes.map((item) => [item.id, item.placeId, item.endsDay])).toEqual([
      ["b", "b", true],
      ["b-extra", "b", true],
      ["c", "c", false],
    ]);
    expect(result.days.map((day) => [day.startAnchor.placeId, day.endAnchor.placeId])).toEqual([
      ["a", "b"],
      ["b", "b"],
      ["b", "c"],
    ]);
  });

  it("supports deterministic boundary, transport, move and remove edits", () => {
    const plan = routePlan([node("b", "b"), node("c", "c"), node("d", "d")]);
    const withBoundary = setFinalRouteDayBoundaryV3(plan, "c", true).plan;
    const withTransport = updateFinalRouteTransportV3(withBoundary, "d", transport("drive")).plan;
    const moved = moveFinalRouteNodeV3(withTransport, "d", 0).plan;
    const removed = removeFinalRouteNodeV3(moved, "b").plan;

    expect(removed.finalRoute.nodes.map((item) => item.id)).toEqual(["d", "c"]);
    expect(removed.finalRoute.nodes.find((item) => item.id === "d")?.transportFromPrevious?.mode).toBe("drive");
    expect(removed.finalRoute.nodes.find((item) => item.id === "c")?.endsDay).toBe(true);
  });

  it("rejects duplicate route node IDs and unknown Place references", () => {
    const base = routePlan([node("b", "b")]);
    expect(() => TravelPlanDocumentSchema.parse({
      ...base,
      finalRoute: { version: 1, nodes: [node("dup", "b"), node("dup", "b")] },
    })).toThrow(/最终线路节点 ID 不能重复/);
    expect(() => TravelPlanDocumentSchema.parse({
      ...base,
      finalRoute: { version: 1, nodes: [node("missing", "missing")] },
    })).toThrow(/最终线路引用未知 Place/);
  });

  it("promotes only the completely empty bootstrap plan to the current final-route version", () => {
    const promoted = materializeLegacyFinalRouteV3(emptyTravelPlan());
    expect(promoted.finalRoute).toEqual({ version: 1, nodes: [] });
  });

  it("rejects nonempty test data that still uses the old route shape instead of converting it", () => {
    const base = emptyTravelPlan();
    const oldPlan = TravelPlanDocumentSchema.parse({
      ...base,
      places: [place("old-place")],
      candidates: [{
        id: "old-candidate",
        placeId: "old-place",
        planningAreaCandidateId: null,
        preference: "want_to_go",
        source: "user",
        aiReason: null,
        aiScore: null,
        suggestedDurationMinutes: null,
        tags: [],
      }],
      finalRoute: { version: 0, nodes: [] },
    });
    expect(() => materializeLegacyFinalRouteV3(oldPlan)).toThrow(/OLD_TEST_PLAN_UNSUPPORTED/);
  });

  it("translates a transitional Day view into final-route nodes before persistence", () => {
    const before = routePlan([], "a");
    const after = TravelPlanDocumentSchema.parse({
      ...before,
      places: [...before.places, place("b"), place("c")],
      days: [
        {
          id: "day-b", dayNumber: 1, date: null, title: "B", stayBlockId: "stay-b", transferMode: "drive", detailLevel: "planned", detailStatus: null,
          startAnchor: { id: "start-b", placeId: "a", label: null, notes: null }, stops: [], endAnchor: { id: "end-b", placeId: "b", label: null, notes: null },
        },
        {
          id: "day-c", dayNumber: 2, date: null, title: "C", transferMode: "rail", detailLevel: "planned", detailStatus: null,
          startAnchor: { id: "start-c", placeId: "b", label: null, notes: null }, stops: [], endAnchor: { id: "end-c", placeId: "c", label: null, notes: null },
        },
      ],
    });

    const saved = syncFinalRouteForLegacyWriteV3(before, after);
    expect(saved.finalRoute.nodes.map((item) => [item.id, item.placeId, item.endsDay, item.transportFromPrevious?.mode ?? null])).toEqual([
      ["day-b", "b", true, "drive"],
      ["day-c", "c", false, "rail"],
    ]);
    expect(saved.days.map((day) => [day.id, day.startAnchor.placeId, day.endAnchor.placeId, day.stayBlockId ?? null, day.transferMode])).toEqual([
      ["day-b", "a", "b", "stay-b", "drive"],
      ["day-c", "b", "c", null, "rail"],
    ]);
  });

  it("preserves inactive nodes while a transitional Day edit changes active detail", () => {
    const beforeBase = routePlan([
      node("x", "x", { status: "tentative", endsDay: true }),
      node("detail", "b", { activity: "B", period: "morning" }),
      node("end", "c"),
    ]);
    const before = TravelPlanDocumentSchema.parse({ ...beforeBase, days: deriveFinalRouteDaysV3(beforeBase) });
    const after = structuredClone(before);
    after.days[0].stops[0].activity = "Updated B";
    after.days[0].stops[0].startTime = "09:00";

    const saved = syncFinalRouteForLegacyWriteV3(before, after);
    expect(saved.finalRoute.nodes.find((item) => item.id === "x")).toMatchObject({ status: "tentative", endsDay: true });
    expect(saved.finalRoute.nodes.find((item) => item.id === "detail")).toMatchObject({ activity: "Updated B", startTime: "09:00" });
    expect(saved.days[0].stops[0]).toMatchObject({ id: "detail", activity: "Updated B", startTime: "09:00" });
  });

  it("keeps a Day start location and explicit detail when the trip origin is not set", () => {
    const base = TravelPlanDocumentSchema.parse({
      ...emptyTravelPlan(),
      places: [place("city"), place("poi")],
      finalRoute: { version: 1, nodes: [] },
    });
    const after = TravelPlanDocumentSchema.parse({
      ...base,
      days: [{
        id: "day-city", dayNumber: 1, date: null, title: "City", transferMode: "none", detailLevel: "planned", detailStatus: null,
        startAnchor: { id: "start-city", placeId: "city", label: "City", notes: null },
        stops: [{
          id: "poi-stop", candidateId: null, placeId: "poi", activity: "Visit", period: "morning", startTime: "09:00", endTime: null,
          durationMinutes: 60, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null,
        }],
        endAnchor: { id: "end-city", placeId: "city", label: "City", notes: null },
      }],
    });

    const saved = syncFinalRouteForLegacyWriteV3(base, after);
    expect(saved.finalRoute.nodes.map((item) => item.placeId)).toEqual(["city", "poi", "city"]);
    expect(saved.days[0].startAnchor.placeId).toBe("city");
    expect(saved.days[0].endAnchor.placeId).toBe("city");
    expect(saved.days[0].detailLevel).toBe("detailed");
    expect(saved.days[0].detailStatus).toBe("ready");
    expect(saved.days[0].stops[0]).toMatchObject({ id: "poi-stop", activity: "Visit", period: "morning", startTime: "09:00" });
  });
});