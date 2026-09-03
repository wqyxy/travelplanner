import type { AiActionType } from "./ai-stage-contracts-v3.js";
import { deriveExplicitReplanStayConstraintsV3 } from "./replan-intent-v3.js";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sameStringSet(left: string[], right: string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length
    && rightSet.size === right.length
    && leftSet.size === rightSet.size
    && [...leftSet].every((item) => rightSet.has(item));
}

function placeIdFromAnchor(value: unknown) {
  const anchor = asRecord(value);
  return typeof anchor?.placeId === "string" ? anchor.placeId : null;
}

function validateReplanOutputAgainstStateV3<T>(state: RecordValue, output: RecordValue, outputValue: T): T {
  if (typeof state.baseGeneration === "number" && output.baseGeneration !== state.baseGeneration) {
    throw new Error(`路线和天数输出 baseGeneration 必须保持为 ${state.baseGeneration}。`);
  }
  const result = asRecord(output.result);
  if (!result || result.type !== "success") return outputValue;

  const constraints = deriveExplicitReplanStayConstraintsV3(state);
  if (!constraints.length) return outputValue;

  const totals = new Map<string, number>();
  const stays = Array.isArray(result.stays) ? result.stays.map(asRecord).filter((item): item is RecordValue => Boolean(item)) : [];
  for (const stay of stays) {
    if (typeof stay.planningAreaCandidateId !== "string" || typeof stay.stayDays !== "number") continue;
    totals.set(stay.planningAreaCandidateId, (totals.get(stay.planningAreaCandidateId) ?? 0) + stay.stayDays);
  }
  const omitted = new Set(
    Array.isArray(result.omittedPlanningAreas)
      ? result.omittedPlanningAreas.map(asRecord).flatMap((item) => typeof item?.candidateId === "string" ? [item.candidateId] : [])
      : [],
  );

  for (const constraint of constraints) {
    const actualDays = totals.get(constraint.candidateId) ?? 0;
    if (actualDays !== constraint.expectedDays) {
      const direction = constraint.kind === "delta" && constraint.deltaDays !== null
        ? `${constraint.deltaDays >= 0 ? "+" : ""}${constraint.deltaDays} 天`
        : `改为 ${constraint.expectedDays} 天`;
      throw new Error(`用户已明确要求${constraint.placeName}${direction}；按当前基线应为 ${constraint.expectedDays} 天，但输出为 ${actualDays} 天。请严格执行本轮明确的停留天数调整。`);
    }
    if (constraint.expectedDays > 0 && omitted.has(constraint.candidateId)) {
      throw new Error(`用户已明确要求安排${constraint.placeName} ${constraint.expectedDays} 天，不得把它放入 omittedPlanningAreas。`);
    }
  }
  return outputValue;
}

