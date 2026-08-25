import { Maximize2, Minimize2 } from "lucide-react";
import { drivingMetricsForItinerary, formatRouteDistance, formatRouteDuration } from "./map-interactions";
import type { Itinerary as ItineraryData, ItineraryLanguage, MapState, Place, TransportMode, Verification } from "./types";

export type MapSelection = { scope: "all" } | { scope: "day"; dayNumber: number };
export const placeNameLines = (place: Place | undefined, fallback: string, language: ItineraryLanguage) => {
  const zh = place?.nameZh || fallback;
  const en = place?.nameEn || place?.nameLocal || zh;
  return language === "zh" ? [zh] : language === "en" ? [en] : zh === en ? [zh] : [zh, en];
};
export const itineraryStageIndex = (stage: ItineraryData["stage"]) => stage === "planning" ? 0 : stage === "draft" ? 1 : 2;

const periodLabels = { morning: "上午", afternoon: "下午", evening: "傍晚", night: "夜间", all_day: "全天" } as const;
const modeLabels: Record<TransportMode, string> = { walk: "步行", drive: "驾车", bike: "骑行", transit: "公共交通", rail: "铁路", flight: "航班", ferry: "轮渡", none: "无需交通" };
const roleLabels = { start: "开始", visit: "访问", end: "结束" } as const;
const name = (place: Place | undefined, fallback: string, language: ItineraryLanguage) => placeNameLines(place, fallback, language).join(" · ");
export const shouldShowVerification = (value: Verification | null) => value?.status === "verified";
const verification = (value: Verification | null, label?: string) => shouldShowVerification(value) ? <small className="verification verified" title={value!.checkedAt ? `核验时间：${value!.checkedAt}` : undefined}>{label ? `${label}：` : ""}已核验</small> : null;
const list = (values: string[]) => values.length ? values.join("、") : null;

