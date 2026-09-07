import { randomUUID } from "node:crypto";
import type { ItineraryRefineOutput } from "./ai-action-contracts-v3.js";
import {
  PlanCommandSchema,
  TravelPlanDocumentSchema,
  type Day,
  type DayStop,
  type PlanCommand,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { applyPlanCommands } from "./plan-commands-v2.js";

const STOP_FIELDS = [
  "activity",
  "period",
  "scheduleText",
  "startTime",
  "endTime",
  "durationMinutes",
  "transportFromPrevious",
  "scheduleVerification",
  "costNote",
  "costVerification",
  "notes",
] as const;

const REPLACEMENT_COMMAND_LIMIT = 100;

function same(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function stopsRepresentSameVisit(left: DayStop, right: DayStop) {
  if (left.candidateId && right.candidateId) {
    return left.candidateId === right.candidateId && left.placeId === right.placeId;
  }
  return left.placeId === right.placeId;
}

export function replacementCommands(
  current: TravelPlanDocument,
  sourceDays: Day[],
  onlyDayIds?: Set<string>,
) {
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
    if (!same(target.startAnchor, source.startAnchor)) {
      commands.push({
        type: "set_day_anchor",
        dayId: target.id,
        anchor: "start",
        placeId: source.startAnchor.placeId,
        label: source.startAnchor.label,
        notes: source.startAnchor.notes,
      });
    }
    if (!same(target.endAnchor, source.endAnchor)) {
      commands.push({
        type: "set_day_anchor",
        dayId: target.id,
        anchor: "end",
        placeId: source.endAnchor.placeId,
        label: source.endAnchor.label,
        notes: source.endAnchor.notes,
      });
    }

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

  if (commands.length > REPLACEMENT_COMMAND_LIMIT) {
    throw new Error(`本次行程修改需要 ${commands.length} 条受控命令，超过单个 Proposal 的 ${REPLACEMENT_COMMAND_LIMIT} 条资源上限；请缩小修改范围后重试。`);
  }
  return commands.map((command) => PlanCommandSchema.parse(command));
}

export function refinementCommands(current: TravelPlanDocument, output: ItineraryRefineOutput) {
  const result = output.result;
  if (result.type !== "success") return [];
  const requested = new Set(result.dayIds);
  const commands: PlanCommand[] = [];

  for (const update of result.dayUpdates) {
    const target = current.days.find((day) => day.id === update.dayId);
    if (!target || !requested.has(target.id)) throw new Error(`细化结果引用未知 Day：${update.dayId}`);
    const returned = new Map(update.stops.map((stop) => [stop.stopId, stop]));
    if (
      returned.size !== update.stops.length
      || update.stops.length !== target.stops.length
      || target.stops.some((stop) => !returned.has(stop.id))
    ) {
      throw new Error(`细化必须恰好返回目标 Day 的全部现有 Stop：${target.id}`);
    }
    for (const before of target.stops) {
      const after = returned.get(before.id)!;
      const changes: Record<string, unknown> = {};
      for (const key of STOP_FIELDS) if (!same(before[key], after[key])) changes[key] = structuredClone(after[key]);
      if (Object.keys(changes).length) {
        commands.push(PlanCommandSchema.parse({ type: "update_day_stop", stopId: before.id, changes }));
      }
    }
  }

  const preview = applyPlanCommands(current, commands).plan;
  TravelPlanDocumentSchema.parse({
    ...preview,
    days: preview.days.map((day) => requested.has(day.id)
      ? { ...day, detailLevel: "detailed", detailStatus: "ready" }
      : day),
  });
  return commands;
}
