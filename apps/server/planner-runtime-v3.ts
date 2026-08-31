import { randomUUID } from "node:crypto";
import {
  AiProposalSchema,
  CandidatePreferenceSchema,
  PlanCommandSchema,
  ProposalScopeSchema,
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type Day,
  type DayStop,
  type PlaceResolution,
  type PlanCommand,
  type ProposalDiff,
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
import { CANDIDATE_DISCOVERY_BATCH_LIMIT, validateMicroCandidateDiscovery } from "./candidate-discovery-policy-v2.js";
import type { DayRouteServiceV2 } from "./day-route-v2.js";
import { analyzeItineraryImpactV3 } from "./itinerary-impact-v3.js";
import {
  applyDetailedUpdatesV3,
  buildMacroDaysV3,
  deriveItineraryUpdateStateV3,
  detailedReplacementCommandsV3,
  macroReplacementCommandsV3,
} from "./itinerary-workflow-v3.js";
import { applyPlanCommands } from "./plan-commands-v2.js";
import { buildPlanningCoverage } from "./planning-areas-v2.js";
import type { PlaceResolutionBatchProgress, PlaceResolverV2 } from "./place-resolver-v2.js";
import { resolutionIsCurrent } from "./place-resolver-v2.js";
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
const STOP_FIELDS = ["activity", "period", "startTime", "endTime", "durationMinutes", "transportFromPrevious", "scheduleVerification", "costNote", "costVerification", "notes"] as const;
const VERIFY_STOP_FIELDS = new Set(["startTime", "endTime", "durationMinutes", "transportFromPrevious", "scheduleVerification", "costNote", "costVerification", "notes"]);
const REQUIREMENT_FIELDS = ["title", "dates", "travelers", "budget", "pace", "themes", "preferences", "constraints", "assumptions"] as const;
const REPLACEMENT_COMMAND_LIMIT = 100;

type ActiveRun = { tripId: string; interrupt: () => Promise<void>; actionId?: string; messageId?: string; stage?: ConversationStage };
type ActionOutput = Record<string, any>;

function now() { return new Date().toISOString(); }
function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
function stringifySize(value: unknown) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

function actionScope(actionType: AiActionType, targetIds: string[], parameters: Record<string, unknown>): ProposalScope {
  if (actionType.startsWith("requirements.")) return { type: "trip", id: null };
  if (actionType.startsWith("destination.") || actionType.startsWith("interest.")) return { type: "candidate_pool", id: null };
  if (actionType === "itinerary.day.optimize" || actionType === "itinerary.refine" || actionType === "itinerary.detail.update") {
    const ids = Array.isArray(parameters.dayIds) ? parameters.dayIds.filter((value): value is string => typeof value === "string") : [];
    const id = targetIds[0] || (typeof parameters.dayId === "string" ? parameters.dayId : ids.length === 1 ? ids[0] : "");
    return id ? { type: "day", id } : { type: "trip", id: null };
  }
  return { type: "trip", id: null };
}

function proposalDiff(commands: PlanCommand[], effects: ReturnType<typeof applyPlanCommands>["effects"]): ProposalDiff {
  const labels = commands.map((command) => {
    if (command.type === "add_candidate") return `新增地点：${command.place.nameZh}`;
    if (command.type === "remove_candidate" || command.type === "remove_candidate_tree") return `移除 Candidate：${command.candidateId}`;
    if (command.type === "update_candidate") return `更新 Candidate：${command.candidateId}`;
    if (command.type === "update_place") return `更新 Place：${command.placeId}`;
    if (command.type === "set_candidate_preference") return `调整 Candidate preference：${command.candidateId}`;
    if (command.type === "bulk_set_candidate_preference") return `批量调整 ${command.candidateIds.length} 个 Candidate`;
    if (command.type === "set_day_anchor") return `设置 Day Anchor：${command.dayId}`;
    if (command.type === "add_day_stop") return `Day ${command.dayId} 新增 Stop`;
    if (command.type === "remove_day_stop") return `删除 Stop：${command.stopId}`;
    if (command.type === "move_day_stop") return `移动 Stop：${command.stopId}`;
    if (command.type === "update_day_stop") return `更新 Stop：${command.stopId}`;
    if (command.type === "move_day") return `调整 Day 顺序：${command.dayId}`;
    return `更新 Day：${command.dayId}`;
  });
  return {
    summary: `建议执行 ${commands.length} 项受控修改${effects.routeDirtyDayIds.length ? `；${effects.routeDirtyDayIds.length} 天路线需更新` : ""}`,
    commandSummaries: labels,
    affectedCandidateIds: effects.changedCandidateIds,
    affectedPlaceIds: effects.changedPlaceIds,
    affectedDayIds: effects.changedDayIds,
  };
}

function currentPlaceResolutions(trip: TripDetailV3, resolutions: PlaceResolution[]) {
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  return resolutions.filter((resolution) => {
    const place = places.get(resolution.placeId);
    return Boolean(place && resolutionIsCurrent(place, resolution));
  });
}

function currentResolvedPlaces(trip: TripDetailV3, resolutions: PlaceResolution[]) {
  return currentPlaceResolutions(trip, resolutions).filter((resolution) => resolution.status === "resolved");
}

function validateItineraryReferences(trip: TripDetailV3, sourceDays: Day[], _resolutions: PlaceResolution[]) {
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const candidates = new Map(trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const checkPlace = (placeId: string | null) => {
    if (!placeId) return;
    if (!places.has(placeId)) throw new Error(`行程引用未知 Place：${placeId}`);
  };
  for (const day of sourceDays) {
    checkPlace(day.startAnchor.placeId);
    checkPlace(day.endAnchor.placeId);
    for (const stop of day.stops) {
      checkPlace(stop.placeId);
      if (!stop.candidateId) continue;
      const candidate = candidates.get(stop.candidateId);
      if (!candidate) throw new Error(`行程引用未知 Candidate：${stop.candidateId}`);
      if (candidate.preference === "excluded") throw new Error(`已排除 Candidate 不得进入行程：${candidate.id}`);
      if (candidate.placeId !== stop.placeId) throw new Error(`Stop Candidate 与 Place 不一致：${candidate.id}`);
    }
  }
}

function normalizeCandidateDiscoveryOutput(output: any, mode: "macro" | "micro") {
  if (mode === "macro") return {
    schemaVersion: 1,
    baseGeneration: output.baseGeneration,
    assistantMessage: output.assistantMessage,
    places: output.places,
    candidates: output.candidates.map((candidate: any) => ({ ...candidate, planningAreaCandidateId: null, defaultPreference: "optional" })),
  };
  return output;
}

function candidateCommand(output: { places: any[]; candidates: any[] }) {
  const source = output.candidates[0];
  const place = output.places.find((item) => item.id === source?.placeTemporaryId) ?? output.places[0];
  if (!source || !place) throw new Error("AI 没有返回可正式化的地点。");
  return PlanCommandSchema.parse({
    type: "add_candidate",
    place,
    candidate: {
      id: source.temporaryId,
      placeId: place.id,
      planningAreaCandidateId: source.planningAreaCandidateId,
      preference: "optional",
      source: "ai",
      aiReason: source.aiReason,
      aiScore: source.aiScore,
      suggestedDurationMinutes: source.suggestedDurationMinutes,
      tags: source.tags,
    },
  });
}

function stopsRepresentSameVisit(left: DayStop, right: DayStop) {
  if (left.candidateId && right.candidateId) return left.candidateId === right.candidateId && left.placeId === right.placeId;
  return left.placeId === right.placeId;
}

function replacementCommands(current: TravelPlanDocument, sourceDays: Day[], onlyDayIds?: Set<string>) {
  const commands: PlanCommand[] = [];
  const currentByNumber = new Map(current.days.map((day) => [day.dayNumber, day]));
  const seen = new Set<number>();
  for (const source of sourceDays) {
    if (seen.has(source.dayNumber)) throw new Error(`AI 返回重复 dayNumber：${source.dayNumber}`);
    seen.add(source.dayNumber);
    const target = currentByNumber.get(source.dayNumber);
    if (!target) throw new Error(`AI 返回未知 dayNumber：${source.dayNumber}`);
    if (onlyDayIds && !onlyDayIds.has(target.id)) throw new Error(`AI 修改了 Scope 外 Day：${target.id}`);
    if (target.title !== source.title) commands.push({ type: "update_day", dayId: target.id, changes: { title: source.title } });
    if (!same(target.startAnchor, source.startAnchor)) commands.push({ type: "set_day_anchor", dayId: target.id, anchor: "start", placeId: source.startAnchor.placeId, label: source.startAnchor.label, notes: source.startAnchor.notes });
    if (!same(target.endAnchor, source.endAnchor)) commands.push({ type: "set_day_anchor", dayId: target.id, anchor: "end", placeId: source.endAnchor.placeId, label: source.endAnchor.label, notes: source.endAnchor.notes });

    const working = target.stops.map((stop) => structuredClone(stop));
    for (let index = 0; index < source.stops.length; index += 1) {
      const desired = source.stops[index];
      const matchIndex = working.findIndex((stop, workingIndex) => workingIndex >= index && stopsRepresentSameVisit(stop, desired));
      if (matchIndex >= 0) {
        if (matchIndex !== index) {
          const [moved] = working.splice(matchIndex, 1);
          working.splice(index, 0, moved);
          commands.push({ type: "move_day_stop", stopId: moved.id, targetDayId: target.id, targetIndex: index });
        }
        const before = working[index];
        const changes: Record<string, unknown> = {};
        for (const key of STOP_FIELDS) if (!same(before[key], desired[key])) changes[key] = structuredClone(desired[key]);
        if (Object.keys(changes).length) {
          commands.push(PlanCommandSchema.parse({ type: "update_day_stop", stopId: before.id, changes }));
          Object.assign(before, changes);
        }
      } else {
        const added = { ...structuredClone(desired), id: `tmp-stop-${randomUUID()}` };
        commands.push(PlanCommandSchema.parse({ type: "add_day_stop", dayId: target.id, index, stop: added }));
        working.splice(index, 0, added);
      }
    }
    for (let index = working.length - 1; index >= source.stops.length; index -= 1) {
      commands.push({ type: "remove_day_stop", stopId: working[index].id });
      working.splice(index, 1);
    }
  }
  if (commands.length > REPLACEMENT_COMMAND_LIMIT) throw new Error(`本次行程修改需要 ${commands.length} 条受控命令，超过单个 Proposal 的 ${REPLACEMENT_COMMAND_LIMIT} 条资源上限；请缩小修改范围后重试。`);
  return commands.map((command) => PlanCommandSchema.parse(command));
}

function refinementCommands(current: TravelPlanDocument, output: ItineraryRefineOutput) {
  const result = output.result;
  if (result.type !== "success") return [];
  const requested = new Set(result.dayIds);
  const commands: PlanCommand[] = [];
  for (const update of result.dayUpdates) {
    const target = current.days.find((day) => day.id === update.dayId);
    if (!target || !requested.has(target.id)) throw new Error(`细化结果引用未知 Day：${update.dayId}`);
    const returned = new Map(update.stops.map((stop) => [stop.stopId, stop]));
    if (returned.size !== update.stops.length || update.stops.length !== target.stops.length || target.stops.some((stop) => !returned.has(stop.id))) {
      throw new Error(`细化必须恰好返回目标 Day 的全部现有 Stop：${target.id}`);
    }
    for (const before of target.stops) {
      const after = returned.get(before.id)!;
      const changes: Record<string, unknown> = {};
      for (const key of STOP_FIELDS) if (!same(before[key], after[key])) changes[key] = structuredClone(after[key]);
      if (Object.keys(changes).length) commands.push(PlanCommandSchema.parse({ type: "update_day_stop", stopId: before.id, changes }));
    }
  }
  const preview = applyPlanCommands(current, commands).plan;
  TravelPlanDocumentSchema.parse({
    ...preview,
    days: preview.days.map((day) => requested.has(day.id) ? { ...day, detailLevel: "detailed", detailStatus: "ready" } : day),
  });
  return commands;
}

function markImpact(before: TravelPlanDocument, after: TravelPlanDocument) {
  const impact = analyzeItineraryImpactV3(before, after);
  if (!impact.detail.affectedDayIds.length) return after;
  const affected = new Set(impact.detail.affectedDayIds);
  return TravelPlanDocumentSchema.parse({
    ...after,
    days: after.days.map((day) => affected.has(day.id) && day.detailLevel === "detailed" ? { ...day, detailStatus: "needs_review" } : day),
  });
}

export class TravelPlannerRuntimeV3 {
  private readonly active = new Map<string, ActiveRun>();
  private readonly aiExecutingTrips = new Set<string>();

  constructor(private readonly options: {
    store: TravelStoreV3;
    ai: StagedTravelAiV3;
    prompts: LoadedPromptRegistryV3;
    tasks: AiTaskMonitorV3;
    resolver: PlaceResolverV2;
    routes: DayRouteServiceV2;
    emit: (event: RuntimeEventV3) => void;
  }) {}

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
    if (!active || active.tripId !== tripId) throw new Error("当前任务已经结束。");
    void active.interrupt().catch(() => undefined);
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
          this.options.store.createAssistantMessage(tripId, stage, verified.assistantMessage, { type: "reply", verification: verified.verification });
        } else if (output.result.type === "action") {
          const registration = actionRegistration(output.result.actionType);
          if (registration.stage !== stage) throw new Error(`阶段对话识别了越界 Action：${output.result.actionType}`);
          const normalizedParameters = parseActionParametersV3(output.result.actionType, registration.inputContract, "conversation", output.result.parameters);
          const scope = actionScope(output.result.actionType, output.result.targetIds, normalizedParameters);
          const action = AiActionRecordSchema.parse({
            id: randomUUID(), tripId, stage, actionType: output.result.actionType, executor: registration.executor, origin: "conversation", sourceMessageId: messageId,
            parameters: output.result.parameters, targetIds: output.result.targetIds, scope, baseGeneration, status: "pending_confirmation",
            taskId: null, proposalId: null, resultRef: null, startedAt: null, updatedAt: now(), completedAt: null, errorSummary: null,
          });
          const stored = this.options.store.createAction(action).action;
          this.options.store.createAssistantMessage(tripId, stage, output.result.assistantMessage, { type: "action", actionId: stored.id, impactSummary: output.result.impactSummary });
          this.emit("travel.action.changed", { tripId, actionId: stored.id });
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
    const registration = actionRegistration(input.actionType);
    if (registration.stage !== input.stage) throw new Error(`CTA Action 与阶段不匹配：${input.actionType}`);
    const trip = this.options.store.requireTrip(input.tripId);
    const rawParameters = input.parameters ?? {};
    const normalizedParameters = parseActionParametersV3(input.actionType, registration.inputContract, "cta", rawParameters);
    const targetIds = input.targetIds ?? [];
    const action = AiActionRecordSchema.parse({
      id: randomUUID(), tripId: input.tripId, stage: input.stage, actionType: input.actionType, executor: registration.executor, origin: "cta", sourceMessageId: null,
      parameters: rawParameters, targetIds, scope: actionScope(input.actionType, targetIds, normalizedParameters), baseGeneration: trip.contentGeneration, status: "pending_confirmation",
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
      this.options.tasks.start({ id: taskId, tripId: action.tripId, agent: "action", label: action.actionType, summary: `准备执行 ${action.actionType}`, metadata: { actionType: action.actionType, executor: "ai", reasoning: registration.reasoning, webPolicy: registration.web, inputBytes: stringifySize(state) } });

      if (action.actionType === "interest.discover" || action.actionType === "interest.supplement") {
        this.options.tasks.update(taskId, "running", `正在执行 ${action.actionType}`, "action:running");
        await this.persistInterestDiscovery(action, null, taskId);
      } else {
        const run = await this.options.ai.startAction<ActionOutput>({ actionType: action.actionType, state, allowWeb: action.parameters.allowWeb !== false, onProgress: this.progress(taskId) });
        this.rememberActive(taskId, { tripId: action.tripId, actionId: action.id, interrupt: run.interrupt });
        this.options.tasks.update(taskId, "running", `正在执行 ${action.actionType}`, "action:running");
        const output = await run.result;
        if (Number(output?.baseGeneration) !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        if (this.options.store.requireTrip(action.tripId).contentGeneration !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        await this.persistAiActionOutput(action, output, taskId);
      }

      const final = this.options.store.getAction(action.id);
      this.options.tasks.metadata(taskId, { actionType: action.actionType, executor: "ai", reasoning: registration.reasoning, webPolicy: registration.web, inputBytes: stringifySize(state), timing: { totalMs: Date.now() - started } });
      this.options.tasks.update(taskId, "completed", final?.status === "awaiting_apply" ? "方案已生成，等待 Apply" : "Action 已完成", "task:completed");
      this.emit("travel.action.changed", { tripId: action.tripId, actionId: action.id });
    } catch (error) {
      const message = normalizePublicAiSummaryV3(aiErrorMessageV3(error)) || "Action 执行失败";
      if (message === "CONTENT_GENERATION_SUPERSEDED") this.options.store.supersedeAction(action.id, "计划已发生变化，Action 已失效。");
      else this.options.store.failAction(action.id, message);
      if (taskId) {
        this.options.tasks.metadata(taskId, { actionType: action.actionType, timing: { totalMs: Date.now() - started, failedPhase: "generation" } });
        this.options.tasks.update(taskId, message === "CONTENT_GENERATION_SUPERSEDED" ? "cancelled_by_generation" : message === "AI 任务已停止。" ? "stopped" : "failed", message, "task:failed");
      }
      this.emit("travel.action.changed", { tripId: action.tripId, actionId: action.id });
    } finally {
      if (taskId) this.forgetActive(taskId);
    }
  }

  private buildActionState(action: AiActionRecord) {
    const trip = this.options.store.requireTrip(action.tripId);
    const places = new Map(trip.plan.places.map((place) => [place.id, place]));
    const resolutions = this.options.store.listPlaceResolutions(action.tripId);
    const currentResolutions = currentResolvedPlaces(trip, resolutions);
    const resolutionByPlace = new Map(currentResolutions.map((resolution) => [resolution.placeId, resolution]));
    const candidateState = (candidate: TripDetailV3["plan"]["candidates"][number]) => ({ ...candidate, place: places.get(candidate.placeId) ?? null, resolution: resolutionByPlace.get(candidate.placeId) ?? null });
    const base = { actionType: action.actionType, baseGeneration: action.baseGeneration, planLanguage: trip.planLanguage, parameters: action.parameters, targetIds: action.targetIds };
    if (action.actionType.startsWith("destination.")) {
      return { ...base, tripFacts: trip.plan.trip, destinations: trip.plan.candidates.filter((candidate) => places.get(candidate.placeId)?.kind === "city").map((candidate) => ({ ...candidate, place: places.get(candidate.placeId) })) };
    }
    if (action.actionType.startsWith("interest.")) {
      const targetIds = action.targetIds.length ? action.targetIds : trip.plan.candidates.filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city").map((candidate) => candidate.id);
      return { ...base, tripFacts: trip.plan.trip, targetMacroCandidateIds: targetIds };
    }
    if (action.actionType === "itinerary.day.optimize" || action.actionType === "itinerary.refine") {
      const requested = action.actionType === "itinerary.day.optimize"
        ? [String(action.parameters.dayId ?? action.targetIds[0] ?? "")].filter(Boolean)
        : (Array.isArray(action.parameters.dayIds) && action.parameters.dayIds.length
            ? action.parameters.dayIds.map(String).slice(0, 2)
            : action.targetIds.length
              ? action.targetIds.slice(0, 2)
              : trip.plan.days.filter((day) => day.detailLevel !== "detailed" || day.detailStatus !== "ready").slice(0, 2).map((day) => day.id));
      if (!requested.length) throw new Error("单日 AI Action 缺少目标 Day。");
      const targetDays = requested.map((dayId) => {
        const day = trip.plan.days.find((item) => item.id === dayId);
        if (!day) throw new Error(`未知 Day：${dayId}`);
        return day;
      });
      const targetIndexes = targetDays.map((day) => trip.plan.days.findIndex((item) => item.id === day.id));
      const adjacentIds = new Set<string>();
      for (const index of targetIndexes) {
        if (trip.plan.days[index - 1]) adjacentIds.add(trip.plan.days[index - 1].id);
        if (trip.plan.days[index + 1]) adjacentIds.add(trip.plan.days[index + 1].id);
      }
      for (const day of targetDays) adjacentIds.delete(day.id);
      const candidateIds = new Set(targetDays.flatMap((day) => day.stops.map((stop) => stop.candidateId).filter((id): id is string => Boolean(id))));
      const routeStates = this.options.routes.workspaceRouteState(action.tripId);
      return {
        ...base,
        tripFacts: trip.plan.trip,
        stage: trip.plan.stage,
        targetDayIds: targetDays.map((day) => day.id),
        days: targetDays,
        adjacentDays: trip.plan.days.filter((day) => adjacentIds.has(day.id)).map((day) => ({ id: day.id, dayNumber: day.dayNumber, date: day.date, title: day.title, startPlaceId: day.startAnchor.placeId, endPlaceId: day.endAnchor.placeId, stopPlaceIds: day.stops.map((stop) => stop.placeId) })),
        candidates: trip.plan.candidates.filter((candidate) => candidateIds.has(candidate.id)).map(candidateState),
        routeStates: routeStates.filter((route) => requested.includes(route.dayId) || adjacentIds.has(route.dayId)),
      };
    }
    if (action.actionType === "itinerary.detail.update") {
      const derived = deriveItineraryUpdateStateV3(trip.plan).detail.affectedDayIds;
      const requested = Array.isArray(action.parameters.dayIds) && action.parameters.dayIds.length ? action.parameters.dayIds.map(String) : action.targetIds.length ? action.targetIds : derived;
      if (!requested.length) throw new Error("当前没有需要局部更新的 Day。");
      const requestedSet = new Set(requested);
      return {
        ...base,
        tripFacts: trip.plan.trip,
        stage: trip.plan.stage,
        affectedDayIds: requested,
        days: trip.plan.days.filter((day) => requestedSet.has(day.id)),
        allMacroDays: trip.plan.days.map((day) => ({ id: day.id, dayNumber: day.dayNumber, date: day.date, title: day.title, transferMode: day.transferMode, startAnchor: day.startAnchor, endAnchor: day.endAnchor })),
        candidates: trip.plan.candidates.filter((candidate) => candidate.preference !== "excluded").map(candidateState),
        macroRouteStates: this.options.routes.workspaceMacroRouteState(action.tripId).filter((route) => requestedSet.has(route.dayId)),
      };
    }
    if (action.actionType.startsWith("itinerary.")) {
      return {
        ...base,
        tripFacts: trip.plan.trip,
        stage: trip.plan.stage,
        candidates: trip.plan.candidates.filter((candidate) => candidate.preference !== "excluded").map(candidateState),
        days: trip.plan.days,
        routeStates: this.options.routes.workspaceRouteState(action.tripId),
        macroRouteStates: this.options.routes.workspaceMacroRouteState(action.tripId),
        itineraryUpdateState: deriveItineraryUpdateStateV3(trip.plan),
      };
    }
    return base;
  }

  private async executeDeterministic(action: AiActionRecord) {
    const trip = this.options.store.requireTrip(action.tripId);
    if (trip.contentGeneration !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    if (action.actionType === "requirements.update" || action.actionType === "requirements.clear") {
      const defaults = emptyTravelPlan().trip;
      const next = structuredClone(trip.plan);
      if (action.actionType === "requirements.update") {
        const raw = action.parameters.changes && typeof action.parameters.changes === "object" && !Array.isArray(action.parameters.changes) ? action.parameters.changes as Record<string, unknown> : {};
        if (!Object.keys(raw).length) throw new Error("requirements.update 没有可执行字段。");
        for (const key of REQUIREMENT_FIELDS) if (key in raw) (next.trip as any)[key] = structuredClone(raw[key]);
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

    const commands = this.deterministicCommands(action, trip);
    const applied = applyPlanCommands(trip.plan, commands);
    if (action.actionType.startsWith("itinerary.")) validateItineraryReferences(trip, applied.plan.days, this.options.store.listPlaceResolutions(action.tripId));
    const plan = markImpact(trip.plan, applied.plan);
    const written = this.options.store.writePlan(action.tripId, plan, action.baseGeneration, { source: `action:${action.actionType}`, summary: `执行 ${action.actionType}` }, { keepActionId: action.id });
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: applied.effects.changedDayIds });
    await this.resolveChangedPlaces(action.tripId, applied.effects.changedPlaceIds, written.generation);
    return `generation:${written.generation}`;
  }

  private deterministicCommands(action: AiActionRecord, trip: TripDetailV3): PlanCommand[] {
    const p = action.parameters as Record<string, any>;
    const places = new Map(trip.plan.places.map((place) => [place.id, place]));
    const candidate = (id: string) => {
      const value = trip.plan.candidates.find((item) => item.id === id);
      if (!value) throw new Error(`未知 Candidate：${id}`);
      return value;
    };
    const targetCandidateId = String(p.candidateId ?? action.targetIds[0] ?? "");
    if (action.actionType === "destination.remove") {
      const item = candidate(targetCandidateId); if (places.get(item.placeId)?.kind !== "city") throw new Error("只能在目的地阶段删除 Macro Candidate。");
      return [{ type: "remove_candidate_tree", candidateId: item.id }];
    }
    if (action.actionType === "interest.remove") {
      const item = candidate(targetCandidateId); if (places.get(item.placeId)?.kind === "city") throw new Error("兴趣点删除不能删除 Macro Candidate。");
      return [{ type: "remove_candidate", candidateId: item.id }];
    }
    if (action.actionType === "destination.preference" || action.actionType === "interest.preference") {
      const ids = Array.isArray(p.candidateIds) && p.candidateIds.length ? p.candidateIds.map(String) : action.targetIds.length ? action.targetIds : [targetCandidateId];
      const preference = CandidatePreferenceSchema.parse(p.preference);
      if (!ids.length) throw new Error("缺少 Candidate ID。");
      for (const id of ids) {
        const item = candidate(id); const macro = places.get(item.placeId)?.kind === "city";
        if (action.actionType === "destination.preference" && !macro) throw new Error("目的地 preference 只能修改 Macro Candidate。");
        if (action.actionType === "interest.preference" && macro) throw new Error("兴趣点 preference 只能修改 Micro Candidate。");
      }
      return ids.length === 1 ? [{ type: "set_candidate_preference", candidateId: ids[0], preference }] : [{ type: "bulk_set_candidate_preference", candidateIds: ids, preference }];
    }
    if (action.actionType === "destination.edit" || action.actionType === "interest.edit") {
      const item = candidate(targetCandidateId); const macro = places.get(item.placeId)?.kind === "city";
      if (action.actionType === "destination.edit" && !macro) throw new Error("目的地编辑只能修改 Macro Candidate。");
      if (action.actionType === "interest.edit" && macro) throw new Error("兴趣点编辑只能修改 Micro Candidate。");
      const commands: PlanCommand[] = [];
      if (p.placeChanges && typeof p.placeChanges === "object") commands.push(PlanCommandSchema.parse({ type: "update_place", placeId: item.placeId, changes: p.placeChanges }));
      if (p.candidateChanges && typeof p.candidateChanges === "object") commands.push(PlanCommandSchema.parse({ type: "update_candidate", candidateId: item.id, changes: p.candidateChanges }));
      if (!commands.length) throw new Error("没有可执行的明确字段修改。");
      return commands;
    }
    if (action.actionType === "itinerary.stop.remove") return [PlanCommandSchema.parse({ type: "remove_day_stop", stopId: String(p.stopId ?? action.targetIds[0] ?? "") })];
    if (action.actionType === "itinerary.stop.move") return [PlanCommandSchema.parse({ type: "move_day_stop", stopId: String(p.stopId ?? action.targetIds[0] ?? ""), targetDayId: String(p.targetDayId ?? ""), targetIndex: Number(p.targetIndex) })];
    if (action.actionType === "itinerary.day.reorder") return [PlanCommandSchema.parse({ type: "move_day", dayId: String(p.dayId ?? action.targetIds[0] ?? ""), targetIndex: Number(p.targetIndex) })];
    if (action.actionType === "itinerary.anchor.set") return [PlanCommandSchema.parse({ type: "set_day_anchor", dayId: String(p.dayId ?? action.targetIds[0] ?? ""), anchor: p.anchor, placeId: p.placeId ?? null, label: p.label ?? null, notes: p.notes ?? null })];
    if (action.actionType === "itinerary.stop.replace") {
      const stopId = String(p.stopId ?? action.targetIds[0] ?? ""); const replacement = candidate(String(p.candidateId ?? ""));
      return [PlanCommandSchema.parse({ type: "update_day_stop", stopId, changes: { candidateId: replacement.id, placeId: replacement.placeId, ...(typeof p.activity === "string" ? { activity: p.activity } : {}) } })];
    }
    if (action.actionType === "itinerary.stop.add") {
      const dayId = String(p.dayId ?? action.targetIds[0] ?? ""); const item = candidate(String(p.candidateId ?? "")); const place = places.get(item.placeId); if (!place) throw new Error("Candidate 引用未知 Place。");
      const day = trip.plan.days.find((value) => value.id === dayId); if (!day) throw new Error(`未知 Day：${dayId}`);
      const index = p.index == null ? day.stops.length : Number(p.index);
      const stop: DayStop = { id: `tmp-stop-${randomUUID()}`, candidateId: item.id, placeId: item.placeId, activity: typeof p.activity === "string" && p.activity.trim() ? p.activity.trim() : `游览${place.nameZh}`, period: null, startTime: null, endTime: null, durationMinutes: item.suggestedDurationMinutes, transportFromPrevious: null, scheduleVerification: null, costNote: null, costVerification: null, notes: null };
      return [PlanCommandSchema.parse({ type: "add_day_stop", dayId, index, stop })];
    }
    if (action.actionType === "itinerary.edit") {
      if (p.stopId) return [PlanCommandSchema.parse({ type: "update_day_stop", stopId: String(p.stopId), changes: p.changes })];
      return [PlanCommandSchema.parse({ type: "update_day", dayId: String(p.dayId ?? action.targetIds[0] ?? ""), changes: p.changes })];
    }
    throw new Error(`未实现 deterministic Action：${action.actionType}`);
  }

  private resolutionProgress(tripId: string, taskId?: string) {
    return (progress: PlaceResolutionBatchProgress) => {
      this.emit("travel.resolution.changed", { tripId, placeId: progress.placeId });
      if (!taskId) return;
      const state = progress.status === "resolving" ? "定位中" : progress.status === "resolved" ? "已定位" : "未定位";
      this.options.tasks.update(taskId, "running", `正在定位地点 ${progress.completed}/${progress.total} · ${state}`, "map:resolution");
    };
  }

  private async resolveChangedPlaces(tripId: string, placeIds: string[], expectedGeneration: number, taskId?: string) {
    const current = this.options.store.requireTrip(tripId);
    if (current.contentGeneration !== expectedGeneration) return [];
    const existing = new Set(current.plan.places.map((place) => place.id));
    const ids = [...new Set(placeIds)].filter((placeId) => existing.has(placeId));
    if (!ids.length) return [];
    try {
      return await this.options.resolver.resolveMany(tripId, ids, expectedGeneration, undefined, this.resolutionProgress(tripId, taskId));
    } catch (error) {
      if (aiErrorMessageV3(error) === "CONTENT_GENERATION_SUPERSEDED") return [];
      return [];
    }
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
    const normalized = normalizeCandidateDiscoveryOutput(output, "macro");
    const applied = applyCandidateDiscovery(trip.plan, normalized);
    const plan = markImpact(trip.plan, applied.plan);
    const resolutionPlaceIds = [...new Set<string>(normalized.candidates.map((candidate: any) => applied.idMappings[candidate.placeTemporaryId]).filter((value: unknown): value is string => typeof value === "string" && Boolean(value)))];
    const written = this.options.store.writePlan(action.tripId, plan, action.baseGeneration, { source: "action:destination.generate", summary: "AI 生成目的地建议" }, { keepActionId: action.id });
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: [] });
    await this.resolveChangedPlaces(action.tripId, resolutionPlaceIds, written.generation, taskId ?? undefined);
    const resolved = currentResolvedPlaces(this.options.store.requireTrip(action.tripId), this.options.store.listPlaceResolutions(action.tripId)).filter((item) => resolutionPlaceIds.includes(item.placeId)).length;
    this.options.store.completeAction(action.id, `generation:${written.generation};resolved:${resolved}/${resolutionPlaceIds.length}`);
  }

  private async persistInterestDiscovery(action: AiActionRecord, firstOutput: any | null, taskId: string | null = null) {
    const original = this.options.store.requireTrip(action.tripId);
    const places = new Map(original.plan.places.map((place) => [place.id, place]));
    const targets = action.targetIds.length ? action.targetIds : original.plan.candidates.filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city").map((candidate) => candidate.id);
    if (!targets.length) throw new Error("请先生成并保留至少一个目的地。");
    let plan = structuredClone(original.plan);
    const addedPlaceIds = new Set<string>();
    const resolutionPlaceIds = new Set<string>();
    for (let index = 0; index < targets.length; index += 1) {
      const targetId = targets[index];
      const target = plan.candidates.find((candidate) => candidate.id === targetId);
      const targetPlace = target ? plan.places.find((place) => place.id === target.placeId) : null;
      if (!target || target.preference === "excluded" || targetPlace?.kind !== "city") throw new Error(`兴趣点研究目标不是有效 Macro Candidate：${targetId}`);
      let output = index === 0 ? firstOutput : null;
      if (!output) {
        const run = await this.options.ai.startAction<any>({
          actionType: action.actionType,
          state: {
            actionType: action.actionType,
            baseGeneration: action.baseGeneration,
            tripFacts: original.plan.trip,
            targetMacroCandidate: { ...target, place: targetPlace },
            existingPlaces: plan.candidates.filter((candidate) => candidate.planningAreaCandidateId === targetId).map((candidate) => ({ ...candidate, place: plan.places.find((place) => place.id === candidate.placeId) ?? null })),
            areaRequest: { planningAreaCandidateId: targetId, maxNewCandidates: CANDIDATE_DISCOVERY_BATCH_LIMIT },
          },
          onProgress: taskId ? this.progress(taskId) : undefined,
        });
        if (taskId) this.rememberActive(taskId, { tripId: action.tripId, actionId: action.id, interrupt: run.interrupt });
        output = await run.result;
      }
      if (output.baseGeneration !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
      if (this.options.store.requireTrip(action.tripId).contentGeneration !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
      validateMicroCandidateDiscovery(output, [targetId], [{ planningAreaCandidateId: targetId, targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT }]);
      if (!output.candidates.length) continue;
      const normalized = normalizeCandidateDiscoveryOutput(output, "micro");
      const applied = applyCandidateDiscovery(plan, normalized);
      plan = applied.plan;
      for (const id of applied.addedPlaceIds) addedPlaceIds.add(id);
      for (const candidate of normalized.candidates) {
        const placeId = applied.idMappings[candidate.placeTemporaryId];
        if (placeId) resolutionPlaceIds.add(placeId);
      }
    }
    if (same(plan, original.plan)) {
      this.options.store.completeAction(action.id, "no-new-candidates");
      return;
    }
    plan = markImpact(original.plan, plan);
    const written = this.options.store.writePlan(action.tripId, plan, action.baseGeneration, { source: `action:${action.actionType}`, summary: "AI 发现兴趣点" }, { keepActionId: action.id });
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: [] });
    await this.resolveChangedPlaces(action.tripId, [...resolutionPlaceIds], written.generation, taskId ?? undefined);
    const resolved = currentResolvedPlaces(this.options.store.requireTrip(action.tripId), this.options.store.listPlaceResolutions(action.tripId)).filter((item) => resolutionPlaceIds.has(item.placeId)).length;
    this.options.store.completeAction(action.id, `added:${addedPlaceIds.size};resolved:${resolved}/${resolutionPlaceIds.size}`);
  }

  private persistCandidateProposal(action: AiActionRecord, output: DestinationAddOutput | DestinationReplaceOutput | InterestAddOutput | InterestReplaceOutput) {
    const commands: PlanCommand[] = [];
    if (action.actionType === "destination.replace") commands.push({ type: "remove_candidate_tree", candidateId: String((output as DestinationReplaceOutput).replaceCandidateId || action.targetIds[0] || "") });
    if (action.actionType === "interest.replace") commands.push({ type: "remove_candidate", candidateId: String((output as InterestReplaceOutput).replaceCandidateId || action.targetIds[0] || "") });
    commands.push(candidateCommand(output));
    return this.createProposalForAction(action, output.title, output.explanation, commands, { type: "candidate_pool", id: null });
  }

  private persistItineraryGenerate(action: AiActionRecord, output: ItineraryGenerateOutput) {
    const result = output.result;
    if (result.type === "requires_stage") {
      this.options.store.completeAction(action.id, `requiresStage:${result.requiresStage}`);
      return;
    }
    const trip = this.options.store.requireTrip(action.tripId);
    if (trip.plan.days.length) throw new Error("首次生成行程骨架只能在尚未存在 Day 时执行；已有骨架请使用重新规划。");
    const days = buildMacroDaysV3(trip, result.destinations);
    const plan = TravelPlanDocumentSchema.parse({ ...trip.plan, stage: "itinerary_planning", days });
    const written = this.options.store.writePlan(action.tripId, plan, action.baseGeneration, { source: "action:itinerary.generate", summary: "AI 生成行程骨架" }, { keepActionId: action.id });
    this.options.store.completeAction(action.id, `generation:${written.generation}`);
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: days.map((day) => day.id) });
    void this.recalculateAllMacroRoutes(action.tripId, written.generation);
  }

  private persistItineraryReplacement(action: AiActionRecord, output: ItineraryReplanOutput) {
    const result = output.result;
    if (result.type === "requires_stage") { this.options.store.completeAction(action.id, `requiresStage:${result.requiresStage}`); return; }
    const trip = this.options.store.requireTrip(action.tripId);
    const replacement = macroReplacementCommandsV3(trip, result.destinations);
    if (!replacement.commands.length) { this.options.store.completeAction(action.id, "no-change"); return; }
    return this.createProposalForAction(action, result.title, result.explanation, replacement.commands, { type: "trip", id: null });
  }

  private persistItineraryDetailGenerate(action: AiActionRecord, output: ItineraryDetailGenerateOutput) {
    const result = output.result;
    if (result.type === "requires_stage") { this.options.store.completeAction(action.id, `requiresStage:${result.requiresStage}`); return; }
    const trip = this.options.store.requireTrip(action.tripId);
    if (!trip.plan.days.length) throw new Error("请先完成第四步行程骨架。");
    const plan = applyDetailedUpdatesV3(trip, result.dayUpdates, true);
    const written = this.options.store.writePlan(action.tripId, plan, action.baseGeneration, { source: "action:itinerary.detail.generate", summary: "AI 生成每日详细行程" }, { keepActionId: action.id });
    this.options.store.completeAction(action.id, `generation:${written.generation}`);
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: plan.days.map((day) => day.id) });
    void this.recalculateAllRoutes(action.tripId, written.generation);
  }

  private persistItineraryDetailUpdate(action: AiActionRecord, output: ItineraryDetailUpdateOutput) {
    const result = output.result;
    if (result.type === "requires_stage") { this.options.store.completeAction(action.id, `requiresStage:${result.requiresStage}`); return; }
    const trip = this.options.store.requireTrip(action.tripId);
    const requested = Array.isArray(action.parameters.dayIds) && action.parameters.dayIds.length ? new Set(action.parameters.dayIds.map(String)) : null;
    if (requested && (requested.size !== result.affectedDayIds.length || result.affectedDayIds.some((id) => !requested.has(id)))) throw new Error("AI 返回了 affected scope 外的 Day。");
    const replacement = detailedReplacementCommandsV3(trip, result.dayUpdates);
    if (!replacement.commands.length) { this.options.store.completeAction(action.id, "no-change"); return; }
    const scope = result.affectedDayIds.length === 1 ? { type: "day" as const, id: result.affectedDayIds[0] } : { type: "trip" as const, id: null };
    return this.createProposalForAction(action, result.title, result.explanation, replacement.commands, scope);
  }

  private persistItineraryRepair(action: AiActionRecord, output: ItineraryRepairOutput) {
    const result = output.result;
    if (result.type === "requires_stage") { this.options.store.completeAction(action.id, `requiresStage:${result.requiresStage}`); return; }
    const trip = this.options.store.requireTrip(action.tripId);
    validateItineraryReferences(trip, result.days, this.options.store.listPlaceResolutions(action.tripId));
    const commands = replacementCommands(trip.plan, result.days);
    if (!commands.length) { this.options.store.completeAction(action.id, "no-change"); return; }
    return this.createProposalForAction(action, result.title, result.explanation, commands, { type: "trip", id: null });
  }

  private persistDayOptimize(action: AiActionRecord, output: ItineraryDayOptimizeOutput) {
    const result = output.result;
    if (result.type === "requires_stage") { this.options.store.completeAction(action.id, `requiresStage:${result.requiresStage}`); return; }
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
    if (result.type === "requires_stage") { this.options.store.completeAction(action.id, `requiresStage:${result.requiresStage}`); return; }
    const trip = this.options.store.requireTrip(action.tripId);
    const commands = refinementCommands(trip.plan, output);
    if (!commands.length) { this.options.store.completeAction(action.id, "no-change"); return; }
    const dayId = result.dayIds.length === 1 ? result.dayIds[0] : null;
    return this.createProposalForAction(action, result.title, result.explanation, commands, dayId ? { type: "day", id: dayId } : { type: "trip", id: null });
  }

  private createProposalForAction(action: AiActionRecord, title: string, explanation: string, commandValues: PlanCommand[], scopeValue: ProposalScope) {
    const trip = this.options.store.requireTrip(action.tripId);
    if (trip.contentGeneration !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const { scope, commands } = assertProposalCommandsWithinScope(trip.plan, ProposalScopeSchema.parse(scopeValue), commandValues);
    const preview = applyPlanCommands(trip.plan, commands);
    const timestamp = now();
    const proposal = AiProposalSchema.parse({
      id: randomUUID(), tripId: action.tripId, baseGeneration: action.baseGeneration, scope, status: "pending", title, explanation,
      commands, diff: proposalDiff(commands, preview.effects), createdAt: timestamp, updatedAt: timestamp, appliedRevisionVersion: null,
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
    if (linkedAction?.actionType === "itinerary.detail.update") void this.recalculateRoutes(tripId, proposal.diff.affectedDayIds, result.generation);
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
    void this.resolveChangedPlaces(tripId, applied.effects.changedPlaceIds, written.generation);
    return { ...applied, plan, trip: written.trip, generation: written.generation, version: written.version };
  }

  async retryResolutions(tripId: string, placeIds: string[], expectedGeneration: number) {
    return this.options.resolver.resolveMany(tripId, placeIds, expectedGeneration, undefined, this.resolutionProgress(tripId));
  }
  searchResolutionCandidates(tripId: string, placeId: string, expectedGeneration: number) { return this.options.resolver.searchCandidates(tripId, placeId, expectedGeneration); }
  selectResolution(tripId: string, placeId: string, input: unknown) { return (this.options.resolver as any).selectCandidate(tripId, placeId, input); }
  setDirectResolution(tripId: string, placeId: string, input: unknown) { return (this.options.resolver as any).setDirect(tripId, placeId, input); }
  recalculateRoute(tripId: string, dayId: string, expectedGeneration: number) { return this.options.routes.recalculate(tripId, dayId, expectedGeneration); }
  recalculateMacroRoute(tripId: string, dayId: string, expectedGeneration: number) { return this.options.routes.recalculateMacro(tripId, dayId, expectedGeneration); }
  async recalculateDirtyRoutes(tripId: string, input: any) {
    const expectedGeneration = Number(input.expectedGeneration); const states = this.options.routes.workspaceRouteState(tripId); const routes = [];
    for (const state of states) if (state.dirty) { const route = await this.options.routes.recalculate(tripId, state.dayId, expectedGeneration); routes.push(route); this.emit("travel.route.changed", { tripId, dayId: state.dayId }); }
    return { routes };
  }
  async recalculateDirtyMacroRoutes(tripId: string, input: any) {
    const expectedGeneration = Number(input.expectedGeneration); const states = this.options.routes.workspaceMacroRouteState(tripId); const routes = [];
    for (const state of states) if (state.required && state.dirty) { const route = await this.options.routes.recalculateMacro(tripId, state.dayId, expectedGeneration); if (route) routes.push(route); this.emit("travel.route.changed", { tripId, dayId: `macro:${state.dayId}` }); }
    return { routes };
  }
  private async recalculateRoutes(tripId: string, dayIds: string[], expectedGeneration: number) {
    for (const dayId of [...new Set(dayIds)]) {
      try { await this.options.routes.recalculate(tripId, dayId, expectedGeneration); this.emit("travel.route.changed", { tripId, dayId }); }
      catch (error) { if (aiErrorMessageV3(error) === "CONTENT_GENERATION_SUPERSEDED") return; }
    }
  }
  private async recalculateAllRoutes(tripId: string, expectedGeneration: number) {
    const trip = this.options.store.requireTrip(tripId);
    await this.recalculateRoutes(tripId, trip.plan.days.map((day) => day.id), expectedGeneration);
  }
  private async recalculateAllMacroRoutes(tripId: string, expectedGeneration: number) {
    const trip = this.options.store.requireTrip(tripId);
    for (const day of trip.plan.days) {
      if (day.startAnchor.placeId === day.endAnchor.placeId) continue;
      try { const route = await this.options.routes.recalculateMacro(tripId, day.id, expectedGeneration); if (route) this.emit("travel.route.changed", { tripId, dayId: `macro:${day.id}` }); }
      catch (error) { if (aiErrorMessageV3(error) === "CONTENT_GENERATION_SUPERSEDED") return; }
    }
  }
}
