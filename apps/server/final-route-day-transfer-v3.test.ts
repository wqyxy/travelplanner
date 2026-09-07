import { describe, expect, it } from "vitest";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type FinalRouteNode,
  type Place,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";
import { tryApplyLegacyDayTransferModesV3 } from "./final-route-day-transfer-v3.js";

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
    places: [place("origin"), place("a"), place("end")],
    finalRoute: {
      version: 1,
      nodes: [
        node("stop-a", "a", {
          transportFromPrevious: {
            mode: "transit",
            durationMinutes: 25,
            note: "旧 Provider 结果",
            verification: { status: "verified", checkedAt: "2026-09-07T00:00:00.000Z" },
          },
        }),
        node("day-end", "end", { endsDay: true }),
      ],
    },
  });
  return rebuildFinalRouteDaysV3(base);
}

describe("legacy Day transferMode -> canonical finalRoute", () => {
  it("writes the mode to the first active node and invalidates old Provider-like numbers", () => {
    const before = plan();
    const incoming = structuredClone(before);
    incoming.days[0].transferMode = "drive";

    const result = tryApplyLegacyDayTransferModesV3(before, incoming);
    expect(result).not.toBeNull();
    expect(result!.finalRoute.nodes.find((item) => item.id === "stop-a")?.transportFromPrevious).toEqual({
      mode: "drive",
      durationMinutes: null,
      note: null,
      verification: { status: "unverified", checkedAt: null },
    });
    expect(result!.days[0].transferMode).toBe("drive");
  });

  it("preserves unrelated canonical changes from the same incoming write", () => {
    const before = plan();
    const incoming = structuredClone(before);
    incoming.days[0].transferMode = "walk";
    incoming.candidates.push({
      id: "candidate-a",
      placeId: "a",
      planningAreaCandidateId: null,
      preference: "optional",
      source: "user",
      aiReason: null,
      aiScore: null,
      suggestedDurationMinutes: null,
      tags: [],
    });

    const result = tryApplyLegacyDayTransferModesV3(before, incoming);
    expect(result).not.toBeNull();
    expect(result!.candidates.some((item) => item.id === "candidate-a")).toBe(true);
    expect(result!.days[0].stops[0].candidateId).toBe("candidate-a");
  });

  it("returns null when another route structural field changes in the same Day edit", () => {
    const before = plan();
    const incoming = structuredClone(before);
    incoming.days[0].transferMode = "drive";
    incoming.days[0].endAnchor.placeId = "a";

    expect(tryApplyLegacyDayTransferModesV3(before, incoming)).toBeNull();
  });
});