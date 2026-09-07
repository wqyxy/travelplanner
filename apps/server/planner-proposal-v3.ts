import type { PlanCommand, ProposalDiff } from "./contracts-v2.js";
import type { applyPlanCommands } from "./plan-commands-v2.js";

export function proposalDiff(
  commands: PlanCommand[],
  effects: ReturnType<typeof applyPlanCommands>["effects"],
): ProposalDiff {
  const labels = commands.map((command) => {
    if (command.type === "add_candidate") return `新增地点：${command.place.nameZh}`;
    if (command.type === "remove_candidate" || command.type === "remove_candidate_tree") return `移除 Candidate：${command.candidateId}`;
    if (command.type === "update_candidate") return `更新 Candidate：${command.candidateId}`;
    if (command.type === "update_place") return `更新 Place：${command.placeId}`;
    if (command.type === "set_candidate_preference") return `调整 Candidate preference：${command.candidateId}`;
    if (command.type === "bulk_set_candidate_preference") return `批量调整 ${command.candidateIds.length} 个 Candidate`;
    if (command.type === "add_final_route_node") return `最终线路新增节点：${command.node.placeId}`;
    if (command.type === "remove_final_route_node") return `最终线路移除节点：${command.nodeId}`;
    if (command.type === "move_final_route_node") return `最终线路移动节点：${command.nodeId}`;
    if (command.type === "set_final_route_status") return `最终线路调整状态：${command.nodeId}`;
    if (command.type === "set_final_route_boundary") return `最终线路调整日程分界：${command.nodeId}`;
    if (command.type === "set_final_route_transport") return `最终线路调整交通：${command.nodeId}`;
    if (command.type === "add_final_route_night") return `最终线路多一晚：${command.nodeId}`;
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
