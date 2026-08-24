import { describe, expect, it } from "vitest";
import { itineraryStageIndex, placeNameLines } from "./Itinerary";
import type { Place } from "./types";

const place: Place = {
  id: "batemans-bay",
  kind: "city",
  nameZh: "巴特曼斯贝",
  nameEn: "Batemans Bay",
  nameLocal: "Batemans Bay",
  city: "Batemans Bay", region: "New South Wales", country: "Australia", countryCode: "au", approximate: false,
};

describe("itinerary place language", () => {
  it("renders Chinese, English, and bilingual names without changing the source place", () => {
    expect(placeNameLines(place, "旧名称", "zh")).toEqual(["巴特曼斯贝"]);
    expect(placeNameLines(place, "旧名称", "en")).toEqual(["Batemans Bay"]);
    expect(placeNameLines(place, "旧名称", "bilingual")).toEqual(["巴特曼斯贝", "Batemans Bay"]);
  });

  it("falls back to the supplied name when translations are unavailable", () => {
    expect(placeNameLines(undefined, "清水寺", "en")).toEqual(["清水寺"]);
    expect(placeNameLines(undefined, "清水寺", "bilingual")).toEqual(["清水寺"]);
  });

  it("maps the canonical stage to the three-step rail", () => {
    expect(["planning", "draft", "detailed"].map((stage) => itineraryStageIndex(stage as "planning" | "draft" | "detailed"))).toEqual([0, 1, 2]);
  });
});
