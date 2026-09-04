import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TravelPlanDocumentSchema } from "./contracts-v2.js";
import { installRuntimeInvariantsV3 } from "./runtime-invariants-v3.js";
import { saveSkeletonEditDraftV3 } from "./skeleton-edit-api-v3.js";
import type { TravelPlannerRuntimeV3 } from "./planner-runtime-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function store() {
  const root = mkdtempSync(path.join(tmpdir(), "skeleton-edit-phase6-"));
  roots.push(root);
  const filename = path.join(root, "travel-v3.sqlite3");
  const value = new TravelStoreV3(filename);
  installRuntimeInvariantsV3(filename);
  return value;
}

function planningFixture(base: ReturnType<TravelStoreV3["createTrip"]>["plan"]) {
  return TravelPlanDocumentSchema.parse({
    ...base,
    trip: { ...base.trip, dates: { start: null, end: null, requestedDurationDays: 3 } },
    places: [
      { id: "p-a", nameZh: "奥克兰", nameLocal: null, nameEn: "Auckland", kind: "city", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
      { id: "p-b", nameZh: "罗托鲁瓦", nameLocal: null, nameEn: "Rotorua", kind: "city", city: null, region: null, country: "新西兰", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "area-a", placeId: "p-a", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "area-b", placeId: "p-b", planningAreaCandidateId: null, planningRole: "planning_area", preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
    ],
  });
}

function runtimeMock() {
  const recalculated: string[] = [];
  const runtime = { recalculateMacroRoute: async (_tripId: string, dayId: string) => { recalculated.push(dayId); return null; } } as unknown as TravelPlannerRuntimeV3;
  return { runtime, recalculated };
}

describe("Phase 6 skeleton edit API", () => {
  it("saves the whole day allocation atomically and supports returning to the same Planning Area", async () => {
    const db = store();
    const created = db.createTrip();
    db.writePlan(created.id, planningFixture(created.plan), 0, { source: "test", summary: "fixture" });
    const { runtime, recalculated } = runtimeMock();

    const result = await saveSkeletonEditDraftV3(db, runtime, created.id, {
      expectedGeneration: 1,
      draft: {
        stays: [
          { planningAreaCandidateId: "area-a", stayDays: 1, transferModeFromPrevious: "none" },
          { planningAreaCandidateId: "area-b", stayDays: 1, transferModeFromPrevious: "drive" },
          { planningAreaCandidateId: "area-a", stayDays: 1, transferModeFromPrevious: "drive" },
        ],
        omittedPlanningAreas: [],
      },
    });

    expect(result.generation).toBe(2);
    expect(result.trip.plan.days).toHaveLength(3);
    expect(result.trip.plan.days.map((day) => day.endAnchor.placeId)).toEqual(["p-a", "p-b", "p-a"]);
    expect(result.trip.plan.days[0].stayBlockId).not.toBe(result.trip.plan.days[2].stayBlockId);
    expect(db.requireTrip(created.id).contentGeneration).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recalculated.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it("saves an incomplete allocation so the user can continue adjusting later", async () => {
    const db = store();
    const created = db.createTrip();
    db.writePlan(created.id, planningFixture(created.plan), 0, { source: "test", summary: "fixture" });
    const { runtime } = runtimeMock();
    const result = await saveSkeletonEditDraftV3(db, runtime, created.id, {
      expectedGeneration: 1,
      draft: {
        stays: [{ planningAreaCandidateId: "area-a", stayDays: 2, transferModeFromPrevious: "none" }],
        omittedPlanningAreas: [{ candidateId: "area-b", reason: "这版先不去" }],
      },
    });

    expect(result.trip.plan.days).toHaveLength(2);
    expect(db.requireTrip(created.id).contentGeneration).toBe(2);
    db.close();
  });

  it("saves an over-allocated route so the user can continue adjusting later", async () => {
    const db = store();
    const created = db.createTrip();
    db.writePlan(created.id, planningFixture(created.plan), 0, { source: "test", summary: "fixture" });
    const { runtime } = runtimeMock();

    const result = await saveSkeletonEditDraftV3(db, runtime, created.id, {
      expectedGeneration: 1,
      draft: {
        stays: [
          { planningAreaCandidateId: "area-a", stayDays: 2, transferModeFromPrevious: "none" },
          { planningAreaCandidateId: "area-b", stayDays: 2, transferModeFromPrevious: "drive" },
        ],
        omittedPlanningAreas: [],
      },
    });

    expect(result.generation).toBe(2);
    expect(result.trip.plan.days).toHaveLength(4);
    db.close();
  });
});
