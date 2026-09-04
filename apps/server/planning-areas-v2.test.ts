import { describe, expect, it } from "vitest";
import { buildPlanningAreaContext, buildPlanningCoverage, fulfilledMacroCityCandidateIds } from "./planning-areas-v2.js";

const place = (id: string, nameZh: string, kind: string, city: string | null) => ({
  id,
  nameZh,
  nameLocal: null,
  nameEn: null,
  kind,
  city,
  region: null,
  country: "新西兰",
  countryCode: "NZ",
});

const candidate = (id: string, placeId: string, preference: "must_go" | "want_to_go" | "optional" | "excluded", planningAreaCandidateId: string | null = null) => ({ id, placeId, planningAreaCandidateId, preference });

describe("planning areas", () => {
  it("groups concrete attractions under a matching city candidate", () => {
    const context = buildPlanningAreaContext({
      places: [
        place("queenstown", "皇后镇", "city", "Queenstown"),
        place("skyline", "天空缆车", "attraction", "Queenstown"),
        place("gardens", "皇后镇花园", "attraction", "Queenstown"),
      ],
      candidates: [
        candidate("city-c", "queenstown", "must_go"),
        candidate("skyline-c", "skyline", "optional", "city-c"),
        candidate("gardens-c", "gardens", "optional", "city-c"),
      ],
    });
    expect(context.areas).toHaveLength(1);
    expect(context.areas[0]).toMatchObject({ cityCandidateId: "city-c", effectivePreference: "must_go" });
    expect(context.areas[0].childCandidateIds).toEqual(expect.arrayContaining(["skyline-c", "gardens-c"]));
    expect(fulfilledMacroCityCandidateIds(context, new Set(["skyline-c"])).has("city-c")).toBe(true);
  });

  it("does not suppress a Planning Area's children when that area is excluded", () => {
    const context = buildPlanningAreaContext({
      places: [place("dunedin", "但尼丁", "city", "Dunedin"), place("station", "但尼丁火车站", "attraction", "Dunedin")],
      candidates: [candidate("city-c", "dunedin", "excluded"), candidate("station-c", "station", "optional", "city-c")],
    });
    expect(context.participatingCandidateIds).toEqual(new Set(["station-c"]));
    expect(context.suppressedCandidateIds).toEqual(new Set(["city-c"]));
    expect(context.conflicts).toEqual([]);
  });

  it("reports a conflict when an excluded city contains a must-go child", () => {
    const context = buildPlanningAreaContext({
      places: [place("dunedin", "但尼丁", "city", "Dunedin"), place("station", "但尼丁火车站", "attraction", "Dunedin")],
      candidates: [candidate("city-c", "dunedin", "excluded"), candidate("station-c", "station", "must_go", "city-c")],
    });
    expect(context.conflicts).toHaveLength(1);
    expect(context.conflicts[0]).toContain("但尼丁火车站");
  });

  it("uses explicit Macro relation even when Micro city text does not match", () => {
    const plan = {
      places: [
        place("franz", "弗朗茨·约瑟夫冰川地区", "city", "Franz Josef"),
        { ...place("glacier", "Franz Josef Glacier Walk", "attraction", "Westland"), region: "West Coast" },
      ],
      candidates: [
        candidate("franz-c", "franz", "must_go"),
        candidate("glacier-c", "glacier", "optional", "franz-c"),
      ],
    };
    const context = buildPlanningAreaContext(plan);
    expect(context.areas).toHaveLength(1);
    expect(context.areas[0].cityCandidateId).toBe("franz-c");
    expect(context.areas[0].childCandidateIds).toEqual(["glacier-c"]);
    expect(buildPlanningCoverage(plan, new Set(["glacier"]))[0]).toMatchObject({
      macroCandidateId: "franz-c",
      participatingResolvedMicroCount: 1,
      status: "ready",
    });
  });

});
