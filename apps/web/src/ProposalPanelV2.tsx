import { Check, Clock3, RotateCcw, X } from "lucide-react";
import { proposalScopeLabel, proposalUiState, type ProposalAction } from "./proposal-ui-v2";
import type { AiProposal } from "./v2-types";

const actionLabels: Record<ProposalAction, string> = { apply: "应用修改", reject: "取消建议", undo: "撤销修改" };

export function ProposalPanelV2({ proposals, currentGeneration, busy, onAction }: {
  proposals: AiProposal[];
  currentGeneration: number;
  busy: boolean;
  onAction: (proposalId: string, action: ProposalAction) => Promise<void>;
}) {
  if (!proposals.length) return <div className="proposal-empty-v2"><strong>还没有 AI 修改建议</strong><span>选择 Scope，描述希望调整的内容。AI 会先生成预览，不会直接覆盖计划。</span></div>;

  return <div className="proposal-list-v2">
    {proposals.slice(0, 12).map((proposal) => {
      const state = proposalUiState(proposal, currentGeneration);
      return <article className={`proposal-card-v2 status-${state.effectiveStatus}`} key={proposal.id}>
        <header><div><span className="proposal-scope-v2">{proposalScopeLabel(proposal.scope)}</span><h3>{proposal.title}</h3></div><span className="proposal-status-v2"><Clock3 size={13}/>{state.label}</span></header>
        <p>{proposal.explanation}</p>
        <div className="proposal-diff-v2"><strong>{proposal.diff.summary}</strong>{proposal.diff.commandSummaries.length > 0 && <ul>{proposal.diff.commandSummaries.map((summary, index) => <li key={`${proposal.id}-${index}`}>{summary}</li>)}</ul>}</div>
        <div className="proposal-impact-v2"><span>候选地点 {proposal.diff.affectedCandidateIds.length}</span><span>地点 {proposal.diff.affectedPlaceIds.length}</span><span>日期 {proposal.diff.affectedDayIds.length}</span></div>
        <small>{state.description}</small>
        {state.actions.length > 0 && <footer>{state.actions.map((action) => <button className={`button small proposal-action-${action}`} type="button" disabled={busy} onClick={() => void onAction(proposal.id, action)} key={action}>{action === "apply" ? <Check size={14}/> : action === "undo" ? <RotateCcw size={14}/> : <X size={14}/>} {actionLabels[action]}</button>)}</footer>}
      </article>;
    })}
  </div>;
}
