import { randomUUID } from "node:crypto";
import {
  AiProposalSchema,
  GoogleMapsLinkCommitInputSchema,
  GoogleMapsLinkPreviewInputSchema,
  PlanCommandSchema,
  ProposalScopeSchema,
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type Place,
  type PlaceResolution,
  type PlanCommand,
  type ProposalScope,
  type TravelPlanDocument,
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
import type {
  DestinationAddOutput,
  DestinationGenerateOutput,
  DestinationReplaceOutput,
  InterestAddOutput,
  InterestReplaceOutput,
  ItineraryDayOptimizeOutput,
  ItineraryDetailGenerateOutput,
  ItineraryDetailUpdateOutput,
  ItineraryGenerateOutput,
  ItineraryRefineOutput,
  ItineraryRepairOutput,
  ItineraryReplanOutput,
  ItineraryVerifyOutput,
} from "./ai-action-contracts-v3.js";
import { actionRegistration } from "./ai-registries-v3.js";
import { parseActionParametersV3 } from "./ai-action-input-contracts-v3.js";
import { AiTaskMonitorV3, aiErrorMessageV3, normalizePublicAiSummaryV3 } from "./ai-task-monitor-v3.js";
import { applyCandidateDiscovery } from "./candidate-workflow-v2.js";
import { CANDIDATE_DISCOVERY_BATCH_LIMIT, filterCoreVisitDuplicatesV3, validateMicroCandidateDiscovery } from "./candidate-discovery-policy-v2.js";
import { classifyCodexFailure } from "./codex-client.js";
import {
  applyDetailedUpdatesPhase5V3,
  detailedReplacementCommandsPhase5V3,
  validateDetailedSchedulingOutcomeV3,
} from "./detail-itinerary-v3.js";
import type { DayRouteServiceV2 } from "./day-route-v2.js";
import {
  applySkeletonPlanV3,
  deriveItineraryUpdateStateV3,
} from "./itinerary-workflow-v3.js";
import { applyPlanCommands } from "./plan-commands-v2.js";
import { buildPlanningCoverage } from "./planning-areas-v2.js";
import {
  buildDetailPlanningContextV3,
  buildInterestAreaContextV3,
  interestDiscoveryReadinessV3,
} from "./planning-context-v3.js";
import { buildPlannerActionStateV3 } from "./planner-action-context-v3.js";
import { actionScope, dayMutationScope } from "./planner-action-scope-v3.js";
import {
  assertDestinationOutputWithinBrief,
  candidateCommand,
  hasTravelRequirements,
  normalizeCandidateDiscoveryOutput,
} from "./planner-candidate-output-v3.js";
import { deterministicCommands } from "./planner-deterministic-commands-v3.js";
import { markImpact } from "./planner-itinerary-impact-v3.js";
import { refinementCommands, replacementCommands } from "./planner-itinerary-commands-v3.js";
import { validateItineraryReferences } from "./planner-itinerary-validation-v3.js";
import { proposalDiff } from "./planner-proposal-v3.js";
import { PlannerResolutionCoordinatorV3 } from "./planner-resolution-coordinator-v3.js";
import { currentPlaceResolutions, currentResolvedPlaces } from "./planner-resolution-state-v3.js";
import { PlannerRouteCoordinatorV3 } from "./planner-route-coordinator-v3.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";
import type { PlaceResolverV2 } from "./place-resolver-v2.js";
import { placeGeoFingerprint } from "./place-resolver-v2.js";
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
const VERIFY_STOP_FIELDS = new Set(["scheduleText", "startTime", "endTime", "durationMinutes", "transportFromPrevious", "scheduleVerification", "costNote", "costVerification", "notes"]);
const REQUIREMENT_FIELDS = ["title", "brief", "dates", "travelers", "budget", "pace", "themes", "preferences", "constraints", "assumptions"] as const;
const INTEREST_DISCOVERY_CONCURRENCY = 4;

type ActiveRun = { tripId: string; interrupt: () => Promise<void>; actionId?: string; messageId?: string; stage?: ConversationStage };
type ActionOutput = Record<string, any>;
type InterestFailure = { targetId: string; errorSummary: string };
type DetailPlanningContextV3 = ReturnType<typeof buildDetailPlanningContextV3>;

function now() { return new Date().toISOString(); }
function same(left: unknown, right: unknown) { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null); }
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

