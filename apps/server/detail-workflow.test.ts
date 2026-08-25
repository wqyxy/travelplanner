import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyItinerary, type Day, type Itinerary, type Place, type Stop } from "./contracts.js";
import { applyDetailBatch, nextDetailBatch } from "./detail-workflow.js";
import { TravelStore } from "./travel-store.js";

const directories: string[] = [];
async function open() { const directory = await mkdtemp(path.join(os.tmpdir(), "detail-workflow-")); directories.push(directory); return new TravelStore(path.join(directory, "travel.sqlite3")); }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const place = (id: string, nameZh: string): Place => ({ id, nameZh, nameLocal: nameZh, nameEn: null, kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false });
const draftStop = (id: string, role: Stop["role"], placeId: string): Stop => ({ id, role, placeId, activity: "初稿活动", period: "morning", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: null, costNote: null, costVerification: null, notes: null });
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const detailedStop = (source: Stop, index: number): Stop => { const start = 9 * 60 + index * 75; return { ...source, activity: `详细活动 ${index + 1}`, startTime: clock(start), endTime: clock(start + 60), durationMinutes: 60, scheduleVerification: { status: "unverified", checkedAt: null }, transportFromPrevious: index === 0 ? null : { mode: "walk", durationMinutes: 15, note: null, verification: { status: "estimated", checkedAt: null } } }; };
function itinerary(): Itinerary {
  const base = emptyItinerary(); const places = [place("place-a", "地点甲"), place("place-b", "地点乙")];
  const days: Day[] = [1, 2, 3].map((number) => ({ id: `day-${number}`, dayNumber: number, date: `2026-10-0${number}`, title: `第 ${number} 天`, detailLevel: "draft", stops: [draftStop(`start-${number}`, "start", "place-a"), draftStop(`visit-${number}`, "visit", "place-b"), draftStop(`end-${number}`, "end", "place-a")] }));
  return { ...base, stage: "draft", trip: { ...base.trip, title: "京都三日", destinationPlaceIds: ["place-a", "place-b"], dates: { start: "2026-10-01", end: "2026-10-03", requestedDurationDays: null } }, places, days };
}
function output(source: Itinerary, batchId: string, dayIds: string[], generation: number, addPlace = false) {
  return { schemaVersion: 1, baseGeneration: generation, batchId, dayIds, placeUpserts: addPlace ? [place("new-place", "新增地点")] : [], days: dayIds.map((id) => { const day = source.days.find((item) => item.id === id)!; const sources = [...day.stops]; if (addPlace && id === dayIds[0]) sources.splice(sources.length - 1, 0, draftStop("new-stop", "visit", "new-place")); return { ...day, detailLevel: "detailed" as const, stops: sources.map(detailedStop) }; }), assistantMessage: "本批已细化" };
}
async function seeded() { const store = await open(); const trip = store.createTrip(); return { store, trip: store.writeItinerary(trip.id, itinerary(), 0).trip }; }

