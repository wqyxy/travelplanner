import { randomUUID } from "node:crypto";
import {
  AiProposalSchema,
  PlanCommandSchema,
  ProposalScopeSchema,
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type PlanCommand,
  type ProposalScope,
} from "./contracts-v2.js";
import {
  ActionCancellationInputSchema,
  ActionConfirmationInputSchema,
  AiActionRecordSchema,
  StageConversationTurnInputSchema,
  type AiActionRecord,
  type AiActionType,
  type ConversationStage,
} from "./ai-stage-contracts-v3.js";
import { actionRegistration } from "./ai-registries-v3.js";
import { parseActionParametersV3 } from "./ai-action-input-contracts-v3.js";
import { AiTaskMonitorV3, aiErrorMessageV3, normalizePublicAiSummaryV3 } from "./ai-task-monitor-v3.js";
import type { DayRouteServiceV2 } from "./day-route-v2.js";
import { deriveItineraryUpdateStateV3 } from "./itinerary-workflow-v3.js";
import { applyPlanCommands } from "./plan-commands-v2.js";
import { buildPlanningCoverage } from "./planning-areas-v2.js";
import { buildPlannerActionStateV3 } from "./planner-action-context-v3.js";
import { actionScope } from "./planner-action-scope-v3.js";
import { PlannerActionPersistenceCoordinatorV3 } from "./planner-action-persistence-coordinator-v3.js";
import { hasTravelRequirements } from "./planner-candidate-output-v3.js";
import { deterministicCommands } from "./planner-deterministic-commands-v3.js";
import { PlannerGoogleMapsLinkCoordinatorV3 } from "./planner-google-maps-link-coordinator-v3.js";
import { PlannerInterestDiscoveryCoordinatorV3 } from "./planner-interest-discovery-coordinator-v3.js";
import { markImpact } from "./planner-itinerary-impact-v3.js";
import { validateItineraryReferences } from "./planner-itinerary-validation-v3.js";
import { proposalDiff } from "./planner-proposal-v3.js";
import { PlannerResolutionCoordinatorV3 } from "./planner-resolution-coordinator-v3.js";
import { currentPlaceResolutions } from "./planner-resolution-state-v3.js";
import { PlannerRouteCoordinatorV3 } from "./planner-route-coordinator-v3.js";
import type { PlannerPlaceResolverCapabilityV3 } from "./provider-resolver-capability-v3.js";
import { GoogleMapsLinkService } from "./google-maps-link.js";
import { assertProposalCommandsWithinScope } from "./proposal-scope-policy-v2.js";
import type { LoadedPromptRegistryV3 } from "./prompt-registry-v3.js";
import { buildStageContext, validateSelectionForStage } from "./stage-context-v3.js";
import type { StagedAiHandle } from "./staged-ai-v3.js";
import { StagedTravelAiV3 } from "./staged-ai-v3.js";
import { STAGE_THREAD_MAX_TURNS, TravelStoreV3, type TripDetailV3 } from "./travel-store-v3.js";

export type RuntimeEventV3 =
  | { kind: "travel.document.changed"; payload: { tripId: string; generation: number; changedDayIds: string[] } }
  | { kind: "travel.resolution.changed"; payload: { tripId: string; placeId: string } }
  | { kind: "travel.route.changed"; payload: { tripId: string; dayId: string } }
  | { kind: "travel.proposal.changed"; payload: { tripId: string; proposalId: string } }
  | { kind: "travel.action.changed"; payload: { tripId: string; actionId: string } }
  | { kind: "travel.turn.changed"; payload: { tripId: string; stage: ConversationStage; messageId: string } }
  | { kind: "ai-task.updated"; payload: unknown };

const dialoguePromptIds: Record<ConversationStage, "dialogue.requirements" | "dialogue.destinations" | "dialogue.interests" | "dialogue.itinerary"> = {
  requirements: "dialogue.requirements",
  destinations: "dialogue.destinations",
  interests: "dialogue.interests",
  itinerary: "dialogue.itinerary",
};
const REQUIREMENT_FIELDS = ["title", "brief", "dates", "travelers", "budget", "pace", "themes", "preferences", "constraints", "assumptions"] as const;

type ActiveRun = { tripId: string; interrupt: () => Promise<void>; actionId?: string; messageId?: string; stage?: ConversationStage };
type ActionOutput = Record<string, any>;

function now() { return new Date().toISOString(); }
function stringifySize(value: unknown) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

function interestCompletionSummary(resultRef: string | null | undefined) {
  if (!resultRef?.startsWith("interest:v1;")) return null;
  const values = new Map(resultRef.split(";").slice(1).map((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, ""];
  }));
  const [successfulText, totalText] = String(values.get("areas") ?? "0/0").split("/");
  const successful = Number(successfulText) || 0;
  const total = Number(totalText) || 0;
  const failed = Number(values.get("failed")) || 0;
  const added = Number(values.get("added")) || 0;
  const resolved = Number(values.get("resolved")) || 0;
  const pending = Number(values.get("pending")) || 0;
  if (successful === total && added === 0) return `兴趣点研究完成 · ${successful}/${total} · 本轮没有发现值得新增的兴趣点`;
  const failure = failed > 0 ? `，${failed} 个区域失败` : "";
  return `兴趣点研究完成 · ${successful}/${total}${failure} · 新增 ${added} · 已定位 ${resolved}/${resolved + pending}`;
}

