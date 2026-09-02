import type { WorkspaceSelection } from "./v2-types";
import type { AiActionType, ConversationStage, WorkflowStepV3, WorkspaceV3 } from "./v3-types";
import { conversationStageForWorkflowStepV3 } from "./v3-types";
import { candidateRows, effectiveCandidatePlanningRole } from "./workspace-v2";

export const WORKFLOW_STEPS_V3: ReadonlyArray<{ step: WorkflowStepV3; number: number; label: string; shortLabel: string; optional?: boolean }> = [
  { step: "requirements", number: 1, label: "旅行需求", shortLabel: "旅行需求" },
  { step: "backbone", number: 2, label: "想去哪些地方", shortLabel: "想去哪些地方" },
  { step: "skeleton", number: 3, label: "路线和天数", shortLabel: "路线和天数" },
  { step: "interests", number: 4, label: "补充景点", shortLabel: "补充景点", optional: true },
  { step: "detail", number: 5, label: "每日行程", shortLabel: "每日行程" },
];

export function stageForWorkflowStepV3(step: WorkflowStepV3): ConversationStage {
  return conversationStageForWorkflowStepV3(step);
}

export function defaultWorkflowStepV3(workspace: WorkspaceV3): WorkflowStepV3 {
  if (workspace.trip.plan.days.some((day) => day.detailLevel === "detailed")) return "detail";
  if (workspace.trip.plan.days.length) {
    if (workspace.itineraryUpdateState.macro.status === "needs_update") return "skeleton";
    return "interests";
  }
  if (workspace.trip.plan.candidates.length) return "backbone";
  return "requirements";
}

export function selectionForWorkflowStepV3(step: WorkflowStepV3): WorkspaceSelection {
  return step === "backbone" || step === "interests"
    ? { type: "candidate_pool", id: null }
    : { type: "trip", id: null };
}

export function actionBelongsToWorkflowStepV3(actionType: AiActionType, step: WorkflowStepV3) {
  if (step === "requirements") return actionType.startsWith("requirements.");
  if (step === "backbone") return actionType.startsWith("destination.");
  if (step === "skeleton") return actionType === "itinerary.generate" || actionType === "itinerary.replan";
  if (step === "interests") return actionType.startsWith("interest.");
  return actionType.startsWith("itinerary.") && actionType !== "itinerary.generate" && actionType !== "itinerary.replan";
}

export function requiredWorkflowStepFromResultRefV3(resultRef: string | null | undefined): WorkflowStepV3 | null {
  const prefix = "requiresWorkflowStep:";
  if (!resultRef?.startsWith(prefix)) return null;
  const value = resultRef.slice(prefix.length);
  return value === "requirements" || value === "backbone" || value === "skeleton" || value === "interests" ? value : null;
}

export function latestRequiredWorkflowStepV3(workspace: WorkspaceV3): { step: WorkflowStepV3; actionId: string } | null {
  const candidates = workspace.actions
    .filter((action) => action.status === "completed" && action.baseGeneration === workspace.trip.contentGeneration)
    .map((action) => ({ action, step: requiredWorkflowStepFromResultRefV3(action.resultRef) }))
    .filter((item): item is { action: typeof workspace.actions[number]; step: WorkflowStepV3 } => Boolean(item.step))
    .sort((left, right) => right.action.updatedAt.localeCompare(left.action.updatedAt));
  const latest = candidates[0];
  return latest ? { step: latest.step, actionId: latest.action.id } : null;
}

export function detailResolutionSummaryV3(workspace: WorkspaceV3) {
  const rows = candidateRows(workspace as any);
  const planningAreas = rows.filter((row) => effectiveCandidatePlanningRole(row) === "planning_area");
  const areaByPlaceId = new Map(planningAreas.map((row) => [row.place.id, row]));
  const resolved = new Set(workspace.resolutions.filter((item) => item.status === "resolved").map((item) => item.placeId));
  const affected = workspace.itineraryUpdateState.detail.affectedDayIds;
  const targetDays = affected.length ? workspace.trip.plan.days.filter((day) => affected.includes(day.id)) : workspace.trip.plan.days;
  const ownerAreaIds = new Set<string>();
  const blocking: Array<{ key: string; message: string; step: WorkflowStepV3 }> = [];
  const nonBlocking = new Set<string>();

  for (const day of targetDays) {
    for (const placeId of [day.startAnchor.placeId, day.endAnchor.placeId]) {
      if (!placeId) continue;
      const area = areaByPlaceId.get(placeId);
      if (area) ownerAreaIds.add(area.candidate.id);
      if (!resolved.has(placeId)) blocking.push({ key: `anchor:${placeId}`, message: `${area?.place.nameZh || "当天起止地点"}尚未定位`, step: "backbone" });
    }
  }

  for (const row of rows) {
    const role = effectiveCandidatePlanningRole(row);
    if (role === "planning_area" || row.candidate.preference === "excluded" || !row.candidate.planningAreaCandidateId || !ownerAreaIds.has(row.candidate.planningAreaCandidateId)) continue;
    if (resolved.has(row.place.id)) continue;
    if (row.candidate.preference === "must_go") blocking.push({ key: `candidate:${row.candidate.id}`, message: `必去的${row.place.nameZh}尚未定位`, step: role === "core_visit" ? "backbone" : "interests" });
    else nonBlocking.add(row.place.nameZh);
  }

  const uniqueBlocking = [...new Map(blocking.map((item) => [item.key, item])).values()];
  return { blocking: uniqueBlocking, blockingCount: uniqueBlocking.length, nonBlockingNames: [...nonBlocking] };
}
