import {
  PlanCommandSchema,
  ProposalScopeSchema,
  type PlanCommand,
  type ProposalScope,
  type TravelPlanDocument,
} from "./contracts-v2.js";

function stopOwner(plan: TravelPlanDocument, stopId: string) {
  return plan.days.find((day) => day.stops.some((stop) => stop.id === stopId))?.id ?? null;
}

function candidatePlaceId(plan: TravelPlanDocument, candidateId: string) {
  return plan.candidates.find((candidate) => candidate.id === candidateId)?.placeId ?? null;
}

function assertCandidatePoolScope(commands: PlanCommand[]) {
  const allowed = new Set<PlanCommand["type"]>(["add_candidate", "remove_candidate", "update_candidate", "update_place"]);
  if (commands.some((command) => !allowed.has(command.type))) {
    throw new Error("Candidate Pool Scope 只能新增、移除或更新候选地点及其语义 Place，不能修改用户 preference、Day、Anchor 或 Stop。");
  }
}

function assertCandidateScope(plan: TravelPlanDocument, candidateId: string, commands: PlanCommand[]) {
  const placeId = candidatePlaceId(plan, candidateId);
  if (!placeId) throw new Error(`未知 Candidate Scope：${candidateId}`);
  for (const command of commands) {
    if (command.type === "update_candidate" && command.candidateId === candidateId) continue;
    if (command.type === "update_place" && command.placeId === placeId) continue;
    if (command.type === "remove_candidate" && command.candidateId === candidateId) continue;
    if (command.type === "add_candidate") continue;
    throw new Error(`Proposal 命令超出 Candidate Scope：${candidateId}`);
  }
}

function assertPlaceScope(plan: TravelPlanDocument, placeId: string, commands: PlanCommand[]) {
  if (!plan.places.some((place) => place.id === placeId)) throw new Error(`未知 Place Scope：${placeId}`);
  if (commands.some((command) => command.type !== "update_place" || command.placeId !== placeId)) {
    throw new Error(`Place Scope 只能修改目标 Place 的语义字段，不能修改坐标、Candidate preference 或任何 Day：${placeId}`);
  }
}

function assertDayScope(plan: TravelPlanDocument, dayId: string, commands: PlanCommand[]) {
  if (!plan.days.some((day) => day.id === dayId)) throw new Error(`未知 Day Scope：${dayId}`);
  const temporaryCandidates = new Set(
    commands.flatMap((command) => command.type === "add_candidate" ? [command.candidate.id] : []),
  );
  const temporaryPlaces = new Set(
    commands.flatMap((command) => command.type === "add_candidate" ? [command.place.id] : []),
  );
  const addedStops = commands.filter((command): command is Extract<PlanCommand, { type: "add_day_stop" }> => command.type === "add_day_stop");

  for (const command of commands) {
    if (command.type === "set_day_anchor" || command.type === "update_day" || command.type === "add_day_stop") {
      if (command.dayId === dayId) continue;
      throw new Error(`Proposal 命令超出 Day Scope：${dayId}`);
    }
    if (command.type === "update_day_stop" || command.type === "remove_day_stop") {
      if (stopOwner(plan, command.stopId) === dayId) continue;
      throw new Error(`Proposal 命令超出 Day Scope：${dayId}`);
    }
    if (command.type === "move_day_stop") {
      if (stopOwner(plan, command.stopId) === dayId && command.targetDayId === dayId) continue;
      throw new Error("Day Scope 不允许跨日移动；请改用 Trip Scope。");
    }
    if (command.type === "add_candidate") {
      const usedByTargetDay = addedStops.some((stopCommand) => stopCommand.dayId === dayId
        && (stopCommand.stop.candidateId === command.candidate.id || stopCommand.stop.placeId === command.place.id));
      if (usedByTargetDay) continue;
      throw new Error("Day Scope 新增的 Candidate 必须在同一 Proposal 中加入目标 Day。");
    }
    if (command.type === "update_candidate" && temporaryCandidates.has(command.candidateId)) continue;
    if (command.type === "update_place" && temporaryPlaces.has(command.placeId)) continue;
    throw new Error(`Proposal 命令超出 Day Scope：${dayId}`);
  }
}

export function assertProposalCommandsWithinScope(
  plan: TravelPlanDocument,
  scopeValue: unknown,
  commandValues: unknown,
): { scope: ProposalScope; commands: PlanCommand[] } {
  const scope = ProposalScopeSchema.parse(scopeValue);
  const commands = Array.isArray(commandValues) ? commandValues.map((command) => PlanCommandSchema.parse(command)) : [];
  if (!commands.length) throw new Error("Proposal 必须包含至少一条命令。");
  if (scope.type === "trip") return { scope, commands };
  if (scope.type === "candidate_pool") assertCandidatePoolScope(commands);
  else if (scope.type === "candidate") assertCandidateScope(plan, scope.id, commands);
  else if (scope.type === "place") assertPlaceScope(plan, scope.id, commands);
  else assertDayScope(plan, scope.id, commands);
  return { scope, commands };
}
