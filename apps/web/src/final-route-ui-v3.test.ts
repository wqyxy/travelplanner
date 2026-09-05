import { describe, expect, it } from "vitest";
import { emptyTravelPlan } from "../../server/contracts-v2.js";
import type { FinalRouteNode, TravelPlanDocument } from "./v2-types";
import { finalRouteDayCountV3, finalRouteDisplayRowsV3, newFinalRoutePlaceCommandsV3, transportFromModeV3 } from "./final-route-ui-v3";

const node = (id: string, status: FinalRouteNode["status"], endsDay = false): FinalRouteNode => ({
  id,
  placeId: `place-${id}`,
  status,
  endsDay,
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
});

function plan(nodes: FinalRouteNode[]) {
  const base = emptyTravelPlan() as unknown as TravelPlanDocument;
  return {
    ...base,
    finalRoute: { version: 1 as const, nodes },
    places: nodes.map((item) => ({
      id: item.placeId,
      nameZh: item.id.toUpperCase(),
      nameLocal: null,
      nameEn: null,
      kind: "attraction" as const,
      city: null,
      region: null,
      country: null,
      countryCode: null,
      approximate: false,
    })),
  } satisfies TravelPlanDocument;
}

describe("final route UI helpers", () => {
  it("assigns display Day numbers only from active boundaries", () => {
    const source = plan([
      node("a", "normal"),
      node("x", "tentative", true),
      node("b", "normal", true),
      node("y", "no_go", true),
      node("c", "normal"),
    ]);
    expect(finalRouteDisplayRowsV3(source).map((row) => [row.node.id, row.dayNumber])).toEqual([
      ["a", 1],
      ["x", 1],
      ["b", 1],
      ["y", 2],
      ["c", 2],
    ]);
    expect(finalRouteDayCountV3(source)).toBe(2);
  });

  it("creates one batch that adds the Place/Candidate and its route occurrence", () => {
    const commands = newFinalRoutePlaceCommandsV3({
      index: 2,
      temporaryPlaceId: "tmp-place",
      temporaryCandidateId: "tmp-candidate",
      temporaryNodeId: "tmp-node",
      nameZh: "Hobbiton",
      kind: "attraction",
    });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ type: "add_candidate", place: { id: "tmp-place", nameZh: "Hobbiton" }, candidate: { id: "tmp-candidate", placeId: "tmp-place", planningRole: "detail_interest" } });
    expect(commands[1]).toMatchObject({ type: "add_final_route_node", index: 2, node: { id: "tmp-node", placeId: "tmp-place", status: "normal", endsDay: false } });
  });

  it("builds arrival transport without inventing provider facts", () => {
    expect(transportFromModeV3("drive")).toEqual({
      mode: "drive",
      durationMinutes: null,
      note: null,
      verification: { status: "unverified", checkedAt: null },
    });
    expect(transportFromModeV3("")).toBeNull();
    expect(transportFromModeV3("none")).toBeNull();
  });
});