export class TravelPlannerRuntimeV3 {
  private readonly active = new Map<string, ActiveRun>();
  private readonly aiExecutingTrips = new Set<string>();
  private readonly resolutionCoordinator: PlannerResolutionCoordinatorV3;
  private readonly routeCoordinator: PlannerRouteCoordinatorV3;
  private readonly interestDiscoveryCoordinator: PlannerInterestDiscoveryCoordinatorV3;
  private readonly actionPersistenceCoordinator: PlannerActionPersistenceCoordinatorV3;
  private readonly googleMapsLinkCoordinator: PlannerGoogleMapsLinkCoordinatorV3;

  constructor(private readonly options: {
    store: TravelStoreV3;
    ai: StagedTravelAiV3;
    prompts: LoadedPromptRegistryV3;
    tasks: AiTaskMonitorV3;
    resolver: PlannerPlaceResolverCapabilityV3;
    routes: DayRouteServiceV2;
    googleMapsLinks?: GoogleMapsLinkService;
    emit: (event: RuntimeEventV3) => void;
  }) {
    this.resolutionCoordinator = new PlannerResolutionCoordinatorV3({
      store: options.store,
      tasks: options.tasks,
      resolver: options.resolver,
      emitChanged: (tripId, placeId) => this.emit("travel.resolution.changed", { tripId, placeId }),
    });
    this.routeCoordinator = new PlannerRouteCoordinatorV3({
      store: options.store,
      tasks: options.tasks,
      routes: options.routes,
      emitChanged: (tripId, dayId) => this.emit("travel.route.changed", { tripId, dayId }),
    });
    this.interestDiscoveryCoordinator = new PlannerInterestDiscoveryCoordinatorV3({
      store: options.store,
      ai: options.ai,
      tasks: options.tasks,
      progress: (taskId) => this.progress(taskId),
      rememberActive: (taskId, value) => this.rememberActive(taskId, value),
      resolveChangedPlaces: (tripId, placeIds, expectedGeneration, taskId, signal) => this.resolveChangedPlaces(tripId, placeIds, expectedGeneration, taskId, signal),
      emitDocumentChanged: (tripId, generation, changedDayIds) => this.emit("travel.document.changed", { tripId, generation, changedDayIds }),
    });
    this.actionPersistenceCoordinator = new PlannerActionPersistenceCoordinatorV3({
      store: options.store,
      createProposal: (action, title, explanation, commands, scope, affectedDayIds) => this.createProposalForAction(action, title, explanation, commands, scope, affectedDayIds),
      resolveChangedPlaces: (tripId, placeIds, expectedGeneration, taskId) => this.resolveChangedPlaces(tripId, placeIds, expectedGeneration, taskId),
      emitDocumentChanged: (tripId, generation, changedDayIds) => this.emit("travel.document.changed", { tripId, generation, changedDayIds }),
      startRouteBatch: (tripId, expectedGeneration, dayIds) => this.startRouteBatch(tripId, expectedGeneration, dayIds),
      recalculateAllMacroRoutes: (tripId, expectedGeneration) => this.recalculateAllMacroRoutes(tripId, expectedGeneration),
    });
    this.googleMapsLinkCoordinator = new PlannerGoogleMapsLinkCoordinatorV3({
      store: options.store,
      service: options.googleMapsLinks,
      emitDocumentChanged: (tripId, generation, changedDayIds) => this.emit("travel.document.changed", { tripId, generation, changedDayIds }),
      emitResolutionChanged: (tripId, placeId) => this.emit("travel.resolution.changed", { tripId, placeId }),
    });
  }

  private emit(kind: RuntimeEventV3["kind"], payload: any) { this.options.emit({ kind, payload } as RuntimeEventV3); }

  workspace(tripId: string) {
    const workspace = this.options.store.getWorkspace(tripId);
    const resolutions = currentPlaceResolutions(workspace.trip, workspace.resolutions);
    const resolved = resolutions.filter((resolution) => resolution.status === "resolved");
    const routeStates = this.options.routes.workspaceRouteState(tripId);
    const macroRouteStates = this.options.routes.workspaceMacroRouteState(tripId);
    return {
      ...workspace,
      resolutions,
      routeStates,
      macroRouteStates,
      itineraryUpdateState: deriveItineraryUpdateStateV3(workspace.trip.plan),
      messages: {
        requirements: this.options.store.listMessages(tripId, "requirements"),
        destinations: this.options.store.listMessages(tripId, "destinations"),
        interests: this.options.store.listMessages(tripId, "interests"),
        itinerary: this.options.store.listMessages(tripId, "itinerary"),
      },
      tasks: this.options.tasks.list(tripId),
      revisions: this.options.store.listRevisions(tripId),
      coverage: buildPlanningCoverage(workspace.trip.plan, new Set(resolved.map((resolution) => resolution.placeId))),
    };
  }

