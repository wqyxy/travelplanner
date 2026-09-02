import { CheckCircle2, MapPin, RefreshCw, Route, Sparkles, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import type { Workspace } from "./v2-types";
import { formatDistance, formatRouteDuration, routeStateForDay } from "./workspace-v2";
import { placeNamePresentation } from "./place-name-presentation";

function placeName(workspace: Workspace, placeId: string | null, fallback = "地点待确认") {
  if (!placeId) return fallback;
  return placeNamePresentation(workspace.trip.plan.places.find((place) => place.id === placeId), workspace.trip.planLanguage, fallback).combined;
}

export function DailyItineraryPanelV3({
  workspace,
  selectedDayId,
  selectedStopId,
  busy,
  onSelectAll,
  onSelectDay,
  onSelectStop,
  onRecalculate,
  onRecalculateDirty,
  onImproveDay,
}: {
  workspace: Workspace;
  selectedDayId: string | null;
  selectedStopId: string | null;
  busy: boolean;
  onSelectAll: () => void;
  onSelectDay: (dayId: string) => void;
  onSelectStop: (stopId: string) => void;
  onRecalculate: (dayId: string) => Promise<void>;
  onRecalculateDirty: () => Promise<void>;
  onImproveDay: (dayIds: string[]) => Promise<void>;
}) {
  const dirtyRoutes = workspace.routeStates.filter((state) => state.dirty);
  const places = useMemo(() => new Map(workspace.trip.plan.places.map((place) => [place.id, place])), [workspace.trip.plan.places]);

  return <section className="phase6-daily-panel">
    <header className="phase6-step-intro"><div><p className="eyebrow">STEP 5</p><h2>每日行程</h2><p>这里是最终按天安排。路线和停留天数保持不变，只调整每天去哪里、先后顺序和时间。</p></div>{dirtyRoutes.length > 0 && <button className="button small" type="button" disabled={busy} onClick={() => void onRecalculateDirty()}><RefreshCw size={14}/>更新 {dirtyRoutes.length} 天地图路线</button>}</header>
    <nav className="itinerary-map-scope-v3 itinerary-map-scope-detail-v3" aria-label="每日行程范围"><button type="button" className={selectedDayId === null ? "active" : ""} onClick={onSelectAll}>全部日期</button>{workspace.trip.plan.days.map((day) => <button type="button" className={selectedDayId === day.id ? "active" : ""} key={day.id} onClick={() => onSelectDay(day.id)}>Day {day.dayNumber}</button>)}</nav>
    <div className="phase6-daily-list">
      {workspace.trip.plan.days.map((day) => {
        const state = routeStateForDay(workspace.routeStates, day.id);
        const status = day.detailLevel !== "detailed" ? "未开始" : day.detailStatus === "needs_review" ? "需更新" : "已完成";
        const selected = selectedDayId === day.id;
        return <article className={`phase6-day-card ${selected ? "selected" : ""}`} key={day.id} onClick={() => onSelectDay(day.id)}>
          <header><span>Day {day.dayNumber}</span><div><strong>{day.title}</strong><small>{day.date || "日期待定"}</small></div><em className={status === "已完成" ? "ready" : status === "需更新" ? "attention" : "idle"}>{status === "已完成" ? <CheckCircle2 size={13}/> : status === "需更新" ? <TriangleAlert size={13}/> : <Sparkles size={13}/>} {status}</em></header>
          <div className="phase6-day-anchors"><span><small>出发</small>{placeName(workspace, day.startAnchor.placeId, day.startAnchor.label || "出发地点待确认")}</span><span><small>结束</small>{placeName(workspace, day.endAnchor.placeId, day.endAnchor.label || "结束地点待确认")}</span></div>
          <div className="phase6-day-stops">{!day.stops.length ? <p>这一天还没有具体游览安排。</p> : day.stops.map((stop, index) => <button type="button" className={selectedStopId === stop.id ? "selected" : ""} key={stop.id} onClick={(event) => { event.stopPropagation(); onSelectStop(stop.id); }}><span>{stop.startTime && stop.endTime ? `${stop.startTime}–${stop.endTime}` : `${index + 1}`}</span><div><strong>{placeNamePresentation(places.get(stop.placeId), workspace.trip.planLanguage, stop.activity).combined}</strong><small>{stop.activity}{stop.durationMinutes != null ? ` · ${stop.durationMinutes} 分钟` : ""}</small></div></button>)}</div>
          <footer><div className={`phase6-route-summary ${state.dirty ? "attention" : ""}`}>{state.dirty ? <><TriangleAlert size={13}/><span>地点或顺序有变化，地图路线需要更新</span></> : state.route ? <><Route size={13}/><span>{formatDistance(state.route.distanceKm)} · {formatRouteDuration(state.route.durationMinutes)}</span></> : <><MapPin size={13}/><span>地图路线待计算</span></>}</div><div><button className="button small" type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); void onRecalculate(day.id); }}><RefreshCw size={13}/>{state.dirty || !state.route ? "更新地图路线" : "重新计算路线"}</button><button className="button small" type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); void onImproveDay([day.id]); }}><Sparkles size={13}/>{status === "已完成" ? "调整这一天" : "完善这一天"}</button></div></footer>
        </article>;
      })}
    </div>
  </section>;
}
