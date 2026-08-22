import { randomUUID } from "node:crypto";
import { MapAgentOutputJsonSchema, MapAgentOutputSchema, MapResolutionOutputJsonSchema, MapResolutionOutputSchema, normalizeMapAgentOutput, type MapAgentOutput, type TripPlan } from "./contracts.js";
import type { AiTaskMonitor } from "./ai-task-monitor.js";
import type { CodexClient, RpcEnvelope } from "./codex-client.js";
import type { MapService } from "./map-service.js";
import type { TravelStore } from "./travel-store.js";

type DayRun = {
  kind: "map";
  phase: "manifest" | "resolution";
  jobToken: string;
  taskId: string;
  tripId: string;
  itineraryVersion: number;
  mapVersion: number;
  baseMapVersion: number;
  dayNumber: number;
  position: number;
  attempt: number;
  claimedEntityIds: string[];
  waitingEntityIds: string[];
  turnId?: string;
  content: string;
  failureMessage?: string;
};

type BufferedDay = { output: MapAgentOutput; run: DayRun };
type MapJob = {
  token: string;
  tripId: string;
  itineraryVersion: number;
  mapVersion: number;
  baseMapVersion: number;
  taskId: string;
  days: TripPlan["days"];
  planPlaces: unknown[];
  requirements: unknown;
  forceRebuild: boolean;
  removedEntityIds: string[];
  removedRouteIds: string[];
  analysisQueue: number[];
  nextCommit: number;
  activeAnalyses: number;
  activeLocationDays: number;
  replaceApplied: boolean;
  draining: boolean;
  stopped: boolean;
  buffered: Map<number, BufferedDay>;
  failedPositions: Set<number>;
  settledPositions: Set<number>;
  pendingLocationDays: Array<{ position: number; dayNumber: number }>;
  threadIds: Set<string>;
  resolutionClaims: Map<string, { promise: Promise<void>; resolve: () => void }>;
};

type CoordinatorOptions = {
  root: string;
  prompt: string;
  codex: CodexClient;
  store: TravelStore;
  maps: MapService;
  tasks: AiTaskMonitor;
  ensureCodex: () => Promise<void>;
  modelOptions: () => Record<string, unknown>;
  broadcast: (kind: string, payload: unknown) => void;
  agentInstructions: string;
  agentConfig: Record<string, unknown>;
};

const publicError = (error: unknown) => error instanceof Error ? error.message : "地图任务失败。";

/**
 * Streams one itinerary day at a time into the V4 place queue. Day analysis may
 * finish out of order, but commits are drained in itinerary order so the first
 * seen place order remains deterministic. Location and route work then proceeds
 * independently and publishes each completed resource immediately.
 */
export class MapCoordinator {
  private readonly jobs = new Map<string, MapJob>();
  private readonly runs = new Map<string, DayRun>();

  constructor(private readonly options: CoordinatorOptions) {}

  hasTrip(tripId: string) { return this.jobs.has(tripId); }

