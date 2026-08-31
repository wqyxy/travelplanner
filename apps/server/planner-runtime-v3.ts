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
  ItineraryGenerateOutput,
  ItineraryRefineOutput,
  ItineraryRepairOutput,
  ItineraryReplanOutput,
  ItineraryVerifyOutput,
} from "./ai-action-contracts-v3.js";
import { ItineraryGenerateOutputSchema } from "./ai-action-contracts-v3.js";
import { actionRegistration } from "./ai-registries-v3.js";
import { parseActionParametersV3 } from "./ai-action-input-contracts-v3.js";
import { AiTaskMonitorV3, aiErrorMessageV3, normalizePublicAiSummaryV3 } from "./ai-task-monitor-v3.js";
import { applyCandidateDiscovery } from "./candidate-workflow-v2.js";
import { CANDIDATE_DISCOVERY_BATCH_LIMIT, validateMicroCandidateDiscovery } from "./candidate-discovery-policy-v2.js";
import { classifyCodexFailure } from "./codex-client.js";
import { ROUTE_DAY_BATCH_CONCURRENCY, type DayRouteServiceV2 } from "./day-route-v2.js";
import { applyPlanCommands } from "./plan-commands-v2.js";
import { buildPlanningCoverage } from "./planning-areas-v2.js";
import type { PlaceResolutionBatchProgress, PlaceResolverV2 } from "./place-resolver-v2.js";
import { resolutionIsCurrent } from "./place-resolver-v2.js";
import { assertProposalCommandsWithinScope } from "./proposal-scope-policy-v2.js";
import type { LoadedPromptRegistryV3 } from "./prompt-registry-v3.js";
import { buildStageContext, validateSelectionForStage } from "./stage-context-v3.js";
import type { StagedAiHandle } from "./staged-ai-v3.js";
import { StagedTravelAiV3 } from "./staged-ai-v3.js";
import { buildOpenAiStructuredOutputSchema } from "./structured-ai-v2.js";
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
const INTEREST_DISCOVERY_CONCURRENCY = 4;

type ActiveRun = { tripId: string; interrupt: () => Promise<void>; actionId?: string; messageId?: string; stage?: ConversationStage };
type RouteBatch = { tripId: string; expectedGeneration: number; controller: AbortController };
type ActionOutput = Record<string, any>;
type InterestFailure = { targetId: string; errorSummary: string };

function now() { return new Date().toISOString(); }
function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
function stringifySize(value: unknown) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

function hasTravelRequirements(plan: TravelPlanDocument) {
  return !same(plan.trip, emptyTravelPlan().trip);
}

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

