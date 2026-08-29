import { randomUUID } from "node:crypto";
import {
  ProposalScopeSchema,
  type AdjustmentProposalOutput,
  type AiTaskStatus,
  type DetailBatchOutputV2,
  type MicroCandidateDiscoveryOutput,
  type PlanCommand,
  type ProposalDiff,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { AiTaskMonitor, aiErrorMessage, normalizePublicAiSummary } from "./ai-task-monitor.js";
import { applyCandidateDiscoveryToStore } from "./candidate-workflow-v2.js";
import { validateMicroCandidateDiscovery, CANDIDATE_DISCOVERY_BATCH_LIMIT, type FixedAreaTargetV2 } from "./candidate-discovery-policy-v2.js";
import { applyPlanCommands } from "./plan-commands-v2.js";
import { applyPreparedPlanCommandBatchToStore, preparePlanForCommands } from "./plan-command-preparation-v2.js";
import { resolutionIsCurrent } from "./place-resolver-v2.js";
import { assertProposalCommandsWithinScope } from "./proposal-scope-policy-v2.js";
import { validateAdjustmentProposal } from "./proposal-validation-v2.js";
import { applyRefinementBatchToStore } from "./refinement-workflow-v2.js";
import {
  AiLedMicroCandidateDiscoveryOutputJsonSchema,
  AiLedMicroCandidateDiscoveryOutputSchema,
} from "./ai-led-micro-contract-v2.js";
import {
  CodexTravelAiV2 as CoreCodexTravelAiV2,
  TravelPlannerRuntimeV2 as CoreTravelPlannerRuntimeV2,
  buildGeoClusters,
  type GeoClusterV2,
  type ModelOptionsV2,
  type RuntimeAiHandle,
  type RuntimeEventV2,
  type TravelAiV2,
} from "./planner-runtime-core-v2.js";

export {
  buildGeoClusters,
  type GeoClusterV2,
  type ModelOptionsV2,
  type RuntimeAiHandle,
  type RuntimeEventV2,
  type TravelAiV2,
};

type CodexOptions = ConstructorParameters<typeof CoreCodexTravelAiV2>[0];
type RuntimeOptions = ConstructorParameters<typeof CoreTravelPlannerRuntimeV2>[0];
type ActiveLocalTask = { tripId: string; interrupt: () => Promise<void> };

const interestDiscoveryInstructions = [
  "这是 AI Travel Planner 的独立兴趣点研究线程。",
  "只使用当前消息注入的旅行需求、目标目的地和已有地点；不得读取项目文件、环境变量、其他线程或账户数据。",
  "AI 自主决定本轮实际新增 0–9 个详细地点；不得为了凑数输出低价值地点。",
  "允许所有非 city 的 Place kind；地点价值、类型、显著性、体验多样性和研究依据均由 AI 判断。",
  "不得输出坐标、Provider Place ID、来源链接、路线 geometry、距离或地图 Provider 交通时长。",
  "只输出本轮指定 JSON Schema，不公开内部推理。",
].join("\n");

function withoutResearchLinks(progress?: (value: any) => void) {
  if (!progress) return undefined;
  return (value: any) => progress({ ...value, text: String(value.text ?? "").replace(/https?:\/\/\S+/giu, "[攻略来源已隐藏]") });
}

/** Active V3 AI facade: keep all existing agents, replace only micro discovery contract. */
export class CodexTravelAiV2 implements TravelAiV2 {
  private readonly core: CoreCodexTravelAiV2;
  constructor(private readonly options: CodexOptions) {
    this.core = new CoreCodexTravelAiV2(options);
  }

  conversation(input: Parameters<TravelAiV2["conversation"]>[0], progress?: Parameters<TravelAiV2["conversation"]>[1]) { return this.core.conversation(input, progress); }
  discoverMacroCandidates(input: Parameters<TravelAiV2["discoverMacroCandidates"]>[0], progress?: Parameters<TravelAiV2["discoverMacroCandidates"]>[1]) { return this.core.discoverMacroCandidates(input, progress); }
  generatePlan(input: Parameters<TravelAiV2["generatePlan"]>[0], progress?: Parameters<TravelAiV2["generatePlan"]>[1]) { return this.core.generatePlan(input, progress); }
  detailDays(input: Parameters<TravelAiV2["detailDays"]>[0], progress?: Parameters<TravelAiV2["detailDays"]>[1]) { return this.core.detailDays(input, progress); }
  proposeAdjustment(input: Parameters<TravelAiV2["proposeAdjustment"]>[0], progress?: Parameters<TravelAiV2["proposeAdjustment"]>[1]) { return this.core.proposeAdjustment(input, progress); }
  assistResolution(input: Parameters<TravelAiV2["assistResolution"]>[0]) { return this.core.assistResolution(input); }

  async discoverMicroCandidates(input: Parameters<TravelAiV2["discoverMicroCandidates"]>[0], progress?: Parameters<TravelAiV2["discoverMicroCandidates"]>[1]) {
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
          areaRequest: { planningAreaCandidateId: targetId, maxNewCandidates: CANDIDATE_DISCOVERY_BATCH_LIMIT },
          planningAreaCandidates: input.trip.plan.candidates
            .filter((candidate) => candidate.id === targetId)
            .map((candidate) => ({ ...candidate, place: places.get(candidate.placeId) ?? null })),
          existingPlaces: input.trip.plan.candidates
            .filter((candidate) => candidate.planningAreaCandidateId === targetId)
            .map((candidate) => ({ candidateId: candidate.id, planningAreaCandidateId: candidate.planningAreaCandidateId, place: places.get(candidate.placeId) ?? null })),
        },
      },
      schema: AiLedMicroCandidateDiscoveryOutputSchema,
      outputSchema: AiLedMicroCandidateDiscoveryOutputJsonSchema,
      validateResult: (output) => validateMicroCandidateDiscovery(output, [targetId], [{ planningAreaCandidateId: targetId, targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT }]),
      developerInstructions: interestDiscoveryInstructions,
      threadSource: "ai-travel-interest-discovery-v3",
      ephemeral: true,
      webSearch: "live",
      timeoutMs: 300_000,
      ...this.options.modelOptions(),
      onProgress: withoutResearchLinks(progress),
    });
  }
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

