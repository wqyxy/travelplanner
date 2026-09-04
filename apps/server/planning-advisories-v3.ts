import type { PlaceResolution, TravelPlanDocument } from "./contracts-v2.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";

export type PlanningAdvisorySeverityV3 = "info" | "warning";
export type PlanningAdvisoryObjectTypeV3 = "trip" | "place" | "candidate" | "day" | "stop";
export type PlanningAdvisoryCapabilityV3 = "map" | "route" | "schedule" | "coverage" | "planning_area" | "date_alignment";
export type PlanningAdvisoryV3 = {
  id: string;
  code: string;
  severity: PlanningAdvisorySeverityV3;
  workflowStep: "requirements" | "backbone" | "skeleton" | "interests" | "detail";
  message: string;
  objectRefs: Array<{ type: PlanningAdvisoryObjectTypeV3; id: string }>;
  affectedCapabilities: PlanningAdvisoryCapabilityV3[];
};

function advisory(
  code: string,
  severity: PlanningAdvisorySeverityV3,
  workflowStep: PlanningAdvisoryV3["workflowStep"],
  message: string,
  objectRefs: PlanningAdvisoryV3["objectRefs"],
  affectedCapabilities: PlanningAdvisoryCapabilityV3[],
): PlanningAdvisoryV3 {
  const suffix = objectRefs.map((ref) => `${ref.type}:${ref.id}`).sort().join("|") || "trip";
  return { id: `${code}:${suffix}`, code, severity, workflowStep, message, objectRefs, affectedCapabilities };
}

function minutes(value: string) { return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)); }
function dateRangeDays(start: string, end: string) {
  const left = Date.parse(`${start}T00:00:00Z`);
  const right = Date.parse(`${end}T00:00:00Z`);
  return Math.floor((right - left) / 86_400_000) + 1;
}
function normalizedNames(place: { nameZh: string; nameLocal: string | null; nameEn: string | null }) {
  return [place.nameZh, place.nameLocal, place.nameEn]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ""))
    .filter(Boolean);
}

