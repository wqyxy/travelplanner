import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, CircleStop, MapPinned, Route } from "lucide-react";
import type { AiTask } from "./v2-types";

const ACTIVE = new Set(["starting", "running", "waiting", "reconnecting"]);
const TASK_LIMIT = 12;
const labels: Record<string, string> = { starting: "启动中", running: "进行中", waiting: "后台解析", reconnecting: "重连中", completed: "已完成", failed: "失败", stopped: "已停止", cancelled_by_generation: "已被新版本取代" };
const elapsed = (startedAt: string, updatedAt: string, active: boolean) => { const end = active ? Date.now() : new Date(updatedAt).getTime(); const seconds = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1000)); if (seconds < 60) return `${seconds} 秒`; return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; };

export function getAiTaskTopbarState(tasks: AiTask[]) {
  const sorted = [...tasks].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const activeTasks = sorted.filter((task) => ACTIVE.has(task.status));
  const historyTasks = sorted.filter((task) => !ACTIVE.has(task.status));
  const visible = [...activeTasks, ...historyTasks.slice(0, Math.max(0, TASK_LIMIT - activeTasks.length))];
  return { visible, selected: activeTasks[0] ?? historyTasks[0] ?? null, activeCount: activeTasks.length };
}

export function AiTaskTopbar({ tasks, onStop }: { tasks: AiTask[]; onStop: (taskId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false); const [, tick] = useState(0);
  const { visible, selected, activeCount } = useMemo(() => getAiTaskTopbarState(tasks), [tasks]);
  useEffect(() => { const timer = window.setInterval(() => tick((value) => value + 1), 1000); return () => window.clearInterval(timer); }, []);
  if (!selected) return null; const active = ACTIVE.has(selected.status);
  return <div className="ai-task-topbar">
    <button className={`ai-task-trigger ${selected.status}`} onClick={() => setOpen((value) => !value)} aria-expanded={open} title="查看 AI 公开进度">
      <span className="ai-task-agent-icon">{selected.agent === "map" ? <MapPinned size={15}/> : <Bot size={15}/>}</span><span className="ai-task-running-line"><b>{selected.label}</b><span>{labels[selected.status]} · {selected.summary}</span></span><time>{elapsed(selected.startedAt, selected.updatedAt, active)}</time>{activeCount > 1 && <em>+{activeCount - 1}</em>}<ChevronDown size={14}/>
    </button>
    {open && <section className="ai-task-popover"><header><div><strong>AI 公开进度</strong><small>公开摘要、计划和执行阶段；不包含隐藏推理</small></div><button className="icon-button" onClick={() => setOpen(false)}>×</button></header><div className="ai-task-list">{visible.map((task) => <article key={task.id} className={`ai-task-card ${task.status}`}><div className="ai-task-card-head"><span>{task.agent === "map" ? <MapPinned size={15}/> : <Route size={15}/>}<b>{task.label}</b><i>{labels[task.status]}</i></span><time>{elapsed(task.startedAt, task.updatedAt, ACTIVE.has(task.status))}</time></div><p>{task.summary}</p><ol>{task.events.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span>{event.summary}</span></li>)}</ol>{task.canStop && ACTIVE.has(task.status) && <button className="ai-task-stop" onClick={() => void onStop(task.id)}><CircleStop size={14}/>停止任务</button>}</article>)}</div></section>}
  </div>;
}