function failureStatus(message: string): AiTaskStatus {
  if (message === "CONTENT_GENERATION_SUPERSEDED") return "cancelled_by_generation";
  if (message === "AI 任务已停止。") return "stopped";
  return "failed";
}

export class TravelPlannerRuntimeV2 extends CoreTravelPlannerRuntimeV2 {
  private readonly localTasks = new Map<string, ActiveLocalTask>();

  constructor(private readonly runtimeOptions: RuntimeOptions) {
    super(runtimeOptions);
  }

  private emitEvent(event: RuntimeEventV2) { this.runtimeOptions.emit(event); }

  private async resolveChangedPlacesAfterMutation(tripId: string, placeIds: string[], expectedGeneration: number) {
    const trip = this.runtimeOptions.store.requireTrip(tripId);
    if (trip.contentGeneration !== expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const stored = new Map(this.runtimeOptions.store.listPlaceResolutions(tripId).map((resolution) => [resolution.placeId, resolution]));
    for (const placeId of [...new Set(placeIds)]) {
      const place = trip.plan.places.find((item) => item.id === placeId);
      if (!place) continue;
      const resolution = stored.get(placeId);
      if (resolution?.status === "resolved" && resolutionIsCurrent(place, resolution)) continue;
      await this.runtimeOptions.resolver.resolve(tripId, placeId, expectedGeneration);
      this.emitEvent({ kind: "travel.resolution.changed", payload: { tripId, placeId } });
    }
  }

  /**
   * Micro discovery is save-first and resolution-best-effort. Map resolution never
   * determines whether the AI recommendation enters the candidate pool.
   */
  override startCandidateDiscovery(tripId: string, mode: "macro" | "micro" = "macro", planningAreaCandidateIds: string[] = [], message: string | null = null) {
    if (mode !== "micro") return super.startCandidateDiscovery(tripId, mode, planningAreaCandidateIds, message);
    const initialTrip = this.runtimeOptions.store.requireTrip(tripId);
    const places = new Map(initialTrip.plan.places.map((place) => [place.id, place]));
    const activeMacroIds = initialTrip.plan.candidates
      .filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city")
      .map((candidate) => candidate.id);
    const targetIds = [...new Set(planningAreaCandidateIds.length ? planningAreaCandidateIds : activeMacroIds)];
    if (!targetIds.length) throw new Error("请先生成并保留至少一个目的地。");
    for (const id of targetIds) if (!activeMacroIds.includes(id)) throw new Error(`详细地点只能围绕有效 Macro 目的地生成：${id}`);

    const taskId = `planner:${randomUUID()}`;
    const tasks: AiTaskMonitor = this.runtimeOptions.tasks;
    tasks.start({ id: taskId, tripId, agent: "planner", label: "生成详细兴趣点", summary: "准备生成 AI 推荐的详细地点" });
    void (async () => {
      const stats = { suggested: 0, added: 0, merged: 0, resolved: 0, unresolved: 0, failedAreas: [] as string[], messages: [] as string[] };
      try {
        for (let index = 0; index < targetIds.length; index += 1) {
          const trip = this.runtimeOptions.store.requireTrip(tripId);
          if (trip.contentGeneration !== initialTrip.contentGeneration && index === 0) throw new Error("CONTENT_GENERATION_SUPERSEDED");
          const areaId = targetIds[index];
          const areaCandidate = trip.plan.candidates.find((candidate) => candidate.id === areaId);
          const areaPlace = areaCandidate ? trip.plan.places.find((place) => place.id === areaCandidate.placeId) : null;
          const areaLabel = areaPlace?.nameZh ?? areaPlace?.nameLocal ?? areaPlace?.nameEn ?? areaId;
          tasks.update(taskId, "running", `正在研究 ${index + 1}/${targetIds.length}：${areaLabel}`, "interest:researching");
          try {
            const handle = await this.runtimeOptions.ai.discoverMicroCandidates(
              { trip, message, areaTarget: { planningAreaCandidateId: areaId, targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT } as FixedAreaTargetV2 },
              (progress) => {
                const summary = normalizePublicAiSummary(progress.text);
                if (summary) tasks.update(taskId, "running", summary, progress.kind);
              },
            );
            this.localTasks.set(taskId, { tripId, interrupt: handle.interrupt });
            const output = await handle.result;
            if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
            validateMicroCandidateDiscovery(output, [areaId], [{ planningAreaCandidateId: areaId, targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT }]);
            stats.suggested += output.candidates.length;
            if (output.assistantMessage) stats.messages.push(output.assistantMessage);
            if (!output.candidates.length) continue;

            const applied = applyCandidateDiscoveryToStore(this.runtimeOptions.store, tripId, output);
            stats.added += applied.addedCandidateIds.length;
            stats.merged += Math.max(0, output.candidates.length - applied.addedCandidateIds.length);
            this.emitEvent({ kind: "travel.document.changed", payload: { tripId, generation: applied.generation, changedDayIds: [] } });

            const formalPlaceIds = [...new Set(output.candidates.map((candidate) => applied.idMappings[candidate.placeTemporaryId]).filter((id): id is string => Boolean(id)))];
            const beforeResolutions = new Map(this.runtimeOptions.store.listPlaceResolutions(tripId).map((resolution) => [resolution.placeId, resolution]));
            for (const placeId of formalPlaceIds) {
              const current = this.runtimeOptions.store.requireTrip(tripId);
              if (current.contentGeneration !== applied.generation) throw new Error("CONTENT_GENERATION_SUPERSEDED");
              const place = current.plan.places.find((item) => item.id === placeId);
              const existing = beforeResolutions.get(placeId);
              if (place && existing?.status === "resolved" && resolutionIsCurrent(place, existing)) {
                stats.resolved += 1;
                continue;
              }
              try {
                const result = await this.runtimeOptions.resolver.resolve(tripId, placeId, applied.generation);
                if (result.resolution.status === "resolved") stats.resolved += 1; else stats.unresolved += 1;
                this.emitEvent({ kind: "travel.resolution.changed", payload: { tripId, placeId } });
              } catch (error) {
                const text = aiErrorMessage(error);
                if (text === "CONTENT_GENERATION_SUPERSEDED") throw error;
                stats.unresolved += 1;
              }
            }
          } catch (error) {
            const text = normalizePublicAiSummary(aiErrorMessage(error)) || "AI 研究失败";
            if (text === "CONTENT_GENERATION_SUPERSEDED" || text === "AI 任务已停止。") throw error;
            stats.failedAreas.push(`${areaLabel}：${text}`);
            tasks.update(taskId, "running", `${areaLabel}研究失败，已保留其他区域结果`, "interest:failed-area");
          }
        }

        const summary = [
          `AI 建议 ${stats.suggested} 个详细地点。`,
          `实际新增 ${stats.added} 个，合并重复 ${stats.merged} 个。`,
          `已定位 ${stats.resolved} 个，待定位 ${stats.unresolved} 个。`,
          stats.failedAreas.length ? `AI 失败区域 ${stats.failedAreas.length} 个：${stats.failedAreas.join("；")}` : "AI 失败区域 0 个。",
        ].join("\n");
        this.runtimeOptions.store.createAssistantMessage(tripId, `${stats.messages.join("\n\n")}\n\n${summary}`.trim().slice(0, 12000), {
          mode: "discover_candidates",
          discoveryMode: "micro",
          aiSuggestedCount: stats.suggested,
          addedCount: stats.added,
          mergedDuplicateCount: stats.merged,
          resolvedCount: stats.resolved,
          unresolvedCount: stats.unresolved,
          failedAreaCount: stats.failedAreas.length,
        });
        tasks.update(taskId, "completed", `详细地点生成完成：${stats.resolved} 个已定位，${stats.unresolved} 个待定位`, "task:completed");
      } catch (error) {
        const text = normalizePublicAiSummary(aiErrorMessage(error)) || "生成详细兴趣点失败";
        const status = failureStatus(text);
        tasks.update(taskId, status, text, `task:${status}`);
      } finally {
        this.localTasks.delete(taskId);
      }
    })();
    return { taskId, messageId: null };
  }

  override startProposal(tripId: string, scopeValue: unknown, message: string) {
    const scope = ProposalScopeSchema.parse(scopeValue);
    const value = message.trim();
    if (!value) throw new Error("请输入希望 AI 调整的内容。");
    const taskId = `planner:${randomUUID()}`;
    const tasks: AiTaskMonitor = this.runtimeOptions.tasks;
    tasks.start({ id: taskId, tripId, agent: "planner", label: "生成修改建议", summary: "准备生成修改建议" });
    void (async () => {
      let handle: RuntimeAiHandle<AdjustmentProposalOutput> | null = null;
      try {
        handle = await this.runtimeOptions.ai.proposeAdjustment({ trip: this.runtimeOptions.store.requireTrip(tripId), scope, message: value }, (progress) => {
          const summary = normalizePublicAiSummary(progress.text);
          if (summary) tasks.update(taskId, "running", summary, progress.kind);
        });
        this.localTasks.set(taskId, { tripId, interrupt: handle.interrupt });
        tasks.update(taskId, "running", "正在生成修改建议", "turn:running");
        const output = await handle.result;
        const trip = this.runtimeOptions.store.requireTrip(tripId);
        if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        const validated = validateAdjustmentProposal(trip.plan, scope, output);
        const timestamp = new Date().toISOString();
        const proposal = this.runtimeOptions.store.createProposal({
          id: randomUUID(), tripId, baseGeneration: trip.contentGeneration, scope: validated.scope, status: "pending",
          title: output.title, explanation: output.explanation, commands: validated.commands,
          diff: proposalDiff(validated.commands, validated.preview.effects), createdAt: timestamp, updatedAt: timestamp, appliedRevisionVersion: null,
        });
        this.runtimeOptions.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "propose_adjustment", proposalId: proposal.id });
        this.emitEvent({ kind: "travel.proposal.changed", payload: { tripId, proposalId: proposal.id } });
        tasks.update(taskId, "completed", "生成修改建议已完成", "task:completed");
      } catch (error) {
        const messageText = normalizePublicAiSummary(aiErrorMessage(error)) || "生成修改建议失败";
        const status = failureStatus(messageText);
        tasks.update(taskId, status, messageText, `task:${status}`);
      } finally { this.localTasks.delete(taskId); }
    })();
    return { taskId, messageId: null };
  }

  override startRefinement(tripId: string, requestedDayIds: string[] | null = null) {
    const trip = this.runtimeOptions.store.requireTrip(tripId);
    if (!trip.plan.days.length) throw new Error("请先生成按天行程。");
    const uniqueRequested = requestedDayIds ? [...new Set(requestedDayIds)] : [];
    if (uniqueRequested.length > 2) throw new Error("每批最多细化两个 Day。");
    const dayIds = uniqueRequested.length ? uniqueRequested : trip.plan.days.filter((day) => day.detailLevel !== "detailed" || day.detailStatus === "needs_review").slice(0, 2).map((day) => day.id);
    if (dayIds.some((dayId) => !trip.plan.days.some((day) => day.id === dayId))) throw new Error("细化请求包含未知 Day。");
    if (!dayIds.length) throw new Error("所有 Day 已完成细化且无需复核。");
    const taskId = `detailer:${randomUUID()}`;
    const tasks: AiTaskMonitor = this.runtimeOptions.tasks;
    tasks.start({ id: taskId, tripId, agent: "detailer", label: `细化 ${dayIds.length} 天行程`, summary: "准备细化行程" });
    void (async () => {
      let handle: RuntimeAiHandle<DetailBatchOutputV2> | null = null;
      try {
        handle = await this.runtimeOptions.ai.detailDays({ trip: this.runtimeOptions.store.requireTrip(tripId), dayIds }, (progress) => {
          const summary = normalizePublicAiSummary(progress.text);
          if (summary) tasks.update(taskId, "running", summary, progress.kind);
        });
        this.localTasks.set(taskId, { tripId, interrupt: handle.interrupt });
        tasks.update(taskId, "running", `正在细化 ${dayIds.length} 天行程`, "turn:running");
        const output = await handle.result;
        const returned = new Set(output.dayIds);
        if (returned.size !== dayIds.length || dayIds.some((dayId) => !returned.has(dayId))) throw new Error("行程细化返回的 Day 超出本批服务端指定范围。");
        const applied = applyRefinementBatchToStore(this.runtimeOptions.store, tripId, output);
        this.runtimeOptions.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "refinement", changedDayIds: applied.changedDayIds });
        this.emitEvent({ kind: "travel.document.changed", payload: { tripId, generation: applied.generation, changedDayIds: applied.changedDayIds } });
        tasks.update(taskId, "completed", `细化 ${dayIds.length} 天行程已完成`, "task:completed");
      } catch (error) {
        const messageText = normalizePublicAiSummary(aiErrorMessage(error)) || "细化行程失败";
        const status = failureStatus(messageText);
        tasks.update(taskId, status, messageText, `task:${status}`);
      } finally { this.localTasks.delete(taskId); }
    })();
    return { taskId, messageId: null };
  }

  override async applyCommands(tripId: string, input: unknown) {
    const applied = applyPreparedPlanCommandBatchToStore(this.runtimeOptions.store, tripId, input);
    this.emitEvent({ kind: "travel.document.changed", payload: { tripId, generation: applied.generation, changedDayIds: applied.effects.changedDayIds } });
    await this.resolveChangedPlacesAfterMutation(tripId, applied.effects.changedPlaceIds, applied.generation);
    return applied;
  }

  override async applyProposal(tripId: string, proposalId: string) {
    const proposal = this.runtimeOptions.store.getProposal(proposalId);
    if (!proposal || proposal.tripId !== tripId) throw new Error("找不到该 Proposal。");
    const trip = this.runtimeOptions.store.requireTrip(tripId);
    const checked = assertProposalCommandsWithinScope(trip.plan, proposal.scope, proposal.commands);
    const prepared: TravelPlanDocument = preparePlanForCommands(trip.plan, checked.commands);
    const applied = applyPlanCommands(prepared, checked.commands);
    const stored = this.runtimeOptions.store.applyProposalPlan(proposalId, applied.plan, `应用 AI 建议：${proposal.title}`);
    this.emitEvent({ kind: "travel.document.changed", payload: { tripId, generation: stored.generation, changedDayIds: applied.effects.changedDayIds } });
    this.emitEvent({ kind: "travel.proposal.changed", payload: { tripId, proposalId } });
    await this.resolveChangedPlacesAfterMutation(tripId, applied.effects.changedPlaceIds, stored.generation);
    return { ...stored, effects: applied.effects };
  }

  override async searchResolutionCandidates(tripId: string, placeId: string, expectedGeneration: number): Promise<any> {
    const ranked = await this.runtimeOptions.resolver.searchCandidates(tripId, placeId, expectedGeneration);
    return ranked.map((item) => item.candidate);
  }

  override stopTask(tripId: string, taskId: string) {
    const localTask = this.localTasks.get(taskId);
    if (!localTask) return super.stopTask(tripId, taskId);
    if (localTask.tripId !== tripId) throw new Error("当前任务已经结束。");
    void localTask.interrupt().catch(() => undefined);
    return { ok: true };
  }
}
