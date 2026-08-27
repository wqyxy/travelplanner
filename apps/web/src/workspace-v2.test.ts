import { describe, expect, it } from "vitest";
import { candidateCounts, candidateRows, filterCandidateRows, formatDuration, selectedUnresolvedRows } from "./workspace-v2";
import type { Workspace } from "./v2-types";

function workspace(): Workspace {
  return {
    trip: {
      id: "t", title: "关西", state: "active", updatedAt: "2026-08-27T00:00:00Z", planLanguage: "bilingual", contentGeneration: 2,
      plan: {
        schemaVersion: 2, stage: "place_selection",
        trip: { title: "关西", originPlaceId: null, destinationPlaceIds: [], dates: { start: null, end: null, requestedDurationDays: 7 }, travelers: { summary: "家庭", adults: 2, children: 1 }, budget: { amount: null, currency: null, note: null }, pace: "轻松", themes: [], preferences: [], constraints: [], assumptions: [] },
        places: [
          { id: "p1", nameZh: "清水寺", nameLocal: null, nameEn: "Kiyomizu-dera", kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
          { id: "p2", nameZh: "铁道博物馆", nameLocal: null, nameEn: null, kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
        ],
        candidates: [
          { id: "c1", placeId: "p1", preference: "must_go", source: "ai", aiReason: "经典", aiScore: 92, suggestedDurationMinutes: 90, tags: ["寺院"] },
          { id: "c2", placeId: "p2", preference: "optional", source: "ai", aiReason: "亲子", aiScore: 96, suggestedDurationMinutes: 150, tags: ["亲子"] },
        ], days: [], warnings: [],
      },
    },
    resolutions: [{ tripId: "t", placeId: "p1", geoFingerprint: "g", status: "resolved", method: "provider_match", provider: "osm", providerPlaceId: "1", latitude: 1, longitude: 2, address: "京都", confidence: .9, resolvedAt: "2026-08-27T00:00:00Z", errorMessage: null }],
    routes: [], routeStates: [], proposals: [], messages: [], tasks: [], revisions: [],
  };
}

describe("candidate-first web helpers", () => {
  it("joins candidates with semantic places and resolutions", () => {
    const rows = candidateRows(workspace());
    expect(rows.map((row) => row.candidate.id)).toEqual(["c1", "c2"]);
    expect(rows[0].resolution?.status).toBe("resolved");
    expect(rows[1].resolution).toBeNull();
  });
  it("filters preference, unresolved state and search text", () => {
    const rows = candidateRows(workspace());
    expect(filterCandidateRows(rows, "must_go", "").map((row) => row.place.nameZh)).toEqual(["清水寺"]);
    expect(filterCandidateRows(rows, "unresolved", "亲子").map((row) => row.place.nameZh)).toEqual(["铁道博物馆"]);
  });
  it("counts selected and unresolved candidates", () => {
    const rows = candidateRows(workspace());
    expect(candidateCounts(rows)).toMatchObject({ all: 2, must_go: 1, optional: 1, selected: 2, unresolved: 1 });
    expect(selectedUnresolvedRows(rows).map((row) => row.candidate.id)).toEqual(["c2"]);
  });
  it("formats suggested durations", () => {
    expect(formatDuration(90)).toBe("1 小时 30 分钟");
    expect(formatDuration(1440)).toBe("1 天");
  });
});
