import { describe, expect, it } from "vitest";
import { skeletonDayBalanceV3, skeletonUiModelV3 } from "./skeleton-ui-v3";
import type { Workspace } from "./v2-types";

function workspace(): Workspace {
  return {
    trip: {
      id: "trip", title: "环线", state: "active", updatedAt: "2026-09-02T00:00:00Z", planLanguage: "zh", contentGeneration: 2,
      plan: {
        schemaVersion: 2, stage: "itinerary_planning",
        trip: { title: "环线", originPlaceId: "p-a", destinationPlaceIds: [], dates: { start: null, end: null, requestedDurationDays: 20 }, travelers: { summary: "", adults: null, children: null }, budget: { amount: null, currency: null, note: null }, pace: null, themes: [], preferences: [], constraints: [], assumptions: [], brief: { destination: "新西兰", origin: "", departureTime: "", duration: "20天", travelers: "", transport: "自驾", additionalRequirements: "" } },
        places: [
          { id: "p-a", nameZh: "奥克兰", nameLocal: null, nameEn: "Auckland", kind: "city", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
          { id: "p-b", nameZh: "罗托鲁瓦", nameLocal: null, nameEn: "Rotorua", kind: "city", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
          { id: "p-c", nameZh: "陶波", nameLocal: null, nameEn: "Taupo", kind: "city", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
        ],
        candidates: [
          { id: "area-a", placeId: "p-a", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
          { id: "area-b", placeId: "p-b", planningAreaCandidateId: null, planningRole: "planning_area", preference: "want_to_go", source: "ai", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
          { id: "area-c", placeId: "p-c", planningAreaCandidateId: null, planningRole: "planning_area", preference: "optional", source: "ai", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
        ],
        days: [
          { id: "d1", stayBlockId: "block-a-1", dayNumber: 1, date: null, title: "奥克兰", transferMode: "none", detailLevel: "planned", detailStatus: null, startAnchor: { id: "s1", placeId: "p-a", label: null, notes: null }, stops: [], endAnchor: { id: "e1", placeId: "p-a", label: null, notes: null } },
          { id: "d2", stayBlockId: "block-b", dayNumber: 2, date: null, title: "前往罗托鲁瓦", transferMode: "drive", detailLevel: "planned", detailStatus: null, startAnchor: { id: "s2", placeId: "p-a", label: null, notes: null }, stops: [], endAnchor: { id: "e2", placeId: "p-b", label: null, notes: null } },
          { id: "d3", stayBlockId: "block-b", dayNumber: 3, date: null, title: "罗托鲁瓦", transferMode: "none", detailLevel: "planned", detailStatus: null, startAnchor: { id: "s3", placeId: "p-b", label: null, notes: null }, stops: [], endAnchor: { id: "e3", placeId: "p-b", label: null, notes: null } },
          { id: "d4", stayBlockId: "block-a-2", dayNumber: 4, date: null, title: "返回奥克兰", transferMode: "drive", detailLevel: "planned", detailStatus: null, startAnchor: { id: "s4", placeId: "p-b", label: null, notes: null }, stops: [], endAnchor: { id: "e4", placeId: "p-a", label: null, notes: null } },
        ] as any,
        planningState: { macroBasisVersion: 1, macroBasisFingerprint: "x" }, warnings: [],
      },
    },
    resolutions: [
      { tripId: "trip", placeId: "p-a", geoFingerprint: "a", status: "resolved", method: "provider_match", provider: "osm", providerPlaceId: "a", latitude: 1, longitude: 1, address: null, confidence: 1, resolvedAt: "2026-09-02T00:00:00Z", errorMessage: null },
      { tripId: "trip", placeId: "p-b", geoFingerprint: "b", status: "resolved", method: "provider_match", provider: "osm", providerPlaceId: "b", latitude: 2, longitude: 2, address: null, confidence: 1, resolvedAt: "2026-09-02T00:00:00Z", errorMessage: null },
    ],
    routes: [], routeStates: [], proposals: [], messages: [], tasks: [], revisions: [], coverage: [],
  };
}

describe("Phase 6 skeleton UI", () => {
  it("keeps two Auckland stay blocks independently visible in a ring trip", () => {
    const model = skeletonUiModelV3(workspace());
    expect(model.blocks.map((block) => [block.placeName, block.key, block.firstDayNumber, block.lastDayNumber])).toEqual([
      ["奥克兰", "block:block-a-1", 1, 1],
      ["罗托鲁瓦", "block:block-b", 2, 3],
      ["奥克兰", "block:block-a-2", 4, 4],
    ]);
    expect(model.omitted.map((item) => item.placeName)).toEqual(["陶波"]);
  });

  it("uses natural day-balance language rather than engineering draft terms", () => {
    const source = workspace().trip.plan;
    expect(skeletonDayBalanceV3(source, { stays: [{ planningAreaCandidateId: "area-a", stayDays: 19, transferModeFromPrevious: "none" }], omittedPlanningAreas: [] }).message).toBe("还剩 1 天需要安排");
    const overAllocated = skeletonDayBalanceV3(source, { stays: [{ planningAreaCandidateId: "area-a", stayDays: 21, transferModeFromPrevious: "none" }], omittedPlanningAreas: [] });
    expect(overAllocated.message).toBe("当前安排多 1 天；可以继续，之后再调整。");
    expect(overAllocated.canSave).toBe(true);
    expect(skeletonDayBalanceV3(source, { stays: [{ planningAreaCandidateId: "area-a", stayDays: 20, transferModeFromPrevious: "none" }], omittedPlanningAreas: [] }).canSave).toBe(true);
  });
});
