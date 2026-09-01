import { describe, expect, it } from "vitest";
import type { Place } from "./v2-types";
import { placeNamePresentation } from "./place-name-presentation";

const milfordSound: Place = {
  id: "milford-sound",
  nameZh: "米尔福德峡湾",
  nameLocal: "Piopiotahi",
  nameEn: "Milford Sound",
  kind: "attraction",
  city: "Milford Sound",
  region: "南地",
  country: "新西兰",
  countryCode: "NZ",
  approximate: true,
};

describe("place name presentation", () => {
  it("uses the configured Chinese, English, and bilingual presentation", () => {
    expect(placeNamePresentation(milfordSound, "zh")).toEqual({ primary: "米尔福德峡湾", secondary: null, combined: "米尔福德峡湾" });
    expect(placeNamePresentation(milfordSound, "en")).toEqual({ primary: "Milford Sound", secondary: null, combined: "Milford Sound" });
    expect(placeNamePresentation(milfordSound, "bilingual")).toEqual({ primary: "米尔福德峡湾", secondary: "Milford Sound", combined: "米尔福德峡湾 / Milford Sound" });
  });

  it("uses the local name only when an English name is unavailable", () => {
    const localOnly = { ...milfordSound, nameEn: null };
    expect(placeNamePresentation(localOnly, "en").combined).toBe("Piopiotahi");
    expect(placeNamePresentation(localOnly, "bilingual").secondary).toBe("Piopiotahi");
  });

  it("uses a supplied fallback when the Place is unavailable", () => {
    expect(placeNamePresentation(undefined, "bilingual", "出发 Anchor")).toEqual({ primary: "出发 Anchor", secondary: null, combined: "出发 Anchor" });
  });
});
