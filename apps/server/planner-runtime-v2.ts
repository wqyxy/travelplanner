export * from "./planner-runtime-base-v2.js";

import { randomUUID } from "node:crypto";
import {
  MapResolutionAssistOutputJsonSchema,
  MapResolutionAssistOutputSchema,
  type MapResolutionAssistOutput,
  type Place,
} from "./contracts-v2.js";
import { AiTaskMonitor, aiErrorMessage, normalizePublicAiSummary } from "./ai-task-monitor.js";
import { applyCandidateDiscoveryToStore } from "./candidate-workflow-v2.js";
import { CANDIDATE_DISCOVERY_BATCH_LIMIT, type FixedAreaTargetV2, validateMicroCandidateDiscovery } from "./candidate-discovery-policy-v2.js";
import { placeGeoFingerprint, resolutionIsCurrent, type PlaceResolutionPreview } from "./place-resolver-v2.js";
import {
  CodexTravelAiV2 as BaseCodexTravelAiV2,
  TravelPlannerRuntimeV2 as BaseTravelPlannerRuntimeV2,
  type RuntimeEventV2,
  type TravelAiV2,
} from "./planner-runtime-base-v2.js";

const mapInstructions = [
  "你只做地图 Provider 候选消歧。",
  "只能从服务端注入的有限候选集合中选择 providerPlaceId，不能输出、猜测或修改坐标。",
  "Provider category/placeType 以及 city/region 等行政字段只是弱参考，不得作为硬过滤规则。",
  "如果候选证据不足，可请求更准确的正式名称、别名或当地语言搜索提示；第二轮必须直接选择或保持未定位。",
  "不得访问网页、文件、账户、其他线程或私人数据。",
].join("\n");

function abortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("AI 任务已停止。");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}

/** Active AI facade with an abortable map-disambiguation turn. */
export class CodexTravelAiV2 extends BaseCodexTravelAiV2 {
  constructor(private readonly optimizedOptions: ConstructorParameters<typeof BaseCodexTravelAiV2>[0]) {
    super(optimizedOptions);
  }

