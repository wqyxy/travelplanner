import type { AiActionRecord } from "./ai-stage-contracts-v3.js";
import { AiTaskMonitorV3, aiErrorMessageV3, normalizePublicAiSummaryV3 } from "./ai-task-monitor-v3.js";
import { applyCandidateDiscovery } from "./candidate-workflow-v2.js";
import {
  CANDIDATE_DISCOVERY_BATCH_LIMIT,
  filterCoreVisitDuplicatesV3,
  validateMicroCandidateDiscovery,
} from "./candidate-discovery-policy-v2.js";
import { classifyCodexFailure } from "./codex-client.js";
import {
  buildInterestAreaContextV3,
  interestDiscoveryReadinessV3,
} from "./planning-context-v3.js";
import { normalizeCandidateDiscoveryOutput } from "./planner-candidate-output-v3.js";
import { markImpact } from "./planner-itinerary-impact-v3.js";
import { currentPlaceResolutions } from "./planner-resolution-state-v3.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";
import { StagedTravelAiV3 } from "./staged-ai-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const INTEREST_DISCOVERY_CONCURRENCY = 4;

type InterestFailure = { targetId: string; errorSummary: string };
type ActiveInterestRun = {
  tripId: string;
  actionId: string;
  interrupt: () => Promise<void>;
};

type ResolutionCallback = (
  tripId: string,
  placeIds: string[],
  expectedGeneration: number,
  taskId?: string,
  signal?: AbortSignal,
) => Promise<unknown[]>;

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * Owns the concurrent multi-area interest-discovery workflow.
 *
 * Action claim/failure/completion lifecycle remains Runtime-owned. This
 * coordinator only performs the previously inline discovery workflow and uses
 * callbacks for Runtime-owned task/active-run/events/resolution seams.
 */
export class PlannerInterestDiscoveryCoordinatorV3 {
  constructor(private readonly options: {
    store: TravelStoreV3;
    ai: StagedTravelAiV3;
    tasks: AiTaskMonitorV3;
    progress: (taskId: string) => (value: { kind: string; text: string }) => void;
    rememberActive: (taskId: string, value: ActiveInterestRun) => void;
    resolveChangedPlaces: ResolutionCallback;
    emitDocumentChanged: (tripId: string, generation: number, changedDayIds: string[]) => void;
  }) {}

