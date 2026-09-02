import type { CandidatePreference, TransportMode, TravelPlanDocument, Workspace } from "./v2-types";
import { candidateRows, effectiveCandidatePlanningRole } from "./workspace-v2";

export type SkeletonStayDraftV3 = {
  planningAreaCandidateId: string;
  stayDays: number;
  transferModeFromPrevious: TransportMode;
};
export type OmittedPlanningAreaDraftV3 = { candidateId: string; reason: string };
export type SkeletonEditDraftV3 = { stays: SkeletonStayDraftV3[]; omittedPlanningAreas: OmittedPlanningAreaDraftV3[] };
export type SkeletonStayBlockUiV3 = SkeletonStayDraftV3 & {
  key: string;
  dayIds: string[];
  firstDayNumber: number;
  lastDayNumber: number;
  placeId: string;
  placeName: string;
  preference: CandidatePreference;
  resolved: boolean;
};

function expectedDays(plan: TravelPlanDocument) {
  if (plan.trip.dates.start && plan.trip.dates.end) {
    return Math.floor((Date.parse(`${plan.trip.dates.end}T00:00:00Z`) - Date.parse(`${plan.trip.dates.start}T00:00:00Z`)) / 86_400_000) + 1;
  }
  return plan.trip.dates.requestedDurationDays;
}

export function skeletonDayBalanceV3(plan: TravelPlanDocument, draft: SkeletonEditDraftV3) {
  const totalDays = expectedDays(plan);
  const allocatedDays = draft.stays.reduce((sum, stay) => sum + stay.stayDays, 0);
  const remainingDays = totalDays === null ? null : totalDays - allocatedDays;
  return {
    totalDays,
    allocatedDays,
    remainingDays,
    canSave: totalDays !== null && remainingDays === 0 && draft.stays.length > 0,
    message: totalDays === null
      ? "请先在旅行需求中确认总天数"
      : remainingDays === 0
        ? "已分配完整"
        : remainingDays > 0
          ? `还剩 ${remainingDays} 天需要安排`
          : `还需要减少 ${Math.abs(remainingDays)} 天`,
  };
}

export function skeletonUiModelV3(workspace: Workspace) {
  const plan = workspace.trip.plan;
  const rows = candidateRows(workspace);
  const planningAreas = rows.filter((row) => effectiveCandidatePlanningRole(row) === "planning_area" && row.candidate.preference !== "excluded");
  const areaByPlaceId = new Map(planningAreas.map((row) => [row.place.id, row]));
  const resolutionByPlace = new Map(workspace.resolutions.map((resolution) => [resolution.placeId, resolution]));
  const occurrences = new Map<string, number>();
  const blocks: SkeletonStayBlockUiV3[] = [];

  for (const day of [...plan.days].sort((left, right) => left.dayNumber - right.dayNumber)) {
    const area = day.endAnchor.placeId ? areaByPlaceId.get(day.endAnchor.placeId) : null;
    if (!area) continue;
    const previous = blocks.at(-1);
    const explicitBlockId = day.stayBlockId ?? null;
    const joinsPrevious = Boolean(previous
      && previous.planningAreaCandidateId === area.candidate.id
      && ((explicitBlockId && previous.key === `block:${explicitBlockId}`) || (!explicitBlockId && previous.key.startsWith(`legacy:${area.candidate.id}:`))));
    if (joinsPrevious && previous) {
      previous.dayIds.push(day.id);
      previous.lastDayNumber = day.dayNumber;
      previous.stayDays += 1;
      continue;
    }
    const occurrence = occurrences.get(area.candidate.id) ?? 0;
    occurrences.set(area.candidate.id, occurrence + 1);
    const key = explicitBlockId ? `block:${explicitBlockId}` : `legacy:${area.candidate.id}:${occurrence}`;
    blocks.push({
      key,
      planningAreaCandidateId: area.candidate.id,
      stayDays: 1,
      transferModeFromPrevious: ((day as typeof day & { transferMode?: TransportMode }).transferMode ?? "none"),
      dayIds: [day.id],
      firstDayNumber: day.dayNumber,
      lastDayNumber: day.dayNumber,
      placeId: area.place.id,
      placeName: area.place.nameZh,
      preference: area.candidate.preference,
      resolved: resolutionByPlace.get(area.place.id)?.status === "resolved",
    });
  }

  const represented = new Set(blocks.map((block) => block.planningAreaCandidateId));
  const omitted = planningAreas
    .filter((row) => !represented.has(row.candidate.id))
    .map((row) => ({
      candidateId: row.candidate.id,
      placeName: row.place.nameZh,
      preference: row.candidate.preference,
      reason: row.candidate.preference === "want_to_go"
        ? "当前路线没有采用这个“想去”的地方；如要加入，需要重新分配天数或顺序。"
        : "当前路线未采用这个候选；按现有天数可以不安排。",
    }));

  const draft: SkeletonEditDraftV3 = {
    stays: blocks.map(({ planningAreaCandidateId, stayDays, transferModeFromPrevious }) => ({ planningAreaCandidateId, stayDays, transferModeFromPrevious })),
    omittedPlanningAreas: omitted.map(({ candidateId, reason }) => ({ candidateId, reason })),
  };

  return { blocks, omitted, draft, balance: skeletonDayBalanceV3(plan, draft) };
}