  override async assistResolution(input: Parameters<TravelAiV2["assistResolution"]>[0] & { round?: 1 | 2; signal?: AbortSignal }) {
    const { signal, round = 1, ...state } = input;
    throwIfAborted(signal);
    const run = await this.optimizedOptions.runner.start<MapResolutionAssistOutput>({
      cwd: this.optimizedOptions.root,
      prompt: this.optimizedOptions.prompts.mapResolver.content,
      state: { ...state, round },
      schema: MapResolutionAssistOutputSchema,
      outputSchema: MapResolutionAssistOutputJsonSchema,
      developerInstructions: mapInstructions,
      threadSource: "ai-travel-map-resolution-v3",
      ephemeral: true,
      webSearch: "disabled",
      ...this.optimizedOptions.modelOptions(),
      timeoutMs: 120_000,
    });
    const onAbort = () => { void run.interrupt().catch(() => undefined); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      return await run.result;
    } catch {
      if (signal?.aborted) throw abortError(signal);
      return null;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

type RuntimeOptions = ConstructorParameters<typeof BaseTravelPlannerRuntimeV2>[0];
type QueueItem = {
  placeId: string;
  snapshot: Place;
  index: number;
  total: number;
};
type PipelineTask = { tripId: string; cancel: () => void };

/**
 * Interest discovery is a serial producer. Map resolution is one background
 * consumer, so research for the next city can overlap the current city's
 * provider lookups without increasing Nominatim concurrency.
 */
export class TravelPlannerRuntimeV2 extends BaseTravelPlannerRuntimeV2 {
  private readonly pipelineTasks = new Map<string, PipelineTask>();

  constructor(private readonly optimizedRuntimeOptions: RuntimeOptions) {
    super(optimizedRuntimeOptions);
  }

  private emitEvent(event: RuntimeEventV2) { this.optimizedRuntimeOptions.emit(event); }

  override startCandidateDiscovery(tripId: string, mode: "macro" | "micro" = "macro", planningAreaCandidateIds: string[] = [], message: string | null = null) {
    if (mode !== "micro") return super.startCandidateDiscovery(tripId, mode, planningAreaCandidateIds, message);

    const initialTrip = this.optimizedRuntimeOptions.store.requireTrip(tripId);
    const places = new Map(initialTrip.plan.places.map((place) => [place.id, place]));
    const activeMacroIds = initialTrip.plan.candidates
      .filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city")
      .map((candidate) => candidate.id);
    const targetIds = [...new Set(planningAreaCandidateIds.length ? planningAreaCandidateIds : activeMacroIds)];
    if (!targetIds.length) throw new Error("请先生成并保留至少一个目的地。");
    for (const id of targetIds) if (!activeMacroIds.includes(id)) throw new Error(`详细地点只能围绕有效 Macro 目的地生成：${id}`);

    const taskId = `planner:${randomUUID()}`;
    const tasks: AiTaskMonitor = this.optimizedRuntimeOptions.tasks;
    const controller = new AbortController();
    const queue: QueueItem[] = [];
    let queueClosed = false;
    let wakeQueue: (() => void) | null = null;
    let currentResearchInterrupt: (() => Promise<void>) | null = null;
    let researchState = "准备研究兴趣点";
    let resolutionState: string | null = null;
    let researchFinished = false;
    let totalResolutionPlaces = 0;
    const completedResolutionPlaceIds = new Set<string>();
    const allFormalPlaceIds = new Set<string>();
    const stats = { suggested: 0, added: 0, merged: 0, failedAreas: [] as string[], messages: [] as string[] };

    const combinedSummary = (resolutionOverride?: string | null) => [researchState, resolutionOverride === undefined ? resolutionState : resolutionOverride].filter(Boolean).join("；");
    const updateTask = (kind: string, resolutionOverride?: string | null) => tasks.update(taskId, "running", combinedSummary(resolutionOverride), kind);
    const wake = () => { const current = wakeQueue; wakeQueue = null; current?.(); };
    const enqueue = (items: QueueItem[]) => { queue.push(...items); wake(); };
    const closeQueue = () => { queueClosed = true; wake(); };
    const waitForQueue = () => new Promise<void>((resolve) => { wakeQueue = resolve; });
    const markFinished = (placeId: string) => { completedResolutionPlaceIds.add(placeId); };
    const updateDrainProgress = () => {
      if (!researchFinished || completedResolutionPlaceIds.size >= totalResolutionPlaces) return;
      resolutionState = `正在完成地点定位 ${completedResolutionPlaceIds.size}/${totalResolutionPlaces}`;
      updateTask("interest:resolving");
    };

    const cancel = () => {
      if (!controller.signal.aborted) controller.abort(new Error("AI 任务已停止。"));
      void currentResearchInterrupt?.().catch(() => undefined);
      wake();
    };
    this.pipelineTasks.set(taskId, { tripId, cancel });
    tasks.start({ id: taskId, tripId, agent: "planner", label: "生成详细兴趣点", summary: "准备生成 AI 推荐的详细地点" });

    const consumer = (async () => {
      while (true) {
        throwIfAborted(controller.signal);
        const item = queue.shift();
        if (!item) {
          if (queueClosed) return;
          await waitForQueue();
          continue;
        }

        const latest = this.optimizedRuntimeOptions.store.requireTrip(tripId);
        const latestPlace = latest.plan.places.find((place) => place.id === item.placeId);
        const existing = this.optimizedRuntimeOptions.store.getPlaceResolution(tripId, item.placeId);
        if (!latestPlace || placeGeoFingerprint(latestPlace) !== placeGeoFingerprint(item.snapshot)) {
          markFinished(item.placeId);
          updateDrainProgress();
          continue;
        }
        if (existing?.status === "resolved" && resolutionIsCurrent(latestPlace, existing)) {
          markFinished(item.placeId);
          resolutionState = `已定位 ${item.index}/${item.total}：${item.snapshot.nameZh}`;
          updateTask("interest:resolved");
          resolutionState = null;
          updateDrainProgress();
          continue;
        }

        resolutionState = `正在定位 ${item.index}/${item.total}：${item.snapshot.nameZh}`;
        updateTask("interest:resolving");
        const preview: PlaceResolutionPreview = await this.optimizedRuntimeOptions.resolver.preview(item.snapshot, { signal: controller.signal });
        throwIfAborted(controller.signal);
        const committed = this.optimizedRuntimeOptions.resolver.commitPreviewLatest(tripId, item.placeId, preview, controller.signal);
        throwIfAborted(controller.signal);
        markFinished(item.placeId);
        if (!committed) {
          resolutionState = `待定位 ${item.index}/${item.total}：${item.snapshot.nameZh}`;
          updateTask("interest:unresolved");
        } else {
          this.emitEvent({ kind: "travel.resolution.changed", payload: { tripId, placeId: item.placeId } });
          resolutionState = committed.status === "resolved"
            ? `已定位 ${item.index}/${item.total}：${item.snapshot.nameZh}`
            : `待定位 ${item.index}/${item.total}：${item.snapshot.nameZh}`;
          updateTask(committed.status === "resolved" ? "interest:resolved" : "interest:unresolved");
        }
        resolutionState = null;
        updateDrainProgress();
      }
    })();
    // Attach a handler immediately so a stop during long-running research cannot
    // create a transient unhandled rejection before the producer reaches await.
    void consumer.catch(() => undefined);

    void (async () => {
      try {
        for (let areaIndex = 0; areaIndex < targetIds.length; areaIndex += 1) {
          throwIfAborted(controller.signal);
          const trip = this.optimizedRuntimeOptions.store.requireTrip(tripId);
          const areaId = targetIds[areaIndex];
          const areaCandidate = trip.plan.candidates.find((candidate) => candidate.id === areaId);
          const areaPlace = areaCandidate ? trip.plan.places.find((place) => place.id === areaCandidate.placeId) : null;
          const areaLabel = areaPlace?.nameZh ?? areaPlace?.nameLocal ?? areaPlace?.nameEn ?? areaId;
          researchState = `正在研究 ${areaIndex + 1}/${targetIds.length}：${areaLabel}`;
          updateTask("interest:researching");

          try {
            const handle = await this.optimizedRuntimeOptions.ai.discoverMicroCandidates(
              { trip, message, areaTarget: { planningAreaCandidateId: areaId, targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT } as FixedAreaTargetV2 },
              (progress) => {
                const detail = normalizePublicAiSummary(progress.text);
                if (!detail) return;
                tasks.update(taskId, "running", `${combinedSummary()}；${detail}`, progress.kind);
              },
            );
            currentResearchInterrupt = handle.interrupt;
            if (controller.signal.aborted) {
              await handle.interrupt().catch(() => undefined);
              throw abortError(controller.signal);
            }
            const output = await handle.result;
            currentResearchInterrupt = null;
            throwIfAborted(controller.signal);
            const currentBeforeSave = this.optimizedRuntimeOptions.store.requireTrip(tripId);
            if (output.baseGeneration !== currentBeforeSave.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
            validateMicroCandidateDiscovery(output, [areaId], [{ planningAreaCandidateId: areaId, targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT }]);
            stats.suggested += output.candidates.length;
            if (output.assistantMessage) stats.messages.push(output.assistantMessage);
            if (!output.candidates.length) continue;

            const applied = applyCandidateDiscoveryToStore(this.optimizedRuntimeOptions.store, tripId, output);
            stats.added += applied.addedCandidateIds.length;
            stats.merged += Math.max(0, output.candidates.length - applied.addedCandidateIds.length);
            this.emitEvent({ kind: "travel.document.changed", payload: { tripId, generation: applied.generation, changedDayIds: [] } });

            const currentAfterSave = this.optimizedRuntimeOptions.store.requireTrip(tripId);
            const formalPlaceIds = [...new Set(output.candidates.map((candidate) => applied.idMappings[candidate.placeTemporaryId]).filter((id): id is string => Boolean(id)))];
            const snapshots = formalPlaceIds
              .map((placeId) => currentAfterSave.plan.places.find((place) => place.id === placeId))
              .filter((place): place is Place => Boolean(place))
              .map((place) => structuredClone(place));
            for (const snapshot of snapshots) allFormalPlaceIds.add(snapshot.id);
            totalResolutionPlaces = allFormalPlaceIds.size;
            enqueue(snapshots.map((snapshot, placeIndex) => ({
              placeId: snapshot.id,
              snapshot,
              index: placeIndex + 1,
              total: snapshots.length,
            })));
          } catch (error) {
            currentResearchInterrupt = null;
            const text = normalizePublicAiSummary(aiErrorMessage(error)) || "AI 研究失败";
            if (controller.signal.aborted || text === "CONTENT_GENERATION_SUPERSEDED" || text === "AI 任务已停止。") throw error;
            stats.failedAreas.push(`${areaLabel}：${text}`);
            researchState = `${areaLabel}研究失败，继续下一目的地`;
            updateTask("interest:failed-area");
          }
        }

        researchFinished = true;
        researchState = "AI 研究已完成";
        closeQueue();
        updateDrainProgress();
        await consumer;
        throwIfAborted(controller.signal);

        const finalTrip = this.optimizedRuntimeOptions.store.requireTrip(tripId);
        const finalPlaces = new Map(finalTrip.plan.places.map((place) => [place.id, place]));
        const resolutions = new Map(this.optimizedRuntimeOptions.store.listPlaceResolutions(tripId).map((resolution) => [resolution.placeId, resolution]));
        let resolved = 0;
        let unresolved = 0;
        for (const placeId of allFormalPlaceIds) {
          const place = finalPlaces.get(placeId);
          if (!place) continue;
          const resolution = resolutions.get(placeId);
          if (resolution?.status === "resolved" && resolutionIsCurrent(place, resolution)) resolved += 1;
          else unresolved += 1;
        }

        const summary = [
          `AI 建议 ${stats.suggested} 个详细地点。`,
          `实际新增 ${stats.added} 个，合并重复 ${stats.merged} 个。`,
          `已定位 ${resolved} 个，待定位 ${unresolved} 个。`,
          stats.failedAreas.length ? `AI 失败区域 ${stats.failedAreas.length} 个：${stats.failedAreas.join("；")}` : "AI 失败区域 0 个。",
        ].join("\n");
        this.optimizedRuntimeOptions.store.createAssistantMessage(tripId, `${stats.messages.join("\n\n")}\n\n${summary}`.trim().slice(0, 12000), {
          mode: "discover_candidates",
          discoveryMode: "micro",
          aiSuggestedCount: stats.suggested,
          addedCount: stats.added,
          mergedDuplicateCount: stats.merged,
          resolvedCount: resolved,
          unresolvedCount: unresolved,
          failedAreaCount: stats.failedAreas.length,
        });
        tasks.update(taskId, "completed", `详细地点生成完成：${resolved} 个已定位，${unresolved} 个待定位`, "task:completed");
      } catch (error) {
        closeQueue();
        const text = controller.signal.aborted ? "AI 任务已停止。" : normalizePublicAiSummary(aiErrorMessage(error)) || "生成详细兴趣点失败";
        const status = text === "CONTENT_GENERATION_SUPERSEDED" ? "cancelled_by_generation" : text === "AI 任务已停止。" ? "stopped" : "failed";
        tasks.update(taskId, status, text, `task:${status}`);
      } finally {
        currentResearchInterrupt = null;
        this.pipelineTasks.delete(taskId);
      }
    })();

    return { taskId, messageId: null };
  }

  override stopTask(tripId: string, taskId: string) {
    const task = this.pipelineTasks.get(taskId);
    if (!task) return super.stopTask(tripId, taskId);
    if (task.tripId !== tripId) throw new Error("当前任务已经结束。");
    task.cancel();
    return { ok: true };
  }
}