  async start(tripId: string, itineraryVersion: number, forceRebuild = false) {
    const existing = this.jobs.get(tripId); if (existing) { if (existing.itineraryVersion === itineraryVersion) return; throw new Error("另一行程版本的地图任务仍在运行。"); }
    const revision = this.options.store.getRevision(tripId, itineraryVersion);
    if (!revision) throw new Error("找不到待制图的行程版本。");
    const currentPlan = revision.plan as TripPlan & { places?: Array<{ id: string; geocoding: unknown }> };
    const previousPlan = itineraryVersion > 1 ? this.options.store.getRevision(tripId, itineraryVersion - 1)?.plan as (TripPlan & { places?: Array<{ id: string; geocoding: unknown }> }) | undefined : undefined;
    const reusableActivityIds = (() => {
      if (!currentPlan.places?.length || !previousPlan?.places?.length) return [];
      const priorActivities = new Map(previousPlan.days.flatMap((day) => day.activities).map((activity) => [activity.id, activity]));
      const currentPlaces = new Map(currentPlan.places.map((place) => [place.id, JSON.stringify(place.geocoding)]));
      const priorPlaces = new Map(previousPlan.places.map((place) => [place.id, JSON.stringify(place.geocoding)]));
      return currentPlan.days.flatMap((day) => day.activities).filter((activity) => {
        const prior = priorActivities.get(activity.id); const placeIds = activity.placeIds ?? []; const priorPlaceIds = prior?.placeIds ?? [];
        return prior && JSON.stringify(placeIds) === JSON.stringify(priorPlaceIds) && placeIds.every((id) => currentPlaces.get(id) === priorPlaces.get(id));
      }).map((activity) => activity.id);
    })();
    const manifest = this.options.store.prepareMapManifest(tripId, itineraryVersion, reusableActivityIds, forceRebuild);
    const taskId = `map:${tripId}:${itineraryVersion}`;
    const job: MapJob = {
      token: randomUUID(), tripId, itineraryVersion, mapVersion: manifest.mapVersion,
      baseMapVersion: manifest.baseMapVersion, taskId, days: revision.plan.days, planPlaces: currentPlan.places ?? [],
      requirements: revision.requirements, forceRebuild,
      removedEntityIds: manifest.removedEntityIds, removedRouteIds: manifest.removedRouteIds,
      analysisQueue: revision.plan.days.map((_day, position) => position), nextCommit: 0, activeAnalyses: 0, activeLocationDays: 0, replaceApplied: false,
      draining: false, stopped: false, buffered: new Map(), failedPositions: new Set(),
      settledPositions: new Set(), pendingLocationDays: [], threadIds: new Set(), resolutionClaims: new Map(),
    };
    this.jobs.set(tripId, job);
    this.options.maps.activateRun(tripId, job.token);
    this.options.tasks.start({ id: taskId, tripId, agent: "map", label: "地图标注", summary: "正在按时间顺序建立地点队列" });
    this.options.store.setMapStatus(tripId, itineraryVersion, "analyzing", "正在按时间顺序建立地点队列");
    this.options.broadcast("travel.map.job.updated", { tripId, itineraryVersion, mapVersion: manifest.mapVersion, status: "analyzing", summary: `正在分析 0/${job.days.length} 天` });
    try { await this.options.ensureCodex(); this.launchAvailable(job); }
    catch (error) {
      const summary = publicError(error); this.jobs.delete(tripId); this.options.maps.deactivateRun(tripId, job.token);
      this.options.store.setMapStatus(tripId, itineraryVersion, "failed", summary); this.options.tasks.update(taskId, "failed", summary, "map:start-failed");
      throw error;
    }
  }

  async stop(tripId: string, summary = "地图任务已停止") {
    const job = this.jobs.get(tripId); if (!job) return false;
    job.stopped = true; this.jobs.delete(tripId); this.options.maps.deactivateRun(tripId, job.token);
    for (const claim of job.resolutionClaims.values()) claim.resolve(); job.resolutionClaims.clear();
    // Invalidate map-service workers before waiting for Agent interrupts.
    this.options.store.setMapStatus(tripId, job.itineraryVersion, "stopped", summary);
    const interrupts: Promise<unknown>[] = [];
    for (const [threadId, run] of this.runs) if (run.jobToken === job.token) {
      this.runs.delete(threadId);
      if (run.turnId) interrupts.push(this.options.codex.call("turn/interrupt", { threadId, turnId: run.turnId }).catch(() => undefined));
    }
    await Promise.all(interrupts);
    this.options.tasks.update(job.taskId, "stopped", summary, "task:stopped");
    this.options.broadcast("travel.map.job.updated", { tripId, itineraryVersion: job.itineraryVersion, mapVersion: job.mapVersion, status: "stopped", summary });
    return true;
  }

