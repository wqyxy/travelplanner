import { ChevronDown, ChevronUp, LoaderCircle, Sparkles } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { AiProposal } from "./v2-types";
import type { AiAction, ConversationStage, WorkflowStepV3, WorkspaceSelectionV3, WorkspaceV3 } from "./v3-types";
import { actionBelongsToWorkflowStepV3, WORKFLOW_STEPS_V3 } from "./workflow-ui-v3";

const copyByStep: Record<WorkflowStepV3, { title: string; boundary: string; placeholder: string; empty: string }> = {
  requirements: { title: "旅行需求助手", boundary: "帮你整理旅行事实、偏好和限制", placeholder: "补充这趟旅行的需求…", empty: "例如：20 天自驾，两大一小，每天不要开太久。" },
  backbone: { title: "想去哪些地方", boundary: "帮你整理停留地点和重要游览地的愿望清单", placeholder: "告诉 AI 哪些地方想去、哪些可以放弃…", empty: "例如：米尔福德峡湾一定想去，但不一定在那里住宿。" },
  skeleton: { title: "路线和天数助手", boundary: "只讨论顺序、停留天数和区域间移动，不安排普通景点", placeholder: "讨论路线顺序或每站住几天…", empty: "例如：皇后镇多住一天，奥克兰最后再留一晚。" },
  interests: { title: "补充景点助手", boundary: "按已经确定的停留时间补充普通景点；这一步可以跳过", placeholder: "需要的话，让 AI 再补几个景点…", empty: "例如：皇后镇补两个适合孩子的半日地点。" },
  detail: { title: "每日行程助手", boundary: "在已确定的路线和天数里调整每天怎么玩", placeholder: "讨论某一天的安排…", empty: "例如：Day 5 排得轻松一点，其他天保持不变。" },
};

function actionLabel(action: AiAction) {
  const labels: Partial<Record<AiAction["actionType"], string>> = {
    "requirements.update": "更新旅行需求", "requirements.clear": "清除部分需求", "requirements.capture": "记录补充需求",
    "destination.generate": "推荐想去的地方", "destination.add": "新增地点", "destination.remove": "移除地点", "destination.replace": "替换地点", "destination.edit": "修改地点", "destination.preference": "调整地点偏好",
    "itinerary.generate": "生成路线和天数", "itinerary.replan": "重新安排路线和天数",
    "interest.discover": "补充普通景点", "interest.supplement": "补充普通景点", "interest.add": "新增普通景点", "interest.remove": "移除普通景点", "interest.replace": "替换普通景点", "interest.edit": "修改普通景点", "interest.preference": "调整景点偏好",
    "itinerary.detail.generate": "生成每日行程", "itinerary.detail.update": "更新受影响的日期", "itinerary.day.optimize": "优化当天顺序", "itinerary.repair": "修复当天安排", "itinerary.verify": "核验动态信息", "itinerary.refine": "完善当天安排",
    "itinerary.stop.add": "加入当天地点", "itinerary.stop.remove": "移除当天地点", "itinerary.stop.replace": "替换当天地点", "itinerary.stop.move": "移动当天地点", "itinerary.day.reorder": "调整日期顺序", "itinerary.edit": "修改当天安排", "itinerary.anchor.set": "修改当天起止点",
  };
  return labels[action.actionType] ?? "调整旅行计划";
}

function humanActionState(action: AiAction) {
  if (action.status === "pending_confirmation") return "等待确认";
  if (action.status === "executing") return "正在处理";
  if (action.status === "awaiting_apply") return "方案已准备好";
  if (action.status === "completed" || action.status === "applied") return "已完成";
  if (action.status === "rejected" || action.status === "cancelled") return "已取消";
  if (action.status === "superseded") return "需要重新确认";
  return "未完成";
}