  async persist(action: AiActionRecord, taskId: string | null = null) {
    const original = this.options.store.requireTrip(action.tripId);
    const readiness = interestDiscoveryReadinessV3(original.plan);
    const allPlanningAreaIds = new Set(original.plan.candidates.flatMap((candidate) => {
      const place = original.plan.places.find((item) => item.id === candidate.placeId);
      return place && effectivePlanningRole(candidate, place) === "planning_area" ? [candidate.id] : [];
    }));
    const defaultTargetIds = readiness.adoptedPlanningAreaIds.length
      ? readiness.adoptedPlanningAreaIds
      : [...allPlanningAreaIds];
    const targets = [...new Set(action.targetIds.length ? action.targetIds : defaultTargetIds)];
    if (!targets.length) throw new Error("兴趣点研究缺少可用 Planning Area；请先添加至少一个规划区域。");
    for (const targetId of targets) {
      if (!allPlanningAreaIds.has(targetId)) throw new Error(`兴趣点研究引用未知 Planning Area：${targetId}`);
      buildInterestAreaContextV3(original.plan, targetId);
    }

    let expectedGeneration = action.baseGeneration;
    let nextIndex = 0;
    let completedAreas = 0;
    let aiSuggestedCount = 0;
    let actualAddedCount = 0;
    let mergedDuplicateCount = 0;
    let skippedCoreDuplicateCount = 0;
    let peakConcurrency = 0;
    let cancelRequested = false;
    let haltRequested = false;
    let fatalError: Error | null = null;
    let commitGate: Promise<void> = Promise.resolve();
    const successfulAreaIds: string[] = [];
    const failedAreas: InterestFailure[] = [];
    const resolutionPlaceIds = new Set<string>();
    const activeRuns = new Set<{ interrupt: () => Promise<void> }>();
    const resolutionAbortController = new AbortController();

    const publishProgress = () => {
      if (!taskId) return;
      this.options.tasks.update(
        taskId,
        "running",
        `正在研究兴趣点 · ${completedAreas}/${targets.length} 已完成 · ${successfulAreaIds.length} 成功 · ${failedAreas.length} 失败 · ${activeRuns.size} 个区域并行处理中`,
        "interest:progress",
      );
    };
    const interruptAll = async () => {
      const runs = [...activeRuns];
      await Promise.allSettled(runs.map((run) => run.interrupt()));
    };
    const throwIfHalted = () => {
      if (cancelRequested) throw new Error("AI 任务已停止。");
      if (fatalError) throw fatalError;
      if (haltRequested) throw new Error("兴趣点研究已停止。");
    };
    if (taskId) {
      this.options.rememberActive(taskId, {
        tripId: action.tripId,
        actionId: action.id,
        interrupt: async () => {
          cancelRequested = true;
          haltRequested = true;
          resolutionAbortController.abort();
          await interruptAll();
        },
      });
    }

    const withCommit = <T>(operation: () => Promise<T> | T): Promise<T> => {
      const result = commitGate.then(operation, operation);
      commitGate = result.then(() => undefined, () => undefined);
      return result;
    };

    const isGlobalFailure = (error: unknown) => {
      const message = aiErrorMessageV3(error);
      if (message === "CONTENT_GENERATION_SUPERSEDED" || message === "AI 任务已停止。") return true;
      const kind = classifyCodexFailure(error);
      if (kind === "authentication" || kind === "model" || kind === "protocol") return true;
      return /app-server|transport error|broken pipe|econn|connection.+(?:closed|reset)|尚未运行/iu.test(message);
    };

    const processTarget = async (targetId: string) => {
      throwIfHalted();
      const snapshot = this.options.store.requireTrip(action.tripId);
      const areaContext = buildInterestAreaContextV3(snapshot.plan, targetId);
      const target = snapshot.plan.candidates.find((candidate) => candidate.id === targetId);
      const targetPlace = target ? snapshot.plan.places.find((place) => place.id === target.placeId) : null;
      if (!target || !targetPlace) throw new Error(`兴趣点研究目标不是有效 Planning Area：${targetId}`);
      const run = await this.options.ai.startAction<any>({
        actionType: action.actionType,
        state: {
          actionType: action.actionType,
          baseGeneration: action.baseGeneration,
          ...areaContext,
          targetMacroCandidate: { ...target, place: targetPlace },
          existingPlaces: snapshot.plan.candidates
            .filter((candidate) => candidate.planningAreaCandidateId === targetId)
            .map((candidate) => ({
              ...candidate,
              place: snapshot.plan.places.find((place) => place.id === candidate.placeId) ?? null,
            })),
          areaRequest: {
            planningAreaCandidateId: targetId,
            maxNewCandidates: CANDIDATE_DISCOVERY_BATCH_LIMIT,
          },
        },
        validateResult: (value) => {
          if (Number(value?.baseGeneration) !== action.baseGeneration) {
            throw new Error(`兴趣点输出 baseGeneration 必须保持为 ${action.baseGeneration}。`);
          }
          return validateMicroCandidateDiscovery(
            value,
            [targetId],
            [{ planningAreaCandidateId: targetId, targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT }],
          );
        },
        onProgress: taskId ? this.options.progress(taskId) : undefined,
      });
      activeRuns.add(run);
      peakConcurrency = Math.max(peakConcurrency, activeRuns.size);
      publishProgress();
      try {
        if (cancelRequested || haltRequested) {
          void run.result.catch(() => undefined);
          await run.interrupt().catch(() => undefined);
          throwIfHalted();
        }
        const output = await run.result;
        throwIfHalted();
        aiSuggestedCount += output.candidates.length;
        await withCommit(async () => {
          throwIfHalted();
          const current = this.options.store.requireTrip(action.tripId);
          if (current.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
          const normalized = normalizeCandidateDiscoveryOutput(output, "micro");
          const filtered = filterCoreVisitDuplicatesV3(current.plan, normalized);
          skippedCoreDuplicateCount += filtered.skippedCoreDuplicateCount;
          const applied = applyCandidateDiscovery(current.plan, filtered.output, { preserveSemanticDuplicates: true });
          actualAddedCount += applied.addedCandidateIds.length;
          mergedDuplicateCount += applied.mergedDuplicateCount;
          for (const candidate of filtered.output.candidates) {
            const placeId = applied.idMappings[candidate.placeTemporaryId];
            if (placeId) resolutionPlaceIds.add(placeId);
          }
          if (!same(applied.plan, current.plan)) {
            throwIfHalted();
            const impactedPlan = markImpact(current.plan, applied.plan);
            const written = this.options.store.writePlan(
              action.tripId,
              impactedPlan,
              expectedGeneration,
              { source: `action:${action.actionType}`, summary: `AI 发现兴趣点 · ${targetPlace.nameZh}` },
              { keepActionId: action.id },
            );
            expectedGeneration = written.generation;
            this.options.emitDocumentChanged(action.tripId, written.generation, []);
          }
        });
        throwIfHalted();
        successfulAreaIds.push(targetId);
      } finally {
        activeRuns.delete(run);
      }
    };

    const worker = async () => {
      while (!cancelRequested && !haltRequested) {
        const index = nextIndex++;
        if (index >= targets.length) return;
        const targetId = targets[index];
        try {
          await processTarget(targetId);
        } catch (error) {
          const message = aiErrorMessageV3(error);
          if (cancelRequested) {
            haltRequested = true;
            resolutionAbortController.abort();
          } else if (fatalError || haltRequested) {
            // Another worker already requested a global halt. Do not turn its interrupt into a user Stop.
          } else if (message === "AI 任务已停止。") {
            cancelRequested = true;
            haltRequested = true;
            resolutionAbortController.abort();
          } else if (isGlobalFailure(error)) {
            fatalError = error instanceof Error ? error : new Error(message);
            haltRequested = true;
            resolutionAbortController.abort();
            await interruptAll();
          } else {
            failedAreas.push({
              targetId,
              errorSummary: normalizePublicAiSummaryV3(message).slice(0, 500),
            });
          }
        } finally {
          completedAreas += 1;
          publishProgress();
        }
      }
    };

    const workerCount = Math.min(INTEREST_DISCOVERY_CONCURRENCY, targets.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await commitGate;

    throwIfHalted();
    if (this.options.store.requireTrip(action.tripId).contentGeneration !== expectedGeneration) {
      throw new Error("CONTENT_GENERATION_SUPERSEDED");
    }
    if (!successfulAreaIds.length) {
      const details = failedAreas.slice(0, 3)
        .map((item) => `${item.targetId}: ${item.errorSummary}`)
        .join("；");
      throw new Error(details ? `所有兴趣点研究区域均失败：${details}` : "所有兴趣点研究区域均失败。");
    }

    await this.options.resolveChangedPlaces(
      action.tripId,
      [...resolutionPlaceIds],
      expectedGeneration,
      taskId ?? undefined,
      resolutionAbortController.signal,
    );
    throwIfHalted();
    const current = this.options.store.requireTrip(action.tripId);
    if (current.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const currentResolutions = currentPlaceResolutions(
      current,
      this.options.store.listPlaceResolutions(action.tripId),
    );
    const resolutionByPlace = new Map(
      currentResolutions.map((resolution) => [resolution.placeId, resolution]),
    );
    let resolvedCount = 0;
    let unresolvedCount = 0;
    for (const placeId of resolutionPlaceIds) {
      if (resolutionByPlace.get(placeId)?.status === "resolved") resolvedCount += 1;
      else unresolvedCount += 1;
    }
    throwIfHalted();
    const interestDiscovery = {
      totalAreas: targets.length,
      concurrency: INTEREST_DISCOVERY_CONCURRENCY,
      successfulAreaIds,
      failedAreas,
      aiSuggestedCount,
      actualAddedCount,
      mergedDuplicateCount,
      skippedCoreDuplicateCount,
      resolutionRequestedCount: resolutionPlaceIds.size,
      resolvedCount,
      unresolvedCount,
      peakConcurrency,
    };
    if (taskId) {
      this.options.tasks.metadata(taskId, {
        ...(this.options.store.getAiTask(taskId)?.metadata ?? {}),
        interestDiscovery,
      });
    }
    const resultRef = `interest:v1;areas=${successfulAreaIds.length}/${targets.length};failed=${failedAreas.length};suggested=${aiSuggestedCount};added=${actualAddedCount};merged=${mergedDuplicateCount};coreSkipped=${skippedCoreDuplicateCount};resolved=${resolvedCount};pending=${unresolvedCount}`;
    throwIfHalted();
    this.options.store.completeAction(action.id, resultRef);
  }
}
