import { ChevronDown, ChevronUp, LoaderCircle, MessagesSquare, Sparkles, WandSparkles } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ProposalPanelV2 } from "./ProposalPanelV2";
import { findProposalScope, proposalScopeKey, proposalScopeOptions, type ProposalAction } from "./proposal-ui-v2";
import type { Chat, ProposalScope, Workspace, WorkspaceSelection } from "./v2-types";

const selectionLabels: Record<WorkspaceSelection["type"], string> = { trip: "整趟旅行", candidate_pool: "地点池", candidate: "候选地点", place: "地点", day: "某一天", stop: "行程地点" };
type AssistantMode = "conversation" | "adjustment";

export function WorkspaceAssistantV2({ title, workspace, selection, chat, busy, error, onSend, onCreateProposal, onProposalAction, onStop }: {
  title: string | null;
  workspace: Workspace | null;
  selection: WorkspaceSelection;
  chat: Chat[];
  busy: boolean;
  error: string;
  onSend: (message: string) => Promise<void>;
  onCreateProposal: (message: string, scope: ProposalScope) => Promise<void>;
  onProposalAction: (proposalId: string, action: ProposalAction) => Promise<void>;
  onStop: (taskOrMessageId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<AssistantMode>("conversation");
  const [input, setInput] = useState("");
  const [scopeKey, setScopeKey] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const scopeOptions = useMemo(() => workspace ? proposalScopeOptions(workspace, selection) : [], [workspace, selection]);
  const scopeOptionKey = scopeOptions.map((item) => proposalScopeKey(item.scope)).join("|");

  useEffect(() => {
    if (!scopeOptions.length) { setScopeKey(""); return; }
    if (!scopeOptions.some((item) => proposalScopeKey(item.scope) === scopeKey)) setScopeKey(proposalScopeKey(scopeOptions[0].scope));
  }, [scopeOptionKey, scopeKey]);
  useEffect(() => { if (expanded) end.current?.scrollIntoView({ block: "end" }); }, [expanded, chat, busy, mode, workspace?.proposals.length]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || !title || busy) return;
    if (mode === "adjustment") {
      const scope = findProposalScope(scopeOptions, scopeKey);
      if (!scope) return;
      setInput(""); void onCreateProposal(message, scope);
      return;
    }
    setInput(""); void onSend(message);
  };
  const context = selectionLabels[selection.type];
  const pending = workspace?.proposals.filter((proposal) => proposal.status === "pending" && proposal.baseGeneration === workspace.trip.contentGeneration).length ?? 0;

  if (!expanded) return <button className="assistant-bar assistant-bar-v2" type="button" onClick={() => setExpanded(true)}><Sparkles size={17}/><span className="assistant-context-label">{title || "AI 旅行顾问"}</span><span className="assistant-scope-chip">当前：{context}</span><span className="assistant-bar-prompt">对话理解需求；AI 调整先生成 Preview，再由你决定是否应用</span>{pending > 0 && <span className="assistant-proposal-badge">{pending} 个待确认</span>}{busy && <LoaderCircle className="spin" size={16}/>}<ChevronUp size={18}/></button>;

  return <section className="assistant-drawer assistant-drawer-v2" aria-label="AI 旅行助手">
    <header className="assistant-head"><div><strong>{title || "AI 旅行顾问"}</strong><small>{mode === "conversation" ? "旅行需求与说明" : "结构化修改建议"}</small></div><div><span className="assistant-scope-chip">当前上下文：{context}</span><button className="icon-button" type="button" aria-label="收起 AI 助手" onClick={() => setExpanded(false)}><ChevronDown size={19}/></button></div></header>
    <div className="assistant-mode-tabs" role="tablist" aria-label="AI 助手模式">
      <button type="button" role="tab" aria-selected={mode === "conversation"} className={mode === "conversation" ? "active" : ""} onClick={() => setMode("conversation")}><MessagesSquare size={15}/>对话</button>
      <button type="button" role="tab" aria-selected={mode === "adjustment"} className={mode === "adjustment" ? "active" : ""} onClick={() => setMode("adjustment")}><WandSparkles size={15}/>AI 调整{pending > 0 && <span>{pending}</span>}</button>
    </div>
    {mode === "conversation" ? <>
      <div className="assistant-context"><Sparkles size={14}/>AI 可以理解旅行需求、补充偏好和回答问题；不会通过普通对话直接覆盖结构化计划。</div>
      <div className="assistant-body">
        {!chat.length && <p className="assistant-opening">描述目的地、日期、同行者和节奏。例如：“国庆从上海去关西 7 天，夫妻带 3 岁孩子，不想太累。”</p>}
        {chat.map((row) => <article className={`message ${row.role}`} key={row.id}>{row.role === "assistant" ? <ReactMarkdown>{row.content}</ReactMarkdown> : <p>{row.content}</p>}{row.turn && <div className={`turn-status ${row.turn.status}`}><small>{row.turn.progressMessage || row.turn.errorMessage || row.turn.status}</small>{["queued", "starting", "active"].includes(row.turn.status) && <button type="button" onClick={() => void onStop(row.id)}>停止</button>}</div>}</article>)}
        {error && <p className="inline-error">{error}</p>}<div ref={end}/>
      </div>
    </> : <>
      <div className="assistant-context proposal-context-v2"><WandSparkles size={14}/><span>先选择修改范围。AI 只生成受限 PlanCommand 和结构化 Diff；点击“应用修改”前，正式计划不会变化。</span><label>调整范围<select aria-label="AI 调整范围" value={scopeKey} onChange={(event) => setScopeKey(event.target.value)} disabled={!workspace || busy}>{scopeOptions.map((item) => <option key={proposalScopeKey(item.scope)} value={proposalScopeKey(item.scope)}>{item.label} · {item.detail}</option>)}</select></label></div>
      <div className="assistant-body proposal-body-v2"><ProposalPanelV2 proposals={workspace?.proposals ?? []} currentGeneration={workspace?.trip.contentGeneration ?? 0} busy={busy} onAction={onProposalAction}/>{error && <p className="inline-error">{error}</p>}<div ref={end}/></div>
    </>}
    <div className="assistant-compose-zone"><form className="assistant-composer" onSubmit={submit}><textarea rows={2} maxLength={4000} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={!title ? "请先新建旅行" : mode === "conversation" ? "描述旅行需求或询问当前计划…" : "描述希望如何调整，例如：这一天太赶了，清水寺必须保留…"} disabled={!title || busy}/><button className="button primary" disabled={!title || busy || !input.trim() || (mode === "adjustment" && !scopeKey)}>{mode === "conversation" ? "发送" : "生成建议"}</button></form></div>
  </section>;
}