function ProposalCard({ proposal, currentGeneration, busy, onAction }: { proposal: AiProposal; currentGeneration: number; busy: boolean; onAction: (proposalId: string, action: "apply" | "reject" | "undo") => Promise<void> }) {
  const current = proposal.baseGeneration === currentGeneration;
  return <section className={`phase6-proposal-card ${proposal.status}`}>
    <header><strong>{proposal.title}</strong><span>{proposal.status === "pending" ? "待确认" : proposal.status === "applied" ? "已采用" : proposal.status === "rejected" ? "未采用" : proposal.status === "superseded" ? "已失效" : proposal.status === "undone" ? "已撤销" : ""}</span></header>
    <p>{proposal.explanation}</p>
    <details><summary>查看原因和具体修改</summary><div>{proposal.diff.commandSummaries.slice(0, 10).map((item, index) => <small key={`${proposal.id}:${index}`}>{item}</small>)}{proposal.diff.commandSummaries.length > 10 && <small>另有 {proposal.diff.commandSummaries.length - 10} 项调整</small>}</div></details>
    {proposal.status === "pending" && <footer><button className="button" disabled={busy} onClick={() => void onAction(proposal.id, "reject")}>不采用</button><button className="button primary" disabled={busy || !current} title={!current ? "旅行计划已经变化，请重新生成这个调整" : undefined} onClick={() => void onAction(proposal.id, "apply")}>采用这个调整</button></footer>}
    {proposal.status === "applied" && <footer><button className="button" disabled={busy || currentGeneration !== proposal.baseGeneration + 1} onClick={() => void onAction(proposal.id, "undo")}>撤销这次调整</button></footer>}
  </section>;
}

