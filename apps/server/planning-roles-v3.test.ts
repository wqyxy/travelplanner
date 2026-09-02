import { describe, expect, it } from "vitest";
import type { Place, TripCandidate } from "./contracts-v2.js";
import {
  activeCoreVisits,
  activeDetailInterests,
  activePlanningAreas,
  effectivePlanningRole,
  planningAreaParent,
} from "./planning-roles-v3.js";
import { deriveMacroBasisStateV3, isMacroDirtyV3 } from "./planning-state-v3.js";

const place = (id: string, kind: Place["kind"]): Place => ({
  id,
  nameZh: id,
  nameLocal: null,
  nameEn: null,
  kind,
  city: kind === "city" ? id : "area",
  region: null,
  country: "Test",
  countryCode: "TT",
  approximate: false,
});

const candidate = (
  id: string,
  placeId: string,
  planningRole?: TripCandidate["planningRole"],
  planningAreaCandidateId: string | null = null,
  preference: TripCandidate["preference"] = "optional",
): TripCandidate => ({
  id,
  placeId,
  planningAreaCandidateId,
  ...(planningRole ? { planningRole } : {}),
  preference,
  source: "ai",
  aiReason: "test",
  aiScore: 80,
  suggestedDurationMinutes: 60,
  tags: [],
});

describe("planning roles v3", () => {
  it("derives legacy roles without rewriting candidates", () => {
    const areaPlace = place("p-area", "city");
    const detailPlace = place("p-detail", "attraction");
    const legacyArea = candidate("c-area", areaPlace.id);
    const legacyDetail = candidate("c-detail", detailPlace.id, undefined, legacyArea.id);

    expect(effectivePlanningRole(legacyArea, areaPlace)).toBe("planning_area");
    expect(effectivePlanningRole(legacyDetail, detailPlace)).toBe("detail_interest");
    expect(legacyArea).not.toHaveProperty("planningRole");
    expect(legacyDetail).not.toHaveProperty("planningRole");
  });

  it("honors explicit core visits and filters excluded candidates", () => {
    const places = [place("p-area", "city"), place("p-core", "attraction"), place("p-detail", "attraction")];
    const candidates = [
      candidate("c-area", "p-area", "planning_area"),
      candidate("c-core", "p-core", "core_visit", "c-area", "must_go"),
      candidate("c-detail", "p-detail", "detail_interest", "c-area", "excluded"),
    ];

    expect(activePlanningAreas({ places, candidates }).map((item) => item.id)).toEqual(["c-area"]);
    expect(activeCoreVisits({ places, candidates }).map((item) => item.id)).toEqual(["c-core"]);
    expect(activeDetailInterests({ places, candidates })).toEqual([]);
    expect(planningAreaParent(candidates[1], candidates)?.id).toBe("c-area");
  });

  it("derives macro basis state instead of persisting macroDirty", () => {
    expect(deriveMacroBasisStateV3(null, "current-fingerprint")).toBe("needs_confirmation");
    expect(deriveMacroBasisStateV3("same", "same")).toBe("current");
    expect(deriveMacroBasisStateV3("old", "new")).toBe("dirty");
    expect(isMacroDirtyV3("old", "new")).toBe(true);
    expect(isMacroDirtyV3(null, "new")).toBe(false);
  });
});
