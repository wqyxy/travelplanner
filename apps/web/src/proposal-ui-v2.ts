import type { AiProposal, ProposalScope, Workspace, WorkspaceSelection } from "./v2-types";

export type ProposalAction = "apply" | "reject" | "undo";
export type ProposalScopeOption = { scope: ProposalScope; label: string; detail: string };
export type ProposalUiState = {
  effectiveStatus: AiProposal["status"] | "expired";
  label: string;
  description: string;
  actions: ProposalAction[];
};


export function proposalCreatePath(tripId: string) {
  return `/api/trips/${encodeURIComponent(tripId)}/proposals`;
}

export function proposalActionPath(tripId: string, proposalId: string, action: ProposalAction) {
  return `${proposalCreatePath(tripId)}/${encodeURIComponent(proposalId)}/${action}`;
}

export function proposalCreateBody(message: string, scope: ProposalScope) {
  const value = message.trim();
  if (!value) throw new Error("请输入希望 AI 调整的内容。");
  return { message: value, scope };
}

export function proposalScopeKey(scope: ProposalScope) {
  return scope.type === "days"
    ? `${scope.type}:${scope.ids.join(",")}`
    : `${scope.type}:${scope.id ?? ""}`;
}

export function proposalScopeLabel(scope: ProposalScope) {
  switch (scope.type) {
    case "candidate_pool": return "地点池";
    case "candidate": return "候选地点";
    case "place": return "真实地点";
    case "day": return "某一天";
    case "days": return "多个日期";
    case "trip": return "整趟旅行";
  }
}

function option(scope: ProposalScope, detail: string): ProposalScopeOption {
  return { scope, label: proposalScopeLabel(scope), detail };
}

function unique(options: ProposalScopeOption[]) {
  const seen = new Set<string>();
  return options.filter((item) => {
    const key = proposalScopeKey(item.scope);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function proposalScopeOptions(workspace: Workspace, selection: WorkspaceSelection): ProposalScopeOption[] {
  const plan = workspace.trip.plan;
  const selected: ProposalScopeOption[] = [];

  if (selection.type === "candidate") {
    const candidate = plan.candidates.find((item) => item.id === selection.id);
    const place = candidate && plan.places.find((item) => item.id === candidate.placeId);
    if (candidate) selected.push(option({ type: "candidate", id: candidate.id }, place?.nameZh || candidate.id));
    if (place) selected.push(option({ type: "place", id: place.id }, place.nameZh));
  } else if (selection.type === "place") {
    const place = plan.places.find((item) => item.id === selection.id);
    if (place) selected.push(option({ type: "place", id: place.id }, place.nameZh));
  } else if (selection.type === "day") {
    const day = plan.days.find((item) => item.id === selection.id);
    if (day) selected.push(option({ type: "day", id: day.id }, `DAY ${day.dayNumber} · ${day.title}`));
  } else if (selection.type === "stop") {
    const day = plan.days.find((item) => item.stops.some((stop) => stop.id === selection.id));
    const stop = day?.stops.find((item) => item.id === selection.id);
    const place = stop && plan.places.find((item) => item.id === stop.placeId);
    if (day) selected.push(option({ type: "day", id: day.id }, `DAY ${day.dayNumber} · ${day.title}`));
    if (place) selected.push(option({ type: "place", id: place.id }, place.nameZh));
  }

  const candidatePool = option({ type: "candidate_pool", id: null }, `${plan.candidates.length} 个候选地点`);
  const trip = option({ type: "trip", id: null }, workspace.trip.title);
  if (selection.type === "trip") return unique([trip, candidatePool, ...selected]);
  if (selection.type === "candidate_pool") return unique([candidatePool, trip, ...selected]);
  return unique([...selected, candidatePool, trip]);
}

export function findProposalScope(options: ProposalScopeOption[], key: string) {
  return options.find((item) => proposalScopeKey(item.scope) === key)?.scope ?? options[0]?.scope ?? null;
}

export function proposalUiState(proposal: AiProposal, currentGeneration: number): ProposalUiState {
  if (proposal.status === "pending" && proposal.baseGeneration !== currentGeneration) {
    return { effectiveStatus: "expired", label: "已过期", description: "计划已在建议生成后发生变化，不能再应用这份建议。", actions: [] };
  }
  if (proposal.status === "pending") {
    return { effectiveStatus: "pending", label: "等待确认", description: "预览不会修改正式计划。", actions: ["apply", "reject"] };
  }
  if (proposal.status === "applied") {
    const undoAvailable = proposal.appliedRevisionVersion !== null && currentGeneration === proposal.baseGeneration + 1;
    return undoAvailable
      ? { effectiveStatus: "applied", label: "已应用", description: "当前计划仍是应用后的版本，可以撤销。", actions: ["undo"] }
      : { effectiveStatus: "applied", label: "已应用", description: "应用后计划又发生了变化，不能直接撤销这份建议。", actions: [] };
  }
  if (proposal.status === "rejected") return { effectiveStatus: "rejected", label: "已取消", description: "这份建议没有修改正式计划。", actions: [] };
  if (proposal.status === "superseded") return { effectiveStatus: "superseded", label: "已失效", description: "计划版本已变化，这份建议已自动失效。", actions: [] };
  return { effectiveStatus: "undone", label: "已撤销", description: "正式计划已恢复到应用前的版本。", actions: [] };
}
