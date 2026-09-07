import type { AiActionRecord } from "./ai-stage-contracts-v3.js";
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
import {
  PlanCommandSchema,
  type PlanCommand,
  type ProposalScope,
} from "./contracts-v2.js";
import { applyCandidateDiscovery } from "./candidate-workflow-v2.js";
import {
  applyDetailedUpdatesPhase5V3,
  detailedReplacementCommandsPhase5V3,
  validateDetailedSchedulingOutcomeV3,
} from "./detail-itinerary-v3.js";
import { applyMainRouteGenerationV3 } from "./final-route-ai-v3.js";
import {
  applySkeletonPlanV3,
  deriveItineraryUpdateStateV3,
} from "./itinerary-workflow-v3.js";
import { buildDetailPlanningContextV3 } from "./planning-context-v3.js";
import { dayMutationScope } from "./planner-action-scope-v3.js";
import {
  assertDestinationOutputWithinBrief,
  candidateCommand,
  normalizeCandidateDiscoveryOutput,
} from "./planner-candidate-output-v3.js";
import { markImpact } from "./planner-itinerary-impact-v3.js";
import { refinementCommands, replacementCommands } from "./planner-itinerary-commands-v3.js";
import { validateItineraryReferences } from "./planner-itinerary-validation-v3.js";
import { currentResolvedPlaces } from "./planner-resolution-state-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const VERIFY_STOP_FIELDS = new Set([
  "scheduleText",
  "startTime",
  "endTime",
  "durationMinutes",
  "transportFromPrevious",
  "scheduleVerification",
  "costNote",
  "costVerification",
  "notes",
]);

type ActionOutput = Record<string, any>;
type DetailPlanningContextV3 = ReturnType<typeof buildDetailPlanningContextV3>;
type ProposalCreator = (
  action: AiActionRecord,
  title: string,
  explanation: string,
  commands: PlanCommand[],
  scope: ProposalScope,
  affectedDayIds?: string[],
) => unknown;

type ResolutionCallback = (
  tripId: string,
  placeIds: string[],
  expectedGeneration: number,
  taskId?: string,
) => Promise<unknown[]>;

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function assertDetailPlanningBlockers(_context: DetailPlanningContextV3) {
  // Planning readiness is advisory-only. Structural target/reference checks are
  // performed by the concrete action and canonical schemas.
}

function assertDetailMacroCurrent(_context: DetailPlanningContextV3) {
  // A dirty upstream skeleton may make the detail plan stale, but it does not
  // revoke the user's ability to work on the current detailed itinerary.
}

/**
 * Persists validated AI Action output or turns it into a scoped Proposal.
 *
 * Claim/execute/failure lifecycle stays in TravelPlannerRuntimeV3. Proposal
 * construction also stays Runtime-owned through the createProposal callback.
 */
export class PlannerActionPersistenceCoordinatorV3 {
  constructor(private readonly options: {
    store: TravelStoreV3;
    createProposal: ProposalCreator;
    resolveChangedPlaces: ResolutionCallback;
    emitDocumentChanged: (tripId: string, generation: number, changedDayIds: string[]) => void;
    startRouteBatch: (tripId: string, expectedGeneration: number, dayIds: string[]) => unknown;
    recalculateAllMacroRoutes: (tripId: string, expectedGeneration: number) => Promise<void>;
  }) {}