  private progress(taskId: string, messageId?: string, stage?: ConversationStage) {
    return (value: { kind: string; text: string }) => {
      const summary = normalizePublicAiSummaryV3(value.text);
      if (!summary) return;
      this.options.tasks.update(taskId, "running", summary, value.kind);
      if (messageId && stage) {
        this.options.store.updateTurn(messageId, "active", { progress: summary });
        this.emit("travel.turn.changed", { tripId: this.options.store.getAiTask(taskId)?.tripId, stage, messageId });
      }
    };
  }

  private rememberActive(taskId: string, value: ActiveRun) { this.active.set(taskId, value); }
  private forgetActive(taskId: string) { this.active.delete(taskId); }

  stopTask(tripId: string, taskId: string) {
    const active = this.active.get(taskId);
    if (active?.tripId === tripId) void active.interrupt().catch(() => undefined);
    else if (!this.routeCoordinator.stopTask(tripId, taskId)) throw new Error("当前任务已经结束。");
    return { ok: true };
  }

  private saveDialogueThread(trip: TripDetailV3, stage: ConversationStage, handle: StagedAiHandle<any>, priorThreadId: string | null) {
    const prompt = this.options.prompts.compose(dialoguePromptIds[stage]);
    const finalThreadId = handle.threadId();
    const existing = this.options.store.getStageThread(trip.id, stage);
    if (existing && existing.threadId === finalThreadId && priorThreadId === finalThreadId) return this.options.store.incrementStageThreadTurn(trip.id, stage, finalThreadId, trip.contentGeneration);
    return this.options.store.setStageThread({ tripId: trip.id, stage, threadId: finalThreadId, promptHash: prompt.hash, promptVersion: prompt.version, contextGeneration: trip.contentGeneration, turnCount: 1 });
  }

  private usableThread(trip: TripDetailV3, stage: ConversationStage) {
    const stored = this.options.store.getStageThread(trip.id, stage);
    if (!stored) return null;
    const prompt = this.options.prompts.compose(dialoguePromptIds[stage]);
    if (stored.promptHash !== prompt.hash || stored.promptVersion !== prompt.version || stored.contextGeneration !== trip.contentGeneration || stored.turnCount >= STAGE_THREAD_MAX_TURNS) {
      this.options.store.deleteStageThread(trip.id, stage);
      return null;
    }
    return stored.threadId;
  }

