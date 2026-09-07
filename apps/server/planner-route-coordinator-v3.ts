import { randomUUID } from "node:crypto";
import { AiTaskMonitorV3, aiErrorMessageV3 } from "./ai-task-monitor-v3.js";
import { ROUTE_DAY_BATCH_CONCURRENCY, type DayRouteServiceV2 } from "./day-route-v2.js";
import type { TravelStoreV3 } from "./travel-store-v3.js";

type RouteBatch = {
  tripId: string;
  expectedGeneration: number;
  controller: AbortController;
};

export class PlannerRouteCoordinatorV3 {
  private readonly routeBatches = new Map<string, RouteBatch>();

  constructor(private readonly options: {
    store: TravelStoreV3;
    tasks: AiTaskMonitorV3;
    routes: DayRouteServiceV2;
    emitChanged: (tripId: string, dayId: string) => void;
  }) {}

  stopTask(tripId: string, taskId: string) {
    const batch = this.routeBatches.get(taskId);
    if (!batch || batch.tripId !== tripId) return false;
    batch.controller.abort();
    return true;
  }

  async recalculateRoute(tripId: string, dayId: string, expectedGeneration: number) {
    const route = await this.options.routes.recalculate(tripId, dayId, expectedGeneration);
    this.options.emitChanged(tripId, dayId);
    return route;
  }

  async recalculateMacroRoute(tripId: string, dayId: string, expectedGeneration: number) {
    const route = await this.options.routes.recalculateMacro(tripId, dayId, expectedGeneration);
    this.options.emitChanged(tripId, `macro:${dayId}`);
    return route;
  }

  async recalculateDirtyRoutes(tripId: string, input: any) {
    const expectedGeneration = Number(input.expectedGeneration);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new Error("expectedGeneration 无效。");
    }
    if (this.options.store.requireTrip(tripId).contentGeneration !== expectedGeneration) {
      throw new Error("CONTENT_GENERATION_SUPERSEDED");
    }
    const states = this.options.routes.workspaceRouteState(tripId);
    const ids = states.filter((state) => state.dirty).map((state) => state.dayId);
    if (ids.length) this.startRouteBatch(tripId, expectedGeneration, ids);
    const routes = await Promise.all(ids.map((dayId) => this.recalculateRoute(tripId, dayId, expectedGeneration)));
    return { routes };
  }

  startRouteBatch(tripId: string, expectedGeneration: number, dayIds: string[]) {
    const existing = [...this.routeBatches.entries()]
      .find(([, batch]) => batch.tripId === tripId && batch.expectedGeneration === expectedGeneration);
    if (existing) return existing[0];

    const dirtyDayIds = this.options.routes.workspaceRouteState(tripId)
      .filter((state) => state.dirty)
      .map((state) => state.dayId);
    const targetDayIds = [...new Set([...dayIds, ...dirtyDayIds])];
    if (!targetDayIds.length) return null;

    const taskId = `route:${randomUUID()}`;
    const controller = new AbortController();
    this.routeBatches.set(taskId, { tripId, expectedGeneration, controller });
    this.options.tasks.start({
      id: taskId,
      tripId,
      agent: "map",
      label: "计算每日路线",
      summary: `正在计算每日路线 0/${targetDayIds.length}`,
      canStop: true,
      metadata: {
        totalDays: targetDayIds.length,
        completedDays: 0,
        readyDays: 0,
        attentionDays: 0,
        peakDayConcurrency: ROUTE_DAY_BATCH_CONCURRENCY,
      },
    });

    void (async () => {
      let completed = 0;
      let ready = 0;
      let attention = 0;
      const calculate = async (dayId: string) => {
        try {
          const route = await this.options.routes.recalculate(
            tripId,
            dayId,
            expectedGeneration,
            controller.signal,
          );
          completed += 1;
          if (route.status === "ready") ready += 1;
          else attention += 1;
          this.options.emitChanged(tripId, dayId);
          const summary = `正在计算每日路线 ${completed}/${targetDayIds.length} · ready ${ready} · attention ${attention}`;
          this.options.tasks.metadata(taskId, {
            totalDays: targetDayIds.length,
            completedDays: completed,
            readyDays: ready,
            attentionDays: attention,
            peakDayConcurrency: ROUTE_DAY_BATCH_CONCURRENCY,
          });
          this.options.tasks.update(taskId, "running", summary, "route:day-completed");
        } catch (error) {
          const message = aiErrorMessageV3(error);
          if (message === "CONTENT_GENERATION_SUPERSEDED") throw error;
          if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
          completed += 1;
          attention += 1;
          this.options.tasks.update(
            taskId,
            "running",
            `正在计算每日路线 ${completed}/${targetDayIds.length} · ready ${ready} · attention ${attention}`,
            "route:day-failed",
          );
        }
      };

      try {
        await Promise.all(targetDayIds.map(calculate));
        const status = controller.signal.aborted ? "stopped" : "completed";
        this.options.tasks.update(
          taskId,
          status,
          controller.signal.aborted
            ? "每日路线计算已停止"
            : `每日路线计算完成 · ready ${ready} · attention ${attention}`,
          "task:completed",
        );
      } catch (error) {
        const superseded = aiErrorMessageV3(error) === "CONTENT_GENERATION_SUPERSEDED";
        controller.abort();
        this.options.tasks.update(
          taskId,
          superseded ? "cancelled_by_generation" : "failed",
          superseded ? "计划已变化，停止旧路线计算" : "每日路线计算失败",
          "task:failed",
        );
      } finally {
        this.routeBatches.delete(taskId);
      }
    })();

    return taskId;
  }

  async recalculateDirtyMacroRoutes(tripId: string, input: any) {
    const expectedGeneration = Number(input.expectedGeneration);
    const states = this.options.routes.workspaceMacroRouteState(tripId);
    const routes = [];
    for (const state of states) {
      if (!state.required || !state.dirty) continue;
      const route = await this.options.routes.recalculateMacro(tripId, state.dayId, expectedGeneration);
      if (route) routes.push(route);
      this.options.emitChanged(tripId, `macro:${state.dayId}`);
    }
    return { routes };
  }

  async recalculateAllMacroRoutes(tripId: string, expectedGeneration: number) {
    const trip = this.options.store.requireTrip(tripId);
    for (const day of trip.plan.days) {
      if (day.startAnchor.placeId === day.endAnchor.placeId) continue;
      try {
        const route = await this.options.routes.recalculateMacro(tripId, day.id, expectedGeneration);
        if (route) this.options.emitChanged(tripId, `macro:${day.id}`);
      } catch (error) {
        if (aiErrorMessageV3(error) === "CONTENT_GENERATION_SUPERSEDED") return;
      }
    }
  }
}
