import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiTaskMonitorV3 } from "./ai-task-monitor-v3.js";
import { TravelPlannerRuntimeV3 } from "./planner-runtime-v3.js";
import { installRuntimeInvariantsV3 } from "./runtime-invariants-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";
import type { StagedTravelAiV3 } from "./staged-ai-v3.js";
import type { LoadedPromptRegistryV3 } from "./prompt-registry-v3.js";
import type { PlaceResolverV2 } from "./place-resolver-v2.js";
import type { DayRouteServiceV2 } from "./day-route-v2.js";
import { TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import { computeMacroDependencyFingerprintV3 } from "./planning-state-v3.js";
import { placeGeoFingerprint } from "./place-resolver-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

async function waitFor(check: () => boolean) {
  for (let index = 0; index < 120; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timeout");
}

function prompts(): LoadedPromptRegistryV3 {
  const compose = (id: any) => ({ id, relativePath: `${id}.md`, content: `# ${id}`, hash: `hash:${id}`, version: "v1" });
  return { prompts: new Map(), get: ((id: any) => compose(id)) as any, compose: compose as any };
}

function runtime(store: TravelStoreV3) {
  const ai = {
    startAction: async () => ({
      threadId: "detail-unavailable",
      turnId: () => "turn-detail-unavailable",
      interrupt: async () => undefined,
      result: Promise.resolve({
        schemaVersion: 1,
        baseGeneration: 1,
        result: {
          type: "success",
          assistantMessage: "只安排已定位必去核心",
          dayUpdates: [{
            dayId: "day-a",
            stops: [{ candidateId: "core-must", activity: "必去核心", period: "morning", startTime: "09:00", endTime: "11:00", durationMinutes: 120, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }],
          }],
          unscheduledCandidates: [],
        },
      }),
    }),
    startDialogue: async () => { throw new Error("dialogue not expected"); },
    startWebDialogue: async () => { throw new Error("web dialogue not expected"); },
  } as unknown as StagedTravelAiV3;
  const resolver = { resolve: async () => ({ resolution: null, candidates: [] }), resolveMany: async () => [], searchCandidates: async () => [] } as unknown as PlaceResolverV2;
  const routes = {
    workspaceRouteState: () => [],
    workspaceMacroRouteState: () => [],
    recalculate: async (_tripId: string, dayId: string) => ({ tripId: "trip", dayId, version: 1, inputFingerprint: "test", status: "ready", distanceKm: null, durationMinutes: null, geometry: null, legs: [], warnings: [], calculatedAt: null }),
    recalculateMacro: async () => null,
  } as unknown as DayRouteServiceV2;
  return new TravelPlannerRuntimeV3({ store, ai, prompts: prompts(), tasks: new AiTaskMonitorV3(store, () => undefined), resolver, routes, emit: () => undefined });
}

function plan(base: TravelPlanDocument) {
  const staged = TravelPlanDocumentSchema.parse({
    ...base,
    stage: "itinerary_planning",
    places: [
      { id: "city-a", nameZh: "甲城", nameLocal: null, nameEn: null, kind: "city", city: null, region: null, country: "Test", countryCode: "NZ", approximate: false },
      { id: "core-must-place", nameZh: "必去核心", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "Test", countryCode: "NZ", approximate: false },
      { id: "core-want-place", nameZh: "想去但未定位核心", nameLocal: null, nameEn: null, kind: "attraction", city: "甲城", region: null, country: "Test", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "area-a", placeId: "city-a", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "core-must", placeId: "core-must-place", planningAreaCandidateId: "area-a", planningRole: "core_visit", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 120, tags: [] },
      { id: "core-want", placeId: "core-want-place", planningAreaCandidateId: "area-a", planningRole: "core_visit", preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 120, tags: [] },
    ],
    days: [{
      id: "day-a", stayBlockId: "block-a", dayNumber: 1, date: null, title: "甲城", transferMode: "none", detailLevel: "planned", detailStatus: null,
      startAnchor: { id: "start-a", placeId: "city-a", label: "甲城", notes: null }, stops: [], endAnchor: { id: "end-a", placeId: "city-a", label: "甲城", notes: null },
    }],
    planningState: { macroBasisVersion: 1, macroBasisFingerprint: null },
  });
  return TravelPlanDocumentSchema.parse({ ...staged, planningState: { macroBasisVersion: 1, macroBasisFingerprint: computeMacroDependencyFingerprintV3(staged) } });
}

describe("Phase 5 unresolved non-must Core runtime semantics", () => {
  it("does not require an unscheduled reason for an unavailable want-to-go Core", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "detail-unavailable-phase5-"));
    roots.push(root);
    const filename = path.join(root, "travel-v3.sqlite3");
    const store = new TravelStoreV3(filename);
    installRuntimeInvariantsV3(filename);
    const created = store.createTrip();
    store.writePlan(created.id, plan(created.plan), 0, { source: "test", summary: "unavailable want core" });
    const current = store.requireTrip(created.id);
    for (const [index, placeId] of ["city-a", "core-must-place"].entries()) {
      const place = current.plan.places.find((item) => item.id === placeId)!;
      store.upsertPlaceResolution(created.id, { tripId: created.id, placeId, geoFingerprint: placeGeoFingerprint(place), status: "resolved", method: "manual_coordinates", provider: null, providerPlaceId: null, latitude: 35 + index, longitude: 135 + index, address: null, confidence: null, resolvedAt: "2026-09-02T00:00:00Z", errorMessage: null }, 1);
    }

    const rt = runtime(store);
    const started = rt.createCtaAction({ tripId: created.id, stage: "itinerary", actionType: "itinerary.detail.generate", parameters: {}, targetIds: [], requestKey: "unavailable-want-core" });
    await waitFor(() => store.getAction(started.action.id)?.status === "completed");
    expect(store.getAction(started.action.id)?.errorSummary).toBeNull();
    expect(store.requireTrip(created.id).plan.days[0].stops.map((stop) => stop.candidateId)).toEqual(["core-must"]);
    expect(store.requireTrip(created.id).plan.days[0].detailStatus).toBe("ready");
    store.close();
  });
});
