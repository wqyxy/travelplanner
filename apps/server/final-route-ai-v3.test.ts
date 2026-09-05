import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
  type TravelPlanDocument,
  type TripCandidate,
} from "./contracts-v2.js";
import type { DestinationGenerateOutput } from "./ai-action-contracts-v3.js";
import {
  applyMainRouteGenerationFromOutputV3,
  finalRouteMoveCommandsForOrderedSubsetV3,
  finalRouteTargetNodeIdsForOptimizationV3,
  insertNewDetailCandidatesFromPlanV3,
} from "./final-route-ai-v3.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";
import { applyPlanCommands } from "./plan-commands-v2.js";

const place = (id: string, name = id.toUpperCase()): Place => ({
  id,
  nameZh: name,
  nameLocal: null,
  nameEn: null,
  kind: "attraction",
  city: null,
  region: null,
  country: "新西兰",
  countryCode: "NZ",
  approximate: false,
});

const candidate = (id: string, placeId: string, planningRole: "planning_area" | "core_visit" | "detail_interest", parent: string | null = null): TripCandidate => ({
  id,
  placeId,
  planningAreaCandidateId: parent,
  planningRole,
  preference: "optional",
  source: "ai",
  aiReason: "test",
  aiScore: 80,
  suggestedDurationMinutes: null,
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

function plan(input: { places: Place[]; candidates?: TripCandidate[]; nodes?: FinalRouteNode[] }): TravelPlanDocument {
  const base = emptyTravelPlan();
  return rebuildFinalRouteDaysV3(TravelPlanDocumentSchema.parse({
    ...base,
    places: input.places,
    candidates: input.candidates ?? [],
    finalRoute: { version: 1, nodes: input.nodes ?? [] },
  }));
}

function mainOutput(): DestinationGenerateOutput {
  return {
    schemaVersion: 2,
    baseGeneration: 0,
    assistantMessage: "主要地点",
    places: [
      { ...place("tmp-a", "A"), id: "tmp-a" },
      { ...place("tmp-b", "B"), id: "tmp-b" },
    ],
    candidates: [
      {
        temporaryId: "candidate-b",
        placeTemporaryId: "tmp-b",
        planningRole: "planning_area",
        parentCandidateRef: null,
        aiReason: "先去 B",
        aiScore: 90,
        suggestedDurationMinutes: null,
        tags: [],
        defaultPreference: "optional",
        routeSuggestion: { endsDay: true, transportMode: "drive" },
      },
      {
        temporaryId: "candidate-a",
        placeTemporaryId: "tmp-a",
        planningRole: "core_visit",
        parentCandidateRef: null,
        aiReason: "再去 A",
        aiScore: 80,
        suggestedDurationMinutes: null,
        tags: [],
        defaultPreference: "optional",
        routeSuggestion: { endsDay: false, transportMode: "none" },
      },
    ],
  };
}

describe("final route AI write permissions", () => {
  it("turns first main-place generation directly into final-route nodes in AI order", () => {
    const before = plan({ places: [] });
    const discovered = plan({
      places: [place("formal-a", "A"), place("formal-b", "B")],
      candidates: [candidate("formal-a-candidate", "formal-a", "core_visit"), candidate("formal-b-candidate", "formal-b", "planning_area")],
    });

    const result = applyMainRouteGenerationFromOutputV3(before, discovered, mainOutput());
    expect(result.finalRoute.nodes.map((item) => result.places.find((value) => value.id === item.placeId)?.nameZh)).toEqual(["B", "A"]);
    expect(result.finalRoute.nodes[0]).toMatchObject({ endsDay: true, transportFromPrevious: { mode: "drive", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } } });
    expect(result.finalRoute.nodes[1]).toMatchObject({ endsDay: false, transportFromPrevious: null });
    expect(result.days.length).toBeGreaterThan(0);
  });

  it("refuses ordinary main generation when the user already has a final route", () => {
    const before = plan({ places: [place("existing")], nodes: [node("existing-node", "existing")] });
    const discovered = plan({ places: [place("formal-a", "A"), place("formal-b", "B")], candidates: [candidate("ca", "formal-a", "core_visit"), candidate("cb", "formal-b", "planning_area")] });
    expect(() => applyMainRouteGenerationFromOutputV3(before, discovered, mainOutput())).toThrow(/FINAL_ROUTE_MAIN_GENERATION_REQUIRES_EMPTY_ROUTE/);
  });

  it("inserts new detailed places without changing any existing route node", () => {
    const parent = candidate("parent", "area", "planning_area");
    const before = plan({
      places: [place("area"), place("x"), place("b")],
      candidates: [parent],
      nodes: [
        node("area-node", "area", { endsDay: true, transportFromPrevious: { mode: "drive", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } } }),
        node("x-node", "x", { status: "tentative", endsDay: true }),
        node("b-node", "b"),
      ],
    });
    const discovered = TravelPlanDocumentSchema.parse({
      ...before,
      places: [...before.places, place("detail-1"), place("detail-2")],
      candidates: [...before.candidates, candidate("detail-c1", "detail-1", "detail_interest", "parent"), candidate("detail-c2", "detail-2", "detail_interest", "parent")],
    });

    const result = insertNewDetailCandidatesFromPlanV3({ before, discoveredPlan: discovered, scopeRequest: "final-route-detail-scope:trip" });
    const oldIds = new Set(before.finalRoute.nodes.map((item) => item.id));
    expect(result.finalRoute.nodes.filter((item) => oldIds.has(item.id))).toEqual(before.finalRoute.nodes);
    expect(result.finalRoute.nodes.map((item) => item.placeId)).toEqual(["detail-1", "detail-2", "area", "x", "b"]);
    expect(result.finalRoute.nodes.find((item) => item.id === "x-node")).toMatchObject({ status: "tentative", endsDay: true });
  });

  it("puts Day-scoped details after an existing start boundary instead of into the previous day", () => {
    const before = plan({
      places: [place("area"), place("end")],
      candidates: [candidate("parent", "area", "planning_area")],
      nodes: [node("area-node", "area", { endsDay: true }), node("end-node", "end")],
    });
    const day2 = before.days[1];
    const discovered = TravelPlanDocumentSchema.parse({
      ...before,
      places: [...before.places, place("detail")],
      candidates: [...before.candidates, candidate("detail-c", "detail", "detail_interest", "parent")],
    });
    const result = insertNewDetailCandidatesFromPlanV3({ before, discoveredPlan: discovered, scopeRequest: `final-route-detail-scope:day:${day2.id}` });
    expect(result.finalRoute.nodes.map((item) => item.placeId)).toEqual(["area", "detail", "end"]);
    expect(result.days[0].endAnchor.placeId).toBe("area");
    expect(result.days[1].stops.map((stop) => stop.placeId)).toContain("detail");
  });

  it("optimizes only authorized normal nodes while inactive nodes keep their exact slots", () => {
    const before = plan({
      places: [place("a"), place("x"), place("b"), place("c")],
      nodes: [node("a-node", "a"), node("x-node", "x", { status: "no_go", endsDay: true }), node("b-node", "b"), node("c-node", "c")],
    });
    const allowed = finalRouteTargetNodeIdsForOptimizationV3(before, { optimizeScope: "segment", fromNodeId: "a-node", toNodeId: "c-node" });
    expect(allowed).toEqual(["a-node", "b-node", "c-node"]);
    const commands = finalRouteMoveCommandsForOrderedSubsetV3(before, allowed, ["c-node", "b-node", "a-node"]);
    expect(commands.every((command) => command.type === "move_final_route_node" && command.nodeId !== "x-node")).toBe(true);
    const applied = applyPlanCommands(before, commands).plan;
    expect(applied.finalRoute.nodes.map((item) => item.id)).toEqual(["c-node", "x-node", "b-node", "a-node"]);
    expect(applied.finalRoute.nodes[1]).toEqual(before.finalRoute.nodes[1]);
  });

  it("rejects optimization output that adds, drops or duplicates authorized IDs", () => {
    const before = plan({ places: [place("a"), place("b")], nodes: [node("a-node", "a"), node("b-node", "b")] });
    expect(() => finalRouteMoveCommandsForOrderedSubsetV3(before, ["a-node", "b-node"], ["a-node"])).toThrow(/FINAL_ROUTE_OPTIMIZE_SCOPE_VIOLATION/);
    expect(() => finalRouteMoveCommandsForOrderedSubsetV3(before, ["a-node", "b-node"], ["a-node", "a-node"])).toThrow(/FINAL_ROUTE_OPTIMIZE_SCOPE_VIOLATION/);
    expect(() => finalRouteMoveCommandsForOrderedSubsetV3(before, ["a-node", "b-node"], ["a-node", "unknown"])).toThrow(/FINAL_ROUTE_OPTIMIZE_SCOPE_VIOLATION/);
  });
});
