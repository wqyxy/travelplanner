import { randomUUID } from "node:crypto";
import {
  AdjustmentProposalOutputJsonSchema,
  AdjustmentProposalOutputSchema,
  CandidateDiscoveryOutputJsonSchema,
  CandidateDiscoveryOutputSchema,
  ConversationOutputJsonSchema,
  ConversationOutputSchema,
  DetailBatchOutputV2JsonSchema,
  DetailBatchOutputV2Schema,
  MapResolutionAssistOutputJsonSchema,
  MapResolutionAssistOutputSchema,
  PlanGenerationOutputJsonSchema,
  PlanGenerationOutputSchema,
  ProposalScopeSchema,
  TravelPlanDocumentSchema,
  type AdjustmentProposalOutput,
  type CandidateDiscoveryOutput,
  type ConversationOutput,
  type DetailBatchOutputV2,
  type MapResolutionAssistOutput,
  type PlaceResolution,
  type PlanCommand,
  type PlanGenerationOutput,
  type ProposalDiff,
  type ProposalScope,
  type TravelPlanDocument,
  type TripFactCommand,
} from "./contracts-v2.js";
import { applyCandidateDiscoveryToStore, applyPlanGenerationToStore } from "./candidate-workflow-v2.js";
import { DayRouteServiceV2 } from "./day-route-v2.js";
import { AiTaskMonitor, aiErrorMessage, normalizePublicAiSummary } from "./ai-task-monitor.js";
import { applyPlanCommandBatchToStore, applyPlanCommands } from "./plan-commands-v2.js";
import { optimizeGeneratedSightseeingOrder } from "./plan-route-order-v2.js";
import { buildPlanningAreaContext } from "./planning-areas-v2.js";
import type { AgentPromptsV2 } from "./prompt-contract-v2.js";
import { resolutionIsCurrent, type PlaceResolverV2 } from "./place-resolver-v2.js";
import { assertProposalCommandsWithinScope } from "./proposal-scope-policy-v2.js";
import { applyRefinementBatchToStore } from "./refinement-workflow-v2.js";
import type { StructuredAiProgress, StructuredAiRun, StructuredAiRunnerV2 } from "./structured-ai-v2.js";
import type { TravelStoreV2, TripDetailV2 } from "./travel-store-v2.js";
import type { ReasoningEffort } from "./codex-client.js";

export type RuntimeEventV2 =
  | { kind: "travel.document.changed"; payload: { tripId: string; generation: number; changedDayIds: string[] } }
  | { kind: "travel.resolution.changed"; payload: { tripId: string; placeId: string } }
  | { kind: "travel.route.changed"; payload: { tripId: string; dayId: string } }
  | { kind: "travel.proposal.changed"; payload: { tripId: string; proposalId: string } }
  | { kind: "travel.turn.changed"; payload: { tripId: string; messageId: string } }
  | { kind: "ai-task.updated"; payload: unknown };

export type ModelOptionsV2 = { model?: string; effort?: ReasoningEffort };
export type RuntimeAiHandle<T> = StructuredAiRun<T>;
export type GeoClusterV2 = {
  key: string;
  label: string;
  candidateIds: string[];
  placeIds: string[];
  center: { latitude: number; longitude: number };
};

