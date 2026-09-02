import { describe, expect, it } from "vitest";
import type { Workspace } from "./v2-types";
import {
  candidatePointFeatures,
  dayRouteColors,
  formatProviderDistance,
  formatProviderDuration,
  itineraryPointFeatures,
  routeGeometryFeatures,
} from "./workspace-map-presentation-v2";

const place = (id: string, nameZh: string) => ({ id, nameZh, nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: null, countryCode: null, approximate: false });
const anchor = (id: string, placeId: string) => ({ id, placeId, label: null, notes: null });
const stop = (id: string, placeId: string, candidateId: string) => ({
  id, candidateId, placeId, activity: placeId, period: null, startTime: null, endTime: null, durationMinutes: null,
  transportFromPrevious: { mode: "drive", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } },
  scheduleVerification: null, costNote: null, costVerification: null, notes: null,
});

function workspaceFixture(): Workspace {
  const days = [
    { id: "day-1", dayNumber: 1, date: null, title: "第一天", detailLevel: "detailed", detailStatus: "ready", startAnchor: anchor("a1", "p1"), stops: [stop("s1", "p2", "c2")], endAnchor: anchor("a2", "p3") },
    { id: "day-2", dayNumber: 2, date: null, title: "第二天", detailLevel: "detailed", detailStatus: "ready", startAnchor: anchor("a3", "p3"), stops: [stop("s2", "p4", "c4")], endAnchor: anchor("a4", "p1") },
  ];
  const routes = [
    { tripId: "trip", dayId: "day-1", version: 1, inputFingerprint: "r1", status: "ready", distanceKm: 12.5, durationMinutes: 65, geometry: null, warnings: [], calculatedAt: "2026-09-02T01:00:00.000Z", legs: [{ id: "leg-1", fromNodeId: "a1", toNodeId: "s1", fromPlaceId: "p1", toPlaceId: "p2", mode: "drive", status: "ready", distanceKm: 12.5, durationMinutes: 65, geometry: { type: "LineString", coordinates: [[100, 30], [101, 31]] }, warning: null }] },
    { tripId: "trip", dayId: "day-2", version: 1, inputFingerprint: "r2", status: "attention", distanceKm: null, durationMinutes: null, geometry: null, warnings: ["路线需更新"], calculatedAt: "2026-09-02T02:00:00.000Z", legs: [{ id: "leg-2", fromNodeId: "a3", toNodeId: "s2", fromPlaceId: "p3", toPlaceId: "p4", mode: "walk", status: "attention", distanceKm: 7.5, durationMinutes: 95, geometry: { type: "LineString", coordinates: [[102, 32], [103, 33]] }, warning: "路线需更新" }] },
  ];
  return {
    trip: {
      id: "trip", title: "测试旅行", state: "active", updatedAt: "2026-09-02T00:00:00.000Z", planLanguage: "zh", contentGeneration: 3,
      plan: { schemaVersion: 2, stage: "itinerary_refinement", trip: {} as any, places: [place("p1", "地点一"), place("p2", "地点二"), place("p3", "地点三"), place("p4", "地点四")] as any, candidates: ["p1", "p2", "p3", "p4"].map((placeId, index) => ({ id: `c${index + 1}`, placeId, planningAreaCandidateId: null, preference: "want_to_go", source: "ai", aiReason: null, aiScore: 80 - index, suggestedDurationMinutes: null, tags: [] })), days: days as any, warnings: [] },
    },
    resolutions: ["p1", "p2", "p3", "p4"].map((placeId, index) => ({ id: `resolution-${index}`, tripId: "trip", placeId, geoFingerprint: placeId, status: "resolved", method: "provider_match", provider: "nominatim", providerPlaceId: `provider-${index}`, latitude: 30 + index, longitude: 100 + index, address: `地址${index + 1}`, timezone: null, confidence: .9, resolvedAt: "2026-09-02T00:00:00.000Z", errorMessage: null, source: "provider" })),
    routes: routes as any,
    routeStates: [{ dayId: "day-1", dirty: false, route: routes[0] }, { dayId: "day-2", dirty: true, route: routes[1] }] as any,
    proposals: [], messages: [], tasks: [], revisions: [], coverage: [],
  } as Workspace;
}

describe("workspace map presentation", () => {
  it("keeps candidate and itinerary views separate and labels all-day itinerary nodes", () => {
    const workspace = workspaceFixture();
    expect(candidatePointFeatures(workspace)).toHaveLength(4);
    const allDays = itineraryPointFeatures(workspace, null);
    expect(allDays).toHaveLength(6);
    expect(allDays.map((feature) => feature.properties.mark)).toEqual(["D1·起", "D1·1", "D1·终", "D2·起", "D2·1", "D2·终"]);
    expect(itineraryPointFeatures(workspace, "day-2").map((feature) => feature.properties.mark)).toEqual(["起", "1", "终"]);
  });

  it("shows only the simple primary preference marks and hides removed candidates", () => {
    const workspace = workspaceFixture();
    workspace.trip.plan.candidates[0].preference = "must_go";
    workspace.trip.plan.candidates[1].preference = "want_to_go";
    workspace.trip.plan.candidates[2].preference = "optional";
    workspace.trip.plan.candidates[3].preference = "excluded";
    expect(candidatePointFeatures(workspace).map((feature) => [feature.properties.candidateId, feature.properties.mark])).toEqual([
      ["c1", "★"],
      ["c2", "♡"],
      ["c3", ""],
    ]);
  });

  it("uses the common English name instead of hiding it behind a local name", () => {
    const workspace = workspaceFixture();
    workspace.trip.planLanguage = "bilingual";
    workspace.trip.plan.places[0] = {
      ...workspace.trip.plan.places[0],
      nameZh: "米尔福德峡湾",
      nameLocal: "Piopiotahi",
      nameEn: "Milford Sound",
    };
    const point = candidatePointFeatures(workspace).find((feature) => feature.properties.placeId === "p1");
    expect(point?.properties).toMatchObject({
      label: "米尔福德峡湾 / Milford Sound",
      name: "米尔福德峡湾",
      secondary: "Milford Sound",
    });
  });

  it("shows every provider leg in all view and hides stale metrics for a dirty route", () => {
    const workspace = workspaceFixture();
    const routes = routeGeometryFeatures(workspace, null);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ id: "route-leg:day-1:leg-1", properties: { dayNumber: 1, mode: "drive", distanceKm: 12.5, durationMinutes: 65, dirty: false } });
    expect(routes[1]).toMatchObject({ properties: { dayNumber: 2, mode: "walk", distanceKm: null, durationMinutes: null, dirty: true, warning: "路线需更新" } });
    expect(routeGeometryFeatures(workspace, "day-2").map((route) => route.properties.dayNumber)).toEqual([2]);
  });

  it("assigns stable unique colors to every day", () => {
    const days = Array.from({ length: 16 }, (_, index) => ({ id: `day-${index + 1}`, dayNumber: index + 1 })) as any;
    const first = dayRouteColors(days);
    const second = dayRouteColors(days);
    expect(new Set(first.values()).size).toBe(days.length);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("formats only provider values and leaves missing values pending", () => {
    expect(formatProviderDistance(12.5)).toBe("13 km");
    expect(formatProviderDuration(65)).toBe("1 小时 5 分钟");
    expect(formatProviderDistance(null)).toBe("距离待计算");
    expect(formatProviderDuration(null)).toBe("时间待计算");
  });
});
