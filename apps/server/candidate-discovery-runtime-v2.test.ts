import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiTaskMonitor } from "./ai-task-monitor.js";
import { emptyTravelPlan, type MicroCandidateDiscoveryOutput } from "./contracts-v2.js";
import { DayRouteServiceV2 } from "./day-route-v2.js";
import type { MapCandidate } from "./map-service.js";
import { PlaceResolverV2 } from "./place-resolver-v2.js";
import { CodexTravelAiV2, TravelPlannerRuntimeV2, type RuntimeAiHandle, type TravelAiV2 } from "./planner-runtime-core-v2.js";
import { TravelStoreV2 } from "./travel-store-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function databasePath() {
  const root = mkdtempSync(path.join(tmpdir(), "candidate-discovery-runtime-v2-"));
  roots.push(root);
  return path.join(root, "travel.sqlite3");
}

function handle<T>(value: T): RuntimeAiHandle<T> {
  return { threadId: "ephemeral-test-thread", result: Promise.resolve(value), interrupt: async () => undefined, turnId: () => "test-turn" };
}

function provider(name: string, city: string, id: string): MapCandidate {
  return {
    providerPlaceId: id,
    name,
    displayName: `${name}, ${city}, Testland`,
    latitude: 1,
    longitude: 2,
    category: "tourism",
    placeType: "attraction",
    countryCode: "tt",
    region: null,
    city,
    timezone: null,
  };
}