export function Itinerary({ itinerary, generation, mapState, language, selection, onSelectAll, onSelectDay, onLanguageChange, fullscreen, onToggleFullscreen }: {
  itinerary: ItineraryData;
  generation: number;
  mapState: MapState | null;
  language: ItineraryLanguage;
  selection: MapSelection;
  onSelectAll: () => void;
  onSelectDay: (day: number) => void;
  onLanguageChange: (language: ItineraryLanguage) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const places = new Map(itinerary.places.map((place) => [place.id, place]));
  const driving = drivingMetricsForItinerary(itinerary, mapState, generation);
  const currentStage = itineraryStageIndex(itinerary.stage);
  const origin = itinerary.trip.originPlaceId ? places.get(itinerary.trip.originPlaceId) : undefined;
  const destinations = itinerary.trip.destinationPlaceIds.map((id) => places.get(id)).filter((place): place is Place => Boolean(place));
  const planningFacts = [
    origin ? ["出发地", name(origin, origin.nameZh, language)] : null,
    destinations.length ? ["目的地", destinations.map((place) => name(place, place.nameZh, language)).join("、")] : null,
    itinerary.trip.dates.start || itinerary.trip.dates.end ? ["日期", `${itinerary.trip.dates.start || "待定"} — ${itinerary.trip.dates.end || "待定"}`] : itinerary.trip.dates.requestedDurationDays ? ["期望天数", `${itinerary.trip.dates.requestedDurationDays} 天`] : null,
    itinerary.trip.travelers.summary ? ["同行者", itinerary.trip.travelers.summary] : null,
    itinerary.trip.budget.amount !== null ? ["预算", `${itinerary.trip.budget.amount} ${itinerary.trip.budget.currency || ""}`.trim()] : itinerary.trip.budget.note ? ["预算", itinerary.trip.budget.note] : null,
    itinerary.trip.pace ? ["节奏", itinerary.trip.pace] : null,
    list(itinerary.trip.themes) ? ["主题", list(itinerary.trip.themes)!] : null,
    list(itinerary.trip.preferences) ? ["偏好", list(itinerary.trip.preferences)!] : null,
    list(itinerary.trip.constraints) ? ["限制", list(itinerary.trip.constraints)!] : null,
  ].filter((item): item is string[] => item !== null);

  return <section className="itinerary-panel">
    <header className={`itinerary-head ${selection.scope === "all" ? "selected" : ""}`} onClick={onSelectAll} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectAll(); } }}>
      <div><h2>{itinerary.trip.title}</h2><div className="stage-rail" aria-label="行程阶段">{["开始", "初稿", "完整行程"].map((label, index) => <span className={index === currentStage ? "active" : index < currentStage ? "complete" : ""} key={label}><i/>{label}</span>)}</div></div>
      <div className="itinerary-controls" onClick={(event) => event.stopPropagation()}><select aria-label="地点名称语言" value={language} onChange={(event) => onLanguageChange(event.target.value as ItineraryLanguage)}><option value="zh">中文</option><option value="en">English</option><option value="bilingual">中英对照</option></select><button className="icon-button panel-fullscreen" type="button" aria-label={fullscreen ? "退出日程全屏" : "日程全屏"} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></div>
    </header>
    {itinerary.stage === "planning" ? <div className="planning-summary"><p>通过 AI Chat 补充旅行信息；信息足够后，AI 会先征求确认，再生成完整初稿。</p>{planningFacts.length > 0 && <dl>{planningFacts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}{itinerary.trip.assumptions.length > 0 && <div className="assumptions"><strong>透明假设</strong>{itinerary.trip.assumptions.map((item, index) => <p key={`${item.text}:${index}`}>{item.text} <small>{item.source} · {item.confidence}</small></p>)}</div>}</div> : itinerary.days.map((day) => {
      const dayDriving = driving.byDayId.get(day.id);
      const mapCurrent = mapState?.generation === generation;
      const pendingLabel = !mapCurrent || mapState?.status === "syncing" || !mapState || mapState.status === "idle" ? "驾车路线计算中" : "部分驾车路线待计算";
      return <article className={`day-card ${selection.scope === "day" && selection.dayNumber === day.dayNumber ? "selected" : ""}`} key={day.id} onClick={() => onSelectDay(day.dayNumber)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectDay(day.dayNumber); } }}>
      <h3><span>Day {day.dayNumber}</span><small>{day.date || "日期待定"} · {day.title}</small><em className={day.detailLevel}>{day.detailLevel === "detailed" ? "已细化" : "初稿"}</em>{day.detailStatus === "needs_review" && <em className="needs-review">需复核</em>}</h3>
      {dayDriving && <div className={`day-driving-metrics ${dayDriving.pending ? "pending" : ""}`}>{dayDriving.pending ? pendingLabel : `${dayDriving.estimated ? "驾车估算" : "驾车约"} ${formatRouteDistance(dayDriving.distanceKm)} · 约 ${formatRouteDuration(dayDriving.durationMinutes)}`}</div>}
      {day.stops.map((stop) => {
        const time = stop.startTime && stop.endTime ? `${stop.startTime}–${stop.endTime}` : stop.period ? periodLabels[stop.period] : "时间待定";
        const drivingMetric = driving.byStopId.get(stop.id);
        const transportMetric = stop.transportFromPrevious?.mode === "drive" && drivingMetric
          ? drivingMetric.pending ? "路线待计算" : `${formatRouteDistance(drivingMetric.distanceKm)} · 约 ${formatRouteDuration(drivingMetric.durationMinutes)}`
          : stop.transportFromPrevious?.durationMinutes !== null && stop.transportFromPrevious?.durationMinutes !== undefined ? `${stop.transportFromPrevious.durationMinutes} 分钟` : null;
        return <div className="activity" key={stop.id}>
          <div><b>{time}</b><small>{roleLabels[stop.role]}</small></div>
          <div>{stop.transportFromPrevious && <div className="transport-line"><span>{modeLabels[stop.transportFromPrevious.mode]}{transportMetric ? ` · ${transportMetric}` : ""}</span>{verification(stop.transportFromPrevious.verification)}{stop.transportFromPrevious.note && <small>{stop.transportFromPrevious.note}</small>}</div>}<strong>{name(places.get(stop.placeId), stop.activity, language)}</strong><p>{stop.activity}{stop.durationMinutes !== null ? ` · 停留 ${stop.durationMinutes} 分钟` : ""}</p>{(shouldShowVerification(stop.scheduleVerification) || shouldShowVerification(stop.costVerification)) && <div className="verification-row">{verification(stop.scheduleVerification, "日程")}{verification(stop.costVerification, "费用")}</div>}{stop.costNote && <small className="stop-note">费用：{stop.costNote}</small>}{stop.notes && <small className="stop-note">{stop.notes}</small>}</div>
        </div>;
      })}
    </article>;})}
    {itinerary.warnings.length > 0 && <footer className="warning"><strong>出发前核验：</strong>{itinerary.warnings.join(" ")}</footer>}
  </section>;
}
