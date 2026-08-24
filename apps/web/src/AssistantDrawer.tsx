import { ChevronDown, ChevronUp, LoaderCircle, Sparkles } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Chat, PlannerReply } from "./types";

export type PlannerQuickAction = { id: string; label: "开始实施初稿" | "开始细化方案" | "采用" | "不采用"; message: string; title?: string };

export function plannerQuickActions(reply: PlannerReply | null): PlannerQuickAction[] {
  if (!reply) return [];
  const actions: PlannerQuickAction[] = [];
  if (reply.nextAction === "start_draft") actions.push({ id: "start-draft", label: "开始实施初稿", message: "开始实施初稿" });
  if (reply.nextAction === "start_detail") actions.push({ id: "start-detail", label: "开始细化方案", message: "开始细化方案" });
  if (reply.suggestion) {
    actions.push({ id: `${reply.suggestion.id}:accept`, label: "采用", message: `采用建议：${reply.suggestion.text}`, title: reply.suggestion.text });
    actions.push({ id: `${reply.suggestion.id}:reject`, label: "不采用", message: `不采用建议：${reply.suggestion.text}`, title: reply.suggestion.text });
  }
  return actions;
}

export function AssistantDrawer({ title, chat, busy, error, onSend, onStop, onRetry }: {
  title: string | null;
  chat: Chat[];
  busy: boolean;
  error: string;
  onSend: (text: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onRetry: (id: string, text: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const latestAssistantId = useMemo(() => [...chat].reverse().find((row) => row.role === "assistant")?.id ?? null, [chat]);
  useEffect(() => { if (expanded) end.current?.scrollIntoView({ block: "end" }); }, [expanded, chat, busy]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy || !title) return;
    setInput("");
    void onSend(text);
  };

  if (!expanded) return <button className="assistant-bar" type="button" onClick={() => setExpanded(true)} aria-label="展开 AI Chat"><Sparkles size={17}/><span className="assistant-context-label">{title || "AI 旅行顾问"}</span><span className="assistant-bar-prompt">从这里开始规划、确认或修改行程</span>{busy && <LoaderCircle className="spin" size={16}/>}<span>展开</span><ChevronUp size={18}/></button>;

  return <section className="assistant-drawer" aria-label="AI Chat">
    <header className="assistant-head"><div><strong>{title || "AI 旅行顾问"}</strong><small>唯一规划入口</small></div><div><span className="assistant-thread-note">所有确认和修改都通过聊天完成</span><button className="icon-button" type="button" aria-label="收起 AI Chat" onClick={() => setExpanded(false)}><ChevronDown size={19}/></button></div></header>
    <div className="assistant-context">AI 会先保存已确认事实，再在你明确确认后生成初稿或开始细化。</div>
    <div className="assistant-body">
      {!chat.length && <p className="assistant-opening">描述目的地、日期、人数或预算中的任意一点即可开始。信息不足时，AI 每次只会追问一个必要问题。</p>}
      {chat.map((row) => {
        const actions = row.role === "assistant" && row.id === latestAssistantId ? plannerQuickActions(row.reply) : [];
        return <article className={`message ${row.role}`} key={row.id}>
          {row.role === "assistant" ? <ReactMarkdown>{row.content}</ReactMarkdown> : <p>{row.content}</p>}
          {row.turn && <div className={`turn-status ${row.turn.status}`}><small>{row.turn.progressMessage || row.turn.errorMessage || row.turn.status}</small>{["queued", "starting", "active"].includes(row.turn.status) && <button type="button" onClick={() => void onStop(row.id)}>停止</button>}{["failed", "interrupted"].includes(row.turn.status) && <button type="button" onClick={() => void onRetry(row.id, row.content)}>重试</button>}</div>}
          {actions.length > 0 && <div className="assistant-quick-prompts">{actions.map((action) => <button type="button" disabled={busy} key={action.id} title={action.title} onClick={() => void onSend(action.message)}>{action.label}</button>)}</div>}
        </article>;
      })}
      {error && <p className="inline-error">{error}</p>}
      <div ref={end}/>
    </div>
    <div className="assistant-compose-zone"><form className="assistant-composer" onSubmit={submit}><textarea rows={2} maxLength={4000} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={title ? "描述旅行或修改行程…" : "请先新建旅行"} disabled={!title || busy}/><button className="button primary" disabled={!input.trim() || !title || busy}>发送</button></form></div>
  </section>;
}
