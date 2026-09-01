import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CheckCircle2,
  Flag,
  GripVertical,
  Hotel,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  Day,
  DayAnchor,
  DayStop,
  ItineraryLanguage,
  Place,
  PlanCommand,
  TransportMode,
  TravelPlanDocument,
  Workspace,
} from "./v2-types";
import {
  buildAddStopCommand,
  buildMoveStopByOffsetCommand,
  buildMoveStopCommand,
  buildMoveStopToDayCommand,
} from "./editor-actions-v2";
import { formatDistance, formatRouteDuration, routeStateForDay } from "./workspace-v2";

const modeLabels: Record<TransportMode, string> = {
  walk: "步行",
  drive: "驾车",
  bike: "骑行",
  transit: "公共交通",
  rail: "铁路",
  flight: "航班",
  ferry: "轮渡",
  none: "交通待定",
};
const periodLabels = { morning: "上午", afternoon: "下午", evening: "傍晚", night: "晚上", all_day: "全天" } as const;

function placeName(place: Place | undefined, language: ItineraryLanguage) {
  if (!place) return "地点待定";
  if (language === "zh") return place.nameZh;
  if (language === "en") return place.nameEn || place.nameLocal || place.nameZh;
  const secondary = place.nameLocal || place.nameEn;
  return secondary && secondary !== place.nameZh ? `${place.nameZh} · ${secondary}` : place.nameZh;
}

function anchorName(anchor: DayAnchor, places: Map<string, Place>, language: ItineraryLanguage) {
  if (anchor.placeId) return placeName(places.get(anchor.placeId), language);
  return anchor.label || "Anchor 待设置";
}

function StopEditor({ stop, day, plan, places, language, busy, onCommand }: {
  stop: DayStop;
  day: Day;
  plan: TravelPlanDocument;
  places: Map<string, Place>;
  language: ItineraryLanguage;
  busy: boolean;
  onCommand: (command: PlanCommand) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState(stop.activity);
  const [duration, setDuration] = useState(stop.durationMinutes === null ? "" : String(stop.durationMinutes));
  const [mode, setMode] = useState<TransportMode | "">(stop.transportFromPrevious?.mode ?? "");
  useEffect(() => {
    setActivity(stop.activity);
    setDuration(stop.durationMinutes === null ? "" : String(stop.durationMinutes));
    setMode(stop.transportFromPrevious?.mode ?? "");
  }, [stop.activity, stop.durationMinutes, stop.transportFromPrevious?.mode]);
  const save = async () => {
    const parsedDuration = duration.trim() ? Number(duration) : null;
    if (!activity.trim()) return;
    if (parsedDuration !== null && (!Number.isInteger(parsedDuration) || parsedDuration < 0 || parsedDuration > 1440)) return;
    await onCommand({
      type: "update_day_stop",
      stopId: stop.id,
      changes: {
        activity: activity.trim(),
        durationMinutes: parsedDuration,
        transportFromPrevious: mode ? {
          mode,
          durationMinutes: stop.transportFromPrevious?.durationMinutes ?? null,
          note: stop.transportFromPrevious?.note ?? null,
          verification: { status: "estimated", checkedAt: null },
        } : null,
      },
    });
    setOpen(false);
  };
  return <div className="stop-editor-v2" onClick={(event) => event.stopPropagation()}>
    <div className="stop-editor-actions">
      <button className="icon-button compact" aria-label={`上移 ${placeName(places.get(stop.placeId), language)}`} disabled={busy || day.stops[0]?.id === stop.id} onClick={() => { const command = buildMoveStopByOffsetCommand(plan, stop.id, -1); if (command) void onCommand(command); }}><ArrowUp size={14}/></button>
      <button className="icon-button compact" aria-label={`下移 ${placeName(places.get(stop.placeId), language)}`} disabled={busy || day.stops.at(-1)?.id === stop.id} onClick={() => { const command = buildMoveStopByOffsetCommand(plan, stop.id, 1); if (command) void onCommand(command); }}><ArrowDown size={14}/></button>
      <select aria-label={`移动 ${placeName(places.get(stop.placeId), language)} 到其他日期`} value={day.id} disabled={busy} onChange={(event) => { const command = buildMoveStopToDayCommand(plan, stop.id, event.target.value); if (command) void onCommand(command); }}>
        {plan.days.map((item) => <option key={item.id} value={item.id}>Day {item.dayNumber}</option>)}
      </select>
      <button className="icon-button compact" aria-label="编辑地点安排" disabled={busy} onClick={() => setOpen((value) => !value)}><Pencil size={14}/></button>
      <button className="icon-button compact danger" aria-label="删除地点" disabled={busy} onClick={() => { if (window.confirm(`从行程中删除“${placeName(places.get(stop.placeId), language)}”？`)) void onCommand({ type: "remove_day_stop", stopId: stop.id }); }}><Trash2 size={14}/></button>
    </div>
    {open && <div className="stop-editor-form">
      <label><span>活动</span><input value={activity} disabled={busy} onChange={(event) => setActivity(event.target.value)}/></label>
      <label><span>停留分钟</span><input type="number" min="0" max="1440" value={duration} disabled={busy} onChange={(event) => setDuration(event.target.value)}/></label>
      <label><span>到达方式</span><select value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as TransportMode | "")}><option value="">待定</option>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="button small primary" disabled={busy || !activity.trim()} onClick={() => void save()}><Save size={13}/>保存修改</button>
    </div>}
  </div>;
}