export function validateAiActionOutputAgainstStateV3<T>(actionType: AiActionType, stateValue: unknown, outputValue: T): T {
  const state = asRecord(stateValue);
  const output = asRecord(outputValue);
  if (!state || !output) return outputValue;

  if (actionType === "itinerary.replan") return validateReplanOutputAgainstStateV3(state, output, outputValue);
  if (actionType !== "itinerary.detail.generate" && actionType !== "itinerary.detail.update") return outputValue;

  if (typeof state.baseGeneration === "number" && output.baseGeneration !== state.baseGeneration) {
    throw new Error(`详细行程输出 baseGeneration 必须保持为 ${state.baseGeneration}。`);
  }

  const result = asRecord(output.result);
  if (!result || result.type !== "success") return outputValue;

  const targetDayIds = stringArray(state.targetDayIds);
  const dayUpdates = Array.isArray(result.dayUpdates) ? result.dayUpdates.map(asRecord).filter((item): item is RecordValue => Boolean(item)) : [];
  const returnedDayIds = dayUpdates.map((item) => typeof item.dayId === "string" ? item.dayId : "").filter(Boolean);
  if (!sameStringSet(targetDayIds, returnedDayIds)) {
    throw new Error("详细行程必须恰好返回本轮 targetDayIds，不得遗漏或引用 scope 外 Day。");
  }

  if (actionType === "itinerary.detail.update") {
    const affectedDayIds = stringArray(result.affectedDayIds);
    if (!sameStringSet(targetDayIds, affectedDayIds)) {
      throw new Error("增量详细行程的 affectedDayIds 必须恰好等于本轮 targetDayIds。");
    }
  }

  const candidates = Array.isArray(state.candidates) ? state.candidates.map(asRecord).filter((item): item is RecordValue => Boolean(item)) : [];
  const candidateById = new Map(candidates.flatMap((candidate) => typeof candidate.id === "string" ? [[candidate.id, candidate] as const] : []));
  const unavailable = new Set(stringArray(state.unavailableCandidateIds));

  const planningAreas = Array.isArray(state.planningAreas) ? state.planningAreas.map(asRecord).filter((item): item is RecordValue => Boolean(item)) : [];
  const planningAreaIdByPlaceId = new Map<string, string>();
  for (const area of planningAreas) {
    const place = asRecord(area.place);
    if (typeof area.id === "string" && typeof place?.id === "string") planningAreaIdByPlaceId.set(place.id, area.id);
  }

  const days = Array.isArray(state.days) ? state.days.map(asRecord).filter((item): item is RecordValue => Boolean(item)) : [];
  const dayById = new Map(days.flatMap((day) => typeof day.id === "string" ? [[day.id, day] as const] : []));
  const scheduledCandidateIds = new Set<string>();
  const ownerAreaIds = new Set<string>();

  for (const dayId of targetDayIds) {
    const day = dayById.get(dayId);
    if (!day) throw new Error(`详细行程输入缺少 target Day：${dayId}`);
    const ownerPlaceId = placeIdFromAnchor(day.endAnchor);
    const ownerAreaId = ownerPlaceId ? planningAreaIdByPlaceId.get(ownerPlaceId) : null;
    if (ownerAreaId) ownerAreaIds.add(ownerAreaId);
  }

  for (const update of dayUpdates) {
    const dayId = String(update.dayId ?? "");
    const day = dayById.get(dayId);
    if (!day) throw new Error(`详细行程引用 scope 外 Day：${dayId}`);
    const allowedAreaIds = new Set<string>();
    for (const placeId of [placeIdFromAnchor(day.startAnchor), placeIdFromAnchor(day.endAnchor)]) {
      const areaId = placeId ? planningAreaIdByPlaceId.get(placeId) : null;
      if (areaId) allowedAreaIds.add(areaId);
    }

    const stops = Array.isArray(update.stops) ? update.stops.map(asRecord).filter((item): item is RecordValue => Boolean(item)) : [];
    for (const stop of stops) {
      const candidateId = typeof stop.candidateId === "string" ? stop.candidateId : "";
      const candidate = candidateById.get(candidateId);
      if (!candidate) {
        throw new Error(`详细行程 Stop 引用了不在本轮 Candidate 白名单中的 ID：${candidateId}。只能引用输入 candidates 中提供的 candidateId。`);
      }
      if (candidate.resolved !== true || unavailable.has(candidateId)) {
        throw new Error(`详细行程 Stop 引用了尚未定位的 Candidate：${candidateId}。请改用 resolved=true 的 Candidate。`);
      }
      const planningAreaCandidateId = typeof candidate.planningAreaCandidateId === "string" ? candidate.planningAreaCandidateId : null;
      if (!planningAreaCandidateId || !allowedAreaIds.has(planningAreaCandidateId)) {
        throw new Error(`Candidate ${candidateId} 不属于 Day ${dayId} 的起点或终点停留区域，请改用该 Day 可用区域内的 Candidate。`);
      }
      scheduledCandidateIds.add(candidateId);
    }
  }

  const unscheduled = Array.isArray(result.unscheduledCandidates)
    ? result.unscheduledCandidates.map(asRecord).filter((item): item is RecordValue => Boolean(item))
    : [];
  const unscheduledIds = new Set<string>();
  for (const item of unscheduled) {
    const candidateId = typeof item.candidateId === "string" ? item.candidateId : "";
    const candidate = candidateById.get(candidateId);
    if (!candidate) throw new Error(`未安排说明引用了不在本轮 Candidate 白名单中的 ID：${candidateId}。`);
    if (candidate.preference === "must_go") throw new Error(`必去 Candidate ${candidateId} 不得进入 unscheduledCandidates。`);
    const parentId = typeof candidate.planningAreaCandidateId === "string" ? candidate.planningAreaCandidateId : null;
    if (!parentId || !ownerAreaIds.has(parentId)) throw new Error(`未安排说明超出本轮 Detailed scope：${candidateId}。`);
    if (scheduledCandidateIds.has(candidateId)) throw new Error(`Candidate ${candidateId} 不能同时已安排和未安排。`);
    unscheduledIds.add(candidateId);
  }

  for (const candidateId of stringArray(state.requiredMustGoCandidateIds)) {
    if (!scheduledCandidateIds.has(candidateId)) throw new Error(`必去 Candidate ${candidateId} 必须排入本轮每日行程。`);
  }
  for (const candidateId of stringArray(state.priorityCoreCandidateIds)) {
    if (!scheduledCandidateIds.has(candidateId) && !unscheduledIds.has(candidateId)) {
      throw new Error(`重要游览地 Candidate ${candidateId} 未安排时必须放入 unscheduledCandidates 并说明原因。`);
    }
  }

  return outputValue;
}
