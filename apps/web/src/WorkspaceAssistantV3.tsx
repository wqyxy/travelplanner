import { ChevronDown, ChevronUp, LoaderCircle, Sparkles } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { AiProposal } from "./v2-types";
import type { AiAction, ConversationStage, WorkspaceV3, WorkspaceSelectionV3 } from "./v3-types";

const stageCopy: Record<ConversationStage, { title: string; boundary: string; placeholder: string; empty: string }> = {
  requirements: { title: "旅行需求 AI", boundary: "只讨论旅行事实、偏好和约束", placeholder: "告诉 AI 这趟旅行的需求…", empty: "例如：新西兰 20 天自驾，两大一小，节奏不要太赶。" },
  destinations: { title: "目的地 AI", boundary: "只讨论城市、区域、岛屿和独立停留地", placeholder: "讨论目的地取舍或调整…", empty: "例如：南岛想少开车，哪些目的地值得保留？" },
  interests: { title: "兴趣点 AI", boundary: "只讨论现有目的地下的具体地点", placeholder: "讨论景点、体验或候选地点…", empty: "例如：皇后镇再补几个适合孩子的地点。" },
  itinerary: { title: "行程 AI", boundary: "区分行程骨架与每日细节；只使用现有目的地和兴趣点", placeholder: "讨论行程骨架或每日安排如何调整…", empty: "例如：骨架保持不变，只把受影响的 Day 5 排得轻松一点。" },
};

function actionLabel(action: AiAction) {
  const labels: Partial<Record<AiAction["actionType"], string>> = {
    "requirements.update": "更新旅行需求",
    "requirements.clear": "清除旅行需求",
    "destination.generate": "生成目的地建议",
    "destination.add": "新增目的地",
    "destination.remove": "删除目的地",
    "destination.replace": "替换目的地",
    "destination.edit": "编辑目的地",
    "destination.preference": "调整目的地偏好",
    "interest.discover": "发现兴趣点",
    "interest.supplement": "补充兴趣点",
    "interest.add": "新增兴趣点",
    "interest.remove": "删除兴趣点",
    "interest.replace": "替换兴趣点",
    "interest.edit": "编辑兴趣点",
    "interest.preference": "调整兴趣点偏好",
    "itinerary.generate": "生成行程与路线",
    "itinerary.replan": "重新规划行程",
    "itinerary.day.optimize": "优化单日顺序",
    "itinerary.repair": "修复行程可行性",
    "itinerary.verify": "核验动态信息",
    "itinerary.refine": "细化每日行程",
  };
  return labels[action.actionType] ?? action.actionType;
}

function interestResultLines(action: AiAction) {
  if (!(action.actionType === "interest.discover" || action.actionType === "interest.supplement") || !action.resultRef?.startsWith("interest:v1;")) return null;
  const values = new Map(action.resultRef.split(";").slice(1).map((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, ""];
  }));
  const areas = String(values.get("areas") ?? "0/0");
  const [successfulText, totalText] = areas.split("/");
  const successful = Number(successfulText) || 0;
  const total = Number(totalText) || 0;
  const failed = Number(values.get("failed")) || 0;
  const added = Number(values.get("added")) || 0;
  const resolved = Number(values.get("resolved")) || 0;
  const pending = Number(values.get("pending")) || 0;
  const first = failed > 0 ? `完成 ${successful}/${total}，${failed} 个区域失败` : `完成 ${successful}/${total}`;
  const second = added === 0 ? "本轮没有发现值得新增的兴趣点" : `新增 ${added} · 已定位 ${resolved}/${resolved + pending}`;
  return [first, second];
}

function ProposalCard({ proposal, currentGeneration, busy, onAction }: { proposal: AiProposal; currentGeneration: number; busy: boolean; onAction: (proposalId: string, action: "apply" | "reject" | "undo") => Promise<void> }) {
  const current = proposal.baseGeneration === currentGeneration;
  return <section className={`stage-proposal-card-v3 ${proposal.status}`}>
    <header><strong>{proposal.title}</strong><span>{proposal.status === "pending" ? "待应用" : proposal.status === "applied" ? "已应用" : proposal.status === "rejected" ? "已拒绝" : proposal.status === "superseded" ? "已失效" : proposal.status === "undone" ? "已撤销" : proposal.status}</span></header>
    <p>{proposal.explanation}</p>
    <div className="stage-proposal-diff-v3"><b>{proposal.diff.summary}</b>{proposal.diff.commandSummaries.slice(0, 8).map((item, index) => <small key={`${proposal.id}:${index}`}>{item}</small>)}{proposal.diff.commandSummaries.length > 8 && <small>另有 {proposal.diff.commandSummaries.length - 8} 项修改</small>}</div>
    {proposal.status === "pending" && <footer><button className="button" disabled={busy} onClick={() => void onAction(proposal.id, "reject")}>拒绝</button><button className="button primary" disabled={busy || !current} title={!current ? "计划已经变化，该方案不能直接应用" : undefined} onClick={() => void onAction(proposal.id, "apply")}>应用修改</button></footer>}
    {proposal.status === "applied" && <footer><button className="button" disabled={busy || currentGeneration !== proposal.baseGeneration + 1} onClick={() => void onAction(proposal.id, "undo")}>撤销这次应用</button></footer>}
  </section>;
}

