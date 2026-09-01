import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyTravelPlan, type MacroCandidateDiscoveryOutput, type PlanGenerationOutput, type TravelPlanDocument } from "./contracts-v2.js";
import { applyCandidateDiscovery, applyCandidateDiscoveryToStore, applyPlanGeneration, applyPlanGenerationToStore } from "./candidate-workflow-v2.js";
import { TravelStoreV2 } from "./travel-store-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function databasePath() { const root = mkdtempSync(path.join(tmpdir(), "candidate-workflow-v2-")); roots.push(root); return path.join(root, "travel.sqlite3"); }

const discovery = (generation = 0): MacroCandidateDiscoveryOutput => ({
  schemaVersion: 1,
  baseGeneration: generation,
  assistantMessage: "先整理一批京都候选地点。",
  places: [
    { id: "tmp-place-1", nameZh: "清水寺", nameLocal: null, nameEn: "Kiyomizu-dera", kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
    { id: "tmp-place-2", nameZh: "伏见稻荷大社", nameLocal: null, nameEn: "Fushimi Inari Taisha", kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false },
  ],
  candidates: [
    { temporaryId: "tmp-candidate-1", placeTemporaryId: "tmp-place-1", aiReason: "京都代表寺院", aiScore: 95, suggestedDurationMinutes: 90, tags: ["寺院"], planningAreaCandidateId: null, defaultPreference: "optional" },
    { temporaryId: "tmp-candidate-2", placeTemporaryId: "tmp-place-2", aiReason: "千本鸟居", aiScore: 92, suggestedDurationMinutes: 120, tags: ["神社"], planningAreaCandidateId: null, defaultPreference: "optional" },
  ],
});

function selectedPlan(): TravelPlanDocument {
  const applied = applyCandidateDiscovery(emptyTravelPlan(), discovery());
  const plan = structuredClone(applied.plan);
  plan.candidates[0].preference = "must_go";
  plan.candidates[1].preference = "want_to_go";
  return plan;
}

function generationOutput(plan: TravelPlanDocument, generation = 1): PlanGenerationOutput {
  const first = plan.candidates[0];
  const second = plan.candidates[1];
  return {
    schemaVersion: 1,
    baseGeneration: generation,
    assistantMessage: "已按区域生成一天行程。",
    newPlaces: [{ id: "tmp-hotel", nameZh: "京都住宿区域", nameLocal: null, nameEn: null, kind: "lodging", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: true }],
    days: [{
      id: "tmp-day-1", dayNumber: 1, date: null, title: "京都东山与伏见", transferMode: "none", detailLevel: "planned", detailStatus: null,
      startAnchor: { id: "tmp-anchor-start", placeId: "tmp-hotel", label: "京都住宿区域", notes: null },
      stops: [
        { id: "tmp-stop-1", candidateId: first.id, placeId: first.placeId, activity: "参观清水寺", period: "morning", startTime: null, endTime: null, durationMinutes: 90, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null },
        { id: "tmp-stop-2", candidateId: second.id, placeId: second.placeId, activity: "游览伏见稻荷", period: "afternoon", startTime: null, endTime: null, durationMinutes: 120, transportFromPrevious: { mode: "transit", durationMinutes: null, note: null, verification: { status: "unverified", checkedAt: null } }, scheduleVerification: null, costNote: null, costVerification: null, notes: null },
      ],
      endAnchor: { id: "tmp-anchor-end", placeId: "tmp-hotel", label: "京都住宿区域", notes: null },
    }],
    unscheduledCandidates: [],
  };
}

describe("Candidate discovery", () => {
  it("assigns formal server IDs and defaults every discovered Candidate to optional", () => {
    const result = applyCandidateDiscovery(emptyTravelPlan(), discovery());
    expect(result.plan.places).toHaveLength(2);
    expect(result.plan.candidates).toHaveLength(2);
    expect(result.plan.candidates.every((candidate) => candidate.preference === "optional" && candidate.source === "ai")).toBe(true);
    expect(result.plan.candidates.every((candidate) => !("prominence" in candidate) && !("experienceTypes" in candidate) && !("visitPointType" in candidate) && !("researchBasis" in candidate))).toBe(true);
    expect(result.idMappings["tmp-place-1"]).not.toBe("tmp-place-1");
    expect(result.idMappings["tmp-candidate-1"]).not.toBe("tmp-candidate-1");
  });

  it("deduplicates semantic Places and preserves an existing user preference", () => {
    const first = applyCandidateDiscovery(emptyTravelPlan(), discovery());
    const current = structuredClone(first.plan);
    current.candidates[0].preference = "must_go";
    current.candidates[0].source = "user";
    const second = applyCandidateDiscovery(current, {
      ...discovery(),
      places: [{ id: "again-place", nameZh: "清水寺", nameLocal: null, nameEn: "Kiyomizu-dera", kind: "attraction", city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false }],
      candidates: [{ temporaryId: "again-candidate", placeTemporaryId: "again-place", aiReason: "更新理由", aiScore: 99, suggestedDurationMinutes: 100, tags: ["世界遗产"], planningAreaCandidateId: null, defaultPreference: "optional" }],
    });
    expect(second.plan.places).toHaveLength(2);
    expect(second.plan.candidates).toHaveLength(2);
    expect(second.plan.candidates[0]).toMatchObject({ preference: "must_go", source: "user", aiReason: "更新理由", aiScore: 99 });
    expect(second.plan.candidates[0].tags).toEqual(expect.arrayContaining(["寺院", "世界遗产"]));
    expect(second.updatedCandidateIds).toContain(current.candidates[0].id);
  });

  it("writes one revision with generation CAS", () => {
    const store = new TravelStoreV2(databasePath());
    const trip = store.createTrip();
    const result = applyCandidateDiscoveryToStore(store, trip.id, discovery(0));
    expect(result.generation).toBe(1);
    expect(result.trip.plan.candidates).toHaveLength(2);
    expect(() => applyCandidateDiscoveryToStore(store, trip.id, discovery(0))).toThrow("CONTENT_GENERATION_SUPERSEDED");
    store.close();
  });
});

describe("Plan generation", () => {
  it("formalizes Day, Anchor, Stop and auxiliary Place IDs", () => {
    const plan = selectedPlan();
    const result = applyPlanGeneration(plan, generationOutput(plan));
    expect(result.plan.stage).toBe("itinerary_planning");
    expect(result.plan.days).toHaveLength(1);
    expect(result.idMappings["tmp-day-1"]).not.toBe("tmp-day-1");
    expect(result.idMappings["tmp-hotel"]).not.toBe("tmp-hotel");
    expect(result.plan.days[0].startAnchor.placeId).toBe(result.idMappings["tmp-hotel"]);
    expect(result.scheduledCandidateIds).toEqual(expect.arrayContaining(plan.candidates.map((candidate) => candidate.id)));
  });

  it("requires every selected Candidate to be scheduled or explicitly explained", () => {
    const plan = selectedPlan();
    const output = generationOutput(plan);
    output.days[0].stops = [output.days[0].stops[0]];
    expect(() => applyPlanGeneration(plan, output)).toThrow(/缺少排程或未排程说明/);
    output.unscheduledCandidates = [{ candidateId: plan.candidates[1].id, reason: "一天时间不足" }];
    expect(applyPlanGeneration(plan, output).unscheduledCandidateIds).toEqual([plan.candidates[1].id]);
  });

  it("never permits a must_go Candidate in the unscheduled list", () => {
    const plan = selectedPlan();
    const output = generationOutput(plan);
    output.days[0].stops = [output.days[0].stops[1]];
    output.unscheduledCandidates = [{ candidateId: plan.candidates[0].id, reason: "时间不足" }];
    expect(() => applyPlanGeneration(plan, output)).toThrow(/must_go Candidate 不得未排程/);
  });

  it("only runs before Days exist and persists the generated plan atomically", () => {
    const store = new TravelStoreV2(databasePath());
    const created = store.createTrip();
    const discovered = applyCandidateDiscoveryToStore(store, created.id, discovery(0));
    const selected = structuredClone(discovered.trip.plan);
    selected.candidates[0].preference = "must_go";
    selected.candidates[1].preference = "want_to_go";
    const selectionWrite = store.writePlan(created.id, selected, discovered.generation, { source: "test", summary: "select" });
    const result = applyPlanGenerationToStore(store, created.id, generationOutput(selectionWrite.trip.plan, selectionWrite.generation));
    expect(result.trip.plan.stage).toBe("itinerary_planning");
    expect(result.generation).toBe(3);
    expect(() => applyPlanGenerationToStore(store, created.id, generationOutput(result.trip.plan, result.generation))).toThrow(/只能从尚未生成 Day/);
    store.close();
  });
});
