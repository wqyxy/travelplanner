import { describe, expect, it } from "vitest";
import { placeNameLines } from "./Itinerary";
import type { PlaceDefinition } from "./types";

const place: PlaceDefinition = {
  id: "batemans-bay",
  kind: "city",
  nameZh: "巴特曼斯贝",
  nameEn: "Batemans Bay",
  nameLocal: "Batemans Bay",
  localLanguage: "en-AU",
  approximate: false,
  geocoding: { name: "Batemans Bay", city: "Batemans Bay", region: "New South Wales", country: "Australia", countryCode: "au" },
};

describe("itinerary place language", () => {
  it("renders Chinese, English, and bilingual names without changing the source place", () => {
    expect(placeNameLines(place, "旧名称", "zh")).toEqual(["巴特曼斯贝"]);
    expect(placeNameLines(place, "旧名称", "en")).toEqual(["Batemans Bay"]);
    expect(placeNameLines(place, "旧名称", "bilingual")).toEqual(["巴特曼斯贝", "Batemans Bay"]);
  });

  it("falls back to the legacy Chinese name when translations are unavailable", () => {
    expect(placeNameLines(undefined, "清水寺", "en")).toEqual(["清水寺"]);
    expect(placeNameLines(undefined, "清水寺", "bilingual")).toEqual(["清水寺"]);
  });
});