export function derivePlanningAdvisoriesV3(
  plan: TravelPlanDocument,
  resolutions: PlaceResolution[] = [],
): PlanningAdvisoryV3[] {
  const result: PlanningAdvisoryV3[] = [];
  const places = new Map(plan.places.map((place) => [place.id, place]));
  const candidates = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const scheduledCandidateIds = new Set<string>();
  const resolvedPlaceIds = new Set(resolutions.filter((item) => item.status === "resolved").map((item) => item.placeId));

  const { start, end, requestedDurationDays } = plan.trip.dates;
  if (start && end && start > end) {
    result.push(advisory("TRIP_DATE_RANGE_REVERSED", "warning", "requirements", "结束日期早于开始日期，内容已保留，请确认是否填写有误。", [{ type: "trip", id: "trip" }], ["date_alignment"]));
  }
  if (start && end && start <= end) {
    const rangeDays = dateRangeDays(start, end);
    if (requestedDurationDays !== null && requestedDurationDays !== rangeDays) {
      result.push(advisory("TRIP_DURATION_MISMATCH", "warning", "requirements", `日期范围为 ${rangeDays} 天，但当前还记录了 ${requestedDurationDays} 天的计划时长；两者都已保留。`, [{ type: "trip", id: "trip" }], ["date_alignment"]));
    }
    if (plan.days.length < rangeDays) result.push(advisory("DAY_COUNT_SHORT", "warning", "skeleton", `当前安排 ${plan.days.length} 天，比旅行日期少 ${rangeDays - plan.days.length} 天，已保留全部内容。`, [{ type: "trip", id: "trip" }], ["date_alignment", "coverage"]));
    if (plan.days.length > rangeDays) result.push(advisory("DAY_COUNT_OVER", "warning", "skeleton", `当前安排 ${plan.days.length} 天，比旅行日期多 ${plan.days.length - rangeDays} 天，已保留全部内容。`, [{ type: "trip", id: "trip" }], ["date_alignment"]));
  }

  const dateOwners = new Map<string, string[]>();
  for (const day of plan.days) {
    if (day.date) dateOwners.set(day.date, [...(dateOwners.get(day.date) ?? []), day.id]);
  }
  for (const [date, dayIds] of dateOwners) {
    if (dayIds.length > 1) result.push(advisory("DAY_DATE_DUPLICATE", "warning", "skeleton", `${date} 被多个 Day 使用，内容已保留。`, dayIds.map((id) => ({ type: "day" as const, id })), ["date_alignment"]));
  }

  const aliases = new Map<string, string[]>();
  for (const place of plan.places) {
    for (const key of normalizedNames(place)) aliases.set(key, [...(aliases.get(key) ?? []), place.id]);
  }
  const duplicateGroups = new Set<string>();
  for (const ids of aliases.values()) {
    const unique = [...new Set(ids)].sort();
    if (unique.length < 2) continue;
    const key = unique.join("|");
    if (duplicateGroups.has(key)) continue;
    duplicateGroups.add(key);
    result.push(advisory("POSSIBLE_DUPLICATE_PLACE", "info", "backbone", "这些地点名称可能重复；系统已全部保留，你可以稍后决定是否合并。", unique.map((id) => ({ type: "place" as const, id })), ["planning_area"]));
  }

  for (const candidate of plan.candidates) {
    const place = places.get(candidate.placeId);
    if (!place) continue;
    const role = effectivePlanningRole(candidate, place);
    if (!candidate.planningAreaCandidateId && role !== "planning_area") {
      result.push(advisory("UNASSIGNED_CANDIDATE", "info", role === "detail_interest" ? "interests" : "backbone", `${place.nameZh} 尚未归入规划区域，内容已保留。`, [{ type: "candidate", id: candidate.id }], ["planning_area"]));
    }
    if (candidate.planningAreaCandidateId) {
      const parent = candidates.get(candidate.planningAreaCandidateId);
      const parentPlace = parent ? places.get(parent.placeId) : null;
      if (parent && parentPlace && effectivePlanningRole(parent, parentPlace) !== "planning_area") {
        result.push(advisory("ATYPICAL_PARENT_RELATION", "info", "backbone", `${place.nameZh} 的父级不是 planning_area；关系已保留。`, [{ type: "candidate", id: candidate.id }, { type: "candidate", id: parent.id }], ["planning_area"]));
      }
    }
    const atypical = (role === "planning_area" && place.kind !== "city") || (role !== "planning_area" && place.kind === "city");
    if (atypical) result.push(advisory("ATYPICAL_PLANNING_ROLE_KIND", "info", "backbone", `${place.nameZh} 的 planningRole 与地点类型采用了非传统组合；系统按你的规划角色保留。`, [{ type: "candidate", id: candidate.id }, { type: "place", id: place.id }], ["planning_area"]));
    if (!resolvedPlaceIds.has(place.id)) result.push(advisory("PLACE_UNRESOLVED", "info", role === "detail_interest" ? "interests" : "backbone", `${place.nameZh} 尚未定位，不影响规划，但暂时无法计算相关地图路线。`, [{ type: "place", id: place.id }, { type: "candidate", id: candidate.id }], ["map", "route"]));
  }

  for (const day of plan.days) {
    const intervals: Array<{ start: number; end: number; stopId: string }> = [];
    for (const stop of day.stops) {
      if (stop.candidateId) scheduledCandidateIds.add(stop.candidateId);
      const candidate = stop.candidateId ? candidates.get(stop.candidateId) : null;
      if (candidate?.preference === "excluded") result.push(advisory("EXCLUDED_CANDIDATE_SCHEDULED", "warning", "detail", "这个地点标记为“不考虑”，但当前仍在每日行程中；内容已保留。", [{ type: "day", id: day.id }, { type: "stop", id: stop.id }, { type: "candidate", id: candidate.id }], ["schedule"]));
      if (!resolvedPlaceIds.has(stop.placeId)) result.push(advisory("PLACE_UNRESOLVED", "info", "detail", "这个行程地点尚未定位，不影响安排，但暂时无法计算相关路线。", [{ type: "day", id: day.id }, { type: "stop", id: stop.id }, { type: "place", id: stop.placeId }], ["map", "route"]));
      if ((stop.startTime === null) !== (stop.endTime === null)) result.push(advisory("STOP_PARTIAL_TIME", "info", "detail", "这个活动只填写了开始或结束时间；内容已保留。", [{ type: "day", id: day.id }, { type: "stop", id: stop.id }], ["schedule"]));
      if (stop.startTime && stop.endTime) {
        const startMinutes = minutes(stop.startTime);
        const endMinutes = minutes(stop.endTime);
        if (endMinutes <= startMinutes) result.push(advisory("STOP_POSSIBLE_OVERNIGHT", "info", "detail", "结束时间早于或等于开始时间，可能是跨夜安排，也可能需要检查时间。", [{ type: "day", id: day.id }, { type: "stop", id: stop.id }], ["schedule"]));
        else {
          intervals.push({ start: startMinutes, end: endMinutes, stopId: stop.id });
          if (stop.durationMinutes !== null && stop.durationMinutes !== endMinutes - startMinutes) result.push(advisory("STOP_DURATION_MISMATCH", "info", "detail", "活动时长与开始/结束时间不一致；三个值都已保留。", [{ type: "day", id: day.id }, { type: "stop", id: stop.id }], ["schedule"]));
        }
      }
    }
    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 1; index < intervals.length; index += 1) {
      const previous = intervals[index - 1];
      const current = intervals[index];
      if (current.start < previous.end) result.push(advisory("STOP_TIME_OVERLAP", "warning", "detail", "同一天的两个活动时间发生重叠；内容已保留。", [{ type: "day", id: day.id }, { type: "stop", id: previous.stopId }, { type: "stop", id: current.stopId }], ["schedule"]));
    }
  }

  for (const candidate of plan.candidates) {
    if (candidate.preference !== "must_go" || scheduledCandidateIds.has(candidate.id)) continue;
    const place = places.get(candidate.placeId);
    result.push(advisory("MUST_GO_NOT_SCHEDULED", "warning", "detail", `${place?.nameZh ?? candidate.id} 标记为“必去”，但尚未安排进每日行程。`, [{ type: "candidate", id: candidate.id }], ["coverage"]));
  }

  return [...new Map(result.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
}
