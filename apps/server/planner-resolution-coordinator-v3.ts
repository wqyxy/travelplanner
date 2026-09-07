import { AiTaskMonitorV3, aiErrorMessageV3 } from "./ai-task-monitor-v3.js";
import type { PlaceResolutionBatchProgress } from "./place-resolver-v2.js";
import type { PlannerPlaceResolverCapabilityV3 } from "./provider-resolver-capability-v3.js";
import type { TravelStoreV3 } from "./travel-store-v3.js";

export class PlannerResolutionCoordinatorV3 {
  constructor(private readonly options: {
    store: TravelStoreV3;
    tasks: AiTaskMonitorV3;
    resolver: PlannerPlaceResolverCapabilityV3;
    emitChanged: (tripId: string, placeId: string) => void;
  }) {}

  private progress(tripId: string, taskId?: string) {
    return (progress: PlaceResolutionBatchProgress) => {
      this.options.emitChanged(tripId, progress.placeId);
      if (!taskId) return;
      const state = progress.status === "resolving"
        ? "定位中"
        : progress.status === "resolved"
          ? "已定位"
          : "未定位";
      this.options.tasks.update(
        taskId,
        "running",
        `正在定位地点 ${progress.completed}/${progress.total} · ${state}`,
        "map:resolution",
      );
    };
  }

  async resolveChangedPlaces(
    tripId: string,
    placeIds: string[],
    expectedGeneration: number,
    taskId?: string,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new Error("AI 任务已停止。");
    const current = this.options.store.requireTrip(tripId);
    if (current.contentGeneration !== expectedGeneration) return [];
    const existing = new Set(current.plan.places.map((place) => place.id));
    const ids = [...new Set(placeIds)].filter((placeId) => existing.has(placeId));
    if (!ids.length) return [];

    try {
      const result = await this.options.resolver.resolveMany(
        tripId,
        ids,
        expectedGeneration,
        signal,
        this.progress(tripId, taskId),
      );
      if (signal?.aborted) throw new Error("AI 任务已停止。");
      return result;
    } catch (error) {
      if (signal?.aborted) throw new Error("AI 任务已停止。");
      if (aiErrorMessageV3(error) === "CONTENT_GENERATION_SUPERSEDED") return [];
      return [];
    }
  }

  retryResolutions(
    tripId: string,
    placeIds: string[],
    expectedGeneration: number,
    force = false,
  ) {
    return this.options.resolver.resolveMany(
      tripId,
      placeIds,
      expectedGeneration,
      undefined,
      this.progress(tripId),
      force,
    );
  }
}