  startConversation(tripId: string, stage: ConversationStage, inputValue: unknown) {
    const trip = this.options.store.requireTrip(tripId);
    const baseGeneration = trip.contentGeneration;
    const input = StageConversationTurnInputSchema.parse(inputValue);
    const selection = validateSelectionForStage(trip, stage, input.selection);
    const messageId = this.options.store.createUserMessage(tripId, stage, input.message);
    const taskId = `dialogue:${randomUUID()}`;
    const started = Date.now();
    const routeStates = stage === "itinerary" ? this.options.routes.workspaceRouteState(tripId) : undefined;
    const context = buildStageContext({ trip, stage, selection, resolutions: this.options.store.listPlaceResolutions(tripId), routeStates });
    this.options.tasks.start({ id: taskId, tripId, agent: "dialogue", label: `${stage} 对话`, summary: "准备阶段对话", metadata: { stage, inputBytes: context.inputBytes, webUsed: false } });
    this.options.store.updateTurn(messageId, "starting", { progress: "准备阶段对话" });

    void (async () => {
      let handle: StagedAiHandle<any> | null = null;
      try {
        const current = this.options.store.requireTrip(tripId);
        if (current.contentGeneration !== baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        const existingThreadId = this.usableThread(current, stage);
        handle = await this.options.ai.startDialogue({ stage, state: { ...context.state, userMessage: input.message }, existingThreadId, onProgress: this.progress(taskId, messageId, stage) });
        this.rememberActive(taskId, { tripId, interrupt: handle.interrupt, messageId, stage });
        this.options.store.updateTurn(messageId, "active", { progress: "正在处理", codexTurnId: handle.turnId() });
        const firstStarted = Date.now();
        const output = await handle.result;
        const afterFirst = this.options.store.requireTrip(tripId);
        if (afterFirst.contentGeneration !== baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        this.saveDialogueThread(afterFirst, stage, handle, existingThreadId);
        let webMs = 0;
        let webReply: { assistantMessage: string; verification: unknown } | null = null;

        if (output.result.type === "web_required") {
          this.options.tasks.update(taskId, "waiting", "正在核验实时信息", "dialogue:web-required");
          const webStarted = Date.now();
          const webContext = buildStageContext({ trip: afterFirst, stage, selection, resolutions: this.options.store.listPlaceResolutions(tripId), routeStates: stage === "itinerary" ? this.options.routes.workspaceRouteState(tripId) : undefined });
          const webThread = this.usableThread(afterFirst, stage);
          const webHandle = await this.options.ai.startWebDialogue({
            stage,
            state: { ...webContext.state, userMessage: input.message, queryIntent: output.result.queryIntent, webRequiredReason: output.result.reason },
            existingThreadId: webThread,
            onProgress: this.progress(taskId, messageId, stage),
          });
          handle = webHandle;
          this.rememberActive(taskId, { tripId, interrupt: webHandle.interrupt, messageId, stage });
          const verified = await webHandle.result;
          const afterWeb = this.options.store.requireTrip(tripId);
          if (afterWeb.contentGeneration !== baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
          this.saveDialogueThread(afterWeb, stage, webHandle, webThread);
          webMs = Date.now() - webStarted;
          webReply = { assistantMessage: verified.assistantMessage, verification: verified.verification };
        }

        const effectiveGeneration = output.requirementsCapture
          ? await this.captureAdditionalRequirements(tripId, messageId, baseGeneration, output.requirementsCapture.additionalRequirements)
          : baseGeneration;

        if (output.result.type === "action") {
          const registration = actionRegistration(output.result.actionType);
          if (registration.stage !== stage) throw new Error(`阶段对话识别了越界 Action：${output.result.actionType}`);
          const normalizedParameters = parseActionParametersV3(output.result.actionType, registration.inputContract, "conversation", output.result.parameters);
          const scope = actionScope(output.result.actionType, output.result.targetIds, normalizedParameters, this.options.store.requireTrip(tripId).plan);
          const action = AiActionRecordSchema.parse({
            id: randomUUID(), tripId, stage, actionType: output.result.actionType, executor: registration.executor, origin: "conversation", sourceMessageId: messageId,
            parameters: output.result.parameters, targetIds: output.result.targetIds, scope, baseGeneration: effectiveGeneration, status: "pending_confirmation",
            taskId: null, proposalId: null, resultRef: null, startedAt: null, updatedAt: now(), completedAt: null, errorSummary: null,
          });
          const stored = this.options.store.createAction(action).action;
          this.options.store.createAssistantMessage(tripId, stage, output.result.assistantMessage, { type: "action", actionId: stored.id, impactSummary: output.result.impactSummary });
          if (stored.actionType === "requirements.update" || stored.actionType === "requirements.clear") this.confirmClaimedAction(stored.id, effectiveGeneration);
          else this.emit("travel.action.changed", { tripId, actionId: stored.id });
        } else if (webReply) {
          this.options.store.createAssistantMessage(tripId, stage, webReply.assistantMessage, { type: "reply", verification: webReply.verification });
        } else {
          this.options.store.createAssistantMessage(tripId, stage, output.result.assistantMessage, { type: output.result.type });
        }

        this.options.store.updateTurn(messageId, "completed", { progress: "已完成" });
        const timing = { generationMs: Date.now() - firstStarted - webMs, ...(webMs ? { webMs } : {}), totalMs: Date.now() - started };
        this.options.tasks.metadata(taskId, { stage, inputBytes: context.inputBytes, webUsed: webMs > 0, timing });
        this.options.tasks.update(taskId, "completed", "阶段对话已完成", "task:completed");
        this.emit("travel.turn.changed", { tripId, stage, messageId });
      } catch (error) {
        const message = normalizePublicAiSummaryV3(aiErrorMessageV3(error)) || "阶段对话失败";
        const superseded = message === "CONTENT_GENERATION_SUPERSEDED";
        const stopped = message === "AI 任务已停止。";
        this.options.tasks.metadata(taskId, { stage, inputBytes: context.inputBytes, webUsed: false, timing: { totalMs: Date.now() - started, failedPhase: "generation" } });
        this.options.tasks.update(taskId, superseded ? "cancelled_by_generation" : stopped ? "stopped" : "failed", message, "task:failed");
        this.options.store.updateTurn(messageId, stopped ? "interrupted" : "failed", { error: stopped ? null : message, progress: stopped ? "已停止" : null, cancelRequested: stopped });
        this.emit("travel.turn.changed", { tripId, stage, messageId });
      } finally {
        this.forgetActive(taskId);
      }
    })();
    return { taskId, messageId };
  }

  createCtaAction(input: { tripId: string; stage: ConversationStage; actionType: AiActionType; parameters?: Record<string, unknown>; targetIds?: string[]; requestKey: string }) {
    if (input.actionType === "requirements.capture") throw new Error("requirements.capture 仅供阶段对话内部使用。");
    const registration = actionRegistration(input.actionType);
    if (registration.stage !== input.stage) throw new Error(`CTA Action 与阶段不匹配：${input.actionType}`);
    const trip = this.options.store.requireTrip(input.tripId);
    if (input.actionType === "destination.generate" && !hasTravelRequirements(trip.plan)) throw new Error("请先填写旅行需求，再生成目的地建议。");
    const rawParameters = input.parameters ?? {};
    const normalizedParameters = parseActionParametersV3(input.actionType, registration.inputContract, "cta", rawParameters);
    const targetIds = input.targetIds ?? [];
    const action = AiActionRecordSchema.parse({
      id: randomUUID(), tripId: input.tripId, stage: input.stage, actionType: input.actionType, executor: registration.executor, origin: "cta", sourceMessageId: null,
      parameters: rawParameters, targetIds, scope: actionScope(input.actionType, targetIds, normalizedParameters, trip.plan), baseGeneration: trip.contentGeneration, status: "pending_confirmation",
      taskId: null, proposalId: null, resultRef: null, startedAt: null, updatedAt: now(), completedAt: null, errorSummary: null,
    });
    const created = this.options.store.createAction(action, input.requestKey);
    if (!created.created) return { action: created.action, taskId: created.action.taskId };
    return this.confirmClaimedAction(created.action.id, trip.contentGeneration);
  }

  confirmAction(tripId: string, actionId: string, inputValue: unknown) {
    const input = ActionConfirmationInputSchema.parse(inputValue);
    const action = this.options.store.getAction(actionId);
    if (!action || action.tripId !== tripId) throw new Error("找不到该 Action。");
    if (action.baseGeneration !== input.expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    return this.confirmClaimedAction(actionId, input.expectedGeneration);
  }

  private confirmClaimedAction(actionId: string, expectedGeneration: number) {
    const before = this.options.store.getAction(actionId);
    if (!before) throw new Error("找不到该 Action。");
    if (before.executor === "ai" && this.aiExecutingTrips.has(before.tripId)) throw new Error("当前旅行已有 AI Action 正在执行，请等待或停止后再试。");
    const claimed = this.options.store.claimActionForExecution(actionId, expectedGeneration);
    if (!claimed.claimed) return { action: claimed.action, taskId: claimed.action.taskId };
    if (claimed.action.executor === "ai") this.aiExecutingTrips.add(claimed.action.tripId);
    const taskId = claimed.action.executor === "ai" ? `action:${randomUUID()}` : null;
    if (taskId) this.options.store.setActionTask(actionId, taskId);
    void this.executeAction(actionId, taskId).finally(() => {
      if (claimed.action.executor === "ai") this.aiExecutingTrips.delete(claimed.action.tripId);
    });
    const action = this.options.store.getAction(actionId)!;
    this.emit("travel.action.changed", { tripId: action.tripId, actionId });
    return { action, taskId };
  }

  cancelAction(tripId: string, actionId: string, inputValue: unknown) {
    ActionCancellationInputSchema.parse(inputValue);
    const action = this.options.store.getAction(actionId);
    if (!action || action.tripId !== tripId) throw new Error("找不到该 Action。");
    const result = this.options.store.cancelPendingAction(actionId);
    this.emit("travel.action.changed", { tripId, actionId });
    return result;
  }

  private async executeAction(actionId: string, taskId: string | null) {
    const action = this.options.store.getAction(actionId);
    if (!action) return;
    const started = Date.now();
    try {
      if (action.executor === "deterministic") {
        const result = await this.executeDeterministic(action);
        this.options.store.completeAction(action.id, result);
        this.emit("travel.action.changed", { tripId: action.tripId, actionId: action.id });
        return;
      }
      if (!taskId) throw new Error("AI Action 缺少 taskId。");
      const registration = actionRegistration(action.actionType);
      const state = this.buildActionState(action);
      const stateBytes = stringifySize(state);
      this.options.tasks.start({ id: taskId, tripId: action.tripId, agent: "action", label: action.actionType, summary: `准备执行 ${action.actionType}`, metadata: { actionType: action.actionType, executor: "ai", reasoning: registration.reasoning, webPolicy: registration.web, inputBytes: stateBytes } });

      let receivedOutputBytes: number | null = null;
      if (action.actionType === "interest.discover" || action.actionType === "interest.supplement") {
        this.options.tasks.update(taskId, "running", `正在执行 ${action.actionType}`, "action:running");
        await this.persistInterestDiscovery(action, taskId);
      } else {
        const run = await this.options.ai.startAction<ActionOutput>({ actionType: action.actionType, state, allowWeb: action.parameters.allowWeb !== false, onProgress: this.progress(taskId) });
        this.rememberActive(taskId, { tripId: action.tripId, actionId: action.id, interrupt: run.interrupt });
        this.options.tasks.update(taskId, "running", `正在执行 ${action.actionType}`, "action:running");
        const output = await run.result;
        receivedOutputBytes = stringifySize(output);
        if (Number(output?.baseGeneration) !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        if (this.options.store.requireTrip(action.tripId).contentGeneration !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        await this.persistAiActionOutput(action, output, taskId);
      }

      const final = this.options.store.getAction(action.id);
      const existingMetadata = this.options.store.getAiTask(taskId)?.metadata ?? {};
      this.options.tasks.metadata(taskId, { ...existingMetadata, actionType: action.actionType, executor: "ai", reasoning: registration.reasoning, webPolicy: registration.web, inputBytes: stringifySize(state), ...(action.actionType === "itinerary.generate" ? { receivedOutputBytes, retryable: false } : {}), timing: { totalMs: Date.now() - started } });
      const interestSummary = interestCompletionSummary(final?.resultRef);
      this.options.tasks.update(taskId, "completed", interestSummary ?? (final?.status === "awaiting_apply" ? "方案已生成，等待 Apply" : "Action 已完成"), "task:completed");
      this.emit("travel.action.changed", { tripId: action.tripId, actionId: action.id });
    } catch (error) {
      const message = normalizePublicAiSummaryV3(aiErrorMessageV3(error)) || "Action 执行失败";
      if (message === "CONTENT_GENERATION_SUPERSEDED") this.options.store.supersedeAction(action.id, "计划已发生变化，Action 已失效。");
      else this.options.store.failAction(action.id, message);
      if (taskId) {
        const existingMetadata = this.options.store.getAiTask(taskId)?.metadata ?? {};
        const deterministic = ["GENERATE_INPUT_BUDGET_EXCEEDED", "GENERATE_REQUIRES_INTERESTS", "GENERATE_REQUIRES_REQUIREMENTS", "CONTENT_GENERATION_SUPERSEDED"].includes(message);
        this.options.tasks.metadata(taskId, { ...existingMetadata, actionType: action.actionType, retryable: action.actionType === "itinerary.generate" ? !deterministic : undefined, failureReasonCode: action.actionType === "itinerary.generate" ? message : undefined, timing: { totalMs: Date.now() - started, failedPhase: "generation" } });
        this.options.tasks.update(taskId, message === "CONTENT_GENERATION_SUPERSEDED" ? "cancelled_by_generation" : message === "AI 任务已停止。" ? "stopped" : "failed", message, "task:failed");
      }
      this.emit("travel.action.changed", { tripId: action.tripId, actionId: action.id });
    } finally {
      if (taskId) this.forgetActive(taskId);
    }
  }

  private buildActionState(action: AiActionRecord) {
    const trip = this.options.store.requireTrip(action.tripId);
    const resolutions = this.options.store.listPlaceResolutions(action.tripId);
    return buildPlannerActionStateV3({
      action,
      trip,
      resolutions,
      routeStates: () => this.options.routes.workspaceRouteState(action.tripId),
      macroRouteStates: () => this.options.routes.workspaceMacroRouteState(action.tripId),
    });
  }

  private async executeDeterministic(action: AiActionRecord) {
    const trip = this.options.store.requireTrip(action.tripId);
    if (trip.contentGeneration !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    if (action.actionType === "requirements.capture") {
      const additionalRequirements = String(action.parameters.additionalRequirements ?? "").trim();
      if (!additionalRequirements) throw new Error("requirements.capture 缺少其他需求。");
      const next = structuredClone(trip.plan);
      next.trip.brief.additionalRequirements = additionalRequirements;
      const parsed = TravelPlanDocumentSchema.parse(next);
      const written = this.options.store.writePlan(action.tripId, parsed, action.baseGeneration, { source: "action:requirements.capture", summary: "记录其他需求" }, { keepActionId: action.id });
      this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: [] });
      return `generation:${written.generation}`;
    }
    if (action.actionType === "requirements.update" || action.actionType === "requirements.clear") {
      const defaults = emptyTravelPlan().trip;
      const next = structuredClone(trip.plan);
      if (action.actionType === "requirements.update") {
        const raw = action.parameters.changes && typeof action.parameters.changes === "object" && !Array.isArray(action.parameters.changes) ? action.parameters.changes as Record<string, unknown> : {};
        if (!Object.keys(raw).length) throw new Error("requirements.update 没有可执行字段。");
        for (const key of REQUIREMENT_FIELDS) {
          if (!(key in raw)) continue;
          if (key === "brief") next.trip.brief = { ...next.trip.brief, ...(raw.brief as Record<string, string>) };
          else (next.trip as any)[key] = structuredClone(raw[key]);
        }
      } else {
        const fields = Array.isArray(action.parameters.fields) ? action.parameters.fields.map(String) : [];
        if (!fields.length) throw new Error("requirements.clear 没有指定字段。");
        for (const key of fields) if ((REQUIREMENT_FIELDS as readonly string[]).includes(key)) (next.trip as any)[key] = structuredClone((defaults as any)[key]);
      }
      const parsed = TravelPlanDocumentSchema.parse(next);
      const written = this.options.store.writePlan(action.tripId, parsed, action.baseGeneration, { source: `action:${action.actionType}`, summary: "更新旅行需求" }, { keepActionId: action.id });
      this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: [] });
      return `generation:${written.generation}`;
    }

    const commands = deterministicCommands(action, trip);
    const applied = applyPlanCommands(trip.plan, commands);
    if (action.actionType.startsWith("itinerary.")) validateItineraryReferences(trip, applied.plan.days, this.options.store.listPlaceResolutions(action.tripId));
    const plan = markImpact(trip.plan, applied.plan);
    const written = this.options.store.writePlan(action.tripId, plan, action.baseGeneration, { source: `action:${action.actionType}`, summary: `执行 ${action.actionType}` }, { keepActionId: action.id });
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: applied.effects.changedDayIds });
    await this.resolveChangedPlaces(action.tripId, applied.effects.changedPlaceIds, written.generation);
    return `generation:${written.generation}`;
  }

  private resolveChangedPlaces(tripId: string, placeIds: string[], expectedGeneration: number, taskId?: string, signal?: AbortSignal) {
    return this.resolutionCoordinator.resolveChangedPlaces(tripId, placeIds, expectedGeneration, taskId, signal);
  }

  private persistAiActionOutput(action: AiActionRecord, output: ActionOutput, taskId: string | null = null) {
    return this.actionPersistenceCoordinator.persist(action, output, taskId);
  }

  private persistInterestDiscovery(action: AiActionRecord, taskId: string | null = null) {
    return this.interestDiscoveryCoordinator.persist(action, taskId);
  }

  private createProposalForAction(action: AiActionRecord, title: string, explanation: string, commandValues: PlanCommand[], scopeValue: ProposalScope, affectedDayIds?: string[]) {
    const trip = this.options.store.requireTrip(action.tripId);
    if (trip.contentGeneration !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const { scope, commands } = assertProposalCommandsWithinScope(trip.plan, ProposalScopeSchema.parse(scopeValue), commandValues);
    const preview = applyPlanCommands(trip.plan, commands);
    const timestamp = now();
    const proposal = AiProposalSchema.parse({
      id: randomUUID(), tripId: action.tripId, baseGeneration: action.baseGeneration, scope, status: "pending", title, explanation,
      commands, diff: { ...proposalDiff(commands, preview.effects), ...(affectedDayIds ? { affectedDayIds } : {}) }, createdAt: timestamp, updatedAt: timestamp, appliedRevisionVersion: null,
    });
    this.options.store.createProposal(proposal);
    this.options.store.setActionAwaitingApply(action.id, proposal.id, `proposal:${proposal.id}`);
    this.emit("travel.proposal.changed", { tripId: action.tripId, proposalId: proposal.id });
    this.emit("travel.action.changed", { tripId: action.tripId, actionId: action.id });
    return proposal;
  }

  async applyProposal(tripId: string, proposalId: string) {
    const proposal = this.options.store.getProposal(proposalId);
    if (!proposal || proposal.tripId !== tripId) throw new Error("找不到该 Proposal。");
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== proposal.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const validated = assertProposalCommandsWithinScope(trip.plan, proposal.scope, proposal.commands);
    const applied = applyPlanCommands(trip.plan, validated.commands);
    let plan = applied.plan;
    const linkedAction = this.options.store.listActions(tripId).find((action) => action.proposalId === proposalId);
    if (linkedAction?.actionType === "itinerary.refine" || linkedAction?.actionType === "itinerary.detail.update") {
      const affected = new Set(proposal.diff.affectedDayIds);
      plan = TravelPlanDocumentSchema.parse({ ...plan, days: plan.days.map((day) => affected.has(day.id) ? { ...day, detailLevel: "detailed", detailStatus: "ready" } : day) });
    } else if (linkedAction?.actionType === "itinerary.replan") {
      const affected = new Set(proposal.diff.affectedDayIds);
      plan = TravelPlanDocumentSchema.parse({ ...plan, days: plan.days.map((day) => affected.has(day.id) && day.detailLevel === "detailed" ? { ...day, detailStatus: "needs_review" } : day) });
    } else {
      plan = markImpact(trip.plan, plan);
    }
    const result = this.options.store.applyProposalPlan(proposalId, plan, `应用 ${linkedAction?.actionType ?? "AI Proposal"}`);
    this.emit("travel.document.changed", { tripId, generation: result.generation, changedDayIds: applied.effects.changedDayIds });
    this.emit("travel.proposal.changed", { tripId, proposalId });
    if (linkedAction) this.emit("travel.action.changed", { tripId, actionId: linkedAction.id });
    await this.resolveChangedPlaces(tripId, applied.effects.changedPlaceIds, result.generation);
    if (linkedAction?.actionType === "itinerary.replan") void this.recalculateAllMacroRoutes(tripId, result.generation);
    if (linkedAction?.actionType === "itinerary.detail.update") this.startRouteBatch(tripId, result.generation, proposal.diff.affectedDayIds);
    return result;
  }

  rejectProposal(tripId: string, proposalId: string) {
    const proposal = this.options.store.getProposal(proposalId); if (!proposal || proposal.tripId !== tripId) throw new Error("找不到该 Proposal。");
    const result = this.options.store.rejectProposal(proposalId); this.emit("travel.proposal.changed", { tripId, proposalId });
    const action = this.options.store.listActions(tripId).find((item) => item.proposalId === proposalId); if (action) this.emit("travel.action.changed", { tripId, actionId: action.id });
    return result;
  }

  undoProposal(tripId: string, proposalId: string) {
    const proposal = this.options.store.getProposal(proposalId); if (!proposal || proposal.tripId !== tripId) throw new Error("找不到该 Proposal。");
    const result = this.options.store.undoProposal(proposalId); this.emit("travel.document.changed", { tripId, generation: result.generation, changedDayIds: result.trip.plan.days.map((day) => day.id) }); this.emit("travel.proposal.changed", { tripId, proposalId }); return result;
  }

  applyCommands(tripId: string, input: { expectedGeneration?: unknown; commands?: unknown }) {
    const expectedGeneration = Number(input.expectedGeneration);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("expectedGeneration 无效。");
    const commands = Array.isArray(input.commands) ? input.commands.map((command) => PlanCommandSchema.parse(command)) : [];
    const trip = this.options.store.requireTrip(tripId); if (trip.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const applied = applyPlanCommands(trip.plan, commands);
    if (commands.some((command) => ["set_day_anchor", "add_day_stop", "update_day_stop", "move_day_stop", "remove_day_stop", "move_day", "update_day"].includes(command.type))) {
      validateItineraryReferences(trip, applied.plan.days, this.options.store.listPlaceResolutions(tripId));
    }
    const plan = markImpact(trip.plan, applied.plan);
    const written = this.options.store.writePlan(tripId, plan, expectedGeneration, { source: "command", summary: "编辑旅行计划" });
    this.emit("travel.document.changed", { tripId, generation: written.generation, changedDayIds: applied.effects.changedDayIds });
    const hasFinalRouteMutation = commands.some((command) => command.type.startsWith("set_final_route_")
      || command.type === "add_final_route_node"
      || command.type === "remove_final_route_node"
      || command.type === "move_final_route_node"
      || command.type === "add_final_route_night");
    const resolution = this.resolveChangedPlaces(tripId, applied.effects.changedPlaceIds, written.generation);
    if (hasFinalRouteMutation && applied.effects.routeDirtyDayIds.length) {
      void resolution.finally(() => {
        if (this.options.store.requireTrip(tripId).contentGeneration === written.generation) {
          this.startRouteBatch(tripId, written.generation, applied.effects.routeDirtyDayIds);
        }
      });
    } else {
      void resolution;
    }
    return { ...applied, plan, trip: written.trip, generation: written.generation, version: written.version };
  }

  retryResolutions(tripId: string, placeIds: string[], expectedGeneration: number, force = false) {
    return this.resolutionCoordinator.retryResolutions(tripId, placeIds, expectedGeneration, force);
  }
  searchResolutionCandidates(tripId: string, placeId: string, expectedGeneration: number) { return this.options.resolver.searchCandidates(tripId, placeId, expectedGeneration); }
  selectResolution(tripId: string, placeId: string, input: unknown) { return this.options.resolver.selectCandidate(tripId, placeId, input); }
  setDirectResolution(tripId: string, placeId: string, input: unknown) { return this.options.resolver.setDirect(tripId, placeId, input); }

  private async captureAdditionalRequirements(tripId: string, sourceMessageId: string, baseGeneration: number, additionalRequirements: string) {
    const normalized = additionalRequirements.trim();
    if (!normalized) return baseGeneration;
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    if (trip.plan.trip.brief.additionalRequirements === normalized) return baseGeneration;
    const action = AiActionRecordSchema.parse({
      id: randomUUID(), tripId, stage: "requirements", actionType: "requirements.capture", executor: "deterministic", origin: "conversation", sourceMessageId,
      parameters: { additionalRequirements: normalized }, targetIds: [], scope: { type: "trip", id: null }, baseGeneration, status: "pending_confirmation",
      taskId: null, proposalId: null, resultRef: null, startedAt: null, updatedAt: now(), completedAt: null, errorSummary: null,
    });
    const stored = this.options.store.createAction(action).action;
    const claimed = this.options.store.claimActionForExecution(stored.id, baseGeneration);
    if (!claimed.claimed) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    try {
      const resultRef = await this.executeDeterministic(claimed.action);
      this.options.store.completeAction(stored.id, resultRef);
      this.emit("travel.action.changed", { tripId, actionId: stored.id });
      return this.options.store.requireTrip(tripId).contentGeneration;
    } catch (error) {
      this.options.store.failAction(stored.id, aiErrorMessageV3(error));
      throw error;
    }
  }

  previewGoogleMapsLink(tripId: string, placeId: string, input: unknown) {
    return this.googleMapsLinkCoordinator.preview(tripId, placeId, input);
  }
  applyGoogleMapsLink(tripId: string, placeId: string, input: unknown) {
    return this.googleMapsLinkCoordinator.apply(tripId, placeId, input);
  }

  recalculateRoute(tripId: string, dayId: string, expectedGeneration: number) {
    return this.routeCoordinator.recalculateRoute(tripId, dayId, expectedGeneration);
  }
  recalculateMacroRoute(tripId: string, dayId: string, expectedGeneration: number) {
    return this.routeCoordinator.recalculateMacroRoute(tripId, dayId, expectedGeneration);
  }
  recalculateDirtyRoutes(tripId: string, input: any) {
    return this.routeCoordinator.recalculateDirtyRoutes(tripId, input);
  }
  private startRouteBatch(tripId: string, expectedGeneration: number, dayIds: string[]) {
    return this.routeCoordinator.startRouteBatch(tripId, expectedGeneration, dayIds);
  }

  recalculateDirtyMacroRoutes(tripId: string, input: any) {
    return this.routeCoordinator.recalculateDirtyMacroRoutes(tripId, input);
  }

  private recalculateAllMacroRoutes(tripId: string, expectedGeneration: number) {
    return this.routeCoordinator.recalculateAllMacroRoutes(tripId, expectedGeneration);
  }
}
