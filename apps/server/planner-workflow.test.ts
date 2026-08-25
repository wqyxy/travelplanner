import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyItinerary, type Itinerary, type PlannerMutation, type Stop } from "./contracts.js";
import { deriveMapGraph } from "./map-pipeline.js";
import { applyPlannerOutput } from "./planner-workflow.js";
import { TravelStore } from "./travel-store.js";

const directories: string[] = [];
async function open() { const directory = await mkdtemp(path.join(os.tmpdir(), "planner-workflow-")); directories.push(directory); return new TravelStore(path.join(directory, "travel.sqlite3")); }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const place = { id: "new-place-kyoto", nameZh: "京都", nameLocal: "京都", nameEn: "Kyoto", kind: "city" as const, city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false };
const osaka = { ...place, id: "new-place-osaka", nameZh: "大阪", nameLocal: "大阪", nameEn: "Osaka", city: "大阪" };
const stop = (id: string, role: Stop["role"], activity: string): Stop => ({ id, role, placeId: place.id, activity, period: "morning", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: null, costNote: null, costVerification: null, notes: null });
function initialDraft(): Itinerary { const base = emptyItinerary(); return { ...base, stage: "draft", trip: { ...base.trip, title: "京都周末", destinationPlaceIds: [place.id], dates: { start: "2026-10-01", end: "2026-10-01", requestedDurationDays: null } }, places: [place], days: [{ id: "new-day-1", dayNumber: 1, date: "2026-10-01", title: "京都第一天", detailLevel: "draft", stops: [stop("new-stop-start", "start", "抵达"), stop("new-stop-visit", "visit", "游览"), stop("new-stop-end", "end", "住宿")] }] }; }
function twoDayDraft(): Itinerary { const value = initialDraft(); value.trip.dates.end = "2026-10-02"; const first = value.days[0]; value.days.push({ ...structuredClone(first), id: "new-day-2", dayNumber: 2, date: "2026-10-02", title: "京都第二天", stops: first.stops.map((item) => ({ ...structuredClone(item), id: `day-2-${item.id}` })) }); return value; }
function detailed(itinerary: Itinerary) { const value = structuredClone(itinerary); value.days = value.days.map((day) => ({ ...day, detailLevel: "detailed", stops: day.stops.map((item, index) => { const start = 9 * 60 + index * 75; const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; return { ...item, startTime: clock(start), endTime: clock(start + 60), durationMinutes: 60, scheduleVerification: { status: "verified", checkedAt: "2026-09-01T00:00:00Z" }, transportFromPrevious: index === 0 ? null : { mode: "walk", durationMinutes: 15, note: null, verification: { status: "verified", checkedAt: "2026-09-01T00:00:00Z" } }, costNote: "1000 JPY", costVerification: { status: "verified", checkedAt: "2026-09-01T00:00:00Z" } }; }) })); return value; }

