import { describe, expect, it } from "vitest";
import { emptyTravelPlan, TravelPlanDocumentSchema, type FinalRouteNode, type Transport } from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";
import { applyPlanCommands, assertCommandsWithinScope } from "./plan-commands-v2.js";

const place = (id: string) => ({
  id,
  nameZh: id.toUpperCase(),
  nameLocal: null,
  nameEn: null,
  kind: "attraction" as const,
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

const forgedTransport = (mode: Transport["mode"]): Transport => ({
  mode,
  durationMinutes: 987,
  note: "claimed fact",
  verification: { status: "verified", checkedAt: "2026-09-05T00:00:00Z" },
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

function routePlan() {
  const base = emptyTravelPlan();
  const plan = TravelPlanDocumentSchema.parse({
    ...base,
    trip: { ...base.trip, originPlaceId: "a" },
    places: [place("a"), place("x"), place("b"), place("c")],
    candidates: [
      { id: "cx", placeId: "x", planningAreaCandidateId: null, preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
    ],
    finalRoute: {
      version: 1,
      nodes: [
        node("x-node", "x", { transportFromPrevious: transport("drive") }),
        node("b-node", "b", { endsDay: true, transportFromPrevious: transport("walk") }),
        node("c-node", "c", { transportFromPrevious: transport("drive") }),
      ],
    },
  });
  return rebuildFinalRouteDaysV3(plan);
}

describe("final route PlanCommand integration", () => {
  it("formalizes one temporary Place/Candidate and its route node in one atomic batch", () => {
    const base = TravelPlanDocumentSchema.parse({
      ...emptyTravelPlan(),
      finalRoute: { version: 1, nodes: [] },
    });
    const applied = applyPlanCommands(base, [
      {
        type: "add_candidate",
        place: { ...place("temp-place"), nameZh: "陶波" },
        candidate: { id: "temp-candidate", placeId: "temp-place", planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      },
      {
        type: "add_final_route_node",
        index: 0,
        node: node("temp-route-node", "temp-place", { endsDay: true, transportFromPrevious: transport("drive") }),
      },
    ]);

    expect(applied.idMappings).toEqual(expect.objectContaining({
      "temp-place": expect.any(String),
      "temp-candidate": expect.any(String),
      "temp-route-node": expect.any(String),
    }));
    const routeNode = applied.plan.finalRoute.nodes[0];
    expect(routeNode.id).toBe(applied.idMappings["temp-route-node"]);
    expect(routeNode.placeId).toBe(applied.idMappings["temp-place"]);
    expect(applied.plan.days[0].id).toBe(routeNode.id);
    expect(applied.effects.routeDirtyDayIds).toContain(routeNode.id);
  });

  it("regenerates only the affected Day structure when a saved route node becomes inactive", () => {
    const before = routePlan();
    const applied = applyPlanCommands(before, [{ type: "set_final_route_status", nodeId: "b-node", status: "tentative" }]);

    expect(applied.plan.finalRoute.nodes.find((item) => item.id === "b-node")).toMatchObject({ status: "tentative", endsDay: true });
    expect(applied.plan.days).toHaveLength(1);
    expect(applied.plan.days[0]).toMatchObject({ id: "c-node", dayNumber: 1 });
    expect(applied.plan.days[0].startAnchor.placeId).toBe("a");
    expect(applied.plan.days[0].endAnchor.placeId).toBe("c");
    expect(new Set(applied.effects.changedDayIds)).toEqual(new Set(["b-node", "c-node"]));
    expect(applied.effects.routeDirtyDayIds).toContain("c-node");
  });

  it("removes a Candidate without deleting a Place still used by the final route", () => {
    const before = routePlan();
    expect(before.days[0].stops.find((stop) => stop.id === "x-node")?.candidateId).toBe("cx");

    const applied = applyPlanCommands(before, [{ type: "remove_candidate", candidateId: "cx" }]);

    expect(applied.plan.candidates.some((candidate) => candidate.id === "cx")).toBe(false);
    expect(applied.plan.places.some((item) => item.id === "x")).toBe(true);
    expect(applied.plan.finalRoute.nodes.some((item) => item.placeId === "x")).toBe(true);
    expect(applied.plan.days[0].stops.find((stop) => stop.id === "x-node")?.candidateId).toBeNull();
    expect(applied.effects.removedPlaceIds).not.toContain("x");
  });

  it("keeps caller-supplied transport duration, notes and verification facts out of finalRoute mutations", () => {
    const before = routePlan();
    const safeDrive = transport("drive");
    const changed = applyPlanCommands(before, [{
      type: "set_final_route_transport",
      nodeId: "c-node",
      transportFromPrevious: forgedTransport("drive"),
    }]);
    expect(changed.plan.finalRoute.nodes.find((item) => item.id === "c-node")?.transportFromPrevious).toEqual(safeDrive);

    const inserted = applyPlanCommands(before, [{
      type: "add_final_route_node",
      index: 1,
      node: node("temp-forged-node", "b", { transportFromPrevious: forgedTransport("walk") }),
    }]);
    const insertedId = inserted.idMappings["temp-forged-node"];
    expect(inserted.plan.finalRoute.nodes.find((item) => item.id === insertedId)?.transportFromPrevious).toEqual(transport("walk"));
  });

  it("keeps new route mutations out of narrow AI scopes until route-specific scopes exist", () => {
    const before = routePlan();
    expect(() => assertCommandsWithinScope(before, { type: "candidate_pool", id: null }, [
      { type: "move_final_route_node", nodeId: "c-node", targetIndex: 0 },
    ])).toThrow(/不能修改 Day/);
    expect(assertCommandsWithinScope(before, { type: "trip", id: null }, [
      { type: "move_final_route_node", nodeId: "c-node", targetIndex: 0 },
    ])).toHaveLength(1);
  });
});
