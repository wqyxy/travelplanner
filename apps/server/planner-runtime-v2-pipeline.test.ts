import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiTaskMonitor } from "./ai-task-monitor.js";
import { emptyTravelPlan, type MicroCandidateDiscoveryOutput } from "./contracts-v2.js";
import { DayRouteServiceV2 } from "./day-route-v2.js";
import type { MapCandidate } from "./map-service.js";
import { PlaceResolverV2 } from "./place-resolver-v2.js";
import { TravelPlannerRuntimeV2, type RuntimeAiHandle, type TravelAiV2 } from "./planner-runtime-v2.js";
import { TravelStoreV2 } from "./travel-store-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function databasePath() { const root = mkdtempSync(path.join(tmpdir(), "planner-runtime-pipeline-v2-")); roots.push(root); return path.join(root, "travel.sqlite3"); }

function handle<T>(value: T): RuntimeAiHandle<T> {
  return { threadId: "pipeline-test", result: Promise.resolve(value), interrupt: async () => undefined, turnId: () => "pipeline-turn" };
}

function provider(name: string, city: string, id: string): MapCandidate {
  return {
    providerPlaceId: id,
    name,
    displayName: `${name}, ${city}, Testland`,
    latitude: city === "Area A" ? 1 : 3,
    longitude: city === "Area A" ? 2 : 4,
    category: "tourism",
    placeType: "attraction",
    countryCode: "tt",
    region: null,
    city,
    timezone: null,
  };
}

function output(areaId: string, baseGeneration: number, name: string, city: string): MicroCandidateDiscoveryOutput {
  return {
    schemaVersion: 1,
    baseGeneration,
    assistantMessage: `${city} research complete`,
    areaTargets: [{ planningAreaCandidateId: areaId, targetCount: 1, reason: "AI chose one strong place" }],
    places: [{ id: `${areaId}-place`, nameZh: name, nameLocal: name, nameEn: name, kind: "attraction", city, region: null, country: "Testland", countryCode: "TT", approximate: false }],
    candidates: [{
      temporaryId: `${areaId}-candidate`,
      placeTemporaryId: `${areaId}-place`,
      planningAreaCandidateId: areaId,
      aiReason: "strong travel recommendation",
      aiScore: 90,
      suggestedDurationMinutes: 90,
      tags: [],
      defaultPreference: "optional",
      prominence: "major",
      experienceTypes: ["landmark"],
      visitPointType: "landmark",
      researchBasis: ["multi_guide_consensus"],
    }],
  };
}

async function waitForTerminal(store: TravelStoreV2, taskId: string) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const task = store.getAiTask(taskId);
    if (task && ["completed", "failed", "stopped", "cancelled_by_generation"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("AI task did not finish");
}

describe("interest discovery resolution pipeline", () => {
  it("starts the next city research while the first city is still resolving, keeps one consumer, and waits for drain", async () => {
    const store = new TravelStoreV2(databasePath());
    const created = store.createTrip();
    const plan = emptyTravelPlan();
    plan.places.push(
      { id: "macro-a", nameZh: "区域 A", nameLocal: "Area A", nameEn: "Area A", kind: "city", city: "Area A", region: null, country: "Testland", countryCode: "TT", approximate: false },
      { id: "macro-b", nameZh: "区域 B", nameLocal: "Area B", nameEn: "Area B", kind: "city", city: "Area B", region: null, country: "Testland", countryCode: "TT", approximate: false },
    );
    plan.candidates.push(
      { id: "area-a", placeId: "macro-a", planningAreaCandidateId: null, preference: "must_go", source: "ai", aiReason: null, aiScore: 90, suggestedDurationMinutes: 1440, tags: [] },
      { id: "area-b", placeId: "macro-b", planningAreaCandidateId: null, preference: "must_go", source: "ai", aiReason: null, aiScore: 90, suggestedDurationMinutes: 1440, tags: [] },
    );
    store.writePlan(created.id, plan, 0, { source: "test", summary: "seed areas" });

    let secondResearchStarted = false;
    let releaseFirstSearch: (() => void) | null = null;
    const firstSearchGate = new Promise<void>((resolve) => { releaseFirstSearch = resolve; });
    const researchOrder: string[] = [];
    const ai = {
      discoverMicroCandidates: async (input: Parameters<TravelAiV2["discoverMicroCandidates"]>[0]) => {
        const areaId = input.areaTarget.planningAreaCandidateId;
        researchOrder.push(areaId);
        if (areaId === "area-b") {
          secondResearchStarted = true;
          releaseFirstSearch?.();
        }
        const city = areaId === "area-a" ? "Area A" : "Area B";
        const name = areaId === "area-a" ? "Landmark A" : "Landmark B";
        return handle(output(areaId, input.trip.contentGeneration, name, city));
      },
    } as unknown as TravelAiV2;

    let activeSearches = 0;
    let maxActiveSearches = 0;
    const maps = {
      search: async (query: string) => {
        activeSearches += 1;
        maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
        try {
          if (query.includes("Landmark A") && !secondResearchStarted) await firstSearchGate;
          return query.includes("Landmark A") ? [provider("Landmark A", "Area A", "provider-a")] : [provider("Landmark B", "Area B", "provider-b")];
        } finally {
          activeSearches -= 1;
        }
      },
      reverse: async () => null,
      route: async () => ({ distanceKm: 0, durationMinutes: 0, geometry: { type: "LineString" as const, coordinates: [] }, warning: null }),
    };
    const runtime = new TravelPlannerRuntimeV2({
      store,
      ai,
      tasks: new AiTaskMonitor(store, () => undefined),
      resolver: new PlaceResolverV2({ store, maps }),
      routes: new DayRouteServiceV2({ store, maps }),
      emit: () => undefined,
    });

    const started = runtime.startCandidateDiscovery(created.id, "micro", ["area-a", "area-b"]);
    const task = await waitForTerminal(store, started.taskId);
    expect(task.status).toBe("completed");
    expect(researchOrder).toEqual(["area-a", "area-b"]);
    expect(secondResearchStarted).toBe(true);
    expect(maxActiveSearches).toBe(1);
    expect(store.listPlaceResolutions(created.id)).toHaveLength(2);
    expect(task.events.some((event) => event.kind === "interest:resolving")).toBe(true);
    expect(task.events.filter((event) => event.kind === "interest:resolved")).toHaveLength(2);
    expect(task.events.some((event) => event.summary.includes("AI 研究已完成") && event.summary.includes("正在完成地点定位"))).toBe(true);
    store.close();
  });
});
