import { randomUUID } from "node:crypto";
import type { AiActionRecord } from "./ai-stage-contracts-v3.js";
import {
  CandidatePreferenceSchema,
  PlanCommandSchema,
  type DayStop,
  type PlanCommand,
} from "./contracts-v2.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";
import type { TripDetailV3 } from "./travel-store-v3.js";

export function deterministicCommands(action: AiActionRecord, trip: TripDetailV3): PlanCommand[] {
  const p = action.parameters as Record<string, any>;
  const places = new Map(trip.plan.places.map((place) => [place.id, place]));
  const candidate = (id: string) => {
    const value = trip.plan.candidates.find((item) => item.id === id);
    if (!value) throw new Error(`未知 Candidate：${id}`);
    return value;
  };
  const role = (item: TripDetailV3["plan"]["candidates"][number]) => {
    const place = places.get(item.placeId);
    if (!place) throw new Error(`Candidate 引用未知 Place：${item.id}`);
    return effectivePlanningRole(item, place);
  };
  const targetCandidateId = String(p.candidateId ?? action.targetIds[0] ?? "");

  if (action.actionType === "destination.remove") {
    const item = candidate(targetCandidateId);
    const planningRole = role(item);
    if (planningRole === "detail_interest") throw new Error("Step 2 只能删除停留区域或重要游览地。");
    return [{
      type: planningRole === "planning_area" ? "remove_candidate_tree" : "remove_candidate",
      candidateId: item.id,
    }];
  }

  if (action.actionType === "interest.remove") {
    const item = candidate(targetCandidateId);
    if (role(item) !== "detail_interest") throw new Error("兴趣点步骤只能删除普通兴趣点。");
    return [{ type: "remove_candidate", candidateId: item.id }];
  }

  if (action.actionType === "destination.preference" || action.actionType === "interest.preference") {
    const ids = Array.isArray(p.candidateIds) && p.candidateIds.length
      ? p.candidateIds.map(String)
      : action.targetIds.length
        ? action.targetIds
        : [targetCandidateId];
    const preference = CandidatePreferenceSchema.parse(p.preference);
    if (!ids.length) throw new Error("缺少 Candidate ID。");
    for (const id of ids) {
      const item = candidate(id);
      const planningRole = role(item);
      if (action.actionType === "destination.preference" && planningRole === "detail_interest") {
        throw new Error("Step 2 preference 只能修改停留区域或重要游览地。");
      }
      if (action.actionType === "interest.preference" && planningRole !== "detail_interest") {
        throw new Error("兴趣点 preference 只能修改普通兴趣点。");
      }
    }
    return ids.length === 1
      ? [{ type: "set_candidate_preference", candidateId: ids[0], preference }]
      : [{ type: "bulk_set_candidate_preference", candidateIds: ids, preference }];
  }

  if (action.actionType === "destination.edit" || action.actionType === "interest.edit") {
    const item = candidate(targetCandidateId);
    const planningRole = role(item);
    if (action.actionType === "destination.edit" && planningRole === "detail_interest") {
      throw new Error("Step 2 编辑只能修改停留区域或重要游览地。");
    }
    if (action.actionType === "interest.edit" && planningRole !== "detail_interest") {
      throw new Error("兴趣点编辑只能修改普通兴趣点。");
    }
    const commands: PlanCommand[] = [];
    if (p.placeChanges && typeof p.placeChanges === "object") {
      commands.push(PlanCommandSchema.parse({
        type: "update_place",
        placeId: item.placeId,
        changes: p.placeChanges,
      }));
    }
    if (p.candidateChanges && typeof p.candidateChanges === "object") {
      commands.push(PlanCommandSchema.parse({
        type: "update_candidate",
        candidateId: item.id,
        changes: p.candidateChanges,
      }));
    }
    if (!commands.length) throw new Error("没有可执行的明确字段修改。");
    return commands;
  }

  if (action.actionType === "itinerary.stop.remove") {
    return [PlanCommandSchema.parse({
      type: "remove_day_stop",
      stopId: String(p.stopId ?? action.targetIds[0] ?? ""),
    })];
  }

  if (action.actionType === "itinerary.stop.move") {
    return [PlanCommandSchema.parse({
      type: "move_day_stop",
      stopId: String(p.stopId ?? action.targetIds[0] ?? ""),
      targetDayId: String(p.targetDayId ?? ""),
      targetIndex: Number(p.targetIndex),
    })];
  }

  if (action.actionType === "itinerary.day.reorder") {
    return [PlanCommandSchema.parse({
      type: "move_day",
      dayId: String(p.dayId ?? action.targetIds[0] ?? ""),
      targetIndex: Number(p.targetIndex),
    })];
  }

  if (action.actionType === "itinerary.anchor.set") {
    return [PlanCommandSchema.parse({
      type: "set_day_anchor",
      dayId: String(p.dayId ?? action.targetIds[0] ?? ""),
      anchor: p.anchor,
      placeId: p.placeId ?? null,
      label: p.label ?? null,
      notes: p.notes ?? null,
    })];
  }

  if (action.actionType === "itinerary.stop.replace") {
    const stopId = String(p.stopId ?? action.targetIds[0] ?? "");
    const replacement = candidate(String(p.candidateId ?? ""));
    return [PlanCommandSchema.parse({
      type: "update_day_stop",
      stopId,
      changes: {
        candidateId: replacement.id,
        placeId: replacement.placeId,
        ...(typeof p.activity === "string" ? { activity: p.activity } : {}),
      },
    })];
  }

  if (action.actionType === "itinerary.stop.add") {
    const dayId = String(p.dayId ?? action.targetIds[0] ?? "");
    const item = candidate(String(p.candidateId ?? ""));
    const place = places.get(item.placeId);
    if (!place) throw new Error("Candidate 引用未知 Place。");
    const day = trip.plan.days.find((value) => value.id === dayId);
    if (!day) throw new Error(`未知 Day：${dayId}`);
    const index = p.index == null ? day.stops.length : Number(p.index);
    const stop: DayStop = {
      id: `tmp-stop-${randomUUID()}`,
      candidateId: item.id,
      placeId: item.placeId,
      activity: typeof p.activity === "string" && p.activity.trim() ? p.activity.trim() : `游览${place.nameZh}`,
      period: null,
      scheduleText: null,
      startTime: null,
      endTime: null,
      durationMinutes: item.suggestedDurationMinutes,
      transportFromPrevious: null,
      scheduleVerification: null,
      costNote: null,
      costVerification: null,
      notes: null,
    };
    return [PlanCommandSchema.parse({ type: "add_day_stop", dayId, index, stop })];
  }

  if (action.actionType === "itinerary.edit") {
    if (p.stopId) {
      return [PlanCommandSchema.parse({
        type: "update_day_stop",
        stopId: String(p.stopId),
        changes: p.changes,
      })];
    }
    return [PlanCommandSchema.parse({
      type: "update_day",
      dayId: String(p.dayId ?? action.targetIds[0] ?? ""),
      changes: p.changes,
    })];
  }

  throw new Error(`未实现 deterministic Action：${action.actionType}`);
}
