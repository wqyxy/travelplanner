import { describe, expect, it } from "vitest";
import { dayPlacesAreTerminal, nominatimSearchUrl, relevantMapCandidates } from "./map-service.js";
import type { Candidate } from "./contracts.js";

describe("map route readiness", () => {
  it("waits for AI decisions before routing", () => {
    expect(dayPlacesAreTerminal(["resolved", "ambiguous"])).toBe(false);
    expect(dayPlacesAreTerminal(["resolved", "unresolved"])).toBe(false);
  });

  it("allows partial routing after every place reaches a terminal state", () => {
    expect(dayPlacesAreTerminal(["resolved", "approximate", "unlocated"])).toBe(true);
  });
});

describe("country-safe geocoding", () => {
  const candidate = (countryCode: string, category = "place", placeType = "town"): Candidate => ({ providerPlaceId: `${countryCode}:1`, displayName: countryCode, latitude: 0, longitude: 0, category, placeType, countryCode, region: null, city: null, sourceUrl: "https://example.com", sourceType: "nominatim", evidenceUrl: null, confidence: "high", decisionNote: null });

  it("adds the hard ISO country filter and local-language address details", () => {
    const url = nominatimSearchUrl("Batemans Bay, New South Wales, Australia", "AU", "en-AU,en");
    expect(url.searchParams.get("countrycodes")).toBe("au");
    expect(url.searchParams.get("addressdetails")).toBe("1");
    expect(url.searchParams.get("accept-language")).toBe("en-AU,en");
  });

  it("rejects a unique foreign match before automatic selection", () => {
    const item = { countryCode: "au", name: "Batemans Bay", query: "Batemans Bay, New South Wales, Australia", kind: "city" as const, approximateLodgingArea: false };
    expect(relevantMapCandidates(item, [candidate("za")])).toEqual([]);
    expect(relevantMapCandidates(item, [candidate("za"), candidate("au")]).map((value) => value.countryCode)).toEqual(["au"]);
  });

  it("rejects a same-country road for an attraction while accepting a tourism feature", () => {
    const item = { countryCode: "au", name: "Sydney Opera House", query: "Sydney Opera House, Sydney, Australia", kind: "attraction" as const, approximateLodgingArea: false };
    expect(relevantMapCandidates(item, [candidate("au", "highway", "road")])).toEqual([]);
    expect(relevantMapCandidates(item, [candidate("au", "tourism", "attraction")])).toHaveLength(1);
  });
});
