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
import { TravelPlanDocumentSchema } from "./contracts-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function db() {
  const root = mkdtempSync(path.join(tmpdir(), "resolver-best-effort-v3-"));
  roots.push(root);
  const filename = path.join(root, "travel-v3.sqlite3");
  const store = new TravelStoreV3(filename);
  installRuntimeInvariantsV3(filename);
  return store;
}

function prompts(): LoadedPromptRegistryV3 {
  const compose = (id: any) => ({ id, relativePath: `${id}.md`, content: `# ${id}`, hash: `hash:${id}`, version: "v1" });
  return { prompts: new Map(), get: ((id: any) => compose(id)) as any, compose: compose as any };
}

describe("shared resolver best-effort behavior", () => {
  it("swallows a stop-like Resolver error when no user AbortSignal was triggered", async () => {
    const store = db();
    const created = store.createTrip();
    const plan = TravelPlanDocumentSchema.parse({
      ...created.plan,
      places: [{
        id: "place-m1",
        nameZh: "目的地1",
        nameLocal: null,
        nameEn: "Macro 1",
        kind: "city",
        city: "Macro 1",
        region: null,
        country: "Test",
        countryCode: "TT",
        approximate: false,
      }],
      candidates: [{
        id: "macro-1",
        placeId: "place-m1",
        planningAreaCandidateId: null,
        preference: "optional",
        source: "ai",
        aiReason: null,
        aiScore: 80,
        suggestedDurationMinutes: 1440,
        tags: [],
      }],
    });
    const written = store.writePlan(created.id, plan, 0, { source: "test", summary: "resolver fixture" });
    let resolveManyCalled = false;
    const resolver = {
      resolve: async () => ({ resolution: null, candidates: [] }),
      resolveMany: async () => {
        resolveManyCalled = true;
        throw new Error("AI 任务已停止。");
      },
      searchCandidates: async () => [],
    } as unknown as PlaceResolverV2;
    const ai = {
      startAction: async () => { throw new Error("AI not expected"); },
      startDialogue: async () => { throw new Error("dialogue not expected"); },
      startWebDialogue: async () => { throw new Error("web dialogue not expected"); },
    } as unknown as StagedTravelAiV3;
    const routes = { workspaceRouteState: () => [], recalculate: async () => { throw new Error("route not expected"); } } as unknown as DayRouteServiceV2;
    const rt = new TravelPlannerRuntimeV3({ store, ai, prompts: prompts(), tasks: new AiTaskMonitorV3(store, () => undefined), resolver, routes, emit: () => undefined });

    await expect((rt as any).resolveChangedPlaces(created.id, ["place-m1"], written.generation)).resolves.toEqual([]);
    expect(resolveManyCalled).toBe(true);
    store.close();
  });
});
