import { describe, expect, it } from "vitest";
import { candidateCounts, candidateRows, filterCandidateRows, formatDuration, selectedUnresolvedRows, step4CoreRows, step4DetailRows } from "./workspace-v2";
import type { Workspace } from "./v2-types";

function workspace(): Workspace {
  return {
    trip: {
      id: "t", title: "关西", state: "active", updatedAt: "2026-08-27T00:00:00Z", planLanguage: "bilingual", contentGeneration: 2,
      plan: {
        schemaVersion: 2, stage: "place_selection",
        trip: { title: "关西", brief: { destination: "关西", origin: "", departureTime: "", duration: "7 天", travelers: "家庭", transport: "", additionalRequirements: "" }, originPlaceId: null, destinationPlaceIds: [], dates: { start: null, end: null, requestedDurationDays: 7 }, travelers: { summary: "家庭", adults: 2, children: 1 }, budget: { amount: null, currency: null, note: null }, pace: "轻松", themes: [], preferences: [], constraints: [], assumptions: [] },
        places: [
          { id: "p0", nameZh: "京都", nameLocal: null, nameEn: "Kyoto", kind: "city", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
          { id: "p1", nameZh: "清水寺", nameLocal: null, nameEn: "Kiyomizu-dera", kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
          { id: "p2", nameZh: "铁道博物馆", nameLocal: null, nameEn: null, kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
          { id: "p3", nameZh: "岚山", nameLocal: null, nameEn: "Arashiyama", kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
        ],
        candidates: [
          { id: "area", placeId: "p0", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "ai", aiReason: "停留区域", aiScore: 90, suggestedDurationMinutes: null, tags: [] },
          { id: "c1", placeId: "p1", planningAreaCandidateId: "area", planningRole: "detail_interest", preference: "must_go", source: "ai", aiReason: "经典", aiScore: 92, suggestedDurationMinutes: 90, tags: ["寺院"] },
          { id: "c2", placeId: "p2", planningAreaCandidateId: "area", preference: "optional", source: "ai", aiReason: "亲子", aiScore: 96, suggestedDurationMinutes: 150, tags: ["亲子"] },
          { id: "core", placeId: "p3", planningAreaCandidateId: "area", planningRole: "core_visit", preference: "want_to_go", source: "ai", aiReason: "重要游览地", aiScore: 98, suggestedDurationMinutes: 240, tags: ["重要"] },
        ], days: [], warnings: [],
      },
    },
    resolutions: [{ tripId: "t", placeId: "p1", geoFingerprint: "g", status: "resolved", method: "provider_match", provider: "osm", providerPlaceId: "1", latitude: 1, longitude: 2, address: "京都", confidence: .9, resolvedAt: "2026-08-27T00:00:00Z", errorMessage: null }],
    routes: [], routeStates: [], proposals: [], messages: [], tasks: [], revisions: [], coverage: [],
  };
}

describe("candidate-first web helpers", () => {
  it("joins candidates with semantic places and resolutions", () => {
    const rows = candidateRows(workspace());
    expect(rows.map((row) => row.candidate.id)).toEqual(["c1", "area", "core", "c2"]);
    expect(rows.find((row) => row.candidate.id === "c1")?.resolution?.status).toBe("resolved");
    expect(rows.find((row) => row.candidate.id === "c2")?.resolution).toBeNull();
  });
  it("separates Step 4 editable Detail Interests from read-only Core Visits with legacy fallback", () => {
    const rows = candidateRows(workspace());
    expect(step4DetailRows(rows).map((row) => row.candidate.id)).toEqual(expect.arrayContaining(["c1", "c2"]));
    expect(step4DetailRows(rows).map((row) => row.candidate.id)).not.toContain("core");
    expect(step4CoreRows(rows).map((row) => row.candidate.id)).toEqual(["core"]);
    expect(step4CoreRows(rows).map((row) => row.candidate.id)).not.toContain("c2");
  });
  it("filters preference, unresolved state and search text", () => {
    const rows = step4DetailRows(candidateRows(workspace()));
    expect(filterCandidateRows(rows, "must_go", "").map((row) => row.place.nameZh)).toEqual(["清水寺"]);
    expect(filterCandidateRows(rows, "unresolved", "亲子").map((row) => row.place.nameZh)).toEqual(["铁道博物馆"]);
  });
  it("counts selected and unresolved candidates", () => {
    const allRows = candidateRows(workspace());
    const rows = step4DetailRows(allRows);
    expect(candidateCounts(rows, allRows)).toMatchObject({ all: 2, must_go: 1, optional: 1, selected: 2, resolving: 0, unresolved: 1 });
    expect(selectedUnresolvedRows(rows, allRows).map((row) => row.candidate.id)).toEqual(["c2"]);
  });
  it("counts an in-flight resolution separately from unresolved", () => {
    const active = workspace();
    active.resolutions.push({ tripId: "t", placeId: "p2", geoFingerprint: "g2", status: "resolving", method: "provider_match", provider: null, providerPlaceId: null, latitude: null, longitude: null, address: null, confidence: null, resolvedAt: null, errorMessage: null });
    const rows = step4DetailRows(candidateRows(active));
    expect(candidateCounts(rows)).toMatchObject({ resolving: 1, unresolved: 0 });
    expect(selectedUnresolvedRows(rows).map((row) => row.candidate.id)).toEqual(["c2"]);
  });
  it("formats suggested durations", () => {
    expect(formatDuration(90)).toBe("1 小时 30 分钟");
    expect(formatDuration(1440)).toBe("1 天");
  });
});