describe("two-day detail workflow", () => {
  it("applies two Days atomically and feeds canonical formal IDs back", async () => {
    const { store, trip } = await seeded(); const request = nextDetailBatch(trip.itinerary)!;
    const result = applyDetailBatch(store, trip.id, request, output(trip.itinerary, request.batchId, request.dayIds, trip.contentGeneration, true));
    expect(request.dayIds).toEqual(["day-1", "day-2"]); expect(result.trip.itinerary.stage).toBe("draft"); expect(result.completedDayIds).toEqual(["day-1", "day-2"]);
    expect(result.feedback.canonicalDays.every((day) => day.detailStatus === "ready")).toBe(true);
    expect(result.feedback.idMappings["new-place"]).toBeTruthy(); expect(result.feedback.idMappings["new-stop"]).toBeTruthy();
    expect(result.feedback.canonicalDays[0].stops.some((stop) => stop.id === result.feedback.idMappings["new-stop"])).toBe(true);
    expect(result.feedback.canonicalPlaceChanges[0].id).toBe(result.feedback.idMappings["new-place"]); expect(store.listRevisions(trip.id)).toHaveLength(0); store.close();
  });

  it("finishes the last one-Day batch and creates only the final visible revision", async () => {
    const { store, trip } = await seeded(); const first = nextDetailBatch(trip.itinerary)!; const partial = applyDetailBatch(store, trip.id, first, output(trip.itinerary, first.batchId, first.dayIds, trip.contentGeneration));
    const last = nextDetailBatch(partial.trip.itinerary)!; const completed = applyDetailBatch(store, trip.id, last, output(partial.trip.itinerary, last.batchId, last.dayIds, partial.trip.contentGeneration));
    expect(last.dayIds).toEqual(["day-3"]); expect(completed.allDetailed).toBe(true); expect(completed.trip.itinerary.stage).toBe("detailed"); expect(store.listRevisions(trip.id)).toHaveLength(1); store.close();
  });

  it("persists a material transport-gap mismatch as a reviewable detailed Day", async () => {
    const { store, trip } = await seeded(); const oneDay = structuredClone(trip.itinerary); oneDay.days = oneDay.days.slice(0, 1); oneDay.trip.dates.end = "2026-10-01";
    const saved = store.writeItinerary(trip.id, oneDay, trip.contentGeneration).trip; const request = nextDetailBatch(saved.itinerary)!; const value = output(saved.itinerary, request.batchId, request.dayIds, saved.contentGeneration);
    value.days[0].stops[1] = { ...value.days[0].stops[1], startTime: "10:05", endTime: "11:05", durationMinutes: 60, transportFromPrevious: { ...value.days[0].stops[1].transportFromPrevious!, durationMinutes: 60 } };
    const applied = applyDetailBatch(store, saved.id, request, value);
    expect(applied.timingReviewIssues).toMatchObject([{ dayId: "day-1", stopIndex: 1, gapMinutes: 5, transportMinutes: 60 }]);
    expect(applied.trip.itinerary.days[0].detailStatus).toBe("needs_review"); expect(applied.allDetailed).toBe(true); expect(applied.trip.itinerary.stage).toBe("detailed"); store.close();
  });

  it("rejects stale or mismatched batches without changing canonical data", async () => {
    const { store, trip } = await seeded(); const request = nextDetailBatch(trip.itinerary)!; const value = output(trip.itinerary, request.batchId, request.dayIds, trip.contentGeneration);
    expect(() => applyDetailBatch(store, trip.id, { ...request, batchId: "other" }, value)).toThrow("指定批次");
    expect(() => applyDetailBatch(store, trip.id, request, { ...value, baseGeneration: 0 })).toThrow("CONTENT_GENERATION_SUPERSEDED");
    expect(store.requireTrip(trip.id).contentGeneration).toBe(trip.contentGeneration); expect(store.requireTrip(trip.id).itinerary.days.every((day) => day.detailLevel === "draft")).toBe(true); store.close();
  });

  it("preserves every formal Stop, its order, Place reference and Day identity", async () => {
    const { store, trip } = await seeded(); const request = nextDetailBatch(trip.itinerary)!; const value = output(trip.itinerary, request.batchId, request.dayIds, trip.contentGeneration);
    value.days[0].date = "2026-10-09"; expect(() => applyDetailBatch(store, trip.id, request, value)).toThrow("日期或 dayNumber");
    const changed = output(trip.itinerary, request.batchId, request.dayIds, trip.contentGeneration); changed.days[0].stops[1].placeId = "place-a"; expect(() => applyDetailBatch(store, trip.id, request, changed)).toThrow("Place 引用");
    expect(store.requireTrip(trip.id).contentGeneration).toBe(trip.contentGeneration); store.close();
  });

  it("rejects a temporary ID after its formal mapping has been fed back", async () => {
    const { store, trip } = await seeded(); const first = nextDetailBatch(trip.itinerary)!; const applied = applyDetailBatch(store, trip.id, first, output(trip.itinerary, first.batchId, first.dayIds, trip.contentGeneration, true));
    const next = nextDetailBatch(applied.trip.itinerary)!; const repeated = output(applied.trip.itinerary, next.batchId, next.dayIds, applied.trip.contentGeneration); repeated.placeUpserts = [place("new-place", "错误复用")];
    expect(() => applyDetailBatch(store, trip.id, next, repeated, { forbiddenTemporaryIds: Object.keys(applied.feedback.idMappings) })).toThrow("重复使用已回灌的临时 ID");
    expect(store.requireTrip(trip.id).contentGeneration).toBe(applied.trip.contentGeneration); store.close();
  });

  it("invalidates dependent detailed Days when an existing Place identity is corrected", async () => {
    const { store, trip } = await seeded(); const mixed = structuredClone(trip.itinerary); mixed.days[2] = { ...mixed.days[2], detailLevel: "detailed", stops: mixed.days[2].stops.map(detailedStop) }; const saved = store.writeItinerary(trip.id, mixed, trip.contentGeneration).trip;
    const request = nextDetailBatch(saved.itinerary)!; const value = output(saved.itinerary, request.batchId, request.dayIds, saved.contentGeneration); value.placeUpserts = [{ ...saved.itinerary.places.find((item) => item.id === "place-b")!, city: "大阪" }];
    const applied = applyDetailBatch(store, trip.id, request, value); const dependent = applied.trip.itinerary.days.find((day) => day.id === "day-3")!;
    expect(dependent.detailLevel).toBe("draft"); expect(dependent.detailStatus).toBe("needs_review"); expect(applied.changedDayIds).toContain("day-3"); expect(applied.feedback.invalidatedFacts).not.toHaveLength(0); store.close();
  });

  it("re-details draft Days without rolling back an existing detailed lifecycle", async () => {
    const { store, trip } = await seeded(); const lifecycle = structuredClone(trip.itinerary); lifecycle.stage = "detailed"; lifecycle.days[0] = { ...lifecycle.days[0], detailLevel: "detailed", stops: lifecycle.days[0].stops.map(detailedStop) }; const saved = store.writeItinerary(trip.id, lifecycle, trip.contentGeneration).trip;
    const request = nextDetailBatch(saved.itinerary)!; const result = applyDetailBatch(store, trip.id, request, output(saved.itinerary, request.batchId, request.dayIds, saved.contentGeneration));
    expect(request.dayIds).toEqual(["day-2", "day-3"]); expect(result.trip.itinerary.stage).toBe("detailed"); expect(result.allDetailed).toBe(true); expect(store.listRevisions(trip.id)).toHaveLength(1); store.close();
  });
});