function ActionCard({ action, proposal, currentGeneration, busy, onConfirm, onCancel, onProposalAction, onRetry }: {
  action: AiAction;
  proposal: AiProposal | null;
  currentGeneration: number;
  busy: boolean;
  onConfirm: (action: AiAction) => Promise<void>;
  onCancel: (action: AiAction) => Promise<void>;
  onProposalAction: (proposalId: string, action: "apply" | "reject" | "undo") => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const requiresUpstream = action.status === "completed" && action.resultRef?.startsWith("requiresWorkflowStep:");
  return <section className={`phase6-action-card ${action.status}`}>
    <header><strong>{actionLabel(action)}</strong><span>{humanActionState(action)}</span></header>
    {action.errorSummary && <p className="inline-error">{action.errorSummary}</p>}
    {action.status === "pending_confirmation" && <><p>这个操作会修改旅行计划，请确认后再继续。</p><footer><button className="button" disabled={busy} onClick={() => void onCancel(action)}>取消</button><button className="button primary" disabled={busy || action.baseGeneration !== currentGeneration} onClick={() => void onConfirm(action)}>确认继续</button></footer></>}
    {action.status === "executing" && <div className="phase6-action-running"><LoaderCircle className="spin" size={14}/>正在处理…</div>}
    {action.status === "awaiting_apply" && !proposal && <small>已经准备好一份调整方案，请检查后决定是否采用。</small>}
    {requiresUpstream && <p>需要先处理前面的规划步骤，界面会自动带你回到需要确认的位置。</p>}
    {action.status === "failed" && <footer><button className="button primary" disabled={busy} onClick={() => void onRetry()}>再试一次</button></footer>}
    {action.status === "superseded" && <p>旅行计划已经变化，这个旧操作不再直接使用。</p>}
    {proposal && <ProposalCard proposal={proposal} currentGeneration={currentGeneration} busy={busy} onAction={onProposalAction}/>} 
  </section>;
}

export function WorkflowAssistantV3({ workflowStep, stage, workspace, selection, busy, error, onSend, onConfirmAction, onCancelAction, onProposalAction, onStopTask, onRetryCurrent }: {
  workflowStep: WorkflowStepV3;
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
  onRetryCurrent: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [drafts, setDrafts] = useState<Record<WorkflowStepV3, string>>({ requirements: "", backbone: "", skeleton: "", interests: "", detail: "" });
  const end = useRef<HTMLDivElement>(null);
  const copy = copyByStep[workflowStep];
  const messages = workspace.messages[stage] ?? [];
  const actions = useMemo(() => workspace.actions.filter((action) => actionBelongsToWorkflowStepV3(action.actionType, workflowStep)), [workspace.actions, workflowStep]);
  const proposals = useMemo(() => new Map(workspace.proposals.map((proposal) => [proposal.id, proposal])), [workspace.proposals]);
  const attachedActionIds = new Set(messages.flatMap((message) => {
    const id = message.reply && typeof message.reply === "object" && typeof (message.reply as Record<string, unknown>).actionId === "string" ? String((message.reply as Record<string, unknown>).actionId) : null;
    return id ? [id] : [];
  }));
  const ctaActions = actions.filter((action) => action.origin === "cta" || !attachedActionIds.has(action.id)).slice(0, 5);
  const activeTask = workspace.tasks.find((task) => ["starting", "running", "waiting", "reconnecting"].includes(task.status) && (task.agent === "dialogue" ? task.metadata?.stage === stage : typeof task.metadata?.actionType === "string" && actionBelongsToWorkflowStepV3(task.metadata.actionType as AiAction["actionType"], workflowStep)));

  useEffect(() => { if (expanded) end.current?.scrollIntoView({ block: "end" }); }, [expanded, workflowStep, messages.length, actions.map((item) => `${item.id}:${item.status}`).join("|")]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = drafts[workflowStep].trim();
    if (!message || busy) return;
    setDrafts((current) => ({ ...current, [workflowStep]: "" }));
    void onSend(stage, message, selection);
  };

  const stepLabel = WORKFLOW_STEPS_V3.find((item) => item.step === workflowStep)?.label ?? copy.title;
  if (!expanded) return <div className="assistant-dock-collapsed-v4"><button className="assistant-dock-toggle-v4" type="button" onClick={() => setExpanded(true)}><span className="assistant-dock-mark-v4"><Sparkles size={16}/></span><span className="assistant-dock-collapsed-copy-v4"><strong>{copy.title}</strong><small>{copy.boundary}</small></span><ChevronUp size={18}/></button></div>;

  return <section className="assistant-dock-v4 phase6-assistant" aria-label={copy.title}>
    <header className="assistant-dock-head-v4"><div className="assistant-dock-identity-v4"><span className="assistant-dock-mark-v4"><Sparkles size={16}/></span><span><strong>{copy.title}</strong><small>{copy.boundary}</small></span></div><button className="icon-button assistant-dock-collapse-v4" type="button" aria-label="收起助手" onClick={() => setExpanded(false)}><ChevronDown size={18}/></button></header>
    <div className="assistant-dock-body-v4">
      {!messages.length && !ctaActions.length && <div className="assistant-opening-v4"><Sparkles size={18}/><p>{copy.boundary}</p><small>{copy.empty}</small></div>}
      {messages.map((message) => {
        const actionId = message.reply && typeof message.reply === "object" && typeof (message.reply as Record<string, unknown>).actionId === "string" ? String((message.reply as Record<string, unknown>).actionId) : null;
        const action = actionId ? actions.find((item) => item.id === actionId) ?? null : null;
        const proposal = action?.proposalId ? proposals.get(action.proposalId) ?? null : null;
        return <article className={`message ${message.role}`} key={message.id}>{message.role === "assistant" ? <ReactMarkdown>{message.content}</ReactMarkdown> : <p>{message.content}</p>}{message.turn && ["queued", "starting", "active"].includes(message.turn.status) && <div className="turn-status active"><small>{message.turn.progressMessage || "正在处理…"}</small></div>}{action && <ActionCard action={action} proposal={proposal} currentGeneration={workspace.trip.contentGeneration} busy={busy} onConfirm={onConfirmAction} onCancel={onCancelAction} onProposalAction={onProposalAction} onRetry={onRetryCurrent}/>}</article>;
      })}
      {ctaActions.length > 0 && <div className="phase6-current-actions"><small>{stepLabel} · 当前操作</small>{ctaActions.map((action) => <ActionCard key={action.id} action={action} proposal={action.proposalId ? proposals.get(action.proposalId) ?? null : null} currentGeneration={workspace.trip.contentGeneration} busy={busy} onConfirm={onConfirmAction} onCancel={onCancelAction} onProposalAction={onProposalAction} onRetry={onRetryCurrent}/>)}</div>}
      {error && <p className="inline-error">{error}</p>}
      <div ref={end}/>
    </div>
    <div className="assistant-compose-zone-v4">{activeTask && <button type="button" className="button small stage-stop-button-v3" onClick={() => void onStopTask(activeTask.id)}>停止当前处理</button>}<form className="assistant-composer-v4" onSubmit={submit}><textarea value={drafts[workflowStep]} disabled={busy} rows={1} placeholder={copy.placeholder} onChange={(event) => setDrafts((current) => ({ ...current, [workflowStep]: event.target.value }))}/><button className="button primary small" disabled={busy || !drafts[workflowStep].trim()}>发送</button></form><small>当前只会处理“{stepLabel}”相关内容；需要上游调整时会自动切换到对应步骤。</small></div>
  </section>;
}
