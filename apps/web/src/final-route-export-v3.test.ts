import { describe, expect, it } from "vitest";
import { finalRouteCsvV3, finalRouteCsvFilenameV3 } from "./final-route-export-v3";
import type { WorkspaceV3 } from "./v3-types";

function workspaceFixture() {
  return {
    trip: {
      id: "trip-1",
      title: "新西兰: 北岛/南岛",
      planLanguage: "zh",
      contentGeneration: 4,
      plan: {
        finalRoute: {
          version: 1,
          nodes: [
            { id: "node-1", placeId: "place-1", status: "normal", endsDay: false, transportFromPrevious: null, activity: "抵达", period: "morning", startTime: "09:00", endTime: "10:00", durationMinutes: 60, scheduleVerification: null, costNote: null, notes: "含,逗号" },
            { id: "node-2", placeId: "place-2", status: "normal", endsDay: true, transportFromPrevious: { mode: "drive", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } }, activity: "他说\"你好\"", period: null, startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, costNote: "免费", notes: null },
            { id: "node-3", placeId: "place-3", status: "no_go", endsDay: false, transportFromPrevious: null, activity: null, period: null, startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, costNote: null, notes: "暂不安排" },
          ],
        },
        days: [
          { id: "day-1", dayNumber: 1, date: "2026-01-01", title: "第一天", transferMode: "drive", detailLevel: "planned", detailStatus: null, startAnchor: { id: "anchor-1-start", placeId: null, label: null, notes: null }, stops: [], endAnchor: { id: "anchor-1-end", placeId: "place-2", label: null, notes: null } },
          { id: "day-2", dayNumber: 2, date: "2026-01-02", title: "第二天", transferMode: "drive", detailLevel: "planned", detailStatus: null, startAnchor: { id: "anchor-2-start", placeId: "place-2", label: null, notes: null }, stops: [], endAnchor: { id: "anchor-2-end", placeId: null, label: null, notes: null } },
        ],
        places: [
          { id: "place-1", nameZh: "基督城", nameLocal: null, nameEn: "Christchurch", kind: "city", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
          { id: "place-2", nameZh: "皇后镇", nameLocal: null, nameEn: "Queenstown", kind: "city", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
          { id: "place-3", nameZh: "罗伊峰, \"步道\"", nameLocal: null, nameEn: null, kind: "attraction", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
        ],
        candidates: [],
      },
    },
    routeStates: [{ dayId: "day-1", dirty: false, route: { legs: [{ fromNodeId: "node-1", toNodeId: "node-2", fromPlaceId: "place-1", toPlaceId: "place-2", mode: "drive", status: "ready", distanceKm: 42.5, durationMinutes: 55, geometry: null, warning: null }] } }],
    resolutions: [{ placeId: "place-1", status: "resolved", address: "1 Main St", latitude: -43.5, longitude: 172.6 }],
  } as unknown as WorkspaceV3;
}

describe("final route CSV export", () => {
  it("exports every route node with route and location state", () => {
    const csv = finalRouteCsvV3(workspaceFixture());
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"天数","日期","顺序"');
    expect(csv).toContain('"基督城"');
    expect(csv).toContain('"已定位","1 Main St","-43.5","172.6"');
    expect(csv).toContain('"皇后镇"');
    expect(csv).toContain('"42.5","55","已获取","未定位"');
    expect(csv).toContain('"不去"');
    expect(csv).toContain('"未定位"');
  });

  it("escapes CSV punctuation and sanitizes the download filename", () => {
    const csv = finalRouteCsvV3(workspaceFixture());
    expect(csv).toContain('"含,逗号"');
    expect(csv).toContain('"他说""你好"""');
    expect(csv).toContain('"罗伊峰, ""步道"""');
    expect(finalRouteCsvFilenameV3("新西兰: 北岛/南岛?. ")).toBe("新西兰_ 北岛_南岛_-行程.csv");
    expect(finalRouteCsvFilenameV3("   ")).toBe("travel-plan-行程.csv");
  });
});