export function ItineraryPanelV2({
  workspace,
  selectedDayId,
  selectedStopId,
  busy,
  onSelectDay,
  onSelectStop,
  onRecalculate,
  onRecalculateDirty,
  onRefine,
  onCommand,
}: {
  workspace: Workspace;
  selectedDayId: string | null;
  selectedStopId: string | null;
  busy: boolean;
  onSelectDay: (dayId: string) => void;
  onSelectStop: (stopId: string) => void;
  onRecalculate: (dayId: string) => Promise<void>;
  onRecalculateDirty: () => Promise<void>;
  onRefine: (dayIds?: string[]) => Promise<void>;
  onCommand: (command: PlanCommand) => Promise<void>;
}) {
  const plan = workspace.trip.plan;
  const places = useMemo(() => new Map(plan.places.map((place) => [place.id, place])), [plan.places]);
  const [dragStopId, setDragStopId] = useState<string | null>(null);
  const [addPlaceByDay, setAddPlaceByDay] = useState<Record<string, string>>({});
  const stopCards = useRef(new Map<string, HTMLElement>());
  const addableCandidates = plan.candidates.filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind !== "city");
  const dirtyStates = workspace.routeStates.filter((state) => state.dirty);
  const pendingDetailDays = plan.days.filter((day) => day.detailLevel !== "detailed" || day.detailStatus === "needs_review");

  useEffect(() => {
    if (!selectedStopId) return;
    stopCards.current.get(selectedStopId)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selectedStopId]);

  const drop = (event: DragEvent, dayId: string, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    const stopId = dragStopId || event.dataTransfer.getData("text/plain");
    setDragStopId(null);
    const command = buildMoveStopCommand(plan, stopId, dayId, index);
    if (command) void onCommand(command);
  };

  if (!plan.days.length) return <section className="itinerary-v2-panel empty"><div><Sparkles size={38}/><h2>还没有按天行程</h2><p>请使用右侧顶部“兴趣点”步骤完成地点选择并生成行程。</p></div></section>;

  return <section className="itinerary-v2-panel">
    <header className="itinerary-v2-head">
      <div><p className="eyebrow">PLAN & ROUTE</p><h2>按天行程</h2><small>{plan.days.length} 天 · 首次生成后路线会在后台逐日计算；编辑后的路线可按需更新</small></div>
      <div className="itinerary-head-actions">
        {dirtyStates.length > 0 && <button className="button small" disabled={busy} onClick={() => void onRecalculateDirty()}><RefreshCw size={13}/>更新全部变更路线 {dirtyStates.length}</button>}
        <button className="button small" disabled={busy || !pendingDetailDays.length} onClick={() => void onRefine()}><CalendarDays size={13}/>{pendingDetailDays.length ? `细化下一批（剩余 ${pendingDetailDays.length} 天）` : "细化已完成"}</button>
      </div>
    </header>
    <div className="itinerary-v2-days">
      {plan.days.map((day) => {
        const state = routeStateForDay(workspace.routeStates, day.id);
        const route = state.route;
        const selected = selectedDayId === day.id;
        const needsDetail = day.detailLevel !== "detailed" || day.detailStatus === "needs_review";
        return <article className={`itinerary-day-v2 ${selected ? "selected" : ""} ${dragStopId ? "drag-active" : ""}`} key={day.id} onClick={() => onSelectDay(day.id)} onDragOver={(event) => event.preventDefault()}>
          <header>
            <div className="day-number-v2"><span>DAY</span><strong>{day.dayNumber}</strong></div>
            <div><h3>{day.title}</h3><small>{day.date || "日期待定"} · {day.detailLevel === "detailed" ? day.detailStatus === "needs_review" ? "细化需复核" : "已细化" : "待细化"}</small></div>
            <div className={`route-state-pill ${state.dirty ? "dirty" : route?.status || "idle"}`}>{state.dirty ? <><AlertTriangle size={13}/>路线有变更</> : route?.status === "ready" ? <><CheckCircle2 size={13}/>路线已更新</> : route?.status === "attention" ? <><AlertTriangle size={13}/>路线需注意</> : <><Route size={13}/>路线待生成</>}</div>
          </header>
          <div className={`day-route-summary ${state.dirty ? "dirty" : ""}`}>
            {state.dirty
              ? <div><strong>旧路线，仅供参考</strong><span>地点、顺序或坐标已经变化；旧距离和时间不代表当前行程。</span>{route?.calculatedAt && <small>旧路线更新于 {new Date(route.calculatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>}</div>
              : route
                ? <><span>{formatDistance(route.distanceKm)}</span><span>{formatRouteDuration(route.durationMinutes)}</span>{route.calculatedAt && <small>更新于 {new Date(route.calculatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>}</>
                : <span>尚未计算当天路线</span>}
            <button className="button small" disabled={busy} onClick={(event) => { event.stopPropagation(); void onRecalculate(day.id); }}><RefreshCw size={13}/>{state.dirty || !route ? "更新路线" : "重新计算"}</button>
            <button className="button small ghost" disabled={busy || !needsDetail} onClick={(event) => { event.stopPropagation(); void onRefine([day.id]); }}><CalendarDays size={13}/>{needsDetail ? "细化此日" : "已细化"}</button>
          </div>
          <details className="day-editor-v2" onClick={(event) => event.stopPropagation()}><summary>编辑 Day 标题</summary><div className="day-editor-grid"><label><span>Day 标题</span><div className="inline-save"><input defaultValue={day.title} id={`day-title-${day.id}`} disabled={busy}/><button className="icon-button compact" aria-label="保存 Day 标题" disabled={busy} onClick={() => { const element = document.getElementById(`day-title-${day.id}`) as HTMLInputElement | null; const title = element?.value.trim(); if (title && title !== day.title) void onCommand({ type: "update_day", dayId: day.id, changes: { title } }); }}><Save size={14}/></button></div></label></div></details>
          <div className="day-timeline-v2">
            <div className="timeline-node anchor"><i><Hotel size={14}/></i><div><small>出发 Anchor</small><strong>{anchorName(day.startAnchor, places, workspace.trip.planLanguage)}</strong>{day.startAnchor.notes && <p>{day.startAnchor.notes}</p>}</div></div>
            <div className={`stop-drop-zone ${dragStopId ? "visible" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, day.id, 0)}>放到 Day {day.dayNumber} 首位</div>
            {day.stops.map((stop, index) => <div key={stop.id}>
              <div
                ref={(node) => { if (node) stopCards.current.set(stop.id, node); else stopCards.current.delete(stop.id); }}
                className={`timeline-node stop editable-stop ${selectedStopId === stop.id ? "selected" : ""}`}
                draggable={!busy}
                onClick={(event) => { event.stopPropagation(); onSelectStop(stop.id); }}
                onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", stop.id); setDragStopId(stop.id); }}
                onDragEnd={() => setDragStopId(null)}
              >
                <div className="timeline-connector"><span>{stop.transportFromPrevious ? modeLabels[stop.transportFromPrevious.mode] : index === 0 ? "前往" : "交通待定"}{stop.transportFromPrevious?.durationMinutes !== null && stop.transportFromPrevious?.durationMinutes !== undefined ? ` · ${stop.transportFromPrevious.durationMinutes} 分钟` : ""}</span></div>
                <i className="drag-handle" aria-label="拖动地点"><GripVertical size={14}/></i>
                <div className="stop-copy"><small>{stop.startTime && stop.endTime ? `${stop.startTime}–${stop.endTime}` : stop.period ? periodLabels[stop.period] : "时间待定"}</small><strong>{placeName(places.get(stop.placeId), workspace.trip.planLanguage)}</strong><p>{stop.activity}{stop.durationMinutes !== null ? ` · 停留 ${stop.durationMinutes} 分钟` : ""}</p>{stop.notes && <em>{stop.notes}</em>}</div>
                <StopEditor stop={stop} day={day} plan={plan} places={places} language={workspace.trip.planLanguage} busy={busy} onCommand={onCommand}/>
              </div>
              <div className={`stop-drop-zone ${dragStopId ? "visible" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, day.id, index + 1)}>放到此处</div>
            </div>)}
            <div className="timeline-node anchor"><div className="timeline-connector"><span>结束当天</span></div><i><Flag size={14}/></i><div><small>结束 Anchor</small><strong>{anchorName(day.endAnchor, places, workspace.trip.planLanguage)}</strong>{day.endAnchor.notes && <p>{day.endAnchor.notes}</p>}</div></div>
          </div>
          <div className="add-stop-v2" onClick={(event) => event.stopPropagation()}>
            <select value={addPlaceByDay[day.id] || ""} disabled={busy || !addableCandidates.length} onChange={(event) => setAddPlaceByDay((current) => ({ ...current, [day.id]: event.target.value }))}>
              <option value="">{addableCandidates.length ? "从地点池选择地点（允许重复到访）" : "地点池中没有可用地点"}</option>
              {addableCandidates.map((candidate) => <option key={candidate.id} value={candidate.placeId}>{placeName(places.get(candidate.placeId), workspace.trip.planLanguage)} · {candidate.preference === "must_go" ? "必去" : candidate.preference === "want_to_go" ? "想去" : "可选"}</option>)}
            </select>
            <button className="button small" disabled={busy || !addPlaceByDay[day.id]} onClick={() => { const command = buildAddStopCommand(plan, day.id, addPlaceByDay[day.id]); if (command) { void onCommand(command); setAddPlaceByDay((current) => ({ ...current, [day.id]: "" })); } }}><Plus size={13}/>添加一次到访</button>
          </div>
          {!state.dirty && route?.warnings.length ? <div className="day-route-warnings">{route.warnings.map((warning) => <p key={warning}><AlertTriangle size={13}/>{warning}</p>)}</div> : null}
        </article>;
      })}
    </div>
    {plan.warnings.length > 0 && <footer className="plan-warning-v2"><strong>出发前核验</strong>{plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}</footer>}
  </section>;
}