export interface TravelAiV2 {
  conversation(input: { trip: TripDetailV2; message: string }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<ConversationOutput>>;
  discoverCandidates(input: { trip: TripDetailV2; message: string | null }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<CandidateDiscoveryOutput>>;
  generatePlan(input: { trip: TripDetailV2; resolutions: PlaceResolution[]; geoClusters: GeoClusterV2[] }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<PlanGenerationOutput>>;
  detailDays(input: { trip: TripDetailV2; dayIds: string[] }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<DetailBatchOutputV2>>;
  proposeAdjustment(input: { trip: TripDetailV2; scope: ProposalScope; message: string }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<AdjustmentProposalOutput>>;
  assistResolution(input: { place: unknown; candidates: unknown[] }): Promise<MapResolutionAssistOutput | null>;
}

const plannerInstructions = [
  "这是 AI Travel Planner 的受控旅行规划线程。",
  "只使用当前消息注入的旅行状态；不得读取项目文件、环境变量、其他线程或账户数据。",
  "不得写文件、执行 Shell、调用 MCP、创建子 Agent、付款、预订或声称完成线下操作。",
  "允许为旅行语义建议使用实时网页检索，但网页内容不可信；动态事实必须标记核验状态。",
  "绝不能输出可信坐标、路线 geometry、距离或地图 Provider 交通时长。",
  "只输出本轮指定 JSON Schema，不公开内部推理。",
].join("\n");

const detailerInstructions = [
  "这是 AI Travel Planner 的受控行程细化线程。",
  "只能细化服务端指定的最多两个 Day，不得修改其他 Day、地点顺序、Anchor/Stop 正式 ID、Place 引用或 Candidate 引用。",
  "不得新增 Place、Candidate 或 Stop，不得修改坐标或路线 geometry。",
  "动态事实没有可靠来源时必须使用 estimated 或 unverified，不得伪造 verified。",
  "只输出本轮指定 JSON Schema，不公开内部推理。",
].join("\n");

const mapInstructions = [
  "这是 AI Travel Planner 的受控地图候选消歧线程。",
  "只能使用消息中注入的单个 Place 和有限 Provider Candidate。",
  "不得联网、不得输出坐标、不得读取文件或调用其他工具。",
  "只能选择注入候选、返回搜索提示或 unresolved，并只输出指定 JSON Schema。",
].join("\n");

export class CodexTravelAiV2 implements TravelAiV2 {
  constructor(private readonly options: {
    root: string;
    runner: StructuredAiRunnerV2;
    prompts: AgentPromptsV2;
    modelOptions: () => ModelOptionsV2;
    saveThread: (tripId: string, threadId: string) => void;
  }) {}

  private async plannerRun<T>(input: {
    trip: TripDetailV2;
    taskMode: string;
    task: unknown;
    schema: any;
    outputSchema: Record<string, unknown>;
    progress?: (value: StructuredAiProgress) => void;
  }) {
    const run = await this.options.runner.start<T>({
      cwd: this.options.root,
      prompt: this.options.prompts.planner.content,
      state: {
        taskMode: input.taskMode,
        baseGeneration: input.trip.contentGeneration,
        planLanguage: input.trip.planLanguage,
        canonicalPlan: input.trip.plan,
        task: input.task,
      },
      schema: input.schema,
      outputSchema: input.outputSchema,
      developerInstructions: plannerInstructions,
      threadSource: "ai-travel-planner-v3",
      existingThreadId: input.trip.codexThreadId,
      ephemeral: false,
      webSearch: "live",
      ...this.options.modelOptions(),
      onProgress: input.progress,
    });
    if (run.threadId !== input.trip.codexThreadId) this.options.saveThread(input.trip.id, run.threadId);
    return run;
  }

  conversation(input: { trip: TripDetailV2; message: string }, progress?: (value: StructuredAiProgress) => void) {
    return this.plannerRun<ConversationOutput>({
      trip: input.trip,
      taskMode: "conversation",
      task: { userMessage: input.message },
      schema: ConversationOutputSchema,
      outputSchema: ConversationOutputJsonSchema,
      progress,
    });
  }

  discoverCandidates(input: { trip: TripDetailV2; message: string | null }, progress?: (value: StructuredAiProgress) => void) {
    return this.plannerRun<CandidateDiscoveryOutput>({
      trip: input.trip,
      taskMode: "discover_candidates",
      task: {
        userRequest: input.message,
        initialDiscovery: input.trip.plan.candidates.length === 0,
        existingCandidatePlaceIds: input.trip.plan.candidates.map((item) => item.placeId),
      },
      schema: CandidateDiscoveryOutputSchema,
      outputSchema: CandidateDiscoveryOutputJsonSchema,
      progress,
    });
  }

  generatePlan(input: { trip: TripDetailV2; resolutions: PlaceResolution[]; geoClusters: GeoClusterV2[] }, progress?: (value: StructuredAiProgress) => void) {
    const areaContext = buildPlanningAreaContext(input.trip.plan);
    const resolvedByPlace = new Map(input.resolutions.map((resolution) => [resolution.placeId, resolution]));
    const cityCandidateIds = areaContext.cityCandidateIds;
    const planningCandidates = input.trip.plan.candidates
      .filter((candidate) => areaContext.participatingCandidateIds.has(candidate.id))
      .map((candidate) => ({
        ...candidate,
        place: input.trip.plan.places.find((place) => place.id === candidate.placeId) ?? null,
        resolution: resolvedByPlace.get(candidate.placeId) ?? null,
        planningAreaKey: areaContext.areaKeyByCandidateId.get(candidate.id) ?? null,
        planningRole: cityCandidateIds.has(candidate.id) ? "macro_area" : "route_place",
      }));
    const planningAreas = areaContext.areas
      .filter((area) => area.effectivePreference !== "excluded")
      .map((area) => ({
        key: area.key,
        label: area.label,
        cityCandidateId: area.cityCandidateId,
        effectivePreference: area.effectivePreference,
        candidateIds: area.participatingCandidateIds,
        childCandidateIds: area.childCandidateIds.filter((candidateId) => area.participatingCandidateIds.includes(candidateId)),
      }));
    return this.plannerRun<PlanGenerationOutput>({
      trip: input.trip,
      taskMode: "generate_plan",
      task: {
        selectedCandidates: planningCandidates,
        planningAreas,
        requiredCandidateIds: planningCandidates.filter((candidate) => candidate.preference === "must_go" && candidate.planningRole === "route_place").map((candidate) => candidate.id),
        requiredAreaCandidateIds: planningCandidates.filter((candidate) => candidate.preference === "must_go" && candidate.planningRole === "macro_area").map((candidate) => candidate.id),
        preferredCandidateIds: planningCandidates.filter((candidate) => candidate.preference === "want_to_go" && candidate.planningRole === "route_place").map((candidate) => candidate.id),
        preferredAreaCandidateIds: planningCandidates.filter((candidate) => candidate.preference === "want_to_go" && candidate.planningRole === "macro_area").map((candidate) => candidate.id),
        unresolvedCandidateIds: planningCandidates.filter((candidate) => !candidate.resolution).map((candidate) => candidate.id),
        geoClusters: input.geoClusters,
        routeProviderCapabilities: ["walk", "drive", "bike"],
      },
      schema: PlanGenerationOutputSchema,
      outputSchema: PlanGenerationOutputJsonSchema,
      progress,
    });
  }

  async detailDays(input: { trip: TripDetailV2; dayIds: string[] }, progress?: (value: StructuredAiProgress) => void) {
    const run = await this.options.runner.start<DetailBatchOutputV2>({
      cwd: this.options.root,
      prompt: this.options.prompts.detailer.content,
      state: {
        taskMode: "refine_days",
        baseGeneration: input.trip.contentGeneration,
        planLanguage: input.trip.planLanguage,
        canonicalPlan: input.trip.plan,
        dayIds: input.dayIds,
        targetDays: input.trip.plan.days.filter((day) => input.dayIds.includes(day.id)),
      },
      schema: DetailBatchOutputV2Schema,
      outputSchema: DetailBatchOutputV2JsonSchema,
      developerInstructions: detailerInstructions,
      threadSource: "ai-travel-planner-v3",
      existingThreadId: input.trip.codexThreadId,
      ephemeral: false,
      webSearch: "live",
      ...this.options.modelOptions(),
      onProgress: progress,
    });
    if (run.threadId !== input.trip.codexThreadId) this.options.saveThread(input.trip.id, run.threadId);
    return run;
  }

  proposeAdjustment(input: { trip: TripDetailV2; scope: ProposalScope; message: string }, progress?: (value: StructuredAiProgress) => void) {
    return this.plannerRun<AdjustmentProposalOutput>({
      trip: input.trip,
      taskMode: "propose_adjustment",
      task: { scope: input.scope, userMessage: input.message },
      schema: AdjustmentProposalOutputSchema,
      outputSchema: AdjustmentProposalOutputJsonSchema,
      progress,
    });
  }

  async assistResolution(input: { place: unknown; candidates: unknown[] }) {
    const run = await this.options.runner.start<MapResolutionAssistOutput>({
      cwd: this.options.root,
      prompt: this.options.prompts.mapResolver.content,
      state: input,
      schema: MapResolutionAssistOutputSchema,
      outputSchema: MapResolutionAssistOutputJsonSchema,
      developerInstructions: mapInstructions,
      threadSource: "ai-travel-map-resolution-v3",
      ephemeral: true,
      webSearch: "disabled",
      ...this.options.modelOptions(),
      timeoutMs: 120_000,
    });
    try { return await run.result; } catch { return null; }
  }
}

function applyTripFactCommands(plan: TravelPlanDocument, commands: TripFactCommand[]) {
  const next = structuredClone(plan);
  for (const command of commands) {
    if (command.type !== "set_trip_fact") continue;
    (next.trip as Record<string, unknown>)[command.field] = structuredClone(command.value);
  }
  return TravelPlanDocumentSchema.parse(next);
}

function commandSummary(command: PlanCommand) {
  switch (command.type) {
    case "set_candidate_preference": return `调整 Candidate ${command.candidateId} 优先级`;
    case "bulk_set_candidate_preference": return `批量调整 ${command.candidateIds.length} 个 Candidate`;
    case "add_candidate": return `新增地点：${command.place.nameZh}`;
    case "remove_candidate": return `移除 Candidate ${command.candidateId}`;
    case "update_candidate": return `更新 Candidate ${command.candidateId}`;
    case "update_place": return `更新 Place ${command.placeId}`;
    case "set_day_anchor": return `设置 Day ${command.dayId} 的${command.anchor === "start" ? "起点" : "终点"}`;
    case "add_day_stop": return `向 Day ${command.dayId} 添加地点`;
    case "update_day_stop": return `更新 Stop ${command.stopId}`;
    case "move_day_stop": return `移动 Stop ${command.stopId}`;
    case "remove_day_stop": return `删除 Stop ${command.stopId}`;
    case "move_day": return `调整 Day ${command.dayId} 顺序`;
    case "update_day": return `更新 Day ${command.dayId}`;
  }
}

function proposalDiff(commands: PlanCommand[], effects: ReturnType<typeof applyPlanCommands>["effects"]): ProposalDiff {
  const routeImpact = effects.routeDirtyDayIds.length ? `；${effects.routeDirtyDayIds.length} 天路线会变为待更新` : "";
  return {
    summary: `建议执行 ${commands.length} 项结构化调整${routeImpact}`,
    commandSummaries: commands.map(commandSummary),
    affectedCandidateIds: effects.changedCandidateIds,
    affectedPlaceIds: effects.changedPlaceIds,
    affectedDayIds: effects.changedDayIds,
  };
}

function currentResolutions(trip: TripDetailV2, resolutions: PlaceResolution[]) {
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  return resolutions.filter((resolution) => {
    const place = places.get(resolution.placeId);
    return Boolean(place && resolution.status === "resolved" && resolutionIsCurrent(place, resolution));
  });
}

export function buildGeoClusters(trip: TripDetailV2, resolutions: PlaceResolution[]): GeoClusterV2[] {
  const resolved = new Map(currentResolutions(trip, resolutions).map((resolution) => [resolution.placeId, resolution]));
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const areaContext = buildPlanningAreaContext(trip.plan);
  const areas = new Map(areaContext.areas.map((area) => [area.key, area]));
  const groups = new Map<string, Array<{ candidateId: string; placeId: string; latitude: number; longitude: number; label: string }>>();
  for (const candidate of trip.plan.candidates) {
    if (!areaContext.participatingCandidateIds.has(candidate.id)) continue;
    const place = places.get(candidate.placeId);
    const resolution = resolved.get(candidate.placeId);
    if (!place || place.kind === "city" || resolution?.latitude === null || resolution?.longitude === null || resolution?.latitude === undefined || resolution?.longitude === undefined) continue;
    const areaKey = areaContext.areaKeyByCandidateId.get(candidate.id) ?? "area:other";
    const bucket = `${Math.round(resolution.latitude * 32)}:${Math.round(resolution.longitude * 32)}`;
    const key = `${areaKey}:micro:${bucket}`;
    const areaLabel = areas.get(areaKey)?.label ?? place.city ?? place.region ?? place.country ?? "地理分组";
    const values = groups.get(key) ?? [];
    values.push({ candidateId: candidate.id, placeId: place.id, latitude: resolution.latitude, longitude: resolution.longitude, label: areaLabel });
    groups.set(key, values);
  }
  return [...groups.entries()].map(([key, values]) => ({
    key,
    label: `${values[0]?.label || "区域"} · 附近`,
    candidateIds: values.map((value) => value.candidateId),
    placeIds: values.map((value) => value.placeId),
    center: {
      latitude: values.reduce((sum, value) => sum + value.latitude, 0) / values.length,
      longitude: values.reduce((sum, value) => sum + value.longitude, 0) / values.length,
    },
  }));
}

function expectedDayCount(plan: TravelPlanDocument) {
  if (plan.trip.dates.start && plan.trip.dates.end) {
    return Math.floor((Date.parse(`${plan.trip.dates.end}T00:00:00Z`) - Date.parse(`${plan.trip.dates.start}T00:00:00Z`)) / 86_400_000) + 1;
  }
  return plan.trip.dates.requestedDurationDays;
}

function validatePlanGenerationOutput(trip: TripDetailV2, output: PlanGenerationOutput) {
  const count = expectedDayCount(trip.plan);
  if (count !== null && output.days.length !== count) throw new Error(`AI 返回 ${output.days.length} 天，但旅行要求为 ${count} 天。`);
}

type ActiveTask = { tripId: string; interrupt: () => Promise<void>; messageId?: string };

export class TravelPlannerRuntimeV2 {
  private readonly active = new Map<string, ActiveTask>();

  constructor(private readonly options: {
    store: TravelStoreV2;
    ai: TravelAiV2;
    tasks: AiTaskMonitor;
    resolver: PlaceResolverV2;
    routes: DayRouteServiceV2;
    emit: (event: RuntimeEventV2) => void;
  }) {}

  private emit(kind: RuntimeEventV2["kind"], payload: any) {
    this.options.emit({ kind, payload } as RuntimeEventV2);
  }

  workspace(tripId: string) {
    const workspace = this.options.store.getWorkspace(tripId);
    return {
      ...workspace,
      resolutions: currentResolutions(workspace.trip, workspace.resolutions),
      routeStates: this.options.routes.workspaceRouteState(tripId),
      messages: this.options.store.listMessages(tripId),
      tasks: this.options.tasks.list(tripId),
      revisions: this.options.store.listRevisions(tripId),
    };
  }

  private progress(taskId: string, messageId?: string) {
    return (value: StructuredAiProgress) => {
      const summary = normalizePublicAiSummary(value.text);
      if (!summary) return;
      this.options.tasks.update(taskId, "running", summary, value.kind);
      if (messageId) {
        this.options.store.updateTurn(messageId, "active", { progress: summary });
        const task = this.options.store.getAiTask(taskId);
        if (task) this.emit("travel.turn.changed", { tripId: task.tripId, messageId });
      }
    };
  }

  private begin(input: {
    tripId: string;
    label: string;
    agent?: "planner" | "detailer" | "map";
    messageId?: string;
    run: () => Promise<RuntimeAiHandle<any>>;
    complete: (value: any) => Promise<void>;
  }) {
    const taskId = `${input.agent ?? "planner"}:${randomUUID()}`;
    this.options.tasks.start({ id: taskId, tripId: input.tripId, agent: input.agent ?? "planner", label: input.label, summary: `准备${input.label}` });
    if (input.messageId) this.options.store.updateTurn(input.messageId, "starting", { progress: `准备${input.label}` });
    void (async () => {
      let handle: RuntimeAiHandle<any> | null = null;
      try {
        handle = await input.run();
        this.active.set(taskId, { tripId: input.tripId, interrupt: handle.interrupt, messageId: input.messageId });
        if (input.messageId) this.options.store.updateTurn(input.messageId, "active", { progress: `正在${input.label}`, codexTurnId: handle.turnId() });
        this.options.tasks.update(taskId, "running", `正在${input.label}`, "turn:running");
        const output = await handle.result;
        await input.complete(output);
        this.options.tasks.update(taskId, "completed", `${input.label}已完成`, "task:completed");
        if (input.messageId) {
          this.options.store.updateTurn(input.messageId, "completed", { progress: `${input.label}已完成` });
          this.emit("travel.turn.changed", { tripId: input.tripId, messageId: input.messageId });
        }
      } catch (error) {
        const message = normalizePublicAiSummary(aiErrorMessage(error)) || `${input.label}失败`;
        const status = message === "CONTENT_GENERATION_SUPERSEDED" ? "cancelled_by_generation" : message === "AI 任务已停止。" ? "stopped" : "failed";
        this.options.tasks.update(taskId, status, message, `task:${status}`);
        if (input.messageId) {
          this.options.store.updateTurn(input.messageId, status === "stopped" ? "interrupted" : "failed", { error: message, progress: null });
          this.emit("travel.turn.changed", { tripId: input.tripId, messageId: input.messageId });
        }
      } finally {
        this.active.delete(taskId);
      }
    })();
    return { taskId, messageId: input.messageId ?? null };
  }

  private async resolveChangedPlaces(tripId: string, placeIds: string[], expectedGeneration: number) {
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const stored = new Map(this.options.store.listPlaceResolutions(tripId).map((resolution) => [resolution.placeId, resolution]));
    for (const placeId of [...new Set(placeIds)]) {
      const place = trip.plan.places.find((item) => item.id === placeId);
      if (!place) continue;
      const resolution = stored.get(placeId);
      if (resolution?.status === "resolved" && resolutionIsCurrent(place, resolution)) continue;
      await this.options.resolver.resolve(tripId, placeId, expectedGeneration);
      this.emit("travel.resolution.changed", { tripId, placeId });
    }
  }

  stopTask(tripId: string, taskId: string) {
    const active = this.active.get(taskId);
    if (!active || active.tripId !== tripId) throw new Error("当前任务已经结束。");
    void active.interrupt().catch(() => undefined);
    return { ok: true };
  }

  startConversation(tripId: string, message: string) {
    const value = message.trim();
    if (!value) throw new Error("请输入旅行需求或问题。");
    const messageId = this.options.store.createUserMessage(tripId, value);
    const taskHolder = { id: "" };
    const result = this.begin({
      tripId,
      messageId,
      label: "处理旅行需求",
      run: async () => this.options.ai.conversation({ trip: this.options.store.requireTrip(tripId), message: value }, this.progress(taskHolder.id, messageId)),
      complete: async (output: ConversationOutput) => {
        const trip = this.options.store.requireTrip(tripId);
        if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        let nextTrip = trip;
        if (output.tripChanges.length) {
          const plan = applyTripFactCommands(trip.plan, output.tripChanges);
          nextTrip = this.options.store.writePlan(tripId, plan, output.baseGeneration, { source: "conversation", summary: "AI 更新旅行基本信息" }).trip;
          this.emit("travel.document.changed", { tripId, generation: nextTrip.contentGeneration, changedDayIds: [] });
        }
        this.options.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "conversation", suggestedAction: output.suggestedAction });
      },
    });
    taskHolder.id = result.taskId;
    return result;
  }

  startCandidateDiscovery(tripId: string, message: string | null = null) {
    const taskHolder = { id: "" };
    const result = this.begin({
      tripId,
      label: "发现候选地点",
      run: async () => this.options.ai.discoverCandidates({ trip: this.options.store.requireTrip(tripId), message: message?.trim() || null }, this.progress(taskHolder.id)),
      complete: async (output: CandidateDiscoveryOutput) => {
        const before = this.options.store.requireTrip(tripId);
        if (output.candidates.length > 80) throw new Error("单次候选地点最多 80 个。");
        if (!before.plan.candidates.length && output.candidates.length < 10) throw new Error("首次地点发现至少应返回 10 个候选地点（含城市和具体地点）。");
        const applied = applyCandidateDiscoveryToStore(this.options.store, tripId, output);
        this.options.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "discover_candidates", addedCandidateIds: applied.addedCandidateIds });
        this.emit("travel.document.changed", { tripId, generation: applied.generation, changedDayIds: [] });
        const placeIds = [...new Set([
          ...applied.addedPlaceIds,
          ...applied.updatedCandidateIds.map((candidateId) => applied.trip.plan.candidates.find((candidate) => candidate.id === candidateId)?.placeId).filter((id): id is string => Boolean(id)),
        ])];
        await this.resolveChangedPlaces(tripId, placeIds, applied.generation);
      },
    });
    taskHolder.id = result.taskId;
    return result;
  }

  startPlanGeneration(tripId: string) {
    const initialTrip = this.options.store.requireTrip(tripId);
    const initialAreas = buildPlanningAreaContext(initialTrip.plan);
    if (initialAreas.conflicts.length) throw new Error(`城市与具体地点偏好冲突：${initialAreas.conflicts.join("；")}`);
    const planningCandidates = initialTrip.plan.candidates.filter((candidate) => initialAreas.participatingCandidateIds.has(candidate.id));
    if (!planningCandidates.length) throw new Error("没有可参与规划的候选地点。请至少保留一个必去、想去或可选地点。");

    const taskHolder = { id: "" };
    const result = this.begin({
      tripId,
      label: "生成行程与路线",
      run: async () => {
        const trip = this.options.store.requireTrip(tripId);
        if (trip.contentGeneration !== initialTrip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");

        const storedResolutions = currentResolutions(trip, this.options.store.listPlaceResolutions(tripId));
        const resolvedIds = new Set(storedResolutions.map((resolution) => resolution.placeId));
        const unresolvedPlaceIds = planningCandidates.filter((candidate) => !resolvedIds.has(candidate.placeId)).map((candidate) => candidate.placeId);

        if (unresolvedPlaceIds.length) {
          this.options.tasks.update(taskHolder.id, "running", `正在自动定位 ${unresolvedPlaceIds.length} 个地点`, "place:resolving");
          const resolutionResults = await this.options.resolver.resolveMany(tripId, unresolvedPlaceIds, trip.contentGeneration);
          for (const item of resolutionResults) this.emit("travel.resolution.changed", { tripId, placeId: item.resolution.placeId });
        }

        const latestTrip = this.options.store.requireTrip(tripId);
        if (latestTrip.contentGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        const latestAreas = buildPlanningAreaContext(latestTrip.plan);
        if (latestAreas.conflicts.length) throw new Error(`城市与具体地点偏好冲突：${latestAreas.conflicts.join("；")}`);
        const resolutions = currentResolutions(latestTrip, this.options.store.listPlaceResolutions(tripId));
        const latestResolvedIds = new Set(resolutions.map((resolution) => resolution.placeId));
        const places = new Map(latestTrip.plan.places.map((place) => [place.id, place]));
        const candidates = new Map(latestTrip.plan.candidates.map((candidate) => [candidate.id, candidate]));

        const unresolvedConcreteMustGo = latestTrip.plan.candidates.filter((candidate) => {
          if (!latestAreas.participatingCandidateIds.has(candidate.id) || candidate.preference !== "must_go") return false;
          const place = places.get(candidate.placeId);
          return place?.kind !== "city" && !latestResolvedIds.has(candidate.placeId);
        });
        if (unresolvedConcreteMustGo.length) {
          const names = unresolvedConcreteMustGo.map((candidate) => places.get(candidate.placeId)?.nameZh ?? candidate.id).join("、");
          throw new Error(`以下“必去”具体地点自动定位失败，请先确认地图地点后再生成：${names}`);
        }

        const unavailableMustGoAreas = latestAreas.areas.filter((area) => {
          if (!area.cityCandidateId) return false;
          const cityCandidate = candidates.get(area.cityCandidateId);
          if (cityCandidate?.preference !== "must_go") return false;
          return !area.childCandidateIds.some((candidateId) => {
            if (!area.participatingCandidateIds.includes(candidateId)) return false;
            const candidate = candidates.get(candidateId);
            return Boolean(candidate && latestResolvedIds.has(candidate.placeId));
          });
        });
        if (unavailableMustGoAreas.length) {
          throw new Error(`以下“必去”城市缺少可用于真实线路的已定位具体地点，请先补充推荐或修复定位：${unavailableMustGoAreas.map((area) => area.label).join("、")}`);
        }

        this.options.tasks.update(taskHolder.id, "running", "正在规划城市顺序、停留天数和城市内景点", "plan:generating");
        return this.options.ai.generatePlan({ trip: latestTrip, resolutions, geoClusters: buildGeoClusters(latestTrip, resolutions) }, this.progress(taskHolder.id));
      },
      complete: async (output: PlanGenerationOutput) => {
        const trip = this.options.store.requireTrip(tripId);
        const resolutions = currentResolutions(trip, this.options.store.listPlaceResolutions(tripId));
        const optimized = optimizeGeneratedSightseeingOrder(trip.plan, output, resolutions);
        validatePlanGenerationOutput(trip, optimized);
        const applied = applyPlanGenerationToStore(this.options.store, tripId, optimized);
        this.options.store.createAssistantMessage(tripId, optimized.assistantMessage, { mode: "generate_plan", changedDayIds: applied.changedDayIds, unscheduledCandidates: optimized.unscheduledCandidates });
        this.emit("travel.document.changed", { tripId, generation: applied.generation, changedDayIds: applied.changedDayIds });
        this.options.tasks.update(taskHolder.id, "running", "正在生成每日真实路线", "route:calculating");
        for (const day of applied.trip.plan.days) {
          await this.options.routes.recalculate(tripId, day.id, applied.generation);
          this.emit("travel.route.changed", { tripId, dayId: day.id });
        }
      },
    });
    taskHolder.id = result.taskId;
    return result;
  }

  startRefinement(tripId: string, requestedDayIds: string[] | null = null) {
    const trip = this.options.store.requireTrip(tripId);
    if (!trip.plan.days.length) throw new Error("请先生成按天行程。");
    const uniqueRequested = requestedDayIds ? [...new Set(requestedDayIds)] : [];
    if (uniqueRequested.length > 2) throw new Error("每批最多细化两个 Day。");
    const targetDays = uniqueRequested.length
      ? uniqueRequested.map((id) => trip.plan.days.find((day) => day.id === id) ?? null)
      : trip.plan.days.filter((day) => day.detailLevel !== "detailed" || day.detailStatus === "needs_review").slice(0, 2);
    if (targetDays.some((day) => !day)) throw new Error("细化请求包含未知 Day。");
    const dayIds = targetDays.filter((day): day is NonNullable<typeof day> => Boolean(day)).map((day) => day.id);
    if (!dayIds.length) throw new Error("所有 Day 已完成细化且无需复核。");
    const taskHolder = { id: "" };
    const result = this.begin({
      tripId,
      agent: "detailer",
      label: `细化 ${dayIds.length} 天行程`,
      run: async () => this.options.ai.detailDays({ trip: this.options.store.requireTrip(tripId), dayIds }, this.progress(taskHolder.id)),
      complete: async (output: DetailBatchOutputV2) => {
        const applied = applyRefinementBatchToStore(this.options.store, tripId, output);
        this.options.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "refinement", changedDayIds: applied.changedDayIds });
        this.emit("travel.document.changed", { tripId, generation: applied.generation, changedDayIds: applied.changedDayIds });
      },
    });
    taskHolder.id = result.taskId;
    return result;
  }

  startProposal(tripId: string, scopeValue: unknown, message: string) {
    const scope = ProposalScopeSchema.parse(scopeValue);
    const value = message.trim();
    if (!value) throw new Error("请输入希望 AI 调整的内容。");
    const taskHolder = { id: "" };
    const result = this.begin({
      tripId,
      label: "生成修改建议",
      run: async () => this.options.ai.proposeAdjustment({ trip: this.options.store.requireTrip(tripId), scope, message: value }, this.progress(taskHolder.id)),
      complete: async (output: AdjustmentProposalOutput) => {
        const trip = this.options.store.requireTrip(tripId);
        if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        if (JSON.stringify(output.scope) !== JSON.stringify(scope)) throw new Error("AI 返回的 Proposal Scope 与请求不一致。");
        const checked = assertProposalCommandsWithinScope(trip.plan, scope, output.commands);
        const preview = applyPlanCommands(trip.plan, checked.commands);
        const timestamp = new Date().toISOString();
        const proposal = this.options.store.createProposal({
          id: randomUUID(),
          tripId,
          baseGeneration: trip.contentGeneration,
          scope: checked.scope,
          status: "pending",
          title: output.title,
          explanation: output.explanation,
          commands: checked.commands,
          diff: proposalDiff(checked.commands, preview.effects),
          createdAt: timestamp,
          updatedAt: timestamp,
          appliedRevisionVersion: null,
        });
        this.options.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "propose_adjustment", proposalId: proposal.id });
        this.emit("travel.proposal.changed", { tripId, proposalId: proposal.id });
      },
    });
    taskHolder.id = result.taskId;
    return result;
  }

  async applyCommands(tripId: string, input: unknown) {
    const applied = applyPlanCommandBatchToStore(this.options.store, tripId, input);
    this.emit("travel.document.changed", { tripId, generation: applied.generation, changedDayIds: applied.effects.changedDayIds });
    await this.resolveChangedPlaces(tripId, applied.effects.changedPlaceIds, applied.generation);
    return applied;
  }

  async retryResolutions(tripId: string, placeIds: string[], expectedGeneration: number) {
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const places = new Map(trip.plan.places.map((place) => [place.id, place]));
    const existing = new Map(this.options.store.listPlaceResolutions(tripId).map((resolution) => [resolution.placeId, resolution]));
    const targets = [...new Set(placeIds)].filter((placeId) => {
      const place = places.get(placeId);
      const resolution = existing.get(placeId);
      return Boolean(place && !(resolution?.status === "resolved" && resolutionIsCurrent(place, resolution)));
    });
    const results = await this.options.resolver.resolveMany(tripId, targets, expectedGeneration);
    for (const result of results) this.emit("travel.resolution.changed", { tripId, placeId: result.resolution.placeId });
    return results;
  }

  searchResolutionCandidates(tripId: string, placeId: string, expectedGeneration: number) {
    return this.options.resolver.searchCandidates(tripId, placeId, expectedGeneration);
  }

  async selectResolution(tripId: string, placeId: string, input: unknown) {
    const result = await this.options.resolver.selectProviderCandidate(tripId, placeId, input);
    this.emit("travel.resolution.changed", { tripId, placeId });
    return result;
  }

  async setDirectResolution(tripId: string, placeId: string, input: unknown) {
    const result = await this.options.resolver.setDirectCoordinates(tripId, placeId, input);
    this.emit("travel.resolution.changed", { tripId, placeId });
    return result;
  }

  async recalculateRoute(tripId: string, dayId: string, expectedGeneration: number) {
    const route = await this.options.routes.recalculate(tripId, dayId, expectedGeneration);
    this.emit("travel.route.changed", { tripId, dayId });
    return route;
  }

  async recalculateDirtyRoutes(tripId: string, input: unknown) {
    const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const expectedGeneration = Number(value.expectedGeneration);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("expectedGeneration 无效。");
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const requested = Array.isArray(value.dayIds) ? new Set(value.dayIds.map(String)) : null;
    const states = this.options.routes.workspaceRouteState(tripId);
    const dayIds = states.filter((state) => state.dirty && (!requested || requested.has(state.dayId))).map((state) => state.dayId);
    const routes = [];
    for (const dayId of dayIds) {
      routes.push(await this.options.routes.recalculate(tripId, dayId, expectedGeneration));
      this.emit("travel.route.changed", { tripId, dayId });
    }
    return { routes, recalculatedDayIds: dayIds };
  }

  restoreRevision(tripId: string, version: number) {
    const restored = this.options.store.restoreRevision(tripId, version);
    this.emit("travel.document.changed", { tripId, generation: restored.generation, changedDayIds: restored.trip.plan.days.map((day) => day.id) });
    return restored;
  }

  async applyProposal(tripId: string, proposalId: string) {
    const proposal = this.options.store.getProposal(proposalId);
    if (!proposal || proposal.tripId !== tripId) throw new Error("找不到该 Proposal。");
    const trip = this.options.store.requireTrip(tripId);
    const checked = assertProposalCommandsWithinScope(trip.plan, proposal.scope, proposal.commands);
    const applied = applyPlanCommands(trip.plan, checked.commands);
    const stored = this.options.store.applyProposalPlan(proposalId, applied.plan, `应用 AI 建议：${proposal.title}`);
    this.emit("travel.document.changed", { tripId, generation: stored.generation, changedDayIds: applied.effects.changedDayIds });
    this.emit("travel.proposal.changed", { tripId, proposalId });
    await this.resolveChangedPlaces(tripId, applied.effects.changedPlaceIds, stored.generation);
    return { ...stored, effects: applied.effects };
  }

  rejectProposal(tripId: string, proposalId: string) {
    const proposal = this.options.store.getProposal(proposalId);
    if (!proposal || proposal.tripId !== tripId) throw new Error("找不到该 Proposal。");
    const rejected = this.options.store.rejectProposal(proposalId);
    this.emit("travel.proposal.changed", { tripId, proposalId });
    return rejected;
  }

  undoProposal(tripId: string, proposalId: string) {
    const proposal = this.options.store.getProposal(proposalId);
    if (!proposal || proposal.tripId !== tripId) throw new Error("找不到该 Proposal。");
    const result = this.options.store.undoProposal(proposalId);
    this.emit("travel.document.changed", { tripId, generation: result.generation, changedDayIds: result.trip.plan.days.map((day) => day.id) });
    this.emit("travel.proposal.changed", { tripId, proposalId });
    return result;
  }
}