function ActionCard({ action, proposal, currentGeneration, busy, onConfirm, onCancel, onProposalAction, canRetryGenerate, onRetryGenerate }: {
  action: AiAction;
  proposal: AiProposal | null;
  currentGeneration: number;
  busy: boolean;
  onConfirm: (action: AiAction) => Promise<void>;
  onCancel: (action: AiAction) => Promise<void>;
  onProposalAction: (proposalId: string, action: "apply" | "reject" | "undo") => Promise<void>;
  canRetryGenerate?: boolean;
  onRetryGenerate?: () => Promise<void>;
}) {
  const pending = action.status === "pending_confirmation";
  const interestResult = interestResultLines(action);
  return <section className={`stage-action-card-v3 ${action.status}`}>
    <header><strong>{actionLabel(action)}</strong><span>{action.executor === "ai" ? "AI" : "确定性"}</span></header>
    <small>范围：{action.stage} · 基于 generation {action.baseGeneration}</small>
    {action.targetIds.length > 0 && <small>目标：{action.targetIds.slice(0, 4).join("、")}{action.targetIds.length > 4 ? ` 等 ${action.targetIds.length} 项` : ""}</small>}
    {action.errorSummary && <p className="inline-error">{action.errorSummary}</p>}
    {pending && <footer><button className="button" disabled={busy} onClick={() => void onCancel(action)}>取消</button><button className="button primary" disabled={busy || action.baseGeneration !== currentGeneration} onClick={() => void onConfirm(action)}>{action.executor === "ai" ? "确认并生成方案" : "确认执行"}</button></footer>}
    {action.status === "executing" && <div className="stage-action-running-v3"><LoaderCircle className="spin" size={14}/><span>正在执行…</span></div>}
    {action.status === "awaiting_apply" && <small>方案已生成，等待你检查并 Apply。</small>}
    {action.status === "completed" && interestResult && <div className="stage-action-result-v3"><small>{interestResult[0]}</small><small>{interestResult[1]}</small></div>}
    {action.status === "completed" && !interestResult && <small>已完成{action.resultRef?.startsWith("requiresStage:") ? " · 需要返回兴趣点阶段" : ""}</small>}
    {action.status === "applied" && <small>已执行并应用到当前旅行。</small>}
    {action.status === "rejected" && <small>方案已拒绝，正式计划未修改。</small>}
    {action.status === "cancelled" && <small>动作已取消。</small>}
    {action.status === "failed" && <small>动作执行失败。</small>}
    {action.status === "failed" && canRetryGenerate && <footer><button className="button primary" disabled={busy} onClick={() => void onRetryGenerate?.()}>重新生成</button></footer>}
    {action.status === "superseded" && <small>计划已变化，此动作已失效。</small>}
    {proposal && <ProposalCard proposal={proposal} currentGeneration={currentGeneration} busy={busy} onAction={onProposalAction}/>} 
  </section>;
}