describe("Planner workflow", () => {
  it("creates a canonical draft with server-owned IDs and a revision", async () => {
    const store = await open(); const trip = store.createTrip(); const result = applyPlannerOutput(store, trip.id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "已生成初稿", baseGeneration: 0, mutations: null, draftItinerary: initialDraft(), nextAction: "none", suggestion: null });
    expect(result.saved).toBe(true); expect(result.trip.contentGeneration).toBe(1); expect(result.trip.itinerary.stage).toBe("draft"); expect(result.trip.itinerary.places[0].id).not.toBe(place.id); expect(result.trip.itinerary.days[0].id).not.toBe("new-day-1"); expect(result.trip.itinerary.days[0].stops[1].placeId).toBe(result.trip.itinerary.places[0].id); expect(store.listRevisions(trip.id)).toHaveLength(1); store.close();
  });

  it("rejects an initial draft whose cross-place edge has no transport", async () => {
    const store = await open(); const trip = store.createTrip(); const draft = initialDraft();
    draft.places.push(osaka); draft.days[0].stops[1].placeId = osaka.id;
    expect(() => applyPlannerOutput(store, trip.id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "错误初稿", baseGeneration: 0, mutations: null, draftItinerary: draft, nextAction: "none", suggestion: null })).toThrow(/Day 1.*京都 → 大阪.*transportFromPrevious 缺失/);
    expect(store.requireTrip(trip.id).contentGeneration).toBe(0); expect(store.listRevisions(trip.id)).toHaveLength(0); store.close();
  });

  it("rejects an initial draft whose adjacent Days do not share the same boundary Place", async () => {
    const store = await open(); const trip = store.createTrip(); const draft = twoDayDraft();
    draft.places.push(osaka); draft.days[0].stops.at(-1)!.placeId = osaka.id; draft.days[0].stops.at(-1)!.transportFromPrevious = { mode: "drive", durationMinutes: null, note: "前往大阪", verification: { status: "unverified", checkedAt: null } };
    expect(() => applyPlannerOutput(store, trip.id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "错误初稿", baseGeneration: 0, mutations: null, draftItinerary: draft, nextAction: "none", suggestion: null })).toThrow(/跨日路线无效.*Day 1.*大阪.*Day 2.*京都.*同一 Place/);
    expect(store.requireTrip(trip.id).contentGeneration).toBe(0); expect(store.listRevisions(trip.id)).toHaveLength(0); store.close();
  });

  it("rejects a newly introduced Day boundary mismatch and accepts its atomic repair", async () => {
    const store = await open(); const created = applyPlannerOutput(store, store.createTrip().id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "初稿", baseGeneration: 0, mutations: null, draftItinerary: twoDayDraft(), nextAction: "none", suggestion: null }).trip;
    const first = created.itinerary.days[0]; const second = created.itinerary.days[1]; const firstEnd = first.stops.at(-1)!; const secondVisit = second.stops[1];
    const incomplete: PlannerMutation[] = [
      { type: "add_entity", entity: "place", parentId: null, value: osaka },
      { type: "replace_reference", entity: "stop", id: firstEnd.id, newReferenceId: osaka.id },
      { type: "update_fields", entity: "stop", id: firstEnd.id, changes: { transportFromPrevious: { mode: "drive", durationMinutes: null, note: "前往大阪", verification: { status: "unverified", checkedAt: null } } } },
    ];
    expect(() => applyPlannerOutput(store, created.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "漏改次日起点", baseGeneration: created.contentGeneration, mutations: incomplete, draftItinerary: null, nextAction: "none", suggestion: null })).toThrow(/跨日路线无效.*大阪.*京都/);
    expect(store.requireTrip(created.id).contentGeneration).toBe(created.contentGeneration); expect(store.listRevisions(created.id)).toHaveLength(1);
    const repaired = applyPlannerOutput(store, created.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "已同步跨日衔接", baseGeneration: created.contentGeneration, mutations: [
      ...incomplete,
      { type: "replace_reference", entity: "stop", id: second.stops[0].id, newReferenceId: osaka.id },
      { type: "update_fields", entity: "stop", id: secondVisit.id, changes: { transportFromPrevious: { mode: "drive", durationMinutes: null, note: "返回京都", verification: { status: "unverified", checkedAt: null } } } },
    ], draftItinerary: null, nextAction: "none", suggestion: null });
    expect(repaired.trip.itinerary.days[0].stops.at(-1)!.placeId).toBe(repaired.trip.itinerary.days[1].stops[0].placeId); expect(store.listRevisions(created.id)).toHaveLength(2); store.close();
  });

  it("grandfathers an unchanged legacy Day boundary mismatch but rejects changing it to another mismatch", async () => {
    const store = await open(); const created = applyPlannerOutput(store, store.createTrip().id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "初稿", baseGeneration: 0, mutations: null, draftItinerary: twoDayDraft(), nextAction: "none", suggestion: null }).trip;
    const legacy = structuredClone(created.itinerary); const legacyOsaka = { ...legacy.places[0], id: "legacy-osaka", nameZh: "大阪", nameLocal: "大阪", nameEn: "Osaka", city: "大阪" }; legacy.places.push(legacyOsaka); legacy.days[0].stops.at(-1)!.placeId = legacyOsaka.id; legacy.days[0].stops.at(-1)!.transportFromPrevious = { mode: "drive", durationMinutes: null, note: "前往大阪", verification: { status: "unverified", checkedAt: null } };
    const seeded = store.writeItinerary(created.id, legacy, created.contentGeneration).trip;
    const unrelated = applyPlannerOutput(store, seeded.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "调整节奏", baseGeneration: seeded.contentGeneration, mutations: [{ type: "update_fields", entity: "trip", id: null, changes: { pace: "慢节奏" } }], draftItinerary: null, nextAction: "none", suggestion: null }).trip;
    expect(unrelated.itinerary.trip.pace).toBe("慢节奏"); expect(unrelated.itinerary.days[0].stops.at(-1)!.placeId).toBe(legacyOsaka.id);
    const nara = { ...osaka, id: "new-place-nara", nameZh: "奈良", nameLocal: "奈良", nameEn: "Nara", city: "奈良" };
    expect(() => applyPlannerOutput(store, unrelated.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "改成另一个断点", baseGeneration: unrelated.contentGeneration, mutations: [{ type: "add_entity", entity: "place", parentId: null, value: nara }, { type: "replace_reference", entity: "stop", id: unrelated.itinerary.days[0].stops.at(-1)!.id, newReferenceId: nara.id }], draftItinerary: null, nextAction: "none", suggestion: null })).toThrow(/跨日路线无效.*奈良.*京都/);
    expect(store.requireTrip(unrelated.id).contentGeneration).toBe(unrelated.contentGeneration); expect(store.listRevisions(unrelated.id)).toHaveLength(2); store.close();
  });

  it("rejects a cross-place route mutation with mode=none and accepts its complete repair atomically", async () => {
    const store = await open(); const created = applyPlannerOutput(store, store.createTrip().id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "初稿", baseGeneration: 0, mutations: null, draftItinerary: initialDraft(), nextAction: "none", suggestion: null }).trip;
    const day = created.itinerary.days[0]; const visit = day.stops[1];
    const incomplete: PlannerMutation[] = [
      { type: "add_entity" as const, entity: "place" as const, parentId: null, value: osaka },
      { type: "update_fields" as const, entity: "day" as const, id: day.id, changes: { title: "京都至大阪" } },
      { type: "replace_reference" as const, entity: "stop" as const, id: visit.id, newReferenceId: osaka.id },
      { type: "replace_reference" as const, entity: "stop" as const, id: day.stops[2].id, newReferenceId: osaka.id },
      { type: "update_fields" as const, entity: "stop" as const, id: visit.id, changes: { transportFromPrevious: { mode: "none" as const, durationMinutes: null, note: null, verification: { status: "unverified" as const, checkedAt: null } } } },
    ];
    expect(() => applyPlannerOutput(store, created.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "错误路线", baseGeneration: created.contentGeneration, mutations: incomplete, draftItinerary: null, nextAction: "none", suggestion: null })).toThrow(/Day 1.*京都 → 大阪.*mode 不能为 none/);
    expect(store.requireTrip(created.id).contentGeneration).toBe(created.contentGeneration); expect(store.listRevisions(created.id)).toHaveLength(1);
    const repaired = applyPlannerOutput(store, created.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "路线已修正", baseGeneration: created.contentGeneration, mutations: incomplete.map((mutation) => mutation.type === "update_fields" && mutation.entity === "stop" ? { ...mutation, changes: { transportFromPrevious: { mode: "drive" as const, durationMinutes: null, note: "前往大阪", verification: { status: "unverified" as const, checkedAt: null } } } } : mutation), draftItinerary: null, nextAction: "none", suggestion: null });
    expect(repaired.trip.contentGeneration).toBe(created.contentGeneration + 1); expect(repaired.changedDayIds).toEqual([day.id]); expect(repaired.trip.itinerary.days[0].stops[1].transportFromPrevious?.mode).toBe("drive"); expect(deriveMapGraph(repaired.trip.itinerary).edges[0].mode).toBe("drive"); store.close();
  });

  it("applies all mutations atomically and preserves untouched fields", async () => {
    const store = await open(); const created = applyPlannerOutput(store, store.createTrip().id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "初稿", baseGeneration: 0, mutations: null, draftItinerary: initialDraft(), nextAction: "none", suggestion: null }).trip;
    const placeId = created.itinerary.places[0].id; const untouchedStop = created.itinerary.days[0].stops[1];
    const changed = applyPlannerOutput(store, created.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "改慢一点", baseGeneration: 1, mutations: [{ type: "update_fields", entity: "trip", id: null, changes: { pace: "慢节奏" } }], draftItinerary: null, nextAction: "none", suggestion: null });
    expect(changed.trip.itinerary.trip.pace).toBe("慢节奏"); expect(changed.trip.itinerary.places[0].id).toBe(placeId); expect(changed.trip.itinerary.days[0].stops[1]).toEqual(untouchedStop);
    expect(() => applyPlannerOutput(store, created.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "错误修改", baseGeneration: 2, mutations: [{ type: "update_fields", entity: "trip", id: null, changes: { title: "不应写入" } }, { type: "remove_entity", entity: "place", id: placeId }], draftItinerary: null, nextAction: "none", suggestion: null })).toThrow();
    expect(store.requireTrip(created.id).itinerary.trip.title).toBe("京都周末"); store.close();
  });

  it("rejects stale Planner writes without changing the canonical itinerary", async () => {
    const store = await open(); const created = applyPlannerOutput(store, store.createTrip().id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "初稿", baseGeneration: 0, mutations: null, draftItinerary: initialDraft(), nextAction: "none", suggestion: null }).trip;
    expect(() => applyPlannerOutput(store, created.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "过期", baseGeneration: 0, mutations: [{ type: "update_fields", entity: "trip", id: null, changes: { title: "错误覆盖" } }], draftItinerary: null, nextAction: "none", suggestion: null })).toThrow("CONTENT_GENERATION_SUPERSEDED");
    expect(store.requireTrip(created.id).itinerary.trip.title).toBe("京都周末"); store.close();
  });

  it("invalidates only affected transport and garbage-collects unreferenced Places", async () => {
    const store = await open(); const created = applyPlannerOutput(store, store.createTrip().id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "初稿", baseGeneration: 0, mutations: null, draftItinerary: initialDraft(), nextAction: "none", suggestion: null }).trip;
    const itinerary = structuredClone(created.itinerary); const extra = { ...itinerary.places[0], id: "unused" }; itinerary.places.push(extra); const withExtra = store.writeItinerary(created.id, itinerary, created.contentGeneration).trip;
    const visit = withExtra.itinerary.days[0].stops[1]; const next = applyPlannerOutput(store, withExtra.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "调整顺序", baseGeneration: withExtra.contentGeneration, mutations: [{ type: "invalidate_dependencies", entity: "stop", id: visit.id, reason: "顺序调整" }], draftItinerary: null, nextAction: "none", suggestion: null });
    expect(next.trip.itinerary.places.some((item) => item.id === "unused")).toBe(false); expect(next.invalidatedFacts).not.toHaveLength(0); store.close();
  });

  it("invalidates date-bound verification without deleting reusable durations", async () => {
    const store = await open(); const created = applyPlannerOutput(store, store.createTrip().id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "初稿", baseGeneration: 0, mutations: null, draftItinerary: initialDraft(), nextAction: "none", suggestion: null }).trip;
    const seeded = store.writeItinerary(created.id, detailed(created.itinerary), created.contentGeneration).trip;
    const changed = applyPlannerOutput(store, seeded.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "改到次日", baseGeneration: seeded.contentGeneration, mutations: [{ type: "update_fields", entity: "trip", id: null, changes: { dates: { start: "2026-10-02", end: "2026-10-02", requestedDurationDays: null } } }], draftItinerary: null, nextAction: "none", suggestion: null });
    const day = changed.trip.itinerary.days[0];
    expect(day.date).toBe("2026-10-02"); expect(day.detailLevel).toBe("detailed"); expect(day.detailStatus).toBe("needs_review"); expect(day.stops[1].durationMinutes).toBe(60); expect(day.stops[1].transportFromPrevious?.durationMinutes).toBe(15);
    expect(day.stops[1].scheduleVerification?.status).toBe("unverified"); expect(day.stops[1].costVerification?.status).toBe("unverified"); expect(day.stops[1].transportFromPrevious?.verification.status).toBe("unverified"); store.close();
  });

  it("invalidates only the edges connected to a changed Place identity", async () => {
    const store = await open(); const created = applyPlannerOutput(store, store.createTrip().id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "初稿", baseGeneration: 0, mutations: null, draftItinerary: initialDraft(), nextAction: "none", suggestion: null }).trip;
    const expanded = detailed(created.itinerary); const unrelatedPlace = { ...expanded.places[0], id: "unrelated-place", nameZh: "奈良", nameLocal: "奈良", nameEn: "Nara", city: "奈良" };
    expanded.places.push(unrelatedPlace); expanded.trip.destinationPlaceIds.push(unrelatedPlace.id); expanded.trip.dates.end = "2026-10-02";
    expanded.days.push({ ...structuredClone(expanded.days[0]), id: "unrelated-day", dayNumber: 2, date: "2026-10-02", title: "奈良", stops: expanded.days[0].stops.map((item) => ({ ...structuredClone(item), id: `unrelated-${item.id}`, placeId: unrelatedPlace.id })) });
    const seeded = store.writeItinerary(created.id, expanded, created.contentGeneration).trip; const placeId = seeded.itinerary.places[0].id;
    const displayOnly = applyPlannerOutput(store, seeded.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "修正中文显示", baseGeneration: seeded.contentGeneration, mutations: [{ type: "update_fields", entity: "place", id: placeId, changes: { nameZh: "京都市" } }], draftItinerary: null, nextAction: "none", suggestion: null });
    expect(displayOnly.trip.itinerary.days[0].detailLevel).toBe("detailed"); expect(displayOnly.trip.itinerary.days[0].stops[1].transportFromPrevious?.durationMinutes).toBe(15);
    const identity = applyPlannerOutput(store, seeded.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "更正城市", baseGeneration: displayOnly.trip.contentGeneration, mutations: [{ type: "update_fields", entity: "place", id: placeId, changes: { city: "大阪" } }], draftItinerary: null, nextAction: "none", suggestion: null });
    expect(identity.trip.itinerary.days[0].detailLevel).toBe("draft"); expect(identity.trip.itinerary.days[0].stops[1].transportFromPrevious?.durationMinutes).toBeNull(); expect(identity.trip.itinerary.days[1].detailLevel).toBe("detailed"); expect(identity.trip.itinerary.days[1].stops[1].transportFromPrevious?.durationMinutes).toBe(15); expect(identity.invalidatedFacts.some((fact) => fact.includes("身份信息变化"))).toBe(true); store.close();
  });

  it("does not allow a planning turn to create Days before confirmation", async () => {
    const store = await open(); const trip = store.createTrip();
    expect(() => applyPlannerOutput(store, trip.id, { schemaVersion: 1, operation: "mutate_itinerary", assistantMessage: "太早", baseGeneration: 0, mutations: [{ type: "add_entity", entity: "day", parentId: null, value: { id: "new-day", date: null, title: "第一天", detailLevel: "draft", stops: [stop("new-start", "start", "开始"), stop("new-visit", "visit", "游览"), stop("new-end", "end", "结束")] } }], draftItinerary: null, nextAction: "none", suggestion: null })).toThrow("未经确认");
    expect(store.requireTrip(trip.id).itinerary.days).toHaveLength(0); store.close();
  });

  it("starts detailing without writing a second itinerary state", async () => {
    const store = await open(); const created = applyPlannerOutput(store, store.createTrip().id, { schemaVersion: 1, operation: "create_draft", assistantMessage: "初稿", baseGeneration: 0, mutations: null, draftItinerary: initialDraft(), nextAction: "none", suggestion: null }).trip;
    const result = applyPlannerOutput(store, created.id, { schemaVersion: 1, operation: "start_detailing", assistantMessage: "开始细化", baseGeneration: created.contentGeneration, mutations: null, draftItinerary: null, nextAction: "none", suggestion: null });
    expect(result.startDetailing).toBe(true); expect(result.saved).toBe(false); expect(store.requireTrip(created.id).contentGeneration).toBe(created.contentGeneration); expect(store.listRevisions(created.id)).toHaveLength(1); store.close();
  });
});
