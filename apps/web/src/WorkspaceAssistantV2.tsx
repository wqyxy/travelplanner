import { ChevronDown, ChevronUp, LoaderCircle, Sparkles } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Chat, WorkspaceSelection } from "./v2-types";

const selectionLabels: Record<WorkspaceSelection["type"], string> = { trip: "整趟旅行", candidate_pool: "地点池", candidate: "候选地点", place: "地点", day: "某一天", stop: "行程地点" };

export function WorkspaceAssistantV2({ title, selection, chat, busy, error, onSend, onStop }: {
  title: string | null;
  selection: WorkspaceSelection;
  chat: Chat[];
  busy: boolean;
  error: string;
  onSend: (message: string) => Promise<void>;
  onStop: (taskOrMessageId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (expanded) end.current?.scrollIntoView({ block: "end" }); }, [expanded, chat, busy]);
  const submit = (event: FormEvent) => {
    event.preventDefault(); const message = input.trim();
    if (!message || !title || busy) return;
    setInput(""); void onSend(message);
  };
  const context = selectionLabels[selection.type];

  if (!expanded) return <button className="assistant-bar assistant-bar-v2" type="button" onClick={() => setExpanded(true)}><Sparkles size={17}/><span className="assistant-context-label">{title || "AI 旅行顾问"}</span><span className="assistant-scope-chip">当前：{context}</span><span className="assistant-bar-prompt">告诉 AI 旅行需求；地点推荐和排程在右侧明确触发</span>{busy && <LoaderCircle className="spin" size={16}/>}<ChevronUp size={18}/></button>;

  return <section className="assistant-drawer assistant-drawer-v2" aria-label="AI 旅行对话">
    <header className="assistant-head"><div><strong>{title || "AI 旅行顾问"}</strong><small>旅行需求与说明</small></div><div><span className="assistant-scope-chip">当前上下文：{context}</span><button className="icon-button" onClick={() => setExpanded(false)}><ChevronDown size={19}/></button></div></header>
    <div className="assistant-context"><Sparkles size={14}/>AI 可以理解旅行需求、补充偏好和回答问题；地点池、生成行程和后续修改都有明确按钮，不会悄悄覆盖计划。</div>
    <div className="assistant-body">
      {!chat.length && <p className="assistant-opening">描述目的地、日期、同行者和节奏。例如：“国庆从上海去关西 7 天，夫妻带 3 岁孩子，不想太累。”</p>}
      {chat.map((row) => <article className={`message ${row.role}`} key={row.id}>{row.role === "assistant" ? <ReactMarkdown>{row.content}</ReactMarkdown> : <p>{row.content}</p>}{row.turn && <div className={`turn-status ${row.turn.status}`}><small>{row.turn.progressMessage || row.turn.errorMessage || row.turn.status}</small>{["queued", "starting", "active"].includes(row.turn.status) && <button type="button" onClick={() => void onStop(row.id)}>停止</button>}</div>}</article>)}
      {error && <p className="inline-error">{error}</p>}<div ref={end}/>
    </div>
    <div className="assistant-compose-zone"><form className="assistant-composer" onSubmit={submit}><textarea rows={2} maxLength={4000} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={title ? "描述旅行需求或询问当前计划…" : "请先新建旅行"} disabled={!title || busy}/><button className="button primary" disabled={!title || busy || !input.trim()}>发送</button></form></div>
  </section>;
}