async function waitForTerminal(store: TravelStoreV2, taskId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = store.getAiTask(taskId);
    if (task && ["completed", "failed", "stopped", "cancelled_by_generation"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("AI task did not finish");
}

function candidate(
  id: string,
  area: string,
  prominence: "iconic" | "major" | "supporting",
  experienceTypes: MicroCandidateDiscoveryOutput["candidates"][number]["experienceTypes"],
): MicroCandidateDiscoveryOutput["candidates"][number] {
  return {
    temporaryId: `${id}-candidate`,
    placeTemporaryId: `${id}-place`,
    planningAreaCandidateId: area,
    aiReason: "多份攻略反复推荐的正式观光点",
    aiScore: prominence === "iconic" ? 95 : 85,
    suggestedDurationMinutes: 90,
    tags: [],
    defaultPreference: "optional" as const,
    prominence,
    experienceTypes,
    visitPointType: (experienceTypes.includes("viewpoint") ? "viewpoint" : "venue") as "viewpoint" | "venue",
    researchBasis: ["multi_guide_consensus"],
  };
}

describe("deterministic micro discovery runtime", () => {
  it("uses the server floor and replaces a provider-rejected candidate only for the affected area", async () => {
    const store = new TravelStoreV2(databasePath());
    const created = store.createTrip();
    const plan = emptyTravelPlan();
    plan.places.push(
      { id: "macro-place-a", nameZh: "区域 A", nameLocal: null, nameEn: "Area A", kind: "city", city: "Area A", region: null, country: "Testland", countryCode: "TT", approximate: false },
      { id: "macro-place-b", nameZh: "区域 B", nameLocal: null, nameEn: "Area B", kind: "city", city: "Area B", region: null, country: "Testland", countryCode: "TT", approximate: false },
    );
    plan.candidates.push(
      { id: "area-a", placeId: "macro-place-a", planningAreaCandidateId: null, preference: "must_go", source: "ai", aiReason: null, aiScore: 90, suggestedDurationMinutes: 1440, tags: [] },
      { id: "area-b", placeId: "macro-place-b", planningAreaCandidateId: null, preference: "must_go", source: "ai", aiReason: null, aiScore: 90, suggestedDurationMinutes: 1440, tags: [] },
    );
    store.writePlan(created.id, plan, 0, { source: "test", summary: "seed areas" });

    const discoveryCalls: Array<{ target: unknown; rejected: unknown }> = [];
    const ai = {
      discoverMicroCandidates: async (input: Parameters<TravelAiV2["discoverMicroCandidates"]>[0]) => {
        discoveryCalls.push({ target: input.areaTarget, rejected: input.rejectedCandidates });
        const area = input.areaTarget.planningAreaCandidateId;
        const supplement = area === "area-b" && input.areaTarget.targetCount === 1;
        const ids = supplement
          ? ["replacement"]
          : area === "area-a" ? ["a-landmark", "a-view", "a-museum"] : ["b-landmark", "b-museum", "b-invalid"];
        const names = supplement
          ? ["Replacement"]
          : area === "area-a" ? ["A Landmark", "A View", "A Museum"] : ["B Landmark", "B Museum", "Central Hall"];
        const city = area === "area-a" ? "Area A" : "Area B";
        const candidates = supplement
          ? [candidate("replacement", "area-b", "major", ["nature"])]
          : area === "area-a" ? [
            candidate("a-landmark", "area-a", "iconic", ["landmark", "photo"]),
            candidate("a-view", "area-a", "supporting", ["viewpoint", "photo"]),
            candidate("a-museum", "area-a", "supporting", ["museum_culture"]),
          ] : [
            candidate("b-landmark", "area-b", "iconic", ["landmark", "photo"]),
            candidate("b-museum", "area-b", "supporting", ["museum_culture"]),
            candidate("b-invalid", "area-b", "supporting", ["viewpoint"]),
          ];
        const output: MicroCandidateDiscoveryOutput = {
          schemaVersion: 1,
          baseGeneration: input.trip.contentGeneration,
          assistantMessage: supplement ? "已替换地图拒绝地点。" : "已完成攻略筛选。",
          areaTargets: [{ ...input.areaTarget, reason: "服务端固定目标" }],
          places: ids.map((id, index) => ({ id: `${id}-place`, nameZh: names[index], nameLocal: names[index], nameEn: names[index], kind: "attraction", city, region: null, country: "Testland", countryCode: "TT", approximate: false })),
          candidates,
        };
        return handle(output);
      },
    } as unknown as TravelAiV2;
    const maps = {
      search: async (query: string) => {
        for (const [name, city] of [["A Landmark", "Area A"], ["A View", "Area A"], ["A Museum", "Area A"], ["B Landmark", "Area B"], ["B Museum", "Area B"], ["Replacement", "Area B"]]) {
          if (query.includes(name)) return [provider(name, city, `provider-${name}`)];
        }
        if (query.includes("Central Hall")) return [{ ...provider("Central Hall", "Area B", "provider-station"), category: "railway", placeType: "station" }];
        return [];
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
    expect(discoveryCalls).toHaveLength(3);
    expect(discoveryCalls[0].target).toEqual({ planningAreaCandidateId: "area-a", targetCount: 3 });
    expect(discoveryCalls[1].target).toEqual({ planningAreaCandidateId: "area-b", targetCount: 3 });
    expect(discoveryCalls[2]).toMatchObject({ target: { planningAreaCandidateId: "area-b", targetCount: 1 } });
    expect(task.events.some((event) => event.summary.includes("正在研究 1/2：区域 A（目标 3 个）"))).toBe(true);
    expect(task.events.some((event) => event.summary.includes("区域 B正在地图预检"))).toBe(true);
    expect(task.events.some((event) => event.summary.includes("区域 B地图预检接受 2/3，正在补位"))).toBe(true);
    expect(task.events.some((event) => event.summary.includes("区域 B已保存 3 个可靠兴趣点"))).toBe(true);
    const latest = store.requireTrip(created.id);
    expect(latest.plan.candidates.filter((item) => item.planningAreaCandidateId)).toHaveLength(6);
    expect(latest.plan.candidates.every((item) => !("researchBasis" in item) && !("prominence" in item))).toBe(true);
    expect(store.listPlaceResolutions(created.id)).toHaveLength(6);
    store.close();
  });

  it("keeps Macro on the planner thread and starts every Micro request as an isolated ephemeral thread", async () => {
    const starts: any[] = [];
    const savedThreads: string[] = [];
    const runner = {
      start: async (options: any) => {
        starts.push(options);
        return handle(undefined);
      },
    } as any;
    const trip = {
      id: "trip",
      contentGeneration: 0,
      planLanguage: "zh-CN",
      codexThreadId: "planner-thread",
      plan: emptyTravelPlan(),
    } as any;
    const ai = new CodexTravelAiV2({
      root: process.cwd(),
      runner,
      prompts: {
        planner: { filename: "00-旅行规划Agent.md", content: "planner prompt" },
        detailer: { filename: "01-行程细化Agent.md", content: "detailer prompt" },
        mapResolver: { filename: "02-地图候选消歧Agent.md", content: "map prompt" },
        interestDiscovery: { filename: "03-兴趣点发现Agent.md", content: "interest prompt" },
      },
      modelOptions: () => ({}),
      saveThread: (_tripId, threadId) => savedThreads.push(threadId),
    });

    await ai.discoverMacroCandidates({ trip, message: null });
    await ai.discoverMicroCandidates({ trip, message: null, areaTarget: { planningAreaCandidateId: "area-a", targetCount: 3 } });

    expect(starts[0]).toMatchObject({ prompt: "planner prompt", existingThreadId: "planner-thread", ephemeral: false, threadSource: "ai-travel-planner-v3" });
    expect(starts[1]).toMatchObject({ prompt: "interest prompt", ephemeral: true, threadSource: "ai-travel-interest-discovery-v3", webSearch: "live", timeoutMs: 300_000 });
    expect(starts[1].state.task.areaTarget).toEqual({ planningAreaCandidateId: "area-a", targetCount: 3 });
    expect(starts[1]).not.toHaveProperty("existingThreadId");
    expect(savedThreads).toEqual(["ephemeral-test-thread"]);
  });

  it("continues with the next destination after one research timeout and keeps the later saved result", async () => {
    const store = new TravelStoreV2(databasePath());
    const created = store.createTrip();
    const plan = emptyTravelPlan();
    plan.places.push(
      { id: "macro-place-a", nameZh: "区域 A", nameLocal: null, nameEn: "Area A", kind: "city", city: "Area A", region: null, country: "Testland", countryCode: "TT", approximate: false },
      { id: "macro-place-b", nameZh: "区域 B", nameLocal: null, nameEn: "Area B", kind: "city", city: "Area B", region: null, country: "Testland", countryCode: "TT", approximate: false },
    );
    plan.candidates.push(
      { id: "area-a", placeId: "macro-place-a", planningAreaCandidateId: null, preference: "must_go", source: "ai", aiReason: null, aiScore: 90, suggestedDurationMinutes: 1440, tags: [] },
      { id: "area-b", placeId: "macro-place-b", planningAreaCandidateId: null, preference: "must_go", source: "ai", aiReason: null, aiScore: 90, suggestedDurationMinutes: 1440, tags: [] },
    );
    store.writePlan(created.id, plan, 0, { source: "test", summary: "seed areas" });

    const calls: string[] = [];
    const ai = {
      discoverMicroCandidates: async (input: Parameters<TravelAiV2["discoverMicroCandidates"]>[0]) => {
        const area = input.areaTarget.planningAreaCandidateId;
        calls.push(area);
        if (area === "area-a") throw new Error("AI 结构化请求超时。");
        const ids = ["b-landmark", "b-view", "b-museum"];
        return handle<MicroCandidateDiscoveryOutput>({
          schemaVersion: 1,
          baseGeneration: input.trip.contentGeneration,
          assistantMessage: "区域 B 研究完成。",
          areaTargets: [{ ...input.areaTarget, reason: "服务端固定目标" }],
          places: ids.map((id) => ({ id: `${id}-place`, nameZh: id, nameLocal: id, nameEn: id, kind: "attraction", city: "Area B", region: null, country: "Testland", countryCode: "TT", approximate: false })),
          candidates: [
            candidate("b-landmark", "area-b", "iconic", ["landmark", "photo"]),
            candidate("b-view", "area-b", "supporting", ["viewpoint", "photo"]),
            candidate("b-museum", "area-b", "major", ["museum_culture"]),
          ],
        });
      },
    } as unknown as TravelAiV2;
    const maps = {
      search: async (query: string) => [provider(query.split(",", 1)[0], "Area B", `provider-${query}`)],
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
    expect(task.status).toBe("failed");
    expect(calls).toEqual(["area-a", "area-b"]);
    expect(store.requireTrip(created.id).plan.candidates.filter((item) => item.planningAreaCandidateId === "area-b")).toHaveLength(3);
    expect(store.listMessages(created.id).at(-1)?.content).toMatch(/区域 A（目标 3 个）研究超过 5 分钟/);
    store.close();
  });

  it("keeps accepted partial results but marks the task failed when supplementation still misses the floor", async () => {
    const store = new TravelStoreV2(databasePath());
    const created = store.createTrip();
    const plan = emptyTravelPlan();
    plan.places.push({ id: "macro-place", nameZh: "区域 A", nameLocal: null, nameEn: "Area A", kind: "city", city: "Area A", region: null, country: "Testland", countryCode: "TT", approximate: false });
    plan.candidates.push({ id: "area-a", placeId: "macro-place", planningAreaCandidateId: null, preference: "must_go", source: "ai", aiReason: null, aiScore: 90, suggestedDurationMinutes: 1440, tags: [] });
    store.writePlan(created.id, plan, 0, { source: "test", summary: "seed area" });

    let call = 0;
    const ai = {
      discoverMicroCandidates: async (input: Parameters<TravelAiV2["discoverMicroCandidates"]>[0]) => {
        call += 1;
        const ids = call === 1 ? ["landmark", "museum", "bad"] : ["bad-replacement"];
        const output: MicroCandidateDiscoveryOutput = {
          schemaVersion: 1,
          baseGeneration: input.trip.contentGeneration,
          assistantMessage: call === 1 ? "首次研究完成。" : "补位研究完成。",
          areaTargets: [{ ...input.areaTarget, reason: "服务端固定目标" }],
          places: ids.map((id) => ({ id: `${id}-place`, nameZh: id, nameLocal: id, nameEn: id, kind: "attraction", city: "Area A", region: null, country: "Testland", countryCode: "TT", approximate: false })),
          candidates: call === 1
            ? [candidate("landmark", "area-a", "iconic", ["landmark", "photo"]), candidate("museum", "area-a", "supporting", ["museum_culture"]), candidate("bad", "area-a", "supporting", ["viewpoint"])]
            : [candidate("bad-replacement", "area-a", "major", ["nature"])],
        };
        return handle(output);
      },
    } as unknown as TravelAiV2;
    const maps = {
      search: async (query: string) => {
        if (query.includes("landmark")) return [provider("landmark", "Area A", "provider-landmark")];
        if (query.includes("museum")) return [provider("museum", "Area A", "provider-museum")];
        return [{ ...provider(query.split(",", 1)[0], "Area A", "provider-bad"), category: "railway", placeType: "station" }];
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

    const started = runtime.startCandidateDiscovery(created.id, "micro", ["area-a"]);
    const task = await waitForTerminal(store, started.taskId);
    expect(task.status).toBe("failed");
    expect(store.requireTrip(created.id).plan.candidates.filter((item) => item.planningAreaCandidateId === "area-a")).toHaveLength(2);
    expect(store.listMessages(created.id).at(-1)?.content).toMatch(/未达到可靠兴趣点下限/);
    store.close();
  });
});
