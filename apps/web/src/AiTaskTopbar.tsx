import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, CircleStop, MapPinned, Route } from "lucide-react";
import type { AiTaskV3 } from "./v3-types";

const ACTIVE = new Set(["starting", "running", "waiting", "reconnecting"]);
const TASK_LIMIT = 12;
const statusLabels: Record<string, string> = { starting: "准备中", running: "进行中", waiting: "等待结果", reconnecting: "重新连接", completed: "已完成", failed: "未完成", stopped: "已停止", cancelled_by_generation: "计划变化，已停止" };
const actionLabels: Record<string, string> = {
  "destination.generate": "推荐想去的地方", "destination.add": "新增地点", "destination.remove": "移除地点", "destination.replace": "替换地点", "destination.edit": "修改地点", "destination.preference": "调整地点偏好",
  "itinerary.generate": "生成路线和天数", "itinerary.replan": "更新路线和天数",
  "interest.discover": "补充普通景点", "interest.supplement": "补充普通景点", "interest.add": "新增普通景点", "interest.remove": "移除普通景点", "interest.replace": "替换普通景点", "interest.edit": "修改普通景点", "interest.preference": "调整景点偏好",
  "itinerary.detail.generate": "生成每日行程", "itinerary.detail.update": "更新受影响日期", "itinerary.refine": "完善当天安排", "itinerary.day.optimize": "优化当天顺序", "itinerary.repair": "修复当天安排", "itinerary.verify": "核验动态信息",
  "requirements.update": "保存旅行需求", "requirements.clear": "更新旅行需求", "requirements.capture": "记录补充需求",
};
const stageLabels: Record<string, string> = { requirements: "旅行需求", destinations: "地点与路线", interests: "补充景点", itinerary: "每日行程" };
const elapsed = (startedAt: string, updatedAt: string, active: boolean) => { const end = active ? Date.now() : new Date(updatedAt).getTime(); const seconds = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1000)); if (seconds < 60) return `${seconds} 秒`; return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; };

function publicTaskLabel(task: AiTaskV3) {
  if (task.agent === "map") return task.label.includes("Macro") ? "计算区域间路线" : "计算地图路线";
  const actionType = typeof task.metadata?.actionType === "string" ? task.metadata.actionType : "";
  if (actionType) return actionLabels[actionType] ?? "调整旅行计划";
  const stage = typeof task.metadata?.stage === "string" ? task.metadata.stage : "";
  if (stage) return `${stageLabels[stage] ?? "旅行"}助手`;
  return "AI 助手";
}

function publicTaskSummary(task: AiTaskV3) {
  if (task.agent === "map") return task.summary.replace(/Macro/giu, "区域间").replace(/attention/giu, "需处理").replace(/ready/giu, "已完成");
  if (ACTIVE.has(task.status)) return `正在${publicTaskLabel(task)}`;
  if (task.status === "completed") return `${publicTaskLabel(task)}已完成`;
  if (task.status === "failed") return task.lastError || `${publicTaskLabel(task)}未完成`;
  return statusLabels[task.status] || "状态已更新";
}

export function getAiTaskTopbarState(tasks: AiTaskV3[]) {
  const sorted = [...tasks].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const activeTasks = sorted.filter((task) => ACTIVE.has(task.status));
  const historyTasks = sorted.filter((task) => !ACTIVE.has(task.status));
  const visible = [...activeTasks, ...historyTasks.slice(0, Math.max(0, TASK_LIMIT - activeTasks.length))];
  return { visible, selected: activeTasks[0] ?? historyTasks[0] ?? null, activeCount: activeTasks.length };
}

export function AiTaskTopbar({ tasks, onStop }: { tasks: AiTaskV3[]; onStop: (taskId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false); const [, tick] = useState(0);
  const { visible, selected, activeCount } = useMemo(() => getAiTaskTopbarState(tasks), [tasks]);
  useEffect(() => { const timer = window.setInterval(() => tick((value) => value + 1), 1000); return () => window.clearInterval(timer); }, []);
  if (!selected) return null; const active = ACTIVE.has(selected.status);
  return <div className="ai-task-topbar">
    <button className={`ai-task-trigger ${selected.status}`} onClick={() => setOpen((value) => !value)} aria-expanded={open} title="查看 AI 进度">
      <span className="ai-task-agent-icon">{selected.agent === "map" ? <MapPinned size={15}/> : <Bot size={15}/>}</span><span className="ai-task-running-line"><b>{publicTaskLabel(selected)}</b><span>{statusLabels[selected.status]} · {publicTaskSummary(selected)}</span></span><time>{elapsed(selected.startedAt, selected.updatedAt, active)}</time>{activeCount > 1 && <em>+{activeCount - 1}</em>}<ChevronDown size={14}/>
    </button>
    {open && <section className="ai-task-popover"><header><div><strong>AI 进度</strong><small>这里只显示可以直接理解的公开进度。</small></div><button className="icon-button" onClick={() => setOpen(false)}>×</button></header><div className="ai-task-list">{visible.map((task) => <article key={task.id} className={`ai-task-card ${task.status}`}><div className="ai-task-card-head"><span>{task.agent === "map" ? <MapPinned size={15}/> : <Route size={15}/>}<b>{publicTaskLabel(task)}</b><i>{statusLabels[task.status]}</i></span><time>{elapsed(task.startedAt, task.updatedAt, ACTIVE.has(task.status))}</time></div><p>{publicTaskSummary(task)}</p>{task.agent === "map" && <ol>{task.events.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span>{event.summary.replace(/Macro/giu, "区域间").replace(/attention/giu, "需处理").replace(/ready/giu, "已完成")}</span></li>)}</ol>}{task.canStop && ACTIVE.has(task.status) && <button className="ai-task-stop" onClick={() => void onStop(task.id)}><CircleStop size={14}/>停止任务</button>}</article>)}</div></section>}
  </div>;
}