  async retry(tripId: string) {
    if (this.jobs.has(tripId)) throw new Error("这趟旅行的地图任务仍在运行。");
    const trip = this.options.store.requireTrip(tripId); const meta = this.options.store.latestMapMeta(tripId);
    if (!trip.activeRevision || !meta || meta.itineraryVersion !== trip.activeRevision.version) throw new Error("当前地图尚未建立。");
    if (meta.status === "failed" || meta.contractVersion < 4) { await this.start(tripId, meta.itineraryVersion, true); return this.options.maps.snapshot(tripId, "all", null); }
    const taskId = `map:${tripId}:${meta.itineraryVersion}`;
    const days = trip.activeRevision.plan.days; const paths = this.options.maps.snapshot(tripId, "all", null)?.dayPaths ?? [];
    const pendingLocationDays = paths.flatMap((path) => { const position = days.findIndex((day) => day.dayNumber === path.dayNumber); return position < 0 ? [] : [{ position, dayNumber: path.dayNumber }]; });
    const pathPositions = new Set(pendingLocationDays.map((item) => item.position)); const missingPositions = days.map((_day, position) => position).filter((position) => !pathPositions.has(position));
    const job: MapJob = { token: randomUUID(), tripId, itineraryVersion: meta.itineraryVersion, mapVersion: meta.mapVersion, baseMapVersion: meta.baseMapVersion, taskId, days, planPlaces: (trip.activeRevision.plan as TripPlan & { places?: unknown[] }).places ?? [], requirements: trip.requirements, forceRebuild: false, removedEntityIds: [], removedRouteIds: [], analysisQueue: [...missingPositions], nextCommit: 0, activeAnalyses: 0, activeLocationDays: 0, replaceApplied: true, draining: false, stopped: false, buffered: new Map(), failedPositions: new Set(days.map((_day, position) => position).filter((position) => pathPositions.has(position))), settledPositions: new Set(), pendingLocationDays, threadIds: new Set(), resolutionClaims: new Map() };
    this.jobs.set(tripId, job); this.options.maps.activateRun(tripId, job.token);
    this.options.tasks.start({ id: taskId, tripId, agent: "map", label: "地图标注", summary: "正在重试未完成地点和路线" });
    this.options.store.setMapStatus(tripId, meta.itineraryVersion, "resolving", "正在重试未完成地点和路线");
    this.launchAvailable(job); this.pumpLocationDays(job); this.checkFinished(job);
    return this.options.maps.snapshot(tripId, "all", null);
  }