function actionScope(actionType: AiActionType, targetIds: string[], parameters: Record<string, unknown>): ProposalScope {
  if (actionType.startsWith("requirements.")) return { type: "trip", id: null };
  if (actionType.startsWith("destination.") || actionType.startsWith("interest.")) return { type: "candidate_pool", id: null };
  if (actionType === "itinerary.day.optimize" || actionType === "itinerary.refine") {
    const ids = Array.isArray(parameters.dayIds) ? parameters.dayIds.filter((value): value is string => typeof value === "string") : [];
    const id = targetIds[0] || (typeof parameters.dayId === "string" ? parameters.dayId : ids[0] ?? "");
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

function expectedDayCount(plan: TravelPlanDocument) {
  if (plan.trip.dates.start && plan.trip.dates.end) return Math.floor((Date.parse(`${plan.trip.dates.end}T00:00:00Z`) - Date.parse(`${plan.trip.dates.start}T00:00:00Z`)) / 86_400_000) + 1;
  return plan.trip.dates.requestedDurationDays;
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

function validateItineraryReferences(trip: TripDetailV3, sourceDays: Day[], resolutions: PlaceResolution[]) {
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const candidates = new Map(trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const resolved = new Set(currentResolvedPlaces(trip, resolutions).map((resolution) => resolution.placeId));
  const checkPlace = (placeId: string | null) => {
    if (!placeId) return;
    const place = places.get(placeId);
    if (!place) throw new Error(`行程引用未知 Place：${placeId}`);
    if (!resolved.has(placeId)) throw new Error(`未定位地点不得进入行程：${place.nameZh}`);
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

type GenerateStateContext = { state: Record<string, unknown>; optionalOmitted: Array<{ candidateId: string; reason: string }>; unresolved: Array<{ candidateId: string; reason: string }>; candidateCounts: Record<string, number>; expectedDayCount: number };

function compactPlace(place: any) { return { id: place.id, nameZh: place.nameZh, nameLocal: place.nameLocal, nameEn: place.nameEn, kind: place.kind, city: place.city, region: place.region, country: place.country }; }

function buildCompactGenerateState(trip: TripDetailV3, resolutions: PlaceResolution[]): GenerateStateContext {
  const dayCount = expectedDayCount(trip.plan);
  if (!dayCount) throw new Error("GENERATE_REQUIRES_REQUIREMENTS");
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const current = new Map(currentResolvedPlaces(trip, resolutions).map((resolution) => [resolution.placeId, resolution]));
  const unresolved: Array<{ candidateId: string; reason: string }> = [];
  const eligible = trip.plan.candidates.filter((candidate) => {
    const place = places.get(candidate.placeId);
    if (!place || candidate.preference === "excluded" || place.kind === "city") return false;
    if (!current.has(place.id)) { unresolved.push({ candidateId: candidate.id, reason: "地点尚未完成定位" }); return false; }
    return true;
  });
  for (const candidate of trip.plan.candidates) {
    const place = places.get(candidate.placeId);
    if (candidate.preference === "must_go" && place?.kind !== "city" && !current.has(candidate.placeId)) throw new Error("GENERATE_REQUIRES_INTERESTS");
  }
  const requiredAreas = trip.plan.candidates.filter((candidate) => candidate.planningAreaCandidateId === null && candidate.preference !== "excluded" && candidate.preference !== "optional");
  for (const area of requiredAreas) if (!eligible.some((candidate) => candidate.planningAreaCandidateId === area.id)) throw new Error("GENERATE_REQUIRES_INTERESTS");
  const makeCandidate = (candidate: any) => {
    const place = places.get(candidate.placeId)!; const resolution = current.get(candidate.placeId)!;
    return { id: candidate.id, planningAreaCandidateId: candidate.planningAreaCandidateId, preference: candidate.preference, aiScore: candidate.aiScore, suggestedDurationMinutes: candidate.suggestedDurationMinutes, tags: candidate.tags, place: compactPlace(place), resolution: { latitude: resolution.latitude, longitude: resolution.longitude } };
  };
  const required = eligible.filter((candidate) => candidate.preference === "must_go" || candidate.preference === "want_to_go").sort((a, b) => (a.preference === b.preference ? a.id.localeCompare(b.id) : a.preference === "must_go" ? -1 : 1));
  const optional = eligible.filter((candidate) => candidate.preference === "optional");
  const anchorOptions = trip.plan.places.filter((place) => current.has(place.id) && (place.id === trip.plan.trip.originPlaceId || ["city", "lodging", "airport", "station", "port"].includes(place.kind))).map((place) => {
    const resolution = current.get(place.id)!; return { placeId: place.id, name: place.nameZh || place.nameLocal || place.nameEn || place.id, kind: place.kind, city: place.city, region: place.region, latitude: resolution.latitude, longitude: resolution.longitude };
  }).sort((a, b) => a.placeId.localeCompare(b.placeId));
  const base = { actionType: "itinerary.generate", baseGeneration: trip.contentGeneration, planLanguage: trip.planLanguage, tripFacts: trip.plan.trip, expectedDayCount: dayCount, anchorOptions, candidates: required.map(makeCandidate) };
  if (stringifySize(base) > 64 * 1024) throw new Error("GENERATE_INPUT_BUDGET_EXCEEDED");
  const selected = [...required]; const areaCounts = new Map<string, number>();
  for (const candidate of selected) areaCounts.set(candidate.planningAreaCandidateId ?? "", (areaCounts.get(candidate.planningAreaCandidateId ?? "") ?? 0) + 1);
  const remaining = [...optional];
  while (remaining.length) {
    remaining.sort((a, b) => (areaCounts.get(a.planningAreaCandidateId ?? "") ?? 0) - (areaCounts.get(b.planningAreaCandidateId ?? "") ?? 0) || (b.aiScore ?? -1) - (a.aiScore ?? -1) || (a.suggestedDurationMinutes ?? 0) - (b.suggestedDurationMinutes ?? 0) || a.id.localeCompare(b.id));
    const candidate = remaining.shift()!; const trial = { ...base, candidates: [...selected, candidate].map(makeCandidate) };
    // 48 KiB is the operating target; 64 KiB remains the non-negotiable hard cap
    // for required inputs that cannot be reduced.
    if (stringifySize(trial) > 48 * 1024) { remaining.unshift(candidate); break; }
    selected.push(candidate); areaCounts.set(candidate.planningAreaCandidateId ?? "", (areaCounts.get(candidate.planningAreaCandidateId ?? "") ?? 0) + 1);
  }
  const omitted = remaining.map((candidate) => ({ candidateId: candidate.id, reason: "因本轮输入预算未发送给 AI" }));
  const state = { ...base, candidates: selected.map(makeCandidate) };
  return { state, optionalOmitted: omitted, unresolved, candidateCounts: { mustGo: required.filter((item) => item.preference === "must_go").length, wantToGo: required.filter((item) => item.preference === "want_to_go").length, optionalIncluded: selected.filter((item) => item.preference === "optional").length, optionalOmitted: omitted.length, unresolved: unresolved.length }, expectedDayCount: dayCount };
}

function formalizeCompactGeneratedDays(trip: TripDetailV3, output: Extract<ItineraryGenerateOutput["result"], { type: "success" }>, resolutions: PlaceResolution[], context: GenerateStateContext, materialize = true) {
  if (output.days.length !== context.expectedDayCount || output.days.some((day, index) => day.dayNumber !== index + 1)) throw new Error("AI 返回的 Day 数量或 dayNumber 不连续。");
  const places = new Map(trip.plan.places.map((place) => [place.id, place])); const candidates = new Map(trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const resolved = new Set(currentResolvedPlaces(trip, resolutions).map((resolution) => resolution.placeId)); const anchorIds = new Set((context.state.anchorOptions as Array<{ placeId: string }>).map((item) => item.placeId));
  const scheduled = new Set<string>();
  const days: Day[] = output.days.map((source, index) => {
    for (const anchorId of [source.startAnchorPlaceId, source.endAnchorPlaceId]) if (anchorId !== null && (!anchorIds.has(anchorId) || !resolved.has(anchorId))) throw new Error("AI 返回了非法或未定位的 Anchor。");
    const stops: DayStop[] = source.stops.map((stop, stopIndex) => {
      const candidate = candidates.get(stop.candidateId); const place = candidate ? places.get(candidate.placeId) : null;
      if (!candidate || !place || candidate.preference === "excluded" || place.kind === "city" || !resolved.has(place.id) || scheduled.has(candidate.id)) throw new Error("AI 返回了重复、未知、排除、城市或未定位 Candidate。");
      scheduled.add(candidate.id);
      return { id: materialize ? randomUUID() : `draft-stop-${source.dayNumber}-${stopIndex}`, candidateId: candidate.id, placeId: place.id, activity: stop.activity, period: null, startTime: null, endTime: null, durationMinutes: candidate.suggestedDurationMinutes, transportFromPrevious: stop.transportModeFromPrevious ? { mode: stop.transportModeFromPrevious, durationMinutes: null, note: null, verification: { status: "estimated", checkedAt: null } } : null, scheduleVerification: null, costNote: null, costVerification: null, notes: null };
    });
    const date = trip.plan.trip.dates.start ? new Date(Date.parse(`${trip.plan.trip.dates.start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10) : null;
    return { id: materialize ? randomUUID() : `draft-day-${source.dayNumber}`, dayNumber: source.dayNumber, date, title: source.title, detailLevel: "planned", detailStatus: null, startAnchor: { id: materialize ? randomUUID() : `draft-start-${source.dayNumber}`, placeId: source.startAnchorPlaceId, label: null, notes: null }, stops, endAnchor: { id: materialize ? randomUUID() : `draft-end-${source.dayNumber}`, placeId: source.endAnchorPlaceId, label: null, notes: null } };
  });
  for (const candidate of trip.plan.candidates) { const place = places.get(candidate.placeId); if (candidate.preference === "must_go" && place?.kind !== "city" && !scheduled.has(candidate.id)) throw new Error(`必去地点未排入行程：${place?.nameZh ?? candidate.id}`); }
  return TravelPlanDocumentSchema.parse({ ...trip.plan, stage: "itinerary_planning", days }).days;
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

export class TravelPlannerRuntimeV3 {
  private readonly active = new Map<string, ActiveRun>();
  private readonly routeBatches = new Map<string, RouteBatch>();
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
    return {
      ...workspace,
      resolutions,
      routeStates,
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
    else {
      const batch = this.routeBatches.get(taskId);
      if (!batch || batch.tripId !== tripId) throw new Error("当前任务已经结束。");
      batch.controller.abort();
    }
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
          if (stored.actionType === "requirements.update" || stored.actionType === "requirements.clear") this.confirmClaimedAction(stored.id, baseGeneration);
          else this.emit("travel.action.changed", { tripId, actionId: stored.id });
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
    if (input.actionType === "destination.generate" && !hasTravelRequirements(trip.plan)) throw new Error("请先填写旅行需求，再生成目的地建议。");
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
      let generateContext: GenerateStateContext | null = null;
      let state: any;
      try {
        generateContext = action.actionType === "itinerary.generate" ? buildCompactGenerateState(this.options.store.requireTrip(action.tripId), this.options.store.listPlaceResolutions(action.tripId)) : null;
        state = generateContext?.state ?? this.buildActionState(action);
      } catch (error) {
        const code = aiErrorMessageV3(error);
        if (code === "GENERATE_REQUIRES_INTERESTS" || code === "GENERATE_REQUIRES_REQUIREMENTS") {
          this.options.store.completeAction(action.id, `requiresStage:${code === "GENERATE_REQUIRES_INTERESTS" ? "interests" : "requirements"}`);
          this.options.tasks.start({ id: taskId, tripId: action.tripId, agent: "action", label: action.actionType, summary: "行程生成前置条件未满足", metadata: { actionType: action.actionType, retryable: false, failureReasonCode: code } });
          this.options.tasks.update(taskId, "completed", code === "GENERATE_REQUIRES_INTERESTS" ? "需要先完成兴趣点定位" : "需要先完善旅行天数", "task:completed");
          return;
        }
        throw error;
      }
      const stateBytes = stringifySize(state);
      const generateDiagnostics = generateContext ? { stateBytes, promptBytes: Buffer.byteLength(this.options.prompts.compose("action.itinerary.generate").content, "utf8"), schemaBytes: stringifySize(buildOpenAiStructuredOutputSchema(ItineraryGenerateOutputSchema)), candidateCounts: generateContext.candidateCounts, expectedDayCount: generateContext.expectedDayCount } : {};
      this.options.tasks.start({ id: taskId, tripId: action.tripId, agent: "action", label: action.actionType, summary: `准备执行 ${action.actionType}`, metadata: { actionType: action.actionType, executor: "ai", reasoning: registration.reasoning, webPolicy: registration.web, inputBytes: stateBytes, ...generateDiagnostics } });

      let receivedOutputBytes: number | null = null;
      if (action.actionType === "interest.discover" || action.actionType === "interest.supplement") {
        this.options.tasks.update(taskId, "running", `正在执行 ${action.actionType}`, "action:running");
        await this.persistInterestDiscovery(action, taskId);
      } else {
        const run = await this.options.ai.startAction<ActionOutput>({ actionType: action.actionType, state, allowWeb: action.parameters.allowWeb !== false, validateResult: generateContext ? (value) => { const generated = value as ItineraryGenerateOutput; if (generated.result.type === "success") formalizeCompactGeneratedDays(this.options.store.requireTrip(action.tripId), generated.result, this.options.store.listPlaceResolutions(action.tripId), generateContext!, false); return value; } : undefined, onProgress: this.progress(taskId) });
        this.rememberActive(taskId, { tripId: action.tripId, actionId: action.id, interrupt: run.interrupt });
        this.options.tasks.update(taskId, "running", `正在执行 ${action.actionType}`, "action:running");
        const output = await run.result;
        receivedOutputBytes = stringifySize(output);
        if (Number(output?.baseGeneration) !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        if (this.options.store.requireTrip(action.tripId).contentGeneration !== action.baseGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        await this.persistAiActionOutput(action, output, taskId, generateContext ?? undefined);
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
    if (action.actionType.startsWith("itinerary.")) {
      return {
        ...base,
        tripFacts: trip.plan.trip,
        stage: trip.plan.stage,
        candidates: trip.plan.candidates.filter((candidate) => candidate.preference !== "excluded").map(candidateState),
        days: trip.plan.days,
        routeStates: this.options.routes.workspaceRouteState(action.tripId),
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
    const written = this.options.store.writePlan(action.tripId, applied.plan, action.baseGeneration, { source: `action:${action.actionType}`, summary: `执行 ${action.actionType}` }, { keepActionId: action.id });
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

  private async resolveChangedPlaces(tripId: string, placeIds: string[], expectedGeneration: number, taskId?: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("AI 任务已停止。");
    const current = this.options.store.requireTrip(tripId);
    if (current.contentGeneration !== expectedGeneration) return [];
    const existing = new Set(current.plan.places.map((place) => place.id));
    const ids = [...new Set(placeIds)].filter((placeId) => existing.has(placeId));
    if (!ids.length) return [];
    try {
      const result = await this.options.resolver.resolveMany(tripId, ids, expectedGeneration, signal, this.resolutionProgress(tripId, taskId));
      if (signal?.aborted) throw new Error("AI 任务已停止。");
      return result;
    } catch (error) {
      if (signal?.aborted) throw new Error("AI 任务已停止。");
      if (aiErrorMessageV3(error) === "CONTENT_GENERATION_SUPERSEDED") return [];
      return [];
    }
  }

  private async persistAiActionOutput(action: AiActionRecord, output: ActionOutput, taskId: string | null = null, generateContext?: GenerateStateContext) {
    if (action.actionType === "destination.generate") return this.persistDestinationGenerate(action, output as DestinationGenerateOutput, taskId);
    if (action.actionType === "destination.add" || action.actionType === "destination.replace" || action.actionType === "interest.add" || action.actionType === "interest.replace") return this.persistCandidateProposal(action, output as any);
    if (action.actionType === "itinerary.generate") return this.persistItineraryGenerate(action, output as ItineraryGenerateOutput, taskId, generateContext);
    if (action.actionType === "itinerary.replan") return this.persistItineraryReplacement(action, output as ItineraryReplanOutput);
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
    const resolutionPlaceIds = [...new Set<string>(normalized.candidates.map((candidate: any) => applied.idMappings[candidate.placeTemporaryId]).filter((value: unknown): value is string => typeof value === "string" && Boolean(value)))];
    const written = this.options.store.writePlan(action.tripId, applied.plan, action.baseGeneration, { source: "action:destination.generate", summary: "AI 生成目的地建议" }, { keepActionId: action.id });
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: [] });
    await this.resolveChangedPlaces(action.tripId, resolutionPlaceIds, written.generation, taskId ?? undefined);
    const resolved = currentResolvedPlaces(this.options.store.requireTrip(action.tripId), this.options.store.listPlaceResolutions(action.tripId)).filter((item) => resolutionPlaceIds.includes(item.placeId)).length;
    this.options.store.completeAction(action.id, `generation:${written.generation};resolved:${resolved}/${resolutionPlaceIds.length}`);
  }

  private async persistInterestDiscovery(action: AiActionRecord, taskId: string | null = null) {
    const original = this.options.store.requireTrip(action.tripId);
    const places = new Map(original.plan.places.map((place) => [place.id, place]));
    const targets = [...new Set(action.targetIds.length ? action.targetIds : original.plan.candidates.filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city").map((candidate) => candidate.id))];
    if (!targets.length) throw new Error("请先生成并保留至少一个目的地。");

    for (const targetId of targets) {
      const target = original.plan.candidates.find((candidate) => candidate.id === targetId);
      const targetPlace = target ? original.plan.places.find((place) => place.id === target.placeId) : null;
      if (!target || target.preference === "excluded" || targetPlace?.kind !== "city") throw new Error(`兴趣点研究目标不是有效 Macro Candidate：${targetId}`);
    }

    let expectedGeneration = action.baseGeneration;
    let nextIndex = 0;
    let completedAreas = 0;
    let aiSuggestedCount = 0;
    let actualAddedCount = 0;
    let mergedDuplicateCount = 0;
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
      const target = snapshot.plan.candidates.find((candidate) => candidate.id === targetId);
      const targetPlace = target ? snapshot.plan.places.find((place) => place.id === target.placeId) : null;
      if (!target || target.preference === "excluded" || targetPlace?.kind !== "city") throw new Error(`兴趣点研究目标不是有效 Macro Candidate：${targetId}`);
      const run = await this.options.ai.startAction<any>({
        actionType: action.actionType,
        state: {
          actionType: action.actionType,
          baseGeneration: action.baseGeneration,
          tripFacts: original.plan.trip,
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
          const applied = applyCandidateDiscovery(current.plan, normalized);
          actualAddedCount += applied.addedCandidateIds.length;
          mergedDuplicateCount += applied.mergedDuplicateCount;
          for (const candidate of normalized.candidates) {
            const placeId = applied.idMappings[candidate.placeTemporaryId];
            if (placeId) resolutionPlaceIds.add(placeId);
          }
          if (!same(applied.plan, current.plan)) {
            throwIfHalted();
            const written = this.options.store.writePlan(action.tripId, applied.plan, expectedGeneration, { source: `action:${action.actionType}`, summary: `AI 发现兴趣点 · ${targetPlace.nameZh}` }, { keepActionId: action.id });
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
      resolutionRequestedCount: resolutionPlaceIds.size,
      resolvedCount,
      unresolvedCount,
      peakConcurrency,
    };
    if (taskId) this.options.tasks.metadata(taskId, { ...(this.options.store.getAiTask(taskId)?.metadata ?? {}), interestDiscovery });
    const resultRef = `interest:v1;areas=${successfulAreaIds.length}/${targets.length};failed=${failedAreas.length};suggested=${aiSuggestedCount};added=${actualAddedCount};merged=${mergedDuplicateCount};resolved=${resolvedCount};pending=${unresolvedCount}`;
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

  private persistItineraryGenerate(action: AiActionRecord, output: ItineraryGenerateOutput, _taskId: string | null, context?: GenerateStateContext) {
    const result = output.result;
    if (result.type === "requires_stage") {
      this.options.store.completeAction(action.id, `requiresStage:${result.requiresStage}`);
      return;
    }
    const trip = this.options.store.requireTrip(action.tripId);
    if (trip.plan.days.length) throw new Error("首次生成行程只能在尚未存在 Day 时执行；已有行程请使用重新规划。");
    if (!context) throw new Error("行程生成缺少受控输入上下文。");
    const validationStarted = Date.now();
    const days = formalizeCompactGeneratedDays(trip, result, this.options.store.listPlaceResolutions(action.tripId), context);
    const plan = TravelPlanDocumentSchema.parse({ ...trip.plan, stage: "itinerary_planning", days });
    const written = this.options.store.writePlan(action.tripId, plan, action.baseGeneration, { source: "action:itinerary.generate", summary: "AI 生成按天行程" }, { keepActionId: action.id });
    const unscheduled = [
      ...result.unscheduledCandidates.map((item) => ({ candidateId: item.candidateId, reasonCode: "ai_unscheduled", reason: item.reason })),
      ...context.unresolved.map((item) => ({ candidateId: item.candidateId, reasonCode: "unresolved", reason: item.reason })),
      ...context.optionalOmitted.map((item) => ({ candidateId: item.candidateId, reasonCode: "input_budget_omitted", reason: item.reason })),
    ];
    this.options.store.completeAction(action.id, `generation:${written.generation};unscheduled:${unscheduled.length}`);
    if (_taskId) this.options.tasks.metadata(_taskId, { ...(this.options.store.getAiTask(_taskId)?.metadata ?? {}), unscheduledCandidates: unscheduled, timing: { validationMs: Date.now() - validationStarted } });
    this.emit("travel.document.changed", { tripId: action.tripId, generation: written.generation, changedDayIds: days.map((day) => day.id) });
    this.startRouteBatch(action.tripId, written.generation, days.map((day) => day.id));
  }

  private persistItineraryReplacement(action: AiActionRecord, output: ItineraryReplanOutput) {
    const result = output.result;
    if (result.type === "requires_stage") { this.options.store.completeAction(action.id, `requiresStage:${result.requiresStage}`); return; }
    const trip = this.options.store.requireTrip(action.tripId);
    if (result.days.length !== trip.plan.days.length) throw new Error("重新规划必须保持旅行 Day 数量不变。");
    validateItineraryReferences(trip, result.days, this.options.store.listPlaceResolutions(action.tripId));
    const commands = replacementCommands(trip.plan, result.days);
    if (!commands.length) { this.options.store.completeAction(action.id, "no-change"); return; }
    return this.createProposalForAction(action, result.title, result.explanation, commands, { type: "trip", id: null });
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
    if (linkedAction?.actionType === "itinerary.refine") {
      const affected = new Set(proposal.diff.affectedDayIds);
      plan = TravelPlanDocumentSchema.parse({ ...plan, days: plan.days.map((day) => affected.has(day.id) ? { ...day, detailLevel: "detailed", detailStatus: "ready" } : day) });
    }
    const result = this.options.store.applyProposalPlan(proposalId, plan, `应用 ${linkedAction?.actionType ?? "AI Proposal"}`);
    this.emit("travel.document.changed", { tripId, generation: result.generation, changedDayIds: applied.effects.changedDayIds });
    this.emit("travel.proposal.changed", { tripId, proposalId });
    if (linkedAction) this.emit("travel.action.changed", { tripId, actionId: linkedAction.id });
    await this.resolveChangedPlaces(tripId, applied.effects.changedPlaceIds, result.generation);
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
    const written = this.options.store.writePlan(tripId, applied.plan, expectedGeneration, { source: "command", summary: "编辑旅行计划" });
    this.emit("travel.document.changed", { tripId, generation: written.generation, changedDayIds: applied.effects.changedDayIds });
    void this.resolveChangedPlaces(tripId, applied.effects.changedPlaceIds, written.generation);
    return { ...applied, trip: written.trip, generation: written.generation, version: written.version };
  }

  async retryResolutions(tripId: string, placeIds: string[], expectedGeneration: number) {
    return this.options.resolver.resolveMany(tripId, placeIds, expectedGeneration, undefined, this.resolutionProgress(tripId));
  }
  searchResolutionCandidates(tripId: string, placeId: string, expectedGeneration: number) { return this.options.resolver.searchCandidates(tripId, placeId, expectedGeneration); }
  selectResolution(tripId: string, placeId: string, input: unknown) { return (this.options.resolver as any).selectCandidate(tripId, placeId, input); }
  setDirectResolution(tripId: string, placeId: string, input: unknown) { return (this.options.resolver as any).setDirect(tripId, placeId, input); }
  async recalculateRoute(tripId: string, dayId: string, expectedGeneration: number) {
    const route = await this.options.routes.recalculate(tripId, dayId, expectedGeneration);
    this.emit("travel.route.changed", { tripId, dayId }); return route;
  }
  async recalculateDirtyRoutes(tripId: string, input: any) {
    const expectedGeneration = Number(input.expectedGeneration); const states = this.options.routes.workspaceRouteState(tripId); const ids = states.filter((state) => state.dirty).map((state) => state.dayId);
    const routes = await Promise.all(ids.map((dayId) => this.recalculateRoute(tripId, dayId, expectedGeneration)));
    return { routes };
  }
  private startRouteBatch(tripId: string, expectedGeneration: number, dayIds: string[]) {
    const taskId = `route:${randomUUID()}`; const controller = new AbortController();
    this.routeBatches.set(taskId, { tripId, expectedGeneration, controller });
    this.options.tasks.start({ id: taskId, tripId, agent: "map", label: "计算每日路线", summary: `正在计算每日路线 0/${dayIds.length}`, canStop: true, metadata: { totalDays: dayIds.length, completedDays: 0, readyDays: 0, attentionDays: 0, peakDayConcurrency: ROUTE_DAY_BATCH_CONCURRENCY } });
    void (async () => {
      let completed = 0; let ready = 0; let attention = 0;
      const calculate = async (dayId: string) => {
        try {
          const route = await this.options.routes.recalculate(tripId, dayId, expectedGeneration, controller.signal);
          completed += 1; if (route.status === "ready") ready += 1; else attention += 1;
          this.emit("travel.route.changed", { tripId, dayId });
          const summary = `正在计算每日路线 ${completed}/${dayIds.length} · ready ${ready} · attention ${attention}`;
          this.options.tasks.metadata(taskId, { totalDays: dayIds.length, completedDays: completed, readyDays: ready, attentionDays: attention, peakDayConcurrency: ROUTE_DAY_BATCH_CONCURRENCY });
          this.options.tasks.update(taskId, "running", summary, "route:day-completed");
        } catch (error) {
          const message = aiErrorMessageV3(error);
          if (message === "CONTENT_GENERATION_SUPERSEDED") throw error;
          if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
          completed += 1; attention += 1;
          this.options.tasks.update(taskId, "running", `正在计算每日路线 ${completed}/${dayIds.length} · ready ${ready} · attention ${attention}`, "route:day-failed");
        }
      };
      try {
        await Promise.all(dayIds.map(calculate));
        const status = controller.signal.aborted ? "stopped" : "completed";
        this.options.tasks.update(taskId, status, controller.signal.aborted ? "每日路线计算已停止" : `每日路线计算完成 · ready ${ready} · attention ${attention}`, "task:completed");
      } catch (error) {
        const superseded = aiErrorMessageV3(error) === "CONTENT_GENERATION_SUPERSEDED";
        controller.abort();
        this.options.tasks.update(taskId, superseded ? "cancelled_by_generation" : "failed", superseded ? "计划已变化，停止旧路线计算" : "每日路线计算失败", "task:failed");
      } finally { this.routeBatches.delete(taskId); }
    })();
    return taskId;
  }
}