export function WorkspaceAssistantV3({ stage, workspace, selection, busy, error, onSend, onConfirmAction, onCancelAction, onProposalAction, onStopTask, onRetryGenerate }: {
  stage: ConversationStage;
  workspace: WorkspaceV3;
  selection: WorkspaceSelectionV3;
  busy: boolean;
  error: string;
  onSend: (stage: ConversationStage, message: string, selection: WorkspaceSelectionV3) => Promise<void>;
  onConfirmAction: (action: AiAction) => Promise<void>;
  onCancelAction: (action: AiAction) => Promise<void>;
  onProposalAction: (proposalId: string, action: "apply" | "reject" | "undo") => Promise<void>;
  onStopTask: (taskId: string) => Promise<void>;
  onRetryGenerate: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [drafts, setDrafts] = useState<Record<ConversationStage, string>>({ requirements: "", destinations: "", interests: "", itinerary: "" });
  const end = useRef<HTMLDivElement>(null);
  const copy = stageCopy[stage];
  const messages = workspace.messages[stage] ?? [];
  const actions = useMemo(() => workspace.actions.filter((action) => action.stage === stage), [workspace.actions, stage]);
  const proposals = useMemo(() => new Map(workspace.proposals.map((proposal) => [proposal.id, proposal])), [workspace.proposals]);
  const attachedActionIds = new Set(messages.flatMap((message) => {
    const id = message.reply && typeof message.reply === "object" && typeof (message.reply as Record<string, unknown>).actionId === "string" ? String((message.reply as Record<string, unknown>).actionId) : null;
    return id ? [id] : [];
  }));
  const ctaActions = actions.filter((action) => action.origin === "cta" || !attachedActionIds.has(action.id)).slice(0, 6);
  const activeTask = workspace.tasks.find((task) => ["starting", "running", "waiting", "reconnecting"].includes(task.status) && (task.agent === "action" || task.metadata?.stage === stage));

  useEffect(() => { if (expanded) end.current?.scrollIntoView({ block: "end" }); }, [expanded, stage, messages.length, actions.map((item) => `${item.id}:${item.status}`).join("|")]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = drafts[stage].trim();
    if (!message || busy) return;
    setDrafts((current) => ({ ...current, [stage]: "" }));
    void onSend(stage, message, selection);
  };

  if (!expanded) return <div className="assistant-dock-collapsed-v4">
    <button className="assistant-dock-toggle-v4" type="button" onClick={() => setExpanded(true)} aria-label={`展开${copy.title}`}><span className="assistant-dock-mark-v4"><Sparkles size={16}/></span><span className="assistant-dock-collapsed-copy-v4"><strong>{copy.title}</strong><small>{copy.boundary}</small></span><ChevronUp size={18}/></button>
  </div>;

  return <section className="assistant-dock-v4 stage-assistant-v3" aria-label={copy.title}>
    <header className="assistant-dock-head-v4">
      <div className="assistant-dock-identity-v4"><span className="assistant-dock-mark-v4"><Sparkles size={16}/></span><span><strong>{copy.title}</strong><small>{copy.boundary}</small></span></div>
      <button className="icon-button assistant-dock-collapse-v4" type="button" aria-label="收起阶段 AI" onClick={() => setExpanded(false)}><ChevronDown size={18}/></button>
    </header>
    <div className="assistant-dock-body-v4">
      {!messages.length && <div className="assistant-opening-v4"><Sparkles size={18}/><p>{copy.boundary}</p><small>{copy.empty}</small></div>}
      {messages.map((message) => {
        const actionId = message.reply && typeof message.reply === "object" && typeof (message.reply as Record<string, unknown>).actionId === "string" ? String((message.reply as Record<string, unknown>).actionId) : null;
        const action = actionId ? actions.find((item) => item.id === actionId) ?? null : null;
        const proposal = action?.proposalId ? proposals.get(action.proposalId) ?? null : null;
        return <article className={`message ${message.role}`} key={message.id}>
          {message.role === "assistant" ? <ReactMarkdown>{message.content}</ReactMarkdown> : <p>{message.content}</p>}
          {message.turn && <div className={`turn-status ${message.turn.status}`}><small>{message.turn.progressMessage || message.turn.errorMessage || message.turn.status}</small></div>}
          {action && <ActionCard action={action} proposal={proposal} currentGeneration={workspace.trip.contentGeneration} busy={busy} onConfirm={onConfirmAction} onCancel={onCancelAction} onProposalAction={onProposalAction} canRetryGenerate={action.actionType === "itinerary.generate" && action.baseGeneration === workspace.trip.contentGeneration && workspace.trip.plan.days.length === 0 && workspace.tasks.find((task) => task.id === action.taskId)?.metadata?.retryable === true} onRetryGenerate={onRetryGenerate}/>} 
        </article>;
      })}
      {ctaActions.length > 0 && <div className="stage-task-area-v3"><small className="stage-task-area-label-v3">当前阶段任务</small>{ctaActions.map((action) => <ActionCard key={action.id} action={action} proposal={action.proposalId ? proposals.get(action.proposalId) ?? null : null} currentGeneration={workspace.trip.contentGeneration} busy={busy} onConfirm={onConfirmAction} onCancel={onCancelAction} onProposalAction={onProposalAction} canRetryGenerate={action.actionType === "itinerary.generate" && action.status === "failed" && action.baseGeneration === workspace.trip.contentGeneration && workspace.trip.plan.days.length === 0 && workspace.tasks.find((task) => task.id === action.taskId)?.metadata?.retryable === true} onRetryGenerate={onRetryGenerate}/>)}</div>}
      {error && <p className="inline-error">{error}</p>}
      <div ref={end}/>
    </div>
    <div className="assistant-compose-zone-v4">
      {activeTask && <button type="button" className="button small stage-stop-button-v3" onClick={() => void onStopTask(activeTask.id)}><LoaderCircle className="spin" size={13}/>停止当前 AI</button>}
      <form className="assistant-composer-v4" onSubmit={submit}>
        <textarea rows={1} maxLength={4000} value={drafts[stage]} onChange={(event) => setDrafts((current) => ({ ...current, [stage]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={copy.placeholder} disabled={busy}/>
        <button className="button primary" disabled={busy || !drafts[stage].trim()}>发送</button>
      </form>
      <small>Enter 发送 · Shift+Enter 换行 · AI 修改先预览再 Apply</small>
    </div>
  </section>;
}