function assertDetailPlanningBlockers(_context: DetailPlanningContextV3) {
  // Planning readiness is advisory-only. Structural target/reference checks are
  // performed by the concrete action and canonical schemas.
}

function assertDetailMacroCurrent(_context: DetailPlanningContextV3) {
  // A dirty upstream skeleton may make the detail plan stale, but it does not
  // revoke the user's ability to work on the current detailed itinerary.
}

export class TravelPlannerRuntimeV3 {
  private readonly active = new Map<string, ActiveRun>();
  private readonly aiExecutingTrips = new Set<string>();
  private readonly resolutionCoordinator: PlannerResolutionCoordinatorV3;
  private readonly routeCoordinator: PlannerRouteCoordinatorV3;

  constructor(private readonly options: {
    store: TravelStoreV3;
    ai: StagedTravelAiV3;
    prompts: LoadedPromptRegistryV3;
    tasks: AiTaskMonitorV3;
    resolver: PlaceResolverV2;
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

  private async persistAiActionOutput(action: AiActionRecord, output: ActionOutput, taskId: string | null = null) {
    if (action.actionType === "destination.generate") return this.persistDestinationGenerate(action, output as DestinationGenerateOutput, taskId);
    if (action.actionType === "destination.add" || action.actionType === "destination.replace" || action.actionType === "interest.add" || action.actionType === "interest.replace") return this.persistCandidateProposal(action, output as any);
    if (action.actionType === "itinerary.generate") return this.persistItineraryGenerate(action, output as ItineraryGenerateOutput);
    if (action.actionType === "itinerary.replan") return this.persistItineraryReplacement(action, output as ItineraryReplanOutput);
    if (action.actionType === "itinerary.detail.generate") return this.persistItineraryDetailGenerate(action, output as ItineraryDetailGenerateOutput);
    if (action.actionType === "itinerary.detail.update") return this.persistItineraryDetailUpdate(action, output as ItineraryDetailUpdateOutput);
    if (action.actionType === "itinerary.repair") return this.persistItineraryRepair(action, output as ItineraryRepairOutput);
    if (action.actionType === "itinerary.day.optimize") return this.persistDayOptimize(action, output as ItineraryDayOptimizeOutput);
    if (action.actionType === "itinerary.verify") return this.persistVerify(action, output as ItineraryVerifyOutput);
    if (action.actionType === "itinerary.refine") return this.persistRefine(action, output as ItineraryRefineOutput);
    throw new Error(`未实现 AI Action：${action.actionType}`);
  }

  private async persistDestinationGenerate(action: AiActionRecord, output: DestinationGenerateOutput, taskId: string | null = null) {
    const trip = this.options.store.requireTrip(action.tripId);
    assertDestinationOutputWithinBrief(trip.plan, output);
    const normalized = normalizeCandidateDiscoveryOutput(output, "macro");
    const applied = applyCandidateDiscovery(trip.plan, normalized);
    const plan = markImpact(trip.plan, applied.plan);
    const resolutionPlaceIds = [...new Set<string>(normalized.candidates.map((candidate: any) => applied.idMappings[candidate.placeTemporaryId]).filter((value: unknown): value is string => typeof value === "string" && Boolean(value)))];
    const written = this.options.store.writePlan(action.tripId, plan, action.baseGeneration, { source: "action:destination.generate", summary: "AI 生成想去的地方" }, { keepActionId: action.id });
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: [] });
    await this.resolveChangedPlaces(action.tripId, resolutionPlaceIds, written.generation, taskId ?? undefined);
    const resolved = currentResolvedPlaces(this.options.store.requireTrip(action.tripId), this.options.store.listPlaceResolutions(action.tripId)).filter((item) => resolutionPlaceIds.includes(item.placeId)).length;
    this.options.store.completeAction(action.id, `generation:${written.generation};resolved:${resolved}/${resolutionPlaceIds.length}`);
  }

