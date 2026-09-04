import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema, emptyTravelPlan, type TravelPlanDocument } from "./contracts-v2.js";
import { applyPlanCommandBatchToStore, applyPlanCommands, assertCommandsWithinScope } from "./plan-commands-v2.js";
import { TravelStoreV2 } from "./travel-store-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function databasePath() {
  const root = mkdtempSync(path.join(tmpdir(), "plan-commands-v2-"));
  roots.push(root);
  return path.join(root, "travel.sqlite3");
}

function plan(): TravelPlanDocument {
  const value = emptyTravelPlan();
  value.stage = "itinerary_planning";
  value.trip.title = "关西三日游";
  value.places.push(
    { id: "p-kyoto", nameZh: "清水寺", nameLocal: null, nameEn: "Kiyomizu-dera", kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
    { id: "p-osaka", nameZh: "大阪城", nameLocal: null, nameEn: "Osaka Castle", kind: "attraction", city: "大阪", region: null, country: "日本", countryCode: "JP", approximate: false },
    { id: "p-hotel", nameZh: "京都酒店", nameLocal: null, nameEn: null, kind: "lodging", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
  );
  value.candidates.push(
    { id: "c-kyoto", placeId: "p-kyoto", planningAreaCandidateId: null, preference: "must_go", source: "ai", aiReason: "代表景点", aiScore: 95, suggestedDurationMinutes: 90, tags: [] },
    { id: "c-osaka", placeId: "p-osaka", planningAreaCandidateId: null, preference: "want_to_go", source: "ai", aiReason: "城市地标", aiScore: 80, suggestedDurationMinutes: 90, tags: [] },
  );
  value.days.push(
    {
      id: "d-1", dayNumber: 1, date: null, title: "京都", transferMode: "none", detailLevel: "planned", detailStatus: null,
      startAnchor: { id: "a-1-start", placeId: "p-hotel", label: null, notes: null },
      stops: [{ id: "s-kyoto", candidateId: "c-kyoto", placeId: "p-kyoto", activity: "参观清水寺", period: "morning", startTime: null, endTime: null, durationMinutes: 90, transportFromPrevious: { mode: "transit", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } }, scheduleVerification: null, costNote: null, costVerification: null, notes: null }],
      endAnchor: { id: "a-1-end", placeId: "p-hotel", label: null, notes: null },
    },
    {
      id: "d-2", dayNumber: 2, date: null, title: "大阪", transferMode: "none", detailLevel: "planned", detailStatus: null,
      startAnchor: { id: "a-2-start", placeId: null, label: "大阪住宿待定", notes: null },
      stops: [{ id: "s-osaka", candidateId: "c-osaka", placeId: "p-osaka", activity: "参观大阪城", period: "afternoon", startTime: null, endTime: null, durationMinutes: 90, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null }],
      endAnchor: { id: "a-2-end", placeId: null, label: "大阪住宿待定", notes: null },
    },
  );
  return TravelPlanDocumentSchema.parse(value);
}

describe("applyPlanCommands", () => {
  it("formalizes new Place, Candidate and Stop IDs owned by the server", () => {
    const applied = applyPlanCommands(plan(), [
      {
        type: "add_candidate",
        place: { id: "new-place", nameZh: "伏见稻荷大社", nameLocal: null, nameEn: "Fushimi Inari Taisha", kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
        candidate: { id: "new-candidate", placeId: "new-place", planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 120, tags: [] },
      },
      {
        type: "add_day_stop", dayId: "d-1", index: 1,
        stop: { id: "new-stop", candidateId: "new-candidate", placeId: "new-place", activity: "参观伏见稻荷", period: "afternoon", startTime: null, endTime: null, durationMinutes: 120, transportFromPrevious: { mode: "transit", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } }, scheduleVerification: null, costNote: null, costVerification: null, notes: null },
      },
    ]);
    expect(applied.idMappings).toEqual(expect.objectContaining({ "new-place": expect.any(String), "new-candidate": expect.any(String), "new-stop": expect.any(String) }));
    const addedCandidate = applied.plan.candidates.find((candidate) => candidate.id === applied.idMappings["new-candidate"]);
    expect(addedCandidate?.placeId).toBe(applied.idMappings["new-place"]);
    expect(applied.plan.days[0].stops[1]).toMatchObject({ id: applied.idMappings["new-stop"], candidateId: applied.idMappings["new-candidate"], placeId: applied.idMappings["new-place"] });
    expect(applied.effects.routeDirtyDayIds).toContain("d-1");
  });

  it("reports the exact fields when Place and Candidate reuse one temporary ID", () => {
    expect(() => applyPlanCommands(plan(), [{
      type: "add_candidate",
      place: { id: "temp-place-taupo", nameZh: "陶波", nameLocal: "Taupō", nameEn: "Taupō", kind: "city", city: "Taupō", region: "Waikato", country: "New Zealand", countryCode: "NZ", approximate: false },
      candidate: { id: "temp-place-taupo", placeId: "temp-place-taupo", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: "北岛湖区目的地", aiScore: 86, suggestedDurationMinutes: 2880, tags: [] },
    }])).toThrow("新增实体临时 ID 重复：temp-place-taupo（commands[0].place.id 与 commands[0].candidate.id）");
  });

  it("rejects temporary IDs reused across commands", () => {
    expect(() => applyPlanCommands(plan(), [
      {
        type: "add_candidate",
        place: { id: "new-place-one", nameZh: "地点一", nameLocal: null, nameEn: null, kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
        candidate: { id: "shared-candidate", placeId: "new-place-one", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: "测试地点一", aiScore: 70, suggestedDurationMinutes: 60, tags: [] },
      },
      {
        type: "add_candidate",
        place: { id: "new-place-two", nameZh: "地点二", nameLocal: null, nameEn: null, kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
        candidate: { id: "shared-candidate", placeId: "new-place-two", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: "测试地点二", aiScore: 70, suggestedDurationMinutes: 60, tags: [] },
      },
    ])).toThrow("新增实体临时 ID 重复：shared-candidate（commands[0].candidate.id 与 commands[1].candidate.id）");
  });

  it("reports when a temporary definition overwrites a formal ID", () => {
    expect(() => applyPlanCommands(plan(), [{
      type: "add_candidate",
      place: { id: "p-kyoto", nameZh: "新地点", nameLocal: null, nameEn: null, kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
      candidate: { id: "new-candidate", placeId: "p-kyoto", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: "测试正式 ID 冲突", aiScore: 70, suggestedDurationMinutes: 60, tags: [] },
    }])).toThrow("新增实体临时 ID 覆盖正式 ID：p-kyoto（commands[0].place.id）");
  });

  it("keeps scheduled Stops when a Candidate becomes excluded", () => {
    const applied = applyPlanCommands(plan(), [{ type: "set_candidate_preference", candidateId: "c-osaka", preference: "excluded" }]);
    expect(applied.plan.candidates.find((candidate) => candidate.id === "c-osaka")?.preference).toBe("excluded");
    expect(applied.plan.days[1].stops.map((stop) => stop.id)).toEqual(["s-osaka"]);
    expect(applied.effects.changedDayIds).not.toContain("d-2");
    expect(applied.effects.routeDirtyDayIds).not.toContain("d-2");
  });

  it("moves a Stop across Days without changing its stable ID", () => {
    const applied = applyPlanCommands(plan(), [{ type: "move_day_stop", stopId: "s-osaka", targetDayId: "d-1", targetIndex: 1 }]);
    expect(applied.plan.days[0].stops.map((stop) => stop.id)).toEqual(["s-kyoto", "s-osaka"]);
    expect(applied.plan.days[1].stops).toEqual([]);
    expect(new Set(applied.effects.routeDirtyDayIds)).toEqual(new Set(["d-1", "d-2"]));
  });

  it("clears an old Candidate link when the Stop Place is changed directly", () => {
    const applied = applyPlanCommands(plan(), [{ type: "update_day_stop", stopId: "s-osaka", changes: { placeId: "p-hotel" } }]);
    expect(applied.plan.days[1].stops[0]).toMatchObject({ placeId: "p-hotel", candidateId: null });
  });

  it("garbage collects a Place after its Candidate and all other references are removed", () => {
    const applied = applyPlanCommands(plan(), [{ type: "remove_candidate", candidateId: "c-osaka" }]);
    expect(applied.plan.candidates.some((candidate) => candidate.id === "c-osaka")).toBe(false);
    expect(applied.plan.places.some((place) => place.id === "p-osaka")).toBe(false);
    expect(applied.effects.removedPlaceIds).toEqual(["p-osaka"]);
  });

  it("cascades a Macro deletion through child Candidates, Stops and trip references", () => {
    const value = plan();
    value.places.push({ id: "p-macro", nameZh: "大阪", nameLocal: "大阪", nameEn: "Osaka", kind: "city", city: "大阪", region: null, country: "日本", countryCode: "JP", approximate: false });
    value.candidates.push({ id: "c-macro", placeId: "p-macro", planningAreaCandidateId: null, preference: "want_to_go", source: "ai", aiReason: "关西目的地", aiScore: 90, suggestedDurationMinutes: null, tags: [] });
    value.candidates.find((candidate) => candidate.id === "c-osaka")!.planningAreaCandidateId = "c-macro";
    value.trip.destinationPlaceIds = ["p-macro"];
    value.days[1].startAnchor = { ...value.days[1].startAnchor, placeId: "p-osaka", label: null };
    const applied = applyPlanCommands(TravelPlanDocumentSchema.parse(value), [{ type: "remove_candidate_tree", candidateId: "c-macro" }]);
    expect(applied.plan.candidates.some((candidate) => candidate.id === "c-macro" || candidate.id === "c-osaka")).toBe(false);
    expect(applied.plan.places.some((place) => place.id === "p-macro" || place.id === "p-osaka")).toBe(false);
    expect(applied.plan.days[1].stops).toEqual([]);
    expect(applied.plan.days[1].startAnchor.placeId).toBeNull();
    expect(applied.plan.trip.destinationPlaceIds).toEqual([]);
    expect(new Set(applied.effects.removedCandidateIds)).toEqual(new Set(["c-macro", "c-osaka"]));
  });

  it("allows semantic duplicates while preserving exact ID integrity", () => {
    expect(() => applyPlanCommands(plan(), [{
      type: "add_candidate",
      place: { id: "new-place", nameZh: "清水寺", nameLocal: null, nameEn: "Kiyomizu-dera", kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
      candidate: { id: "new-candidate", placeId: "new-place", planningAreaCandidateId: null, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
    }])).not.toThrow();
  });

  it("keeps Proposal commands inside their declared Scope", () => {
    expect(assertCommandsWithinScope(plan(), { type: "day", id: "d-1" }, [{ type: "update_day", dayId: "d-1", changes: { title: "京都东山" } }])).toHaveLength(1);
    expect(() => assertCommandsWithinScope(plan(), { type: "day", id: "d-1" }, [{ type: "move_day_stop", stopId: "s-kyoto", targetDayId: "d-2", targetIndex: 0 }])).toThrow(/超出 Day Scope/);
    expect(() => assertCommandsWithinScope(plan(), { type: "candidate_pool", id: null }, [{ type: "remove_day_stop", stopId: "s-kyoto" }])).toThrow(/不能修改 Day/);
  });
});

describe("applyPlanCommandBatchToStore", () => {
  it("writes one atomic revision with generation CAS", () => {
    const store = new TravelStoreV2(databasePath());
    const created = store.createTrip();
    const seeded = store.writePlan(created.id, plan(), 0, { source: "test", summary: "seed" });
    const result = applyPlanCommandBatchToStore(store, created.id, {
      expectedGeneration: seeded.generation,
      commands: [{ type: "set_day_anchor", dayId: "d-1", anchor: "end", placeId: null, label: "京都站附近", notes: null }],
    });
    expect(result.generation).toBe(2);
    expect(result.trip.plan.days[0].endAnchor).toMatchObject({ placeId: null, label: "京都站附近" });
    expect(store.listRevisions(created.id)).toHaveLength(3);
    expect(() => applyPlanCommandBatchToStore(store, created.id, { expectedGeneration: seeded.generation, commands: [{ type: "update_day", dayId: "d-1", changes: { title: "过期写入" } }] })).toThrow("CONTENT_GENERATION_SUPERSEDED");
    store.close();
  });
});
