import { ChevronDown, ChevronUp, LoaderCircle, MessagesSquare, Sparkles, WandSparkles } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ProposalPanelV2 } from "./ProposalPanelV2";
import { findProposalScope, proposalScopeKey, proposalScopeOptions, type ProposalAction } from "./proposal-ui-v2";
import type { Chat, ProposalScope, Workspace, WorkspaceSelection } from "./v2-types";

const selectionLabels: Record<WorkspaceSelection["type"], string> = {
  trip: "整趟旅行",
  candidate_pool: "地点池",
  candidate: "候选地点",
  place: "地点",
  day: "某一天",
  stop: "行程地点",
};

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
  const [expanded, setExpanded] = useState(true);
  const [mode, setMode] = useState<AssistantMode>("conversation");
  const [input, setInput] = useState("");
  const [scopeKey, setScopeKey] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const scopeOptions = useMemo(() => workspace ? proposalScopeOptions(workspace, selection) : [], [workspace, selection]);
  const scopeOptionKey = scopeOptions.map((item) => proposalScopeKey(item.scope)).join("|");

  useEffect(() => {
    if (!scopeOptions.length) {
      setScopeKey("");
      return;
    }
    if (!scopeOptions.some((item) => proposalScopeKey(item.scope) === scopeKey)) {
      setScopeKey(proposalScopeKey(scopeOptions[0].scope));
    }
  }, [scopeOptionKey, scopeKey]);

  useEffect(() => {
    if (expanded) end.current?.scrollIntoView({ block: "end" });
  }, [expanded, chat, busy, mode, workspace?.proposals.length]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || !title || busy) return;

    if (mode === "adjustment") {
      const scope = findProposalScope(scopeOptions, scopeKey);
      if (!scope) return;
      setInput("");
      void onCreateProposal(message, scope);
      return;
    }

    setInput("");
    void onSend(message);
  };

  const context = selectionLabels[selection.type];
  const pending = workspace?.proposals.filter((proposal) => proposal.status === "pending" && proposal.baseGeneration === workspace.trip.contentGeneration).length ?? 0;

  if (!expanded) {
    return <button className="assistant-dock-collapsed-v4" type="button" aria-expanded="false" onClick={() => setExpanded(true)}>
      <span className="assistant-dock-mark-v4"><Sparkles size={16}/></span>
      <span className="assistant-dock-collapsed-copy-v4">
        <strong>AI 旅行助手</strong>
        <small>{busy ? "AI 正在处理任务…" : `当前上下文：${context}`}</small>
      </span>
      {pending > 0 && <span className="assistant-proposal-badge">{pending} 个待确认</span>}
      {busy && <LoaderCircle className="spin" size={16}/>}<ChevronUp size={18}/>
    </button>;
  }

  return <section className="assistant-dock-v4" aria-label="AI 旅行助手">
    <header className="assistant-dock-head-v4">
      <div className="assistant-dock-identity-v4">
        <span className="assistant-dock-mark-v4"><Sparkles size={16}/></span>
        <span><strong>AI 旅行助手</strong><small>{title || "当前旅行"} · {context}</small></span>
      </div>
      <div className="assistant-mode-tabs-v4" role="tablist" aria-label="AI 助手模式">
        <button type="button" role="tab" aria-selected={mode === "conversation"} className={mode === "conversation" ? "active" : ""} onClick={() => setMode("conversation")}><MessagesSquare size={14}/>对话</button>
        <button type="button" role="tab" aria-selected={mode === "adjustment"} className={mode === "adjustment" ? "active" : ""} onClick={() => setMode("adjustment")}><WandSparkles size={14}/>调整{pending > 0 && <span>{pending}</span>}</button>
      </div>
      <button className="icon-button assistant-dock-collapse-v4" type="button" aria-label="收起 AI 助手" aria-expanded="true" onClick={() => setExpanded(false)}><ChevronDown size={18}/></button>
    </header>

    {mode === "adjustment" && <div className="assistant-scope-toolbar-v4">
      <WandSparkles size={14}/><span>修改范围</span>
      <select aria-label="AI 调整范围" value={scopeKey} onChange={(event) => setScopeKey(event.target.value)} disabled={!workspace || busy}>
        {scopeOptions.map((item) => <option key={proposalScopeKey(item.scope)} value={proposalScopeKey(item.scope)}>{item.label} · {item.detail}</option>)}
      </select>
    </div>}

    <div className="assistant-dock-body-v4">
      {mode === "conversation" ? <>
        {!chat.length && <div className="assistant-opening-v4"><Sparkles size={18}/><p>直接告诉 AI 目的地、天数、同行者、节奏或你想修改的旅行需求。</p><small>例如：新西兰 20 天自驾，两大一小，节奏不要太赶。</small></div>}
        {chat.map((row) => <article className={`message ${row.role}`} key={row.id}>
          {row.role === "assistant" ? <ReactMarkdown>{row.content}</ReactMarkdown> : <p>{row.content}</p>}
          {row.turn && <div className={`turn-status ${row.turn.status}`}><small>{row.turn.progressMessage || row.turn.errorMessage || row.turn.status}</small>{["queued", "starting", "active"].includes(row.turn.status) && <button type="button" onClick={() => void onStop(row.id)}>停止</button>}</div>}
        </article>)}
      </> : <ProposalPanelV2 proposals={workspace?.proposals ?? []} currentGeneration={workspace?.trip.contentGeneration ?? 0} busy={busy} onAction={onProposalAction}/>} 
      {error && <p className="inline-error">{error}</p>}
      <div ref={end}/>
    </div>

    <div className="assistant-compose-zone-v4">
      <form className="assistant-composer-v4" onSubmit={submit}>
        <textarea rows={1} maxLength={4000} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} placeholder={!title ? "请先新建旅行" : mode === "conversation" ? "和 AI 讨论这趟旅行…" : "描述希望如何调整当前计划…"} disabled={!title || busy}/>
        <button className="button primary" disabled={!title || busy || !input.trim() || (mode === "adjustment" && !scopeKey)}>{mode === "conversation" ? "发送" : "生成建议"}</button>
      </form>
      <small>Enter 发送 · Shift+Enter 换行</small>
    </div>
  </section>;
}