  private async persistInterestDiscovery(action: AiActionRecord, taskId: string | null = null) {
    const original = this.options.store.requireTrip(action.tripId);
    const readiness = interestDiscoveryReadinessV3(original.plan);
    const allPlanningAreaIds = new Set(original.plan.candidates.flatMap((candidate) => {
      const place = original.plan.places.find((item) => item.id === candidate.placeId);
      return place && effectivePlanningRole(candidate, place) === "planning_area" ? [candidate.id] : [];
    }));
    const defaultTargetIds = readiness.adoptedPlanningAreaIds.length ? readiness.adoptedPlanningAreaIds : [...allPlanningAreaIds];
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
      this.options.tasks.update(taskId, "running", `正在研究兴趣点 · ${completedAreas}/${targets.length} 已完成 · ${successfulAreaIds.length} 成功 · ${failedAreas.length} 失败 · ${activeRuns.size} 个区域并行处理中`, "interest:progress");
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
      this.rememberActive(taskId, {
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
          existingPlaces: snapshot.plan.candidates.filter((candidate) => candidate.planningAreaCandidateId === targetId).map((candidate) => ({ ...candidate, place: snapshot.plan.places.find((place) => place.id === candidate.placeId) ?? null })),
          areaRequest: { planningAreaCandidateId: targetId, maxNewCandidates: CANDIDATE_DISCOVERY_BATCH_LIMIT },
        },
        validateResult: (value) => {
          if (Number(value?.baseGeneration) !== action.baseGeneration) throw new Error(`兴趣点输出 baseGeneration 必须保持为 ${action.baseGeneration}。`);
          return validateMicroCandidateDiscovery(value, [targetId], [{ planningAreaCandidateId: targetId, targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT }]);
        },
        onProgress: taskId ? this.progress(taskId) : undefined,
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
            const written = this.options.store.writePlan(action.tripId, impactedPlan, expectedGeneration, { source: `action:${action.actionType}`, summary: `AI 发现兴趣点 · ${targetPlace.nameZh}` }, { keepActionId: action.id });
            expectedGeneration = written.generation;
            this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: [] });
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
            failedAreas.push({ targetId, errorSummary: normalizePublicAiSummaryV3(message).slice(0, 500) });
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
    if (this.options.store.requireTrip(action.tripId).contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    if (!successfulAreaIds.length) {
      const details = failedAreas.slice(0, 3).map((item) => `${item.targetId}: ${item.errorSummary}`).join("；");
      throw new Error(details ? `所有兴趣点研究区域均失败：${details}` : "所有兴趣点研究区域均失败。");
    }

    await this.resolveChangedPlaces(action.tripId, [...resolutionPlaceIds], expectedGeneration, taskId ?? undefined, resolutionAbortController.signal);
    throwIfHalted();
    const current = this.options.store.requireTrip(action.tripId);
    if (current.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const currentResolutions = currentPlaceResolutions(current, this.options.store.listPlaceResolutions(action.tripId));
    const resolutionByPlace = new Map(currentResolutions.map((resolution) => [resolution.placeId, resolution]));
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
    if (taskId) this.options.tasks.metadata(taskId, { ...(this.options.store.getAiTask(taskId)?.metadata ?? {}), interestDiscovery });
    const resultRef = `interest:v1;areas=${successfulAreaIds.length}/${targets.length};failed=${failedAreas.length};suggested=${aiSuggestedCount};added=${actualAddedCount};merged=${mergedDuplicateCount};coreSkipped=${skippedCoreDuplicateCount};resolved=${resolvedCount};pending=${unresolvedCount}`;
    throwIfHalted();
    this.options.store.completeAction(action.id, resultRef);
  }

  private persistCandidateProposal(action: AiActionRecord, output: DestinationAddOutput | DestinationReplaceOutput | InterestAddOutput | InterestReplaceOutput) {
    const commands: PlanCommand[] = [];
    if (action.actionType === "destination.replace") commands.push({ type: "remove_candidate_tree", candidateId: String((output as DestinationReplaceOutput).replaceCandidateId || action.targetIds[0] || "") });
    if (action.actionType === "interest.replace") commands.push({ type: "remove_candidate", candidateId: String((output as InterestReplaceOutput).replaceCandidateId || action.targetIds[0] || "") });
    commands.push(candidateCommand(output));
    return this.createProposalForAction(action, output.title, output.explanation, commands, { type: "candidate_pool", id: null });
  }

  private completeRequiresWorkflowStep(action: AiActionRecord, result: any) {
    if (result?.type === "requires_workflow_step") {
      this.options.store.completeAction(action.id, `requiresWorkflowStep:${result.requiresWorkflowStep}`);
      return true;
    }
    if (result?.type === "requires_stage") {
      this.options.store.completeAction(action.id, `requiresStage:${result.requiresStage}`);
      return true;
    }
    return false;
  }

  private persistItineraryGenerate(action: AiActionRecord, output: ItineraryGenerateOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    const trip = this.options.store.requireTrip(action.tripId);
    if (trip.plan.days.length) throw new Error("首次生成路线和天数只能在尚未存在 Day 时执行；已有结果请使用重新规划。");
    if (result.type !== "success") throw new Error("路线和天数生成结果类型无效。");
    const applied = applySkeletonPlanV3(trip, { stays: result.stays, omittedPlanningAreas: result.omittedPlanningAreas });
    const written = this.options.store.writePlan(action.tripId, applied.plan, action.baseGeneration, { source: "action:itinerary.generate", summary: "AI 生成路线和天数" }, { keepActionId: action.id });
    this.options.store.completeAction(action.id, `generation:${written.generation};omitted:${result.omittedPlanningAreas.length}`);
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: applied.affectedDayIds });
    void this.recalculateAllMacroRoutes(action.tripId, written.generation);
  }

  private persistItineraryReplacement(action: AiActionRecord, output: ItineraryReplanOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    if (result.type !== "success") throw new Error("路线和天数更新结果类型无效。");
    const trip = this.options.store.requireTrip(action.tripId);
    const applied = applySkeletonPlanV3(trip, { stays: result.stays, omittedPlanningAreas: result.omittedPlanningAreas });
    if (same(applied.plan, trip.plan)) { this.options.store.completeAction(action.id, "no-change"); return; }
    const written = this.options.store.writePlan(action.tripId, applied.plan, action.baseGeneration, { source: "action:itinerary.replan", summary: "AI 更新路线和天数" }, { keepActionId: action.id });
    this.options.store.completeAction(action.id, `generation:${written.generation};affected:${applied.affectedDayIds.length};omitted:${result.omittedPlanningAreas.length}`);
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: applied.affectedDayIds });
    void this.recalculateAllMacroRoutes(action.tripId, written.generation);
  }

  private persistItineraryDetailGenerate(action: AiActionRecord, output: ItineraryDetailGenerateOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    if (result.type !== "success") throw new Error("详细行程生成结果类型无效。");
    const trip = this.options.store.requireTrip(action.tripId);
    const resolutions = this.options.store.listPlaceResolutions(action.tripId);
    const detail = buildDetailPlanningContextV3(trip.plan, resolutions);
    assertDetailMacroCurrent(detail);
    assertDetailPlanningBlockers(detail);
    const plan = applyDetailedUpdatesPhase5V3(trip, result.dayUpdates, true);
    validateItineraryReferences(trip, plan.days, resolutions);
    validateDetailedSchedulingOutcomeV3(plan, result.unscheduledCandidates, detail.targetDayIds, detail.unavailableCandidateIds);
    const written = this.options.store.writePlan(action.tripId, plan, action.baseGeneration, { source: "action:itinerary.detail.generate", summary: "AI 生成每日详细行程" }, { keepActionId: action.id });
    this.options.store.completeAction(action.id, `generation:${written.generation};unscheduled:${result.unscheduledCandidates.length}`);
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: detail.targetDayIds });
    this.startRouteBatch(action.tripId, written.generation, detail.targetDayIds);
  }

  private persistItineraryDetailUpdate(action: AiActionRecord, output: ItineraryDetailUpdateOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    if (result.type !== "success") throw new Error("详细行程更新结果类型无效。");
    const trip = this.options.store.requireTrip(action.tripId);
    const requestedIds = Array.isArray(action.parameters.dayIds) && action.parameters.dayIds.length
      ? action.parameters.dayIds.map(String)
      : action.targetIds.length
        ? action.targetIds
        : deriveItineraryUpdateStateV3(trip.plan).detail.affectedDayIds;
    const requested = new Set(requestedIds);
    if (!requested.size || requested.size !== result.affectedDayIds.length || result.affectedDayIds.some((id) => !requested.has(id))) throw new Error("AI 返回了 affected scope 外的 Day。");
    const resolutions = this.options.store.listPlaceResolutions(action.tripId);
    const detail = buildDetailPlanningContextV3(trip.plan, resolutions, requestedIds);
    assertDetailMacroCurrent(detail);
    assertDetailPlanningBlockers(detail);
    const replacement = detailedReplacementCommandsPhase5V3(trip, result.dayUpdates);
    validateItineraryReferences(trip, replacement.plan.days.filter((day) => requested.has(day.id)), resolutions);
    validateDetailedSchedulingOutcomeV3(replacement.plan, result.unscheduledCandidates, requestedIds, detail.unavailableCandidateIds);
    if (!replacement.commands.length) {
      const written = this.options.store.writePlan(action.tripId, replacement.plan, action.baseGeneration, { source: "action:itinerary.detail.update", summary: "确认受影响日期无需内容调整" }, { keepActionId: action.id });
      this.options.store.completeAction(action.id, `generation:${written.generation};no-content-change;unscheduled:${result.unscheduledCandidates.length}`);
      this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: result.affectedDayIds });
      return;
    }
    const scope = dayMutationScope(result.affectedDayIds);
    return this.createProposalForAction(action, result.title, result.explanation, replacement.commands, scope, result.affectedDayIds);
  }

  private persistItineraryRepair(action: AiActionRecord, output: ItineraryRepairOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    if (result.type !== "success") throw new Error("行程修复结果类型无效。");
    const trip = this.options.store.requireTrip(action.tripId);
    validateItineraryReferences(trip, result.days, this.options.store.listPlaceResolutions(action.tripId));
    const commands = replacementCommands(trip.plan, result.days);
    if (!commands.length) { this.options.store.completeAction(action.id, "no-change"); return; }
    return this.createProposalForAction(action, result.title, result.explanation, commands, { type: "trip", id: null });
  }

  private persistDayOptimize(action: AiActionRecord, output: ItineraryDayOptimizeOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    if (result.type !== "success") throw new Error("单日优化结果类型无效。");
    const trip = this.options.store.requireTrip(action.tripId);
    const day = trip.plan.days.find((item) => item.id === result.dayId);
    if (!day) throw new Error(`未知 Day：${result.dayId}`);
    const desired = result.orderedStopIds;
    if (desired.length !== day.stops.length || new Set(desired).size !== desired.length || day.stops.some((stop) => !desired.includes(stop.id))) throw new Error("单日优化必须原样覆盖目标 Day 的现有 Stop ID。");
    const working = day.stops.map((stop) => stop.id);
    const commands: PlanCommand[] = [];
    for (let index = 0; index < desired.length; index += 1) {
      const id = desired[index]; const currentIndex = working.indexOf(id); if (currentIndex === index) continue;
      working.splice(currentIndex, 1); working.splice(index, 0, id);
      commands.push({ type: "move_day_stop", stopId: id, targetDayId: day.id, targetIndex: index });
    }
    if (!commands.length) { this.options.store.completeAction(action.id, "no-change"); return; }
    return this.createProposalForAction(action, result.title, result.explanation, commands, { type: "day", id: day.id });
  }

  private persistVerify(action: AiActionRecord, output: ItineraryVerifyOutput) {
    const allowed = output.commands.map((command) => PlanCommandSchema.parse(command));
    for (const command of allowed) {
      if (command.type !== "update_day_stop") throw new Error("动态核验 Action 只能更新现有 Stop 的动态事实字段。");
      const keys = Object.keys(command.changes);
      if (!keys.length || keys.some((key) => !VERIFY_STOP_FIELDS.has(key))) throw new Error("动态核验 Action 尝试修改地点身份或其他非动态字段。");
    }
    if (!allowed.length) { this.options.store.completeAction(action.id, `verified:${output.checkedAt};no-change`); return; }
    return this.createProposalForAction(action, output.title, output.explanation, allowed, { type: "trip", id: null });
  }

  private persistRefine(action: AiActionRecord, output: ItineraryRefineOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    if (result.type !== "success") throw new Error("细化行程结果类型无效。");
    const trip = this.options.store.requireTrip(action.tripId);
    const commands = refinementCommands(trip.plan, output);
    if (!commands.length) { this.options.store.completeAction(action.id, "no-change"); return; }
    const scope = dayMutationScope(result.dayIds);
    return this.createProposalForAction(action, result.title, result.explanation, commands, scope, result.dayIds);
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
  selectResolution(tripId: string, placeId: string, input: unknown) { return (this.options.resolver as any).selectCandidate(tripId, placeId, input); }
  setDirectResolution(tripId: string, placeId: string, input: unknown) { return (this.options.resolver as any).setDirect(tripId, placeId, input); }
  private googleMapsLinks() {
    if (!this.options.googleMapsLinks) throw new Error("Google Maps 链接解析服务未配置。");
    return this.options.googleMapsLinks;
  }

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
  async previewGoogleMapsLink(tripId: string, placeId: string, input: unknown) {
    const parsed = GoogleMapsLinkPreviewInputSchema.parse(input);
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== parsed.expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    if (!trip.plan.places.some((place) => place.id === placeId)) throw new Error("找不到目标 Place。");
    return this.googleMapsLinks().preview(parsed.url);
  }
  async applyGoogleMapsLink(tripId: string, placeId: string, input: unknown) {
    const parsed = GoogleMapsLinkCommitInputSchema.parse(input);
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== parsed.expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const currentPlace = trip.plan.places.find((place) => place.id === placeId);
    if (!currentPlace) throw new Error("找不到目标 Place。");
    const preview = await this.googleMapsLinks().preview(parsed.url);
    const command = PlanCommandSchema.parse({ type: "update_place", placeId, changes: { ...parsed.changes, nameZh: currentPlace.nameZh } });
    const applied = applyPlanCommands(trip.plan, [command]);
    const plan = markImpact(trip.plan, applied.plan);
    const place = plan.places.find((item) => item.id === placeId) as Place | undefined;
    if (!place) throw new Error("找不到更新后的 Place。");
    const resolution: PlaceResolution = {
      tripId, placeId, geoFingerprint: placeGeoFingerprint(place), status: "resolved", method: "google_maps_link",
      provider: null, providerPlaceId: null, latitude: preview.latitude, longitude: preview.longitude,
      address: preview.address, confidence: null, resolvedAt: now(), errorMessage: null,
    };
    const written = this.options.store.writePlanAndPlaceResolution(tripId, plan, resolution, parsed.expectedGeneration, { source: "google_maps_link", summary: "通过 Google Maps 链接更新地点和坐标" });
    this.emit("travel.document.changed", { tripId, generation: written.generation, changedDayIds: applied.effects.changedDayIds });
    this.emit("travel.resolution.changed", { tripId, placeId });
    return { trip: written.trip, resolution: written.resolution, generation: written.generation, version: written.version };
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
