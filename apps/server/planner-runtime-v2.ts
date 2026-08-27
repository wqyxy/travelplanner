import { randomUUID } from "node:crypto";
import {
  AdjustmentProposalOutputJsonSchema,
  AdjustmentProposalOutputSchema,
  CandidateDiscoveryOutputJsonSchema,
  CandidateDiscoveryOutputSchema,
  ConversationOutputJsonSchema,
  ConversationOutputSchema,
  MapResolutionAssistOutputJsonSchema,
  MapResolutionAssistOutputSchema,
  PlanGenerationOutputJsonSchema,
  PlanGenerationOutputSchema,
  ProposalScopeSchema,
  TravelPlanDocumentSchema,
  type AdjustmentProposalOutput,
  type CandidateDiscoveryOutput,
  type ConversationOutput,
  type MapResolutionAssistOutput,
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
import { applyPlanCommandBatchToStore, applyPlanCommands, assertCommandsWithinScope } from "./plan-commands-v2.js";
import type { AgentPromptsV2 } from "./prompt-contract-v2.js";
import type { PlaceResolverV2 } from "./place-resolver-v2.js";
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

export interface TravelAiV2 {
  conversation(input: { trip: TripDetailV2; message: string }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<ConversationOutput>>;
  discoverCandidates(input: { trip: TripDetailV2; message: string | null }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<CandidateDiscoveryOutput>>;
  generatePlan(input: { trip: TripDetailV2; resolvedPlaceIds: string[] }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<PlanGenerationOutput>>;
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
      state: { taskMode: input.taskMode, baseGeneration: input.trip.contentGeneration, planLanguage: input.trip.planLanguage, canonicalPlan: input.trip.plan, task: input.task },
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
    return this.plannerRun<ConversationOutput>({ trip: input.trip, taskMode: "conversation", task: { userMessage: input.message }, schema: ConversationOutputSchema, outputSchema: ConversationOutputJsonSchema, progress });
  }

  discoverCandidates(input: { trip: TripDetailV2; message: string | null }, progress?: (value: StructuredAiProgress) => void) {
    return this.plannerRun<CandidateDiscoveryOutput>({ trip: input.trip, taskMode: "discover_candidates", task: { userRequest: input.message, existingCandidatePlaceIds: input.trip.plan.candidates.map((item) => item.placeId) }, schema: CandidateDiscoveryOutputSchema, outputSchema: CandidateDiscoveryOutputJsonSchema, progress });
  }

  generatePlan(input: { trip: TripDetailV2; resolvedPlaceIds: string[] }, progress?: (value: StructuredAiProgress) => void) {
    const selected = input.trip.plan.candidates.filter((candidate) => candidate.preference !== "excluded" && input.resolvedPlaceIds.includes(candidate.placeId));
    return this.plannerRun<PlanGenerationOutput>({
      trip: input.trip,
      taskMode: "generate_plan",
      task: { selectedCandidates: selected, requiredCandidateIds: selected.filter((candidate) => candidate.preference === "must_go").map((candidate) => candidate.id), resolvedPlaceIds: input.resolvedPlaceIds },
      schema: PlanGenerationOutputSchema,
      outputSchema: PlanGenerationOutputJsonSchema,
      progress,
    });
  }

  proposeAdjustment(input: { trip: TripDetailV2; scope: ProposalScope; message: string }, progress?: (value: StructuredAiProgress) => void) {
    return this.plannerRun<AdjustmentProposalOutput>({ trip: input.trip, taskMode: "propose_adjustment", task: { scope: input.scope, userMessage: input.message }, schema: AdjustmentProposalOutputSchema, outputSchema: AdjustmentProposalOutputJsonSchema, progress });
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
  return {
    summary: `建议执行 ${commands.length} 项结构化调整`,
    commandSummaries: commands.map(commandSummary),
    affectedCandidateIds: effects.changedCandidateIds,
    affectedPlaceIds: effects.changedPlaceIds,
    affectedDayIds: effects.changedDayIds,
  };
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
    return {
      ...this.options.store.getWorkspace(tripId),
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

  private begin(input: { tripId: string; label: string; agent?: "planner" | "detailer" | "map"; messageId?: string; run: () => Promise<RuntimeAiHandle<any>>; complete: (value: any) => Promise<void> }) {
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
      run: async () => {
        const trip = this.options.store.requireTrip(tripId);
        return this.options.ai.conversation({ trip, message: value }, this.progress(taskHolder.id, messageId));
      },
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
      run: async () => {
        const trip = this.options.store.requireTrip(tripId);
        return this.options.ai.discoverCandidates({ trip, message: message?.trim() || null }, this.progress(taskHolder.id));
      },
      complete: async (output: CandidateDiscoveryOutput) => {
        const applied = applyCandidateDiscoveryToStore(this.options.store, tripId, output);
        this.options.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "discover_candidates", addedCandidateIds: applied.addedCandidateIds });
        this.emit("travel.document.changed", { tripId, generation: applied.generation, changedDayIds: [] });
        const placeIds = [...new Set([...applied.addedPlaceIds, ...applied.updatedCandidateIds.map((candidateId) => applied.trip.plan.candidates.find((candidate) => candidate.id === candidateId)?.placeId).filter((id): id is string => Boolean(id))])];
        for (const placeId of placeIds) {
          await this.options.resolver.resolve(tripId, placeId, applied.generation);
          this.emit("travel.resolution.changed", { tripId, placeId });
        }
      },
    });
    taskHolder.id = result.taskId;
    return result;
  }

  startPlanGeneration(tripId: string) {
    const trip = this.options.store.requireTrip(tripId);
    const currentResolved = this.options.store.listPlaceResolutions(tripId)
      .filter((resolution) => resolution.status === "resolved")
      .map((resolution) => resolution.placeId);
    const selected = trip.plan.candidates.filter((candidate) => candidate.preference !== "excluded");
    if (!selected.length) throw new Error("请先选择至少一个候选地点。");
    const missing = selected.filter((candidate) => !currentResolved.includes(candidate.placeId));
    if (missing.length) throw new Error(`仍有 ${missing.length} 个已选择地点未定位，请先处理未定位地点。`);
    const taskHolder = { id: "" };
    const result = this.begin({
      tripId,
      label: "生成按天行程",
      run: async () => this.options.ai.generatePlan({ trip: this.options.store.requireTrip(tripId), resolvedPlaceIds: currentResolved }, this.progress(taskHolder.id)),
      complete: async (output: PlanGenerationOutput) => {
        const applied = applyPlanGenerationToStore(this.options.store, tripId, output);
        this.options.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "generate_plan", changedDayIds: applied.changedDayIds });
        this.emit("travel.document.changed", { tripId, generation: applied.generation, changedDayIds: applied.changedDayIds });
        for (const day of applied.trip.plan.days) {
          await this.options.routes.recalculate(tripId, day.id, applied.generation);
          this.emit("travel.route.changed", { tripId, dayId: day.id });
        }
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
        const commands = assertCommandsWithinScope(trip.plan, scope, output.commands);
        const preview = applyPlanCommands(trip.plan, commands);
        const timestamp = new Date().toISOString();
        const proposal = this.options.store.createProposal({
          id: randomUUID(),
          tripId,
          baseGeneration: trip.contentGeneration,
          scope,
          status: "pending",
          title: output.title,
          explanation: output.explanation,
          commands,
          diff: proposalDiff(commands, preview.effects),
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

  applyCommands(tripId: string, input: unknown) {
    const applied = applyPlanCommandBatchToStore(this.options.store, tripId, input);
    this.emit("travel.document.changed", { tripId, generation: applied.generation, changedDayIds: applied.effects.changedDayIds });
    return applied;
  }

  async retryResolutions(tripId: string, placeIds: string[], expectedGeneration: number) {
    const results = await this.options.resolver.resolveMany(tripId, placeIds, expectedGeneration);
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

  restoreRevision(tripId: string, version: number) {
    const restored = this.options.store.restoreRevision(tripId, version);
    this.emit("travel.document.changed", { tripId, generation: restored.generation, changedDayIds: restored.trip.plan.days.map((day) => day.id) });
    return restored;
  }

  applyProposal(tripId: string, proposalId: string) {
    const proposal = this.options.store.getProposal(proposalId);
    if (!proposal || proposal.tripId !== tripId) throw new Error("找不到该 Proposal。");
    const trip = this.options.store.requireTrip(tripId);
    const commands = assertCommandsWithinScope(trip.plan, proposal.scope, proposal.commands);
    const applied = applyPlanCommands(trip.plan, commands);
    const stored = this.options.store.applyProposalPlan(proposalId, applied.plan, `应用 AI 建议：${proposal.title}`);
    this.emit("travel.document.changed", { tripId, generation: stored.generation, changedDayIds: applied.effects.changedDayIds });
    this.emit("travel.proposal.changed", { tripId, proposalId });
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
