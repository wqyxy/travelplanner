import type { DayStop, PlanCommand, TravelPlanDocument, TripCandidate } from "./v2-types";

export type StopPosition = { dayId: string; dayIndex: number; stopIndex: number };

export function buildPlanCommandBatchRequest(expectedGeneration: number, command: PlanCommand) {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("expectedGeneration 无效。");
  return { expectedGeneration, commands: [command] };
}

export function findStopPosition(plan: TravelPlanDocument, stopId: string): StopPosition | null {
  for (const [dayIndex, day] of plan.days.entries()) {
    const stopIndex = day.stops.findIndex((stop) => stop.id === stopId);
    if (stopIndex >= 0) return { dayId: day.id, dayIndex, stopIndex };
  }
  return null;
}

export function buildMoveStopCommand(
  plan: TravelPlanDocument,
  stopId: string,
  targetDayId: string,
  targetDropIndex: number,
): PlanCommand | null {
  const source = findStopPosition(plan, stopId);
  const target = plan.days.find((day) => day.id === targetDayId);
  if (!source || !target) return null;
  const boundedDropIndex = Math.max(0, Math.min(target.stops.length, targetDropIndex));
  const targetIndex = source.dayId === targetDayId && boundedDropIndex > source.stopIndex
    ? boundedDropIndex - 1
    : boundedDropIndex;
  if (source.dayId === targetDayId && targetIndex === source.stopIndex) return null;
  return { type: "move_day_stop", stopId, targetDayId, targetIndex };
}

export function buildMoveStopByOffsetCommand(
  plan: TravelPlanDocument,
  stopId: string,
  offset: -1 | 1,
): PlanCommand | null {
  const source = findStopPosition(plan, stopId);
  if (!source) return null;
  const day = plan.days[source.dayIndex];
  if (offset < 0) {
    if (source.stopIndex === 0) return null;
    return buildMoveStopCommand(plan, stopId, day.id, source.stopIndex - 1);
  }
  if (source.stopIndex >= day.stops.length - 1) return null;
  return buildMoveStopCommand(plan, stopId, day.id, source.stopIndex + 2);
}

export function buildMoveStopToDayCommand(
  plan: TravelPlanDocument,
  stopId: string,
  targetDayId: string,
): PlanCommand | null {
  const target = plan.days.find((day) => day.id === targetDayId);
  if (!target) return null;
  return buildMoveStopCommand(plan, stopId, targetDayId, target.stops.length);
}

export function createTemporaryStop(
  placeId: string,
  placeName: string,
  candidate: TripCandidate | null,
  idFactory: () => string = () => crypto.randomUUID(),
): DayStop {
  return {
    id: `tmp-stop-${idFactory()}`,
    candidateId: candidate?.id ?? null,
    placeId,
    activity: `游览${placeName}`,
    period: null,
    startTime: null,
    endTime: null,
    durationMinutes: candidate?.suggestedDurationMinutes ?? 60,
    transportFromPrevious: null,
    scheduleVerification: null,
    costNote: null,
    costVerification: null,
    notes: null,
  };
}

export function buildAddStopCommand(
  plan: TravelPlanDocument,
  dayId: string,
  placeId: string,
  idFactory?: () => string,
): PlanCommand | null {
  const day = plan.days.find((item) => item.id === dayId);
  const place = plan.places.find((item) => item.id === placeId);
  if (!day || !place) return null;
  const candidate = plan.candidates.find((item) => item.placeId === placeId && item.preference !== "excluded") ?? null;
  return {
    type: "add_day_stop",
    dayId,
    index: day.stops.length,
    stop: createTemporaryStop(placeId, place.nameZh, candidate, idFactory),
  };
}
