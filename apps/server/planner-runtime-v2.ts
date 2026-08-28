import { randomUUID } from "node:crypto";
import {
  ProposalScopeSchema,
  type AdjustmentProposalOutput,
  type AiTaskStatus,
  type DetailBatchOutputV2,
  type PlanCommand,
  type ProposalDiff,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { AiTaskMonitor, aiErrorMessage, normalizePublicAiSummary } from "./ai-task-monitor.js";
import { applyPlanCommands } from "./plan-commands-v2.js";
import { applyPreparedPlanCommandBatchToStore, preparePlanForCommands } from "./plan-command-preparation-v2.js";
import { resolutionIsCurrent } from "./place-resolver-v2.js";
import { assertProposalCommandsWithinScope } from "./proposal-scope-policy-v2.js";
import { applyRefinementBatchToStore } from "./refinement-workflow-v2.js";
import {
  CodexTravelAiV2,
  TravelPlannerRuntimeV2 as CoreTravelPlannerRuntimeV2,
  buildGeoClusters,
  type GeoClusterV2,
  type ModelOptionsV2,
  type RuntimeAiHandle,
  type RuntimeEventV2,
  type TravelAiV2,
} from "./planner-runtime-core-v2.js";

export {
  CodexTravelAiV2,
  buildGeoClusters,
  type GeoClusterV2,
  type ModelOptionsV2,
  type RuntimeAiHandle,
  type RuntimeEventV2,
  type TravelAiV2,
};

type RuntimeOptions = ConstructorParameters<typeof CoreTravelPlannerRuntimeV2>[0];
type ActiveLocalTask = { tripId: string; interrupt: () => Promise<void> };

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

  private emitEvent(event: RuntimeEventV2) {
    this.runtimeOptions.emit(event);
  }

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
        handle = await this.runtimeOptions.ai.proposeAdjustment(
          { trip: this.runtimeOptions.store.requireTrip(tripId), scope, message: value },
          (progress) => {
            const summary = normalizePublicAiSummary(progress.text);
            if (summary) tasks.update(taskId, "running", summary, progress.kind);
          },
        );
        this.localTasks.set(taskId, { tripId, interrupt: handle.interrupt });
        tasks.update(taskId, "running", "正在生成修改建议", "turn:running");
        const output = await handle.result;
        const trip = this.runtimeOptions.store.requireTrip(tripId);
        if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        if (JSON.stringify(output.scope) !== JSON.stringify(scope)) throw new Error("AI 返回的 Proposal Scope 与请求不一致。");
        const checked = assertProposalCommandsWithinScope(trip.plan, scope, output.commands);
        const prepared = preparePlanForCommands(trip.plan, checked.commands);
        const preview = applyPlanCommands(prepared, checked.commands);
        const timestamp = new Date().toISOString();
        const proposal = this.runtimeOptions.store.createProposal({
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
        this.runtimeOptions.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "propose_adjustment", proposalId: proposal.id });
        this.emitEvent({ kind: "travel.proposal.changed", payload: { tripId, proposalId: proposal.id } });
        tasks.update(taskId, "completed", "生成修改建议已完成", "task:completed");
      } catch (error) {
        const messageText = normalizePublicAiSummary(aiErrorMessage(error)) || "生成修改建议失败";
        const status = failureStatus(messageText);
        tasks.update(taskId, status, messageText, `task:${status}`);
      } finally {
        this.localTasks.delete(taskId);
      }
    })();
    return { taskId, messageId: null };
  }

  override startRefinement(tripId: string, requestedDayIds: string[] | null = null) {
    const trip = this.runtimeOptions.store.requireTrip(tripId);
    if (!trip.plan.days.length) throw new Error("请先生成按天行程。");
    const uniqueRequested = requestedDayIds ? [...new Set(requestedDayIds)] : [];
    if (uniqueRequested.length > 2) throw new Error("每批最多细化两个 Day。");
    const dayIds = uniqueRequested.length
      ? uniqueRequested
      : trip.plan.days
        .filter((day) => day.detailLevel !== "detailed" || day.detailStatus === "needs_review")
        .slice(0, 2)
        .map((day) => day.id);
    if (dayIds.some((dayId) => !trip.plan.days.some((day) => day.id === dayId))) throw new Error("细化请求包含未知 Day。");
    if (!dayIds.length) throw new Error("所有 Day 已完成细化且无需复核。");

    const taskId = `detailer:${randomUUID()}`;
    const tasks: AiTaskMonitor = this.runtimeOptions.tasks;
    tasks.start({ id: taskId, tripId, agent: "detailer", label: `细化 ${dayIds.length} 天行程`, summary: "准备细化行程" });
    void (async () => {
      let handle: RuntimeAiHandle<DetailBatchOutputV2> | null = null;
      try {
        handle = await this.runtimeOptions.ai.detailDays(
          { trip: this.runtimeOptions.store.requireTrip(tripId), dayIds },
          (progress) => {
            const summary = normalizePublicAiSummary(progress.text);
            if (summary) tasks.update(taskId, "running", summary, progress.kind);
          },
        );
        this.localTasks.set(taskId, { tripId, interrupt: handle.interrupt });
        tasks.update(taskId, "running", `正在细化 ${dayIds.length} 天行程`, "turn:running");
        const output = await handle.result;
        const returned = new Set(output.dayIds);
        if (returned.size !== dayIds.length || dayIds.some((dayId) => !returned.has(dayId))) {
          throw new Error("行程细化返回的 Day 超出本批服务端指定范围。");
        }
        const applied = applyRefinementBatchToStore(this.runtimeOptions.store, tripId, output);
        this.runtimeOptions.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "refinement", changedDayIds: applied.changedDayIds });
        this.emitEvent({ kind: "travel.document.changed", payload: { tripId, generation: applied.generation, changedDayIds: applied.changedDayIds } });
        tasks.update(taskId, "completed", `细化 ${dayIds.length} 天行程已完成`, "task:completed");
      } catch (error) {
        const messageText = normalizePublicAiSummary(aiErrorMessage(error)) || "细化行程失败";
        const status = failureStatus(messageText);
        tasks.update(taskId, status, messageText, `task:${status}`);
      } finally {
        this.localTasks.delete(taskId);
      }
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
