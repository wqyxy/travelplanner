import { AlertTriangle, CalendarDays, CheckCircle2, Flag, Hotel, MapPin, RefreshCw, Route, Sparkles } from "lucide-react";
import type { DayAnchor, ItineraryLanguage, Place, TransportMode, Workspace } from "./v2-types";
import { formatDistance, formatRouteDuration, routeStateForDay } from "./workspace-v2";

const modeLabels: Record<TransportMode, string> = { walk: "步行", drive: "驾车", bike: "骑行", transit: "公共交通", rail: "铁路", flight: "航班", ferry: "轮渡", none: "交通待定" };
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

export function ItineraryPanelV2({ workspace, selectedDayId, busy, onSelectDay, onRecalculate, onOpenCandidates }: {
  workspace: Workspace;
  selectedDayId: string | null;
  busy: boolean;
  onSelectDay: (dayId: string) => void;
  onRecalculate: (dayId: string) => Promise<void>;
  onOpenCandidates: () => void;
}) {
  const plan = workspace.trip.plan;
  const places = new Map(plan.places.map((place) => [place.id, place]));
  if (!plan.days.length) return <section className="itinerary-v2-panel empty"><div><Sparkles size={38}/><h2>先选择地点，再生成按天行程</h2><p>地点池让你先确认“去哪里”；AI 排程只会使用你保留并完成定位的地点。</p><button className="button primary" onClick={onOpenCandidates}>返回地点选择</button></div></section>;

  return <section className="itinerary-v2-panel">
    <header className="itinerary-v2-head"><div><p className="eyebrow">PLAN & ROUTE</p><h2>按天行程</h2><small>{plan.days.length} 天 · {plan.stage === "itinerary_refinement" ? "行程细化" : "行程规划"}</small></div><div className="plan-stage-badge"><span className="complete"><CheckCircle2 size={14}/>地点选择</span><span className="active"><Route size={14}/>行程规划</span><span><CalendarDays size={14}/>细化</span></div></header>
    <div className="itinerary-v2-days">
      {plan.days.map((day) => {
        const state = routeStateForDay(workspace.routeStates, day.id);
        const route = state.route;
        const selected = selectedDayId === day.id;
        return <article className={`itinerary-day-v2 ${selected ? "selected" : ""}`} key={day.id} onClick={() => onSelectDay(day.id)}>
          <header><div className="day-number-v2"><span>DAY</span><strong>{day.dayNumber}</strong></div><div><h3>{day.title}</h3><small>{day.date || "日期待定"}</small></div><div className={`route-state-pill ${state.dirty ? "dirty" : route?.status || "idle"}`}>{state.dirty ? <><AlertTriangle size={13}/>路线有变更</> : route?.status === "ready" ? <><CheckCircle2 size={13}/>路线已更新</> : route?.status === "attention" ? <><AlertTriangle size={13}/>路线需注意</> : <><Route size={13}/>路线待生成</>}</div></header>
          <div className="day-route-summary">{route ? <><span>{formatDistance(route.distanceKm)}</span><span>{formatRouteDuration(route.durationMinutes)}</span>{route.calculatedAt && <small>更新于 {new Date(route.calculatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>}</> : <span>尚未计算当天路线</span>}<button className="button small" disabled={busy} onClick={(event) => { event.stopPropagation(); void onRecalculate(day.id); }}><RefreshCw size={13}/>{state.dirty || !route ? "更新路线" : "重新计算"}</button></div>
          <div className="day-timeline-v2">
            <div className="timeline-node anchor"><i><Hotel size={14}/></i><div><small>出发 Anchor</small><strong>{anchorName(day.startAnchor, places, workspace.trip.planLanguage)}</strong>{day.startAnchor.notes && <p>{day.startAnchor.notes}</p>}</div></div>
            {day.stops.map((stop, index) => <div className="timeline-node stop" key={stop.id}><div className="timeline-connector"><span>{stop.transportFromPrevious ? modeLabels[stop.transportFromPrevious.mode] : index === 0 ? "前往" : "交通待定"}{stop.transportFromPrevious?.durationMinutes !== null && stop.transportFromPrevious?.durationMinutes !== undefined ? ` · ${stop.transportFromPrevious.durationMinutes} 分钟` : ""}</span></div><i><MapPin size={14}/></i><div><small>{stop.startTime && stop.endTime ? `${stop.startTime}–${stop.endTime}` : stop.period ? periodLabels[stop.period] : "时间待定"}</small><strong>{placeName(places.get(stop.placeId), workspace.trip.planLanguage)}</strong><p>{stop.activity}{stop.durationMinutes !== null ? ` · 停留 ${stop.durationMinutes} 分钟` : ""}</p>{stop.notes && <em>{stop.notes}</em>}</div></div>)}
            <div className="timeline-node anchor"><div className="timeline-connector"><span>结束当天</span></div><i><Flag size={14}/></i><div><small>结束 Anchor</small><strong>{anchorName(day.endAnchor, places, workspace.trip.planLanguage)}</strong>{day.endAnchor.notes && <p>{day.endAnchor.notes}</p>}</div></div>
          </div>
          {route?.warnings.length ? <div className="day-route-warnings">{route.warnings.map((warning) => <p key={warning}><AlertTriangle size={13}/>{warning}</p>)}</div> : null}
        </article>;
      })}
    </div>
    {plan.warnings.length > 0 && <footer className="plan-warning-v2"><strong>出发前核验</strong>{plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}</footer>}
  </section>;
}