  persist(action: AiActionRecord, output: ActionOutput, taskId: string | null = null) {
    if (action.actionType === "destination.generate") {
      return this.persistDestinationGenerate(action, output as DestinationGenerateOutput, taskId);
    }
    if (
      action.actionType === "destination.add"
      || action.actionType === "destination.replace"
      || action.actionType === "interest.add"
      || action.actionType === "interest.replace"
    ) {
      return this.persistCandidateProposal(
        action,
        output as DestinationAddOutput | DestinationReplaceOutput | InterestAddOutput | InterestReplaceOutput,
      );
    }
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

  private async persistDestinationGenerate(
    action: AiActionRecord,
    output: DestinationGenerateOutput,
    taskId: string | null = null,
  ) {
    const trip = this.options.store.requireTrip(action.tripId);
    assertDestinationOutputWithinBrief(trip.plan, output);
    const normalized = normalizeCandidateDiscoveryOutput(output, "macro");
    const applied = applyCandidateDiscovery(trip.plan, normalized);
    const plan = markImpact(
      trip.plan,
      applyMainRouteGenerationV3(trip.plan, applied.plan, output, applied.idMappings),
    );
    const resolutionPlaceIds = [...new Set<string>(
      normalized.candidates
        .map((candidate: any) => applied.idMappings[candidate.placeTemporaryId])
        .filter((value: unknown): value is string => typeof value === "string" && Boolean(value)),
    )];
    const written = this.options.store.writePlan(
      action.tripId,
      plan,
      action.baseGeneration,
      { source: "action:destination.generate", summary: "AI 生成想去的地方" },
      { keepActionId: action.id },
    );
    this.options.emitDocumentChanged(action.tripId, written.generation, []);
    await this.options.resolveChangedPlaces(
      action.tripId,
      resolutionPlaceIds,
      written.generation,
      taskId ?? undefined,
    );
    const resolved = currentResolvedPlaces(
      this.options.store.requireTrip(action.tripId),
      this.options.store.listPlaceResolutions(action.tripId),
    ).filter((item) => resolutionPlaceIds.includes(item.placeId)).length;
    this.options.store.completeAction(
      action.id,
      `generation:${written.generation};resolved:${resolved}/${resolutionPlaceIds.length}`,
    );
  }

  private persistCandidateProposal(
    action: AiActionRecord,
    output: DestinationAddOutput | DestinationReplaceOutput | InterestAddOutput | InterestReplaceOutput,
  ) {
    const commands: PlanCommand[] = [];
    if (action.actionType === "destination.replace") {
      commands.push({
        type: "remove_candidate_tree",
        candidateId: String((output as DestinationReplaceOutput).replaceCandidateId || action.targetIds[0] || ""),
      });
    }
    if (action.actionType === "interest.replace") {
      commands.push({
        type: "remove_candidate",
        candidateId: String((output as InterestReplaceOutput).replaceCandidateId || action.targetIds[0] || ""),
      });
    }
    commands.push(candidateCommand(output));
    return this.options.createProposal(
      action,
      output.title,
      output.explanation,
      commands,
      { type: "candidate_pool", id: null },
    );
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
    if (trip.plan.days.length) {
      throw new Error("首次生成路线和天数只能在尚未存在 Day 时执行；已有结果请使用重新规划。");
    }
    if (result.type !== "success") throw new Error("路线和天数生成结果类型无效。");
    const applied = applySkeletonPlanV3(trip, {
      stays: result.stays,
      omittedPlanningAreas: result.omittedPlanningAreas,
    });
    const written = this.options.store.writePlan(
      action.tripId,
      applied.plan,
      action.baseGeneration,
      { source: "action:itinerary.generate", summary: "AI 生成路线和天数" },
      { keepActionId: action.id },
    );
    this.options.store.completeAction(
      action.id,
      `generation:${written.generation};omitted:${result.omittedPlanningAreas.length}`,
    );
    this.options.emitDocumentChanged(action.tripId, written.generation, applied.affectedDayIds);
    void this.options.recalculateAllMacroRoutes(action.tripId, written.generation);
  }

  private persistItineraryReplacement(action: AiActionRecord, output: ItineraryReplanOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    if (result.type !== "success") throw new Error("路线和天数更新结果类型无效。");
    const trip = this.options.store.requireTrip(action.tripId);
    const applied = applySkeletonPlanV3(trip, {
      stays: result.stays,
      omittedPlanningAreas: result.omittedPlanningAreas,
    });
    if (same(applied.plan, trip.plan)) {
      this.options.store.completeAction(action.id, "no-change");
      return;
    }
    const written = this.options.store.writePlan(
      action.tripId,
      applied.plan,
      action.baseGeneration,
      { source: "action:itinerary.replan", summary: "AI 更新路线和天数" },
      { keepActionId: action.id },
    );
    this.options.store.completeAction(
      action.id,
      `generation:${written.generation};affected:${applied.affectedDayIds.length};omitted:${result.omittedPlanningAreas.length}`,
    );
    this.options.emitDocumentChanged(action.tripId, written.generation, applied.affectedDayIds);
    void this.options.recalculateAllMacroRoutes(action.tripId, written.generation);
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
    validateDetailedSchedulingOutcomeV3(
      plan,
      result.unscheduledCandidates,
      detail.targetDayIds,
      detail.unavailableCandidateIds,
    );
    const written = this.options.store.writePlan(
      action.tripId,
      plan,
      action.baseGeneration,
      { source: "action:itinerary.detail.generate", summary: "AI 生成每日详细行程" },
      { keepActionId: action.id },
    );
    this.options.store.completeAction(
      action.id,
      `generation:${written.generation};unscheduled:${result.unscheduledCandidates.length}`,
    );
    this.options.emitDocumentChanged(action.tripId, written.generation, detail.targetDayIds);
    this.options.startRouteBatch(action.tripId, written.generation, detail.targetDayIds);
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
    if (
      !requested.size
      || requested.size !== result.affectedDayIds.length
      || result.affectedDayIds.some((id) => !requested.has(id))
    ) {
      throw new Error("AI 返回了 affected scope 外的 Day。");
    }
    const resolutions = this.options.store.listPlaceResolutions(action.tripId);
    const detail = buildDetailPlanningContextV3(trip.plan, resolutions, requestedIds);
    assertDetailMacroCurrent(detail);
    assertDetailPlanningBlockers(detail);
    const replacement = detailedReplacementCommandsPhase5V3(trip, result.dayUpdates);
    validateItineraryReferences(
      trip,
      replacement.plan.days.filter((day) => requested.has(day.id)),
      resolutions,
    );
    validateDetailedSchedulingOutcomeV3(
      replacement.plan,
      result.unscheduledCandidates,
      requestedIds,
      detail.unavailableCandidateIds,
    );
    if (!replacement.commands.length) {
      const written = this.options.store.writePlan(
        action.tripId,
        replacement.plan,
        action.baseGeneration,
        { source: "action:itinerary.detail.update", summary: "确认受影响日期无需内容调整" },
        { keepActionId: action.id },
      );
      this.options.store.completeAction(
        action.id,
        `generation:${written.generation};no-content-change;unscheduled:${result.unscheduledCandidates.length}`,
      );
      this.options.emitDocumentChanged(action.tripId, written.generation, result.affectedDayIds);
      return;
    }
    return this.options.createProposal(
      action,
      result.title,
      result.explanation,
      replacement.commands,
      dayMutationScope(result.affectedDayIds),
      result.affectedDayIds,
    );
  }

  private persistItineraryRepair(action: AiActionRecord, output: ItineraryRepairOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    if (result.type !== "success") throw new Error("行程修复结果类型无效。");
    const trip = this.options.store.requireTrip(action.tripId);
    validateItineraryReferences(
      trip,
      result.days,
      this.options.store.listPlaceResolutions(action.tripId),
    );
    const commands = replacementCommands(trip.plan, result.days);
    if (!commands.length) {
      this.options.store.completeAction(action.id, "no-change");
      return;
    }
    return this.options.createProposal(
      action,
      result.title,
      result.explanation,
      commands,
      { type: "trip", id: null },
    );
  }

  private persistDayOptimize(action: AiActionRecord, output: ItineraryDayOptimizeOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    if (result.type !== "success") throw new Error("单日优化结果类型无效。");
    const trip = this.options.store.requireTrip(action.tripId);
    const day = trip.plan.days.find((item) => item.id === result.dayId);
    if (!day) throw new Error(`未知 Day：${result.dayId}`);
    const desired = result.orderedStopIds;
    if (
      desired.length !== day.stops.length
      || new Set(desired).size !== desired.length
      || day.stops.some((stop) => !desired.includes(stop.id))
    ) {
      throw new Error("单日优化必须原样覆盖目标 Day 的现有 Stop ID。");
    }
    const working = day.stops.map((stop) => stop.id);
    const commands: PlanCommand[] = [];
    for (let index = 0; index < desired.length; index += 1) {
      const id = desired[index];
      const currentIndex = working.indexOf(id);
      if (currentIndex === index) continue;
      working.splice(currentIndex, 1);
      working.splice(index, 0, id);
      commands.push({
        type: "move_day_stop",
        stopId: id,
        targetDayId: day.id,
        targetIndex: index,
      });
    }
    if (!commands.length) {
      this.options.store.completeAction(action.id, "no-change");
      return;
    }
    return this.options.createProposal(
      action,
      result.title,
      result.explanation,
      commands,
      { type: "day", id: day.id },
    );
  }

  private persistVerify(action: AiActionRecord, output: ItineraryVerifyOutput) {
    const allowed = output.commands.map((command) => PlanCommandSchema.parse(command));
    for (const command of allowed) {
      if (command.type !== "update_day_stop") {
        throw new Error("动态核验 Action 只能更新现有 Stop 的动态事实字段。");
      }
      const keys = Object.keys(command.changes);
      if (!keys.length || keys.some((key) => !VERIFY_STOP_FIELDS.has(key))) {
        throw new Error("动态核验 Action 尝试修改地点身份或其他非动态字段。");
      }
    }
    if (!allowed.length) {
      this.options.store.completeAction(action.id, `verified:${output.checkedAt};no-change`);
      return;
    }
    return this.options.createProposal(
      action,
      output.title,
      output.explanation,
      allowed,
      { type: "trip", id: null },
    );
  }

  private persistRefine(action: AiActionRecord, output: ItineraryRefineOutput) {
    const result = output.result;
    if (this.completeRequiresWorkflowStep(action, result)) return;
    if (result.type !== "success") throw new Error("细化行程结果类型无效。");
    const trip = this.options.store.requireTrip(action.tripId);
    const commands = refinementCommands(trip.plan, output);
    if (!commands.length) {
      this.options.store.completeAction(action.id, "no-change");
      return;
    }
    return this.options.createProposal(
      action,
      result.title,
      result.explanation,
      commands,
      dayMutationScope(result.dayIds),
      result.dayIds,
    );
  }
}
