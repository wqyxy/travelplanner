import { randomUUID } from "node:crypto";
import {
  AdjustmentProposalOutputJsonSchema,
  AdjustmentProposalOutputSchema,
  MacroCandidateDiscoveryOutputJsonSchema,
  MacroCandidateDiscoveryOutputSchema,
  MicroCandidateDiscoveryOutputJsonSchema,
  MicroCandidateDiscoveryOutputSchema,
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
  type MacroCandidateDiscoveryOutput,
  type MapResolutionAssistOutput,
  type MicroCandidateDiscoveryOutput,
  type PlaceResolution,
  type PlanCommand,
  type PlanGenerationOutput,
  type ProposalDiff,
  type ProposalScope,
  type TravelPlanDocument,
  type TripFactCommand,
} from "./contracts-v2.js";
import { applyCandidateDiscoveryToStore, applyPlanGenerationToStore } from "./candidate-workflow-v2.js";
import {
  buildFixedMicroDiscoveryTargets,
  discoveryShortfalls,
  microTourismPlaceRejection,
  microTourismProviderRejection,
  validateMacroCandidateDiscovery,
  validateMicroCandidateDiscovery,
  type FixedAreaTargetV2,
  type RejectedDiscoveryCandidateV2,
} from "./candidate-discovery-policy-v2.js";
import { DayRouteServiceV2 } from "./day-route-v2.js";
import { AiTaskMonitor, aiErrorMessage, normalizePublicAiSummary } from "./ai-task-monitor.js";
import { applyPlanCommandBatchToStore, applyPlanCommands, semanticPlaceKey } from "./plan-commands-v2.js";
import { optimizeGeneratedSightseeingOrder } from "./plan-route-order-v2.js";
import { buildPlanningAreaContext, buildPlanningCoverage } from "./planning-areas-v2.js";
import type { AgentPromptsV2 } from "./prompt-contract-v2.js";
import { resolutionIsCurrent, type PlaceResolverV2 } from "./place-resolver-v2.js";
import { assertProposalCommandsWithinScope } from "./proposal-scope-policy-v2.js";
import { validateAdjustmentProposal } from "./proposal-validation-v2.js";
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
export type CandidateDiscoveryModeV2 = "macro" | "micro";
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
  discoverMacroCandidates(input: {
    trip: TripDetailV2;
    message: string | null;
  }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<MacroCandidateDiscoveryOutput>>;
  discoverMicroCandidates(input: {
    trip: TripDetailV2;
    message: string | null;
    areaTarget: FixedAreaTargetV2;
    rejectedCandidates?: RejectedDiscoveryCandidateV2[];
  }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<MicroCandidateDiscoveryOutput>>;
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

const interestDiscoveryInstructions = [
  "这是 AI Travel Planner 的独立兴趣点研究线程。",
  "只使用当前消息注入的旅行需求、目标目的地、已有地点、固定数量和拒绝原因；不得读取项目文件、环境变量、其他线程或账户数据。",
  "必须使用实时网页检索，并为每个目的地参考至少两份相互独立的旅游攻略或目的地榜单；官方网站只核验实体和当前状态。",
  "不得写文件、执行 Shell、调用 MCP、创建子 Agent、付款、预订或声称完成线下操作。",
  "不得输出坐标、来源链接、内部推理、路线 geometry、距离或地图 Provider 交通时长。",
  "必须逐项原样返回服务端固定目标，只输出本轮指定 JSON Schema。",
].join("\n");

function withoutResearchLinks(progress?: (value: StructuredAiProgress) => void) {
  if (!progress) return undefined;
  return (value: StructuredAiProgress) => progress({
    ...value,
    text: value.text.replace(/https?:\/\/\S+/giu, "[攻略来源已隐藏]"),
  });
}

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
    validateResult?: (value: T) => T;
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
      validateResult: input.validateResult,
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

  discoverMacroCandidates(input: {
    trip: TripDetailV2;
    message: string | null;
  }, progress?: (value: StructuredAiProgress) => void) {
    return this.plannerRun<MacroCandidateDiscoveryOutput>({
      trip: input.trip,
      taskMode: "discover_candidates",
      task: {
        userRequest: input.message,
        initialDiscovery: !input.trip.plan.candidates.some((candidate) => input.trip.plan.places.find((place) => place.id === candidate.placeId)?.kind === "city"),
        existingCandidatePlaceIds: input.trip.plan.candidates.map((item) => item.placeId),
      },
      schema: MacroCandidateDiscoveryOutputSchema,
      outputSchema: MacroCandidateDiscoveryOutputJsonSchema,
      validateResult: validateMacroCandidateDiscovery,
      progress,
    });
  }

  async discoverMicroCandidates(input: {
    trip: TripDetailV2;
    message: string | null;
    areaTarget: FixedAreaTargetV2;
    rejectedCandidates?: RejectedDiscoveryCandidateV2[];
  }, progress?: (value: StructuredAiProgress) => void) {
    const places = new Map(input.trip.plan.places.map((place) => [place.id, place]));
    const targetId = input.areaTarget.planningAreaCandidateId;
    return this.options.runner.start<MicroCandidateDiscoveryOutput>({
      cwd: this.options.root,
      prompt: this.options.prompts.interestDiscovery.content,
      state: {
        baseGeneration: input.trip.contentGeneration,
        planLanguage: input.trip.planLanguage,
        tripFacts: input.trip.plan.trip,
        task: {
          userRequest: input.message,
          areaTarget: input.areaTarget,
          planningAreaCandidates: input.trip.plan.candidates
            .filter((candidate) => candidate.id === targetId)
            .map((candidate) => ({ ...candidate, place: places.get(candidate.placeId) ?? null })),
          existingPlaces: input.trip.plan.candidates
            .filter((candidate) => candidate.planningAreaCandidateId === targetId)
            .map((candidate) => ({ candidateId: candidate.id, planningAreaCandidateId: candidate.planningAreaCandidateId, place: places.get(candidate.placeId) ?? null })),
          coveragePolicy: {
            targetCountMeaning: "服务端确定的本轮固定新增可靠兴趣点数量",
            batchAreaLimit: 1,
            batchCandidateLimit: 9,
            microPlaceKind: "attraction",
            requiredResearchBasis: "multi_guide_consensus",
            excludedFromInterestPool: ["机场", "车站", "港口", "住宿", "餐饮", "停车场", "行政机构", "普通游客中心", "信息中心", "整片湖泊", "海湾", "公园", "泛称区域"],
          },
          rejectedCandidates: input.rejectedCandidates ?? [],
        },
      },
      schema: MicroCandidateDiscoveryOutputSchema,
      outputSchema: MicroCandidateDiscoveryOutputJsonSchema,
      validateResult: (output) => validateMicroCandidateDiscovery(output, [targetId], [input.areaTarget]),
      developerInstructions: interestDiscoveryInstructions,
      threadSource: "ai-travel-interest-discovery-v3",
      ephemeral: true,
      webSearch: "live",
      timeoutMs: 300_000,
      ...this.options.modelOptions(),
      onProgress: withoutResearchLinks(progress),
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
      validateResult: (output) => {
        if (output.baseGeneration !== input.trip.contentGeneration) {
          throw new Error(`AI 返回的 baseGeneration 与请求不一致：期望 ${input.trip.contentGeneration}，收到 ${output.baseGeneration}。`);
        }
        return validateAdjustmentProposal(input.trip.plan, input.scope, output).output;
      },
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
    case "remove_candidate_tree": return `级联移除 Candidate ${command.candidateId} 及其子地点`;
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

function validatePlanGenerationOutput(trip: TripDetailV2, output: PlanGenerationOutput, resolutions: PlaceResolution[]) {
  const count = expectedDayCount(trip.plan);
  if (count !== null && output.days.length !== count) throw new Error(`AI 返回 ${output.days.length} 天，但旅行要求为 ${count} 天。`);
  const currentResolvedPlaceIds = new Set(currentResolutions(trip, resolutions).map((resolution) => resolution.placeId));
  const candidates = new Map(trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  for (const day of output.days) {
    for (const stop of day.stops) {
      const candidate = stop.candidateId ? candidates.get(stop.candidateId) : null;
      const place = candidate ? places.get(candidate.placeId) : null;
      if (candidate && place?.kind !== "city" && !currentResolvedPlaceIds.has(candidate.placeId)) {
        throw new Error(`未定位地点不得进入按天行程：${place?.nameZh ?? candidate.id}`);
      }
    }
  }
}

type ActiveTask = { tripId: string; interrupt: () => Promise<void>; messageId?: string };
type MicroDiscoveryBatchResult = {
  areaLabel: string;
  messages: string[];
  areaTargets: MicroCandidateDiscoveryOutput["areaTargets"];
  addedCandidateIds: string[];
  rejected: RejectedDiscoveryCandidateV2[];
  initialTargetCount: number;
  initialAcceptedCount: number;
  supplementTargetCount: number;
  supplementAcceptedCount: number;
  remainingShortfalls: FixedAreaTargetV2[];
  supplementError: string | null;
};

export class TravelPlannerRuntimeV2 {
  private readonly active = new Map<string, ActiveTask>();
  private readonly stopRequested = new Set<string>();

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
    const resolutions = currentResolutions(workspace.trip, workspace.resolutions);
    return {
      ...workspace,
      resolutions,
      coverage: buildPlanningCoverage(workspace.trip.plan, new Set(resolutions.map((resolution) => resolution.placeId))),
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
        this.stopRequested.delete(taskId);
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
    this.stopRequested.add(taskId);
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

  private candidateDiscoveryTargets(trip: TripDetailV2, mode: CandidateDiscoveryModeV2, requestedIds: string[]) {
    if (mode === "macro") return [];
    const places = new Map(trip.plan.places.map((place) => [place.id, place]));
    const activeMacroIds = trip.plan.candidates
      .filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city")
      .map((candidate) => candidate.id);
    const targetIds = [...new Set(requestedIds.length ? requestedIds : activeMacroIds)];
    if (!targetIds.length) throw new Error("请先在“目的地”步骤生成并保留至少一个目的地。");
    for (const candidateId of targetIds) {
      const candidate = trip.plan.candidates.find((item) => item.id === candidateId);
      const place = candidate ? places.get(candidate.placeId) : null;
      if (!candidate || candidate.preference === "excluded" || place?.kind !== "city") {
        throw new Error(`详细兴趣点只能围绕有效 Macro 目的地生成：${candidateId}`);
      }
    }
    return targetIds;
  }

  private validateCandidateDiscoveryScope(
    trip: TripDetailV2,
    output: CandidateDiscoveryOutput,
    mode: CandidateDiscoveryModeV2,
    targetIds: string[],
    fixedTargets: FixedAreaTargetV2[] = [],
  ) {
    const outputPlaces = new Map(output.places.map((place) => [place.id, place]));
    const allowedParents = new Set(targetIds);
    for (const candidate of output.candidates) {
      const place = outputPlaces.get(candidate.placeTemporaryId);
      if (!place) continue;
      if (mode === "macro") {
        if (place.kind !== "city") throw new Error(`目的地发现只能生成 Macro 节点，不能直接生成具体地点：${place.nameZh}`);
        if (candidate.planningAreaCandidateId !== null) throw new Error("Macro Candidate 的 planningAreaCandidateId 必须为 null。");
        continue;
      }
      if (place.kind === "city") throw new Error(`详细兴趣点阶段不得再次生成 Macro 城市：${place.nameZh}`);
      if (!candidate.planningAreaCandidateId || !allowedParents.has(candidate.planningAreaCandidateId)) {
        throw new Error(`详细兴趣点必须显式归属于本次指定的 Macro Candidate：${place.nameZh}`);
      }
    }
    if (mode === "macro") validateMacroCandidateDiscovery(output as MacroCandidateDiscoveryOutput);
    else validateMicroCandidateDiscovery(output as MicroCandidateDiscoveryOutput, targetIds, fixedTargets);
    if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
  }

  private async preflightCandidateDiscovery<T extends CandidateDiscoveryOutput>(trip: TripDetailV2, output: T, mode: CandidateDiscoveryModeV2) {
    const places = new Map(output.places.map((place) => [place.id, place]));
    const existingByKey = new Map(trip.plan.places.map((place) => [semanticPlaceKey(place), place]));
    const resolutions = new Map(currentResolutions(trip, this.options.store.listPlaceResolutions(trip.id)).map((resolution) => [resolution.placeId, resolution]));
    const acceptedPlaceIds = new Set<string>();
    const rejected: RejectedDiscoveryCandidateV2[] = [];
    const previews = new Map<string, Awaited<ReturnType<PlaceResolverV2["preview"]>>>();

    for (const candidate of output.candidates) {
      const place = places.get(candidate.placeTemporaryId);
      if (!place) continue;
      if (mode === "micro") {
        const reason = microTourismPlaceRejection(place);
        if (reason) {
          rejected.push({ planningAreaCandidateId: candidate.planningAreaCandidateId, name: place.nameZh, reason });
          continue;
        }
      }
      const existing = existingByKey.get(semanticPlaceKey(place));
      if (mode === "micro" && existing) {
        rejected.push({
          planningAreaCandidateId: candidate.planningAreaCandidateId,
          name: place.nameZh,
          reason: "候选地点已存在于当前兴趣点池",
        });
        continue;
      }
      if (existing && resolutions.has(existing.id)) {
        acceptedPlaceIds.add(place.id);
        continue;
      }
      const preview = await this.options.resolver.preview(place);
      const providerRejection = mode === "micro" && preview.selected
        ? microTourismProviderRejection(preview.selected.candidate, place)
        : null;
      if (preview.selected && !providerRejection) {
        acceptedPlaceIds.add(place.id);
        previews.set(place.id, preview);
      }
      else rejected.push({
        planningAreaCandidateId: candidate.planningAreaCandidateId,
        name: place.nameZh,
        reason: providerRejection ?? (preview.candidates.length ? "名称存在歧义或不是唯一可导航地点" : "公开地图服务未找到该正式地点"),
      });
    }

    let candidates = output.candidates.filter((candidate) => acceptedPlaceIds.has(candidate.placeTemporaryId)) as T["candidates"];
    if (mode === "micro") {
      const microOutput = output as MicroCandidateDiscoveryOutput;
      const targets = new Map(microOutput.areaTargets.map((target) => [target.planningAreaCandidateId, target.targetCount]));
      const retained = new Set<string>();
      for (const [parentId, targetCount] of targets) {
        const ranked = candidates
          .filter((candidate) => candidate.planningAreaCandidateId === parentId)
          .sort((left, right) => (right.aiScore ?? -1) - (left.aiScore ?? -1));
        ranked.slice(0, targetCount).forEach((candidate) => retained.add(candidate.placeTemporaryId));
        ranked.slice(targetCount).forEach((candidate) => rejected.push({
          planningAreaCandidateId: parentId,
          name: places.get(candidate.placeTemporaryId)?.nameZh ?? candidate.placeTemporaryId,
          reason: `超过服务端为该目的地设定的本轮 ${targetCount} 个固定目标`,
        }));
      }
      candidates = candidates.filter((candidate) => retained.has(candidate.placeTemporaryId)) as T["candidates"];
    }
    const referencedPlaceIds = new Set(candidates.map((candidate) => candidate.placeTemporaryId));
    const placesAfterPreflight = output.places.filter((place) => referencedPlaceIds.has(place.id));
    return {
      output: { ...output, places: placesAfterPreflight, candidates } as T,
      rejected,
      previews,
    };
  }

  private async applyScopedCandidateDiscovery<T extends CandidateDiscoveryOutput>(
    tripId: string,
    output: T,
    mode: CandidateDiscoveryModeV2,
    requestedIds: string[],
    fixedTargets: FixedAreaTargetV2[] = [],
  ) {
    const before = this.options.store.requireTrip(tripId);
    const targetIds = this.candidateDiscoveryTargets(before, mode, requestedIds);
    this.validateCandidateDiscoveryScope(before, output, mode, targetIds, fixedTargets);
    const preflight = await this.preflightCandidateDiscovery(before, output, mode);
    if (!preflight.output.candidates.length) {
      return {
        trip: before,
        generation: before.contentGeneration,
        output: preflight.output,
        addedCandidateIds: [] as string[],
        updatedCandidateIds: [] as string[],
        addedPlaceIds: [] as string[],
        rejected: preflight.rejected,
        acceptedCandidates: preflight.output.candidates,
        changed: false,
      };
    }
    const applied = applyCandidateDiscoveryToStore(this.options.store, tripId, preflight.output);
    this.emit("travel.document.changed", { tripId, generation: applied.generation, changedDayIds: [] });
    for (const [temporaryPlaceId, preview] of preflight.previews) {
      const placeId = applied.idMappings[temporaryPlaceId];
      if (!placeId) continue;
      this.options.resolver.commitPreview(tripId, placeId, preview, applied.generation);
      this.emit("travel.resolution.changed", { tripId, placeId });
    }
    const placeIds = [...new Set([
      ...applied.addedPlaceIds,
      ...applied.updatedCandidateIds.map((candidateId) => applied.trip.plan.candidates.find((candidate) => candidate.id === candidateId)?.placeId).filter((id): id is string => Boolean(id)),
    ])];
    await this.resolveChangedPlaces(tripId, placeIds, applied.generation);
    return { ...applied, rejected: preflight.rejected, acceptedCandidates: preflight.output.candidates, changed: true };
  }

  private assertMicroTaskRunning(taskId: string) {
    if (this.stopRequested.has(taskId)) throw new Error("AI 任务已停止。");
  }

  private microAreaLabel(trip: TripDetailV2, planningAreaCandidateId: string) {
    const candidate = trip.plan.candidates.find((item) => item.id === planningAreaCandidateId);
    const place = candidate ? trip.plan.places.find((item) => item.id === candidate.placeId) : null;
    return place?.nameZh ?? place?.nameLocal ?? place?.nameEn ?? planningAreaCandidateId;
  }

  private async awaitMicroResearch(
    tripId: string,
    taskId: string,
    handle: RuntimeAiHandle<MicroCandidateDiscoveryOutput>,
    areaLabel: string,
    phase: "研究" | "补位研究",
  ) {
    const startedAt = Date.now();
    this.active.set(taskId, { tripId, interrupt: handle.interrupt });
    if (this.stopRequested.has(taskId)) {
      await handle.interrupt().catch(() => undefined);
      throw new Error("AI 任务已停止。");
    }
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.max(30, Math.floor((Date.now() - startedAt) / 30_000) * 30);
      this.options.tasks.update(taskId, "running", `${areaLabel}仍在${phase}，已用时 ${elapsedSeconds} 秒`, "interest:heartbeat");
    }, 30_000);
    heartbeat.unref();
    try {
      const output = await handle.result;
      this.assertMicroTaskRunning(taskId);
      return output;
    } finally {
      clearInterval(heartbeat);
      const current = this.active.get(taskId);
      if (current?.interrupt === handle.interrupt) this.active.set(taskId, { tripId, interrupt: async () => undefined });
    }
  }

  private microFailureMessage(areaLabel: string, targetCount: number, error: unknown, phase = "研究") {
    const raw = normalizePublicAiSummary(aiErrorMessage(error)) || `${phase}失败`;
    if (/超时/u.test(raw)) return `${areaLabel}（目标 ${targetCount} 个）${phase}超过 5 分钟，已跳过并继续下一个目的地`;
    return `${areaLabel}（目标 ${targetCount} 个）${phase}失败：${raw}`;
  }

  private async completeMicroDiscoveryArea(
    tripId: string,
    areaTarget: FixedAreaTargetV2,
    areaLabel: string,
    taskId: string,
    message: string | null,
  ): Promise<MicroDiscoveryBatchResult> {
    this.assertMicroTaskRunning(taskId);
    const initialTrip = this.options.store.requireTrip(tripId);
    const initialHandle = await this.options.ai.discoverMicroCandidates({
      trip: initialTrip,
      message,
      areaTarget,
    }, this.progress(taskId));
    const initialOutput = await this.awaitMicroResearch(tripId, taskId, initialHandle, areaLabel, "研究");
    this.options.tasks.update(taskId, "running", `${areaLabel}正在地图预检`, "interest:map-preflight");
    const initial = await this.applyScopedCandidateDiscovery(
      tripId,
      initialOutput,
      "micro",
      [areaTarget.planningAreaCandidateId],
      [areaTarget],
    );
    this.assertMicroTaskRunning(taskId);
    const initialAccepted = initial.acceptedCandidates as MicroCandidateDiscoveryOutput["candidates"];
    const shortfalls = discoveryShortfalls(initialOutput, initialAccepted);
    const result: MicroDiscoveryBatchResult = {
      areaLabel,
      messages: [initialOutput.assistantMessage],
      areaTargets: initialOutput.areaTargets,
      addedCandidateIds: [...initial.addedCandidateIds],
      rejected: [...initial.rejected],
      initialTargetCount: areaTarget.targetCount,
      initialAcceptedCount: initialAccepted.length,
      supplementTargetCount: shortfalls[0]?.targetCount ?? 0,
      supplementAcceptedCount: 0,
      remainingShortfalls: shortfalls,
      supplementError: null,
    };
    if (!shortfalls.length) {
      this.options.tasks.update(taskId, "running", `${areaLabel}已保存 ${initialAccepted.length} 个可靠兴趣点`, "interest:saved");
      return result;
    }

    this.options.tasks.update(
      taskId,
      "running",
      `${areaLabel}地图预检接受 ${initialAccepted.length}/${areaTarget.targetCount}，正在补位`,
      "coverage:supplementing",
    );
    try {
      const trip = this.options.store.requireTrip(tripId);
      const resolvedIds = new Set(currentResolutions(trip, this.options.store.listPlaceResolutions(tripId)).map((resolution) => resolution.placeId));
      const refreshedTarget = buildFixedMicroDiscoveryTargets(trip.plan, [areaTarget.planningAreaCandidateId], resolvedIds)[0];
      if (!refreshedTarget) {
        result.remainingShortfalls = [];
        this.options.tasks.update(taskId, "running", `${areaLabel}已保存 ${initialAccepted.length} 个可靠兴趣点`, "interest:saved");
        return result;
      }
      result.supplementTargetCount = refreshedTarget.targetCount;
      const supplementHandle = await this.options.ai.discoverMicroCandidates({
        trip,
        message: "根据服务端给出的缺口自动补位。重新检索多份旅游攻略，不得重复已有地点或被拒地点；只能改用当前正式、可导航且被攻略推荐的地标、经典拍照点、主要景点、观景台、博物馆、文化场馆、自然景观或正式体验入口，不得使用交通、住宿、餐饮或游客服务设施。",
        areaTarget: refreshedTarget,
        rejectedCandidates: initial.rejected,
      }, this.progress(taskId));
      const supplementOutput = await this.awaitMicroResearch(tripId, taskId, supplementHandle, areaLabel, "补位研究");
      this.options.tasks.update(taskId, "running", `${areaLabel}正在地图预检补位结果`, "interest:map-preflight");
      const supplement = await this.applyScopedCandidateDiscovery(
        tripId,
        supplementOutput,
        "micro",
        [refreshedTarget.planningAreaCandidateId],
        [refreshedTarget],
      );
      this.assertMicroTaskRunning(taskId);
      result.messages.push(supplementOutput.assistantMessage);
      result.addedCandidateIds.push(...supplement.addedCandidateIds);
      result.rejected.push(...supplement.rejected);
      const supplementAccepted = supplement.acceptedCandidates as MicroCandidateDiscoveryOutput["candidates"];
      result.supplementAcceptedCount = supplementAccepted.length;
      result.remainingShortfalls = discoveryShortfalls(supplementOutput, supplementAccepted);
      const acceptedTotal = initialAccepted.length + supplementAccepted.length;
      this.options.tasks.update(taskId, "running", `${areaLabel}已保存 ${acceptedTotal} 个可靠兴趣点`, "interest:saved");
    } catch (error) {
      const errorMessage = aiErrorMessage(error);
      if (errorMessage === "CONTENT_GENERATION_SUPERSEDED" || errorMessage === "AI 任务已停止。") throw error;
      result.supplementError = this.microFailureMessage(areaLabel, result.supplementTargetCount, error, "补位研究");
      this.options.tasks.update(taskId, "running", result.supplementError, "coverage:attention");
    }
    return result;
  }

  private async runMicroDiscoveryQueue(
    tripId: string,
    taskId: string,
    fixedTargets: FixedAreaTargetV2[],
    message: string | null,
  ) {
    const results: MicroDiscoveryBatchResult[] = [];
    for (let index = 0; index < fixedTargets.length; index += 1) {
      this.assertMicroTaskRunning(taskId);
      const requestedTarget = fixedTargets[index];
      const trip = this.options.store.requireTrip(tripId);
      const resolvedIds = new Set(currentResolutions(trip, this.options.store.listPlaceResolutions(tripId)).map((resolution) => resolution.placeId));
      const currentTarget = buildFixedMicroDiscoveryTargets(trip.plan, [requestedTarget.planningAreaCandidateId], resolvedIds)[0];
      if (!currentTarget) continue;
      const areaLabel = this.microAreaLabel(trip, currentTarget.planningAreaCandidateId);
      this.options.tasks.update(
        taskId,
        "running",
        `正在研究 ${index + 1}/${fixedTargets.length}：${areaLabel}（目标 ${currentTarget.targetCount} 个）`,
        "interest:researching",
      );
      try {
        results.push(await this.completeMicroDiscoveryArea(tripId, currentTarget, areaLabel, taskId, message));
      } catch (error) {
        const errorMessage = aiErrorMessage(error);
        if (errorMessage === "CONTENT_GENERATION_SUPERSEDED" || errorMessage === "AI 任务已停止。") throw error;
        const failure = this.microFailureMessage(areaLabel, currentTarget.targetCount, error);
        this.options.tasks.update(taskId, "running", failure, "interest:failed-area");
        results.push({
          areaLabel,
          messages: [],
          areaTargets: [{ ...currentTarget, reason: "服务端固定目标" }],
          addedCandidateIds: [],
          rejected: [],
          initialTargetCount: currentTarget.targetCount,
          initialAcceptedCount: 0,
          supplementTargetCount: 0,
          supplementAcceptedCount: 0,
          remainingShortfalls: [currentTarget],
          supplementError: failure,
        });
      }
    }

    this.assertMicroTaskRunning(taskId);
    const initialTargetCount = results.reduce((sum, item) => sum + item.initialTargetCount, 0);
    const initialAcceptedCount = results.reduce((sum, item) => sum + item.initialAcceptedCount, 0);
    const supplementTargetCount = results.reduce((sum, item) => sum + item.supplementTargetCount, 0);
    const supplementAcceptedCount = results.reduce((sum, item) => sum + item.supplementAcceptedCount, 0);
    const remainingShortfalls = results.flatMap((item) => item.remainingShortfalls);
    const rejected = results.flatMap((item) => item.rejected);
    const latestTrip = this.options.store.requireTrip(tripId);
    const latestResolvedIds = new Set(currentResolutions(latestTrip, this.options.store.listPlaceResolutions(tripId)).map((resolution) => resolution.placeId));
    const targetedIds = new Set(fixedTargets.map((target) => target.planningAreaCandidateId));
    const uncoveredAreaCount = buildPlanningCoverage(latestTrip.plan, latestResolvedIds)
      .filter((item) => targetedIds.has(item.macroCandidateId) && item.status !== "ready").length;
    const reasonCounts = new Map<string, number>();
    for (const item of rejected) reasonCounts.set(item.reason, (reasonCounts.get(item.reason) ?? 0) + 1);
    const failureMessages = results.map((item) => item.supplementError).filter((item): item is string => Boolean(item));
    const modelMessages = [...new Set(results.flatMap((item) => item.messages).filter(Boolean))];
    const summary = [
      `AI 本轮目标 ${initialTargetCount} 个兴趣点，首次地图预检接受 ${initialAcceptedCount} 个。`,
      supplementTargetCount ? `系统自动补位目标 ${supplementTargetCount} 个，接受 ${supplementAcceptedCount} 个。` : "无需自动补位。",
      remainingShortfalls.length ? `仍有 ${remainingShortfalls.length} 个目的地未达到可靠兴趣点下限。` : "所有目的地均已达到可靠兴趣点下限。",
      uncoveredAreaCount ? `其中 ${uncoveredAreaCount} 个目的地仍没有可靠兴趣点，页面保持需要关注或阻塞状态。` : "所有目标目的地都至少有 1 个可靠兴趣点。",
      reasonCounts.size ? `候选拒绝原因：${[...reasonCounts].map(([reason, count]) => `${reason} ${count} 个`).join("；")}。` : "",
      failureMessages.length ? `未完成项：${failureMessages.join("；")}。` : "",
    ].filter(Boolean).join("\n");
    this.options.store.createAssistantMessage(tripId, `${modelMessages.join("\n\n")}\n\n${summary}`.trim().slice(0, 12000), {
      mode: "discover_candidates",
      discoveryMode: "micro",
      areaTargets: results.flatMap((item) => item.areaTargets),
      addedCandidateIds: results.flatMap((item) => item.addedCandidateIds),
      initialTargetCount,
      initialAcceptedCount,
      supplementTargetCount,
      supplementAcceptedCount,
      uncoveredAreaCount,
      remainingAreaIds: remainingShortfalls.map((item) => item.planningAreaCandidateId),
      rejectedReasonCounts: Object.fromEntries(reasonCounts),
    });
    if (remainingShortfalls.length || failureMessages.length) {
      throw new Error(`兴趣点生成未达到质量与数量门槛：${remainingShortfalls.length} 个目的地仍有缺口${failureMessages.length ? `；${failureMessages.join("；")}` : ""}`);
    }
  }

  private startMicroCandidateDiscovery(tripId: string, fixedTargets: FixedAreaTargetV2[], message: string | null) {
    const taskId = `planner:${randomUUID()}`;
    const label = "生成详细兴趣点";
    this.options.tasks.start({ id: taskId, tripId, agent: "planner", label, summary: `准备${label}` });
    this.active.set(taskId, { tripId, interrupt: async () => undefined });
    void (async () => {
      try {
        await this.runMicroDiscoveryQueue(tripId, taskId, fixedTargets, message);
        this.options.tasks.update(taskId, "completed", `${label}已完成`, "task:completed");
      } catch (error) {
        const failure = normalizePublicAiSummary(aiErrorMessage(error)) || `${label}失败`;
        const status = failure === "CONTENT_GENERATION_SUPERSEDED" ? "cancelled_by_generation" : failure === "AI 任务已停止。" ? "stopped" : "failed";
        this.options.tasks.update(taskId, status, failure, `task:${status}`);
      } finally {
        this.active.delete(taskId);
        this.stopRequested.delete(taskId);
      }
    })();
    return { taskId, messageId: null };
  }

  startCandidateDiscovery(tripId: string, mode: CandidateDiscoveryModeV2 = "macro", planningAreaCandidateIds: string[] = [], message: string | null = null) {
    const trip = this.options.store.requireTrip(tripId);
    if (mode === "micro") {
      const targetIds = this.candidateDiscoveryTargets(trip, mode, planningAreaCandidateIds);
      const resolvedIds = new Set(currentResolutions(trip, this.options.store.listPlaceResolutions(tripId)).map((resolution) => resolution.placeId));
      const fixedTargets = buildFixedMicroDiscoveryTargets(trip.plan, targetIds, resolvedIds);
      if (!fixedTargets.length) {
        const taskId = `planner:${randomUUID()}`;
        this.options.tasks.start({ id: taskId, tripId, agent: "planner", label: "生成详细兴趣点", summary: "准备生成详细兴趣点" });
        const summary = "所选目的地均已达到建议的可靠兴趣点数量，无需再次生成。";
        this.options.store.createAssistantMessage(tripId, summary, {
          mode: "discover_candidates",
          discoveryMode: mode,
          areaTargets: [],
          addedCandidateIds: [],
          initialTargetCount: 0,
          initialAcceptedCount: 0,
          supplementTargetCount: 0,
          supplementAcceptedCount: 0,
          uncoveredAreaCount: 0,
          remainingAreaIds: [],
          rejectedReasonCounts: {},
        });
        this.options.tasks.update(taskId, "completed", "已达到建议数量", "task:completed");
        return { taskId, messageId: null };
      }
      return this.startMicroCandidateDiscovery(tripId, fixedTargets, message?.trim() || null);
    }

    const taskHolder = { id: "" };
    const result = this.begin({
      tripId,
      label: "生成目的地建议",
      run: async () => this.options.ai.discoverMacroCandidates({ trip: this.options.store.requireTrip(tripId), message: message?.trim() || null }, this.progress(taskHolder.id)),
      complete: async (output: MacroCandidateDiscoveryOutput) => {
        const applied = await this.applyScopedCandidateDiscovery(tripId, output, "macro", []);
        this.options.store.createAssistantMessage(tripId, applied.output.assistantMessage, {
          mode: "discover_candidates",
          discoveryMode: "macro",
          areaTargets: [],
          addedCandidateIds: applied.addedCandidateIds,
        });
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

        let latestTrip = this.options.store.requireTrip(tripId);
        if (latestTrip.contentGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        let resolutions = currentResolutions(latestTrip, this.options.store.listPlaceResolutions(tripId));
        let coverage = buildPlanningCoverage(latestTrip.plan, new Set(resolutions.map((resolution) => resolution.placeId)));
        const supplementMacroIds = coverage
          .filter((item) => item.status === "blocked" || (item.status === "attention" && item.preference === "want_to_go"))
          .map((item) => item.macroCandidateId);

        if (supplementMacroIds.length) {
          this.options.tasks.update(taskHolder.id, "running", `正在为 ${supplementMacroIds.length} 个目的地自动补充具体兴趣点`, "coverage:supplementing");
          try {
            const supplementTrip = this.options.store.requireTrip(tripId);
            const currentResolvedIds = new Set(currentResolutions(supplementTrip, this.options.store.listPlaceResolutions(tripId)).map((resolution) => resolution.placeId));
            const targets = buildFixedMicroDiscoveryTargets(supplementTrip.plan, supplementMacroIds, currentResolvedIds);
            const failures: string[] = [];
            this.active.set(taskHolder.id, { tripId, interrupt: async () => undefined });
            for (let index = 0; index < targets.length; index += 1) {
              this.assertMicroTaskRunning(taskHolder.id);
              const target = targets[index];
              const currentTrip = this.options.store.requireTrip(tripId);
              const currentResolvedIdsForArea = new Set(currentResolutions(currentTrip, this.options.store.listPlaceResolutions(tripId)).map((resolution) => resolution.placeId));
              const currentTarget = buildFixedMicroDiscoveryTargets(currentTrip.plan, [target.planningAreaCandidateId], currentResolvedIdsForArea)[0];
              if (!currentTarget) continue;
              const areaLabel = this.microAreaLabel(currentTrip, currentTarget.planningAreaCandidateId);
              this.options.tasks.update(taskHolder.id, "running", `正在研究 ${index + 1}/${targets.length}：${areaLabel}（目标 ${currentTarget.targetCount} 个）`, "interest:researching");
              try {
                const areaResult = await this.completeMicroDiscoveryArea(
                  tripId,
                  currentTarget,
                  areaLabel,
                  taskHolder.id,
                  "自动补全缺少可用于真实路线的具体兴趣点；只补充本次指定的目的地，不修改其他目的地。",
                );
                if (areaResult.remainingShortfalls.length || areaResult.supplementError) {
                  failures.push(areaResult.supplementError ?? `${areaLabel}自动补充后仍未达到可靠兴趣点下限`);
                }
              } catch (error) {
                const errorMessage = aiErrorMessage(error);
                if (errorMessage === "CONTENT_GENERATION_SUPERSEDED" || errorMessage === "AI 任务已停止。") throw error;
                const failure = this.microFailureMessage(areaLabel, currentTarget.targetCount, error);
                failures.push(failure);
                this.options.tasks.update(taskHolder.id, "running", failure, "interest:failed-area");
              }
            }
            if (failures.length) throw new Error(failures.join("；"));
          } catch (error) {
            const summary = normalizePublicAiSummary(aiErrorMessage(error)) || "自动补充兴趣点失败";
            if (summary === "CONTENT_GENERATION_SUPERSEDED" || summary === "AI 任务已停止。") throw error;
            this.options.tasks.update(taskHolder.id, "running", `自动补充未完成：${summary}；继续检查可生成性`, "coverage:attention");
          }
          latestTrip = this.options.store.requireTrip(tripId);
          resolutions = currentResolutions(latestTrip, this.options.store.listPlaceResolutions(tripId));
          coverage = buildPlanningCoverage(latestTrip.plan, new Set(resolutions.map((resolution) => resolution.placeId)));
        }

        const latestAreas = buildPlanningAreaContext(latestTrip.plan);
        if (latestAreas.conflicts.length) throw new Error(`目的地与具体兴趣点偏好冲突：${latestAreas.conflicts.join("；")}`);
        const latestResolvedIds = new Set(resolutions.map((resolution) => resolution.placeId));
        const places = new Map(latestTrip.plan.places.map((place) => [place.id, place]));

        const unresolvedConcreteMustGo = latestTrip.plan.candidates.filter((candidate) => {
          if (!latestAreas.participatingCandidateIds.has(candidate.id) || candidate.preference !== "must_go") return false;
          const place = places.get(candidate.placeId);
          return place?.kind !== "city" && !latestResolvedIds.has(candidate.placeId);
        });
        if (unresolvedConcreteMustGo.length) {
          const names = unresolvedConcreteMustGo.map((candidate) => places.get(candidate.placeId)?.nameZh ?? candidate.id).join("、");
          throw new Error(`以下“必去”具体地点自动定位失败，请先在右侧兴趣点步骤修复定位：${names}`);
        }

        const unavailableMustGoAreas = coverage.filter((item) => item.status === "blocked");
        if (unavailableMustGoAreas.length) {
          throw new Error(`自动补充后，以下“必去”目的地仍缺少可用于真实线路的已定位具体地点：${unavailableMustGoAreas.map((item) => item.label).join("、")}。请在右侧“兴趣点”步骤补充推荐、手动添加或修复定位。`);
        }

        this.options.tasks.update(taskHolder.id, "running", "正在规划目的地顺序、停留天数和区域内兴趣点", "plan:generating");
        return this.options.ai.generatePlan({ trip: latestTrip, resolutions, geoClusters: buildGeoClusters(latestTrip, resolutions) }, this.progress(taskHolder.id));
      },
      complete: async (output: PlanGenerationOutput) => {
        const trip = this.options.store.requireTrip(tripId);
        const resolutions = currentResolutions(trip, this.options.store.listPlaceResolutions(tripId));
        const optimized = optimizeGeneratedSightseeingOrder(trip.plan, output, resolutions);
        validatePlanGenerationOutput(trip, optimized, resolutions);
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
        const validated = validateAdjustmentProposal(trip.plan, scope, output);
        const timestamp = new Date().toISOString();
        const proposal = this.options.store.createProposal({
          id: randomUUID(),
          tripId,
          baseGeneration: trip.contentGeneration,
          scope: validated.scope,
          status: "pending",
          title: output.title,
          explanation: output.explanation,
          commands: validated.commands,
          diff: proposalDiff(validated.commands, validated.preview.effects),
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