  handleNotification(event: RpcEnvelope) {
    const params = event.params as Record<string, any> | undefined;
    const threadId = String(params?.threadId || ""); const run = this.runs.get(threadId);
    if (!run) return false;
    if (event.method === "turn/started") {
      run.turnId = String(params?.turn?.id || params?.turnId || run.turnId || "");
      this.options.tasks.update(run.taskId, "running", run.phase === "manifest" ? `正在分析 Day ${run.dayNumber}` : `正在补充 Day ${run.dayNumber} 的地点坐标`, `map:${run.phase}:day-${run.dayNumber}`);
    }
    if (event.method === "item/agentMessage/delta") run.content += String(params?.delta || "");
    if (event.method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string") run.content = params.item.text;
    if (event.method === "error" || event.method === "turn/error") run.failureMessage = String(params?.error?.message || params?.message || "").trim();
    if (event.method === "item/reasoning/summaryTextDelta" || event.method === "item/plan/delta") this.options.tasks.append(run.taskId, `${run.phase}:day-${run.dayNumber}`, params?.delta);
    if (event.method === "turn/completed") void this.complete(threadId, String(params?.turn?.status || "completed"), String(params?.turn?.error?.message || params?.error?.message || "").trim());
    return true;
  }

  private isCurrent(job: MapJob) { return !job.stopped && this.jobs.get(job.tripId)?.token === job.token; }

  private claimResolution(job: MapJob, entityIds: string[]) {
    const claimed: string[] = []; const waiting: string[] = [];
    for (const entityId of entityIds) {
      if (job.resolutionClaims.has(entityId)) { waiting.push(entityId); continue; }
      let resolve = () => {};
      const promise = new Promise<void>((done) => { resolve = done; });
      job.resolutionClaims.set(entityId, { promise, resolve }); claimed.push(entityId);
    }
    return { claimed, waiting };
  }

  private releaseResolution(job: MapJob, entityIds: string[]) {
    for (const entityId of entityIds) { const claim = job.resolutionClaims.get(entityId); claim?.resolve(); job.resolutionClaims.delete(entityId); }
  }

  private waitForResolution(job: MapJob, entityIds: string[]) { return Promise.all(entityIds.flatMap((entityId) => { const claim = job.resolutionClaims.get(entityId); return claim ? [claim.promise] : []; })).then(() => undefined); }

  private launchAvailable(job: MapJob) {
    while (this.isCurrent(job) && job.activeAnalyses < 2 && job.analysisQueue.length) {
      const position = job.analysisQueue.shift()!; void this.launchManifest(job, position, 0);
    }
  }

  private async createThread(job: MapJob) {
    const started = await this.options.codex.call("thread/start", { cwd: this.options.root, developerInstructions: this.options.agentInstructions, threadSource: "ai-travel-map-day", ephemeral: true, config: this.options.agentConfig, sandbox: "read-only", approvalPolicy: "never", environments: [], ...this.options.modelOptions() });
    const threadId = String(started?.thread?.id || ""); if (!threadId) throw new Error("Codex 没有返回地图日任务线程。");
    if (!this.isCurrent(job)) throw new Error("地图任务已经过期。"); job.threadIds.add(threadId); return threadId;
  }

  private async launchManifest(job: MapJob, position: number, attempt: number, feedback?: string) {
    job.activeAnalyses += 1;
    const day = job.days[position];
    let threadId = "";
    try {
      threadId = await this.createThread(job);
      const run: DayRun = { kind: "map", phase: "manifest", jobToken: job.token, taskId: job.taskId, tripId: job.tripId, itineraryVersion: job.itineraryVersion, mapVersion: job.mapVersion, baseMapVersion: job.baseMapVersion, dayNumber: day.dayNumber, position, attempt, claimedEntityIds: [], waitingEntityIds: [], content: "" };
      this.runs.set(threadId, run);
      const previousDay = position > 0 ? job.days[position - 1] : null;
      const nextDay = position + 1 < job.days.length ? job.days[position + 1] : null;
      const knownMap = this.options.store.mapContext(job.tripId, job.itineraryVersion);
      const input = JSON.stringify({ contract: "travel-map-day:v4", baseItineraryVersion: job.itineraryVersion, baseMapVersion: job.baseMapVersion, day, previousDay, nextDay, planPlaces: job.planPlaces, currentRequirements: job.requirements, knownPlaces: knownMap?.entities ?? [], fullRebuild: job.forceRebuild, contractFeedback: feedback || null, responseSchema: MapAgentOutputJsonSchema }, null, 2);
      const result = await this.options.codex.call("turn/start", { threadId, summary: "detailed", input: [{ type: "text", text: `${this.options.prompt}\n\n本轮受控状态：\n${input}`, text_elements: [] }], outputSchema: MapAgentOutputJsonSchema, ...this.options.modelOptions() }, 120000);
      if (this.runs.get(threadId) === run) run.turnId = String(result?.turn?.id || run.turnId || "");
    } catch (error) {
      const failedRun = threadId ? this.runs.get(threadId) : undefined;
      if (threadId) this.runs.delete(threadId);
      if (threadId && failedRun?.turnId) void this.options.codex.call("turn/interrupt", { threadId, turnId: failedRun.turnId }).catch(() => undefined);
      this.analysisFailed(job, position, attempt, publicError(error));
    }
  }

  private analysisFailed(job: MapJob, position: number, attempt: number, detail: string) {
    job.activeAnalyses = Math.max(0, job.activeAnalyses - 1);
    if (!this.isCurrent(job)) return;
    if (attempt < 1) { this.options.tasks.update(job.taskId, "running", `Day ${job.days[position].dayNumber} 输出无效，正在重试`, `map:day-retry-${position}`); void this.launchManifest(job, position, attempt + 1, detail); }
    else { job.failedPositions.add(position); job.settledPositions.add(position); this.options.tasks.update(job.taskId, "running", `Day ${job.days[position].dayNumber} 标注失败，继续其他日期`, `map:day-failed-${position}`); void this.drain(job); }
    this.launchAvailable(job);
  }

  private async complete(threadId: string, status: string, reportedError: string) {
    const run = this.runs.get(threadId); if (!run) return; this.runs.delete(threadId);
    const job = this.jobs.get(run.tripId); if (!job || job.token !== run.jobToken || !this.isCurrent(job)) return;
    if (status !== "completed") {
      const detail = reportedError || run.failureMessage || "AI 未能完成本轮。";
      if (run.phase === "manifest") this.analysisFailed(job, run.position, run.attempt, detail);
      else await this.finishResolutionFallback(job, run.position, run.dayNumber, detail, run.claimedEntityIds, run.waitingEntityIds);
      return;
    }
    if (run.phase === "manifest") {
      job.activeAnalyses = Math.max(0, job.activeAnalyses - 1);
      try {
        const output = MapAgentOutputSchema.parse(normalizeMapAgentOutput(JSON.parse(run.content)));
        if (output.dayPaths.length !== 1 || output.dayPaths[0].dayNumber !== run.dayNumber) throw new Error(`日任务只能返回 Day ${run.dayNumber}。`);
        job.buffered.set(run.position, { output: { ...output, upsertRoutes: [], removeRouteIds: [] }, run });
        void this.drain(job);
      } catch (error) { this.analysisFailedAfterDecrement(job, run, publicError(error)); }
      this.launchAvailable(job); return;
    }
    try {
      const output = MapResolutionOutputSchema.parse(JSON.parse(run.content));
      await this.options.maps.applyResolution(run.tripId, run.itineraryVersion, run.mapVersion, output, run.dayNumber, job.token, run.claimedEntityIds);
      await this.options.maps.settleUnresolvedWithCityFallback(run.tripId, run.itineraryVersion, run.mapVersion, run.dayNumber, job.token, run.claimedEntityIds);
      this.releaseResolution(job, run.claimedEntityIds); await this.waitForResolution(job, run.waitingEntityIds);
      const routing = this.options.maps.resolveDayRoutes(run.tripId, run.itineraryVersion, run.mapVersion, run.dayNumber, job.token);
      this.pumpLocationDays(job);
      await routing;
      this.daySettled(job, run.position);
    } catch (error) { await this.finishResolutionFallback(job, run.position, run.dayNumber, publicError(error), run.claimedEntityIds, run.waitingEntityIds); }
  }

  private analysisFailedAfterDecrement(job: MapJob, run: DayRun, detail: string) {
    if (!this.isCurrent(job)) return;
    if (run.attempt < 1) void this.launchManifest(job, run.position, run.attempt + 1, detail);
    else { job.failedPositions.add(run.position); job.settledPositions.add(run.position); void this.drain(job); }
  }

  private async drain(job: MapJob) {
    if (job.draining || !this.isCurrent(job)) return; job.draining = true;
    try {
      while (job.nextCommit < job.days.length) {
        if (job.failedPositions.has(job.nextCommit)) { job.nextCommit += 1; continue; }
        const buffered = job.buffered.get(job.nextCommit); if (!buffered) break;
        job.buffered.delete(job.nextCommit);
        const replaceAll = job.forceRebuild && !job.replaceApplied; job.replaceApplied ||= replaceAll;
        const applied = this.options.store.applyMapPatch(job.tripId, job.itineraryVersion, job.baseMapVersion, buffered.output, replaceAll);
        const snapshot = this.options.maps.snapshot(job.tripId, "all", null)!;
        this.options.broadcast("travel.map.patch", { tripId: job.tripId, itineraryVersion: job.itineraryVersion, mapVersion: job.mapVersion, sequence: snapshot.sequence, replaceAll, places: { upsert: snapshot.places, remove: replaceAll ? job.removedEntityIds : applied.removedEntityIds }, visits: { upsert: snapshot.visits, remove: [] }, entities: { upsert: snapshot.entities, remove: replaceAll ? job.removedEntityIds : applied.removedEntityIds }, routes: { upsert: snapshot.routes, remove: replaceAll ? job.removedRouteIds : applied.removedRouteIds }, dayPaths: snapshot.dayPaths, dayProgress: snapshot.dayProgress });
        const position = job.nextCommit++; job.pendingLocationDays.push({ position, dayNumber: buffered.run.dayNumber }); this.pumpLocationDays(job);
      }
    } catch (error) {
      const summary = publicError(error); this.options.tasks.update(job.taskId, "running", `地图日数据提交失败：${summary}`, "map:day-commit-failed");
      job.failedPositions.add(job.nextCommit); job.settledPositions.add(job.nextCommit); job.nextCommit += 1;
      if (job.buffered.size || job.failedPositions.has(job.nextCommit)) queueMicrotask(() => void this.drain(job));
    } finally { job.draining = false; this.checkFinished(job); }
  }

  private pumpLocationDays(job: MapJob) {
    while (this.isCurrent(job) && job.activeLocationDays < 3 && job.pendingLocationDays.length) {
      const item = job.pendingLocationDays.shift()!; job.activeLocationDays += 1;
      void this.processDay(job, item.position, item.dayNumber).finally(() => { job.activeLocationDays = Math.max(0, job.activeLocationDays - 1); this.pumpLocationDays(job); this.checkFinished(job); });
    }
  }

  private async processDay(job: MapJob, position: number, dayNumber: number) {
    let claimedEntityIds: string[] = []; let waitingEntityIds: string[] = []; let threadId = "";
    try {
      const batch = await this.options.maps.resolveLocationsForDay(job.tripId, job.itineraryVersion, job.mapVersion, dayNumber, job.token);
      if (!this.isCurrent(job)) return;
      if (!batch.length) {
        void this.options.maps.resolveDayRoutes(job.tripId, job.itineraryVersion, job.mapVersion, dayNumber, job.token)
          .then(() => this.daySettled(job, position))
          .catch((error) => this.finishResolutionFallback(job, position, dayNumber, publicError(error)));
        return;
      }
      const { claimed, waiting } = this.claimResolution(job, batch.map((item) => item.entityId));
      claimedEntityIds = claimed; waitingEntityIds = waiting;
      if (!claimed.length) {
        await this.waitForResolution(job, waiting);
        if (!this.isCurrent(job)) return;
        void this.options.maps.resolveDayRoutes(job.tripId, job.itineraryVersion, job.mapVersion, dayNumber, job.token).then(() => this.daySettled(job, position)).catch((error) => this.finishResolutionFallback(job, position, dayNumber, publicError(error)));
        return;
      }
      threadId = await this.createThread(job);
      const run: DayRun = { kind: "map", phase: "resolution", jobToken: job.token, taskId: job.taskId, tripId: job.tripId, itineraryVersion: job.itineraryVersion, mapVersion: job.mapVersion, baseMapVersion: job.baseMapVersion, dayNumber, position, attempt: 0, claimedEntityIds: claimed, waitingEntityIds: waiting, content: "" };
      this.runs.set(threadId, run);
      const input = JSON.stringify({ contract: "travel-map-resolution:v1", baseItineraryVersion: job.itineraryVersion, baseMapVersion: job.mapVersion, pendingLocations: batch.filter((item) => claimed.includes(item.entityId)), responseSchema: MapResolutionOutputJsonSchema }, null, 2);
      const result = await this.options.codex.call("turn/start", { threadId, summary: "detailed", input: [{ type: "text", text: `${this.options.prompt}\n\n本轮受控状态：\n${input}`, text_elements: [] }], outputSchema: MapResolutionOutputJsonSchema, ...this.options.modelOptions() }, 120000);
      if (this.runs.get(threadId) === run) run.turnId = String(result?.turn?.id || run.turnId || "");
    } catch (error) {
      const runEntry = threadId ? ([threadId, this.runs.get(threadId)] as const) : undefined;
      if (runEntry?.[1]) { this.runs.delete(runEntry[0]); if (runEntry[1].turnId) void this.options.codex.call("turn/interrupt", { threadId: runEntry[0], turnId: runEntry[1].turnId }).catch(() => undefined); }
      await this.finishResolutionFallback(job, position, dayNumber, publicError(error), claimedEntityIds, waitingEntityIds);
    }
  }

  private async finishResolutionFallback(job: MapJob, position: number, dayNumber: number, detail: string, claimedEntityIds: string[] = [], waitingEntityIds: string[] = []) {
    if (!this.isCurrent(job)) return;
    this.options.tasks.update(job.taskId, "running", `Day ${dayNumber} 坐标补充失败，使用可用结果继续：${detail}`, `map:day-partial-${dayNumber}`);
    try { await this.options.maps.settleUnresolvedWithCityFallback(job.tripId, job.itineraryVersion, job.mapVersion, dayNumber, job.token, claimedEntityIds.length ? claimedEntityIds : undefined); this.releaseResolution(job, claimedEntityIds); await this.waitForResolution(job, waitingEntityIds); const routing = this.options.maps.resolveDayRoutes(job.tripId, job.itineraryVersion, job.mapVersion, dayNumber, job.token); this.pumpLocationDays(job); await routing; }
    catch { /* The day remains partial; other days continue. */ }
    this.daySettled(job, position);
  }

  private daySettled(job: MapJob, position: number) {
    if (!this.isCurrent(job)) return; job.settledPositions.add(position);
    const snapshot = this.options.maps.snapshot(job.tripId, "all", null); const located = snapshot?.places.filter((place) => place.location).length ?? 0; const total = snapshot?.places.length ?? 0; const routes = snapshot?.routes.filter((route) => route.status === "resolved").length ?? 0; const routeTotal = snapshot?.routes.length ?? 0;
    const summary = `已定位 ${located}/${total} 个地点 · 已生成 ${routes}/${routeTotal} 条路线`;
    this.options.store.setMapStatus(job.tripId, job.itineraryVersion, "resolving", summary);
    this.options.tasks.update(job.taskId, "running", summary, `map:progress-${position}`);
    this.options.broadcast("travel.map.job.updated", { tripId: job.tripId, itineraryVersion: job.itineraryVersion, mapVersion: job.mapVersion, status: "resolving", summary });
    this.pumpLocationDays(job); this.checkFinished(job);
  }

  private checkFinished(job: MapJob) {
    if (!this.isCurrent(job) || job.settledPositions.size < job.days.length || job.activeAnalyses || job.activeLocationDays || job.pendingLocationDays.length || job.buffered.size) return;
    if (!job.replaceApplied && job.forceRebuild) {
      const summary = "新地图逐日分析均未成功，已保留旧地图";
      this.options.store.setMapStatus(job.tripId, job.itineraryVersion, "failed", summary); this.options.tasks.update(job.taskId, "failed", summary, "map:all-days-failed");
      this.options.broadcast("travel.map.job.updated", { tripId: job.tripId, itineraryVersion: job.itineraryVersion, mapVersion: job.mapVersion, status: "failed", summary }); this.jobs.delete(job.tripId); this.options.maps.deactivateRun(job.tripId, job.token); return;
    }
    try { this.options.maps.finalize(job.tripId, job.itineraryVersion, job.mapVersion); }
    catch (error) { const summary = publicError(error); this.options.store.setMapStatus(job.tripId, job.itineraryVersion, "partial", summary); this.options.tasks.update(job.taskId, "failed", summary, "map:finalize-failed"); }
    this.jobs.delete(job.tripId); this.options.maps.deactivateRun(job.tripId, job.token);
  }
}
