import { describe, expect, it } from "vitest";
import { convertItineraryV1ToPlanV2, convertResolvedPlaceV1 } from "./migration-v2.js";

const verification = { status: "unverified" as const, checkedAt: null };
const place = (id: string) => ({ id, nameZh: id, nameLocal: null, nameEn: null, kind: "attraction" as const, city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false });

const legacy = {
  schemaVersion: 1 as const,
  stage: "detailed" as const,
  trip: {
    title: "关西", originPlaceId: "osaka", destinationPlaceIds: ["kyoto"],
    dates: { start: null, end: null, requestedDurationDays: 1 },
    travelers: { summary: "两人", adults: 2, children: 0 },
    budget: { amount: null, currency: null, note: null },
    pace: "轻松", themes: [], preferences: [], constraints: [], assumptions: [],
  },
  places: [place("osaka"), place("kiyomizu"), place("kyoto")],
  days: [{
    id: "d1", dayNumber: 1, date: null, title: "大阪到京都", detailLevel: "detailed" as const, detailStatus: "ready" as const,
    stops: [
      { id: "start", role: "start" as const, placeId: "osaka", activity: "大阪酒店", period: "morning" as const, startTime: "08:00", endTime: "08:30", durationMinutes: 30, scheduleVerification: verification, transportFromPrevious: null, costNote: null, costVerification: null, notes: null },
      { id: "visit", role: "visit" as const, placeId: "kiyomizu", activity: "清水寺", period: "afternoon" as const, startTime: "13:00", endTime: "14:30", durationMinutes: 90, scheduleVerification: verification, transportFromPrevious: { mode: "rail" as const, durationMinutes: 120, note: null, verification }, costNote: null, costVerification: null, notes: null },
      { id: "end", role: "end" as const, placeId: "kyoto", activity: "京都酒店", period: "evening" as const, startTime: "18:00", endTime: "18:30", durationMinutes: 30, scheduleVerification: verification, transportFromPrevious: { mode: "transit" as const, durationMinutes: 30, note: null, verification }, costNote: null, costVerification: null, notes: null },
    ],
  }],
  warnings: [],
};

describe("v1 to v2 pure converter", () => {
  it("maps stages, anchors and intermediate Stops deterministically", () => {
    const first = convertItineraryV1ToPlanV2(legacy);
    const second = convertItineraryV1ToPlanV2(legacy);
    expect(first.document).toEqual(second.document);
    expect(first.document.stage).toBe("itinerary_refinement");
    expect(first.document.days[0]).toMatchObject({
      detailLevel: "detailed",
      startAnchor: { placeId: "osaka" },
      endAnchor: { placeId: "kyoto" },
      stops: [{ id: "visit", placeId: "kiyomizu" }],
    });
    expect(first.document.candidates).toEqual([expect.objectContaining({ placeId: "kiyomizu", preference: "want_to_go", source: "migration" })]);
  });

  it("does not treat migrated Candidates as must_go", () => {
    expect(convertItineraryV1ToPlanV2(legacy).document.candidates[0].preference).toBe("want_to_go");
  });

  it("downgrades old AI researched coordinates", () => {
    const resolution = convertResolvedPlaceV1("trip", { placeId: "p", geoFingerprint: "v5|p", provider: "ai-web+nominatim", providerPlaceId: "1", lat: 35, lng: 135, resolution: "researched", confidence: .7, resolvedAt: new Date().toISOString() });
    expect(resolution).toMatchObject({ status: "unresolved", latitude: null, longitude: null });
  });

  it("preserves trusted provider coordinates", () => {
    const resolution = convertResolvedPlaceV1("trip", { placeId: "p", geoFingerprint: "v5|p", provider: "nominatim", providerPlaceId: "1", lat: 35, lng: 135, resolution: "exact", confidence: .9, resolvedAt: new Date().toISOString() });
    expect(resolution).toMatchObject({ status: "resolved", latitude: 35, longitude: 135, provider: "nominatim" });
  });
});
