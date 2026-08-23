import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { ItineraryLanguage, MapSnapshot, PlaceDefinition, PlanningStage, RouteDecision, TripPlan } from "./types";
import { shouldActivateSelectionKey } from "./workspace-controls";

export type MapSelection = { scope: "all" } | { scope: "day"; dayNumber: number };

const languageLabels: Array<{ value: ItineraryLanguage; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "bilingual", label: "中英" },
];

export function placeNameLines(place: PlaceDefinition | undefined, fallback: string, language: ItineraryLanguage) {
  const zh = place?.nameZh?.trim() || fallback;
  const en = place?.nameEn?.trim() || place?.nameLocal?.trim() || zh;
  if (language === "zh") return [zh];
  if (language === "en") return [en];
  return zh.toLocaleLowerCase() === en.toLocaleLowerCase() ? [zh] : [zh, en];
}

type ItineraryProps = {
  plan: TripPlan | null;
  language?: ItineraryLanguage;
  onLanguageChange?: (language: ItineraryLanguage) => void;
  unlocatedActivityIds?: ReadonlySet<string>;
  selection: MapSelection;
  onSelectAll: () => void;
  onSelectDay: (dayNumber: number) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  planningStage?: PlanningStage;
  detailProgress?: { completed: number; total: number; repairing: number; waiting: number; stopped: number; tasks: Array<{ dayNumber: number; status: string; error: string | null }> };
  decisions?: RouteDecision[];
  onConfirmOutline?: () => void;
  onDetailAction?: (action: "stop" | "resume") => void;
  onDecision?: (id: string, choice: "accept" | "reject") => void;
};

export function Itinerary({ plan, language, onLanguageChange, unlocatedActivityIds: suppliedUnlocatedActivityIds = new Set<string>(), selection, onSelectAll, onSelectDay, fullscreen, onToggleFullscreen, planningStage, detailProgress, decisions = [], onConfirmOutline, onDetailAction, onDecision }: ItineraryProps) {
  const [mapUnlocatedActivityIds, setMapUnlocatedActivityIds] = useState<ReadonlySet<string>>(new Set());
  const [savedLanguage, setSavedLanguage] = useState<ItineraryLanguage>("bilingual");
  const [planningSnapshot, setPlanningSnapshot] = useState<{ planningStage?: PlanningStage; detailProgress?: ItineraryProps["detailProgress"]; decisions: RouteDecision[] }>({ decisions: [] });
  const displayLanguage = language || savedLanguage;
  useEffect(() => {
    const update = (event: Event) => {
      const snapshot = (event as CustomEvent<MapSnapshot | null>).detail;
      if (!snapshot) { setMapUnlocatedActivityIds(new Set()); return; }
      if (snapshot.scope !== "all") return;
      setMapUnlocatedActivityIds(new Set(snapshot.entities.flatMap((entity) => entity.status === "unlocated" && entity.activityId ? [entity.activityId] : [])));
    };
    window.addEventListener("travel.map.snapshot", update);
    return () => window.removeEventListener("travel.map.snapshot", update);
  }, []);
  useEffect(() => {
    if (language) return;
    const update = (event: Event) => setSavedLanguage((event as CustomEvent<ItineraryLanguage>).detail || "bilingual");
    window.addEventListener("travel.itinerary.language", update);
    return () => window.removeEventListener("travel.itinerary.language", update);
  }, [language]);
  useEffect(() => { const update = (event: Event) => { const value = (event as CustomEvent<{ planningStage?: PlanningStage; detailProgress?: ItineraryProps["detailProgress"]; decisions?: RouteDecision[] }>).detail; setPlanningSnapshot({ ...value, decisions: value?.decisions || [] }); }; window.addEventListener("travel.planning.state", update); return () => window.removeEventListener("travel.planning.state", update); }, []);
  const changeLanguage = (next: ItineraryLanguage) => { setSavedLanguage(next); if (onLanguageChange) onLanguageChange(next); else window.dispatchEvent(new CustomEvent("travel.itinerary.language.change", { detail: next })); };
  const unlocatedActivityIds = mapUnlocatedActivityIds.size ? mapUnlocatedActivityIds : suppliedUnlocatedActivityIds;
  const visibleStage = planningStage || planningSnapshot.planningStage; const visibleProgress = detailProgress || planningSnapshot.detailProgress; const visibleDecisions = decisions.length ? decisions : planningSnapshot.decisions;
  if (!plan) return <section className="itinerary-panel empty-itinerary">告诉 AI 目的地，它会在需求足够时自动生成首版旅行方案。日期、人数和预算都可以稍后再决定。</section>;
  const keySelect = (event: KeyboardEvent, action: () => void) => { if (shouldActivateSelectionKey(event.key, event.target === event.currentTarget)) { event.preventDefault(); action(); } };
  const places = new Map((plan.places || []).map((place) => [place.id, place]));
  return <section className="itinerary-panel">
    <div className={`itinerary-head ${selection.scope === "all" ? "selected" : ""}`} role="button" tabIndex={0} onClick={onSelectAll} onKeyDown={(event) => keySelect(event, onSelectAll)}>
      <div><h2>当前行程 · {plan.tripName}</h2><p>{plan.travelerSummary} · {plan.pace}节奏 · {plan.themes.join(" / ")} · {plan.timezone}</p><p>预算：{plan.budgetNote}</p></div>
      <div className="itinerary-head-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <div className="itinerary-language" role="group" aria-label="地点名称显示语言">{languageLabels.map((item) => <button type="button" className={displayLanguage === item.value ? "active" : ""} aria-pressed={displayLanguage === item.value} onClick={() => changeLanguage(item.value)} key={item.value}>{item.label}</button>)}</div>
        <span>Codex</span>
        <button className="icon-button panel-fullscreen" type="button" title={fullscreen ? "退出行程全屏" : "行程全屏"} aria-label={fullscreen ? "退出行程全屏" : "行程全屏"} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button>
      </div>
    </div>
    {(visibleStage === "outline" || plan.warnings.includes("路线草案：确认后逐日细化")) && <div className="planning-banner"><span>路线草案已可用：确认后会每天独立细化，完成一天显示一天。</span><button className="button primary small" onClick={(event) => { event.stopPropagation(); if (onConfirmOutline) onConfirmOutline(); else window.dispatchEvent(new Event("travel.outline.confirm")); }}>确认路线并细化</button></div>}
    {visibleDecisions.filter((item) => item.status === "pending").map((decision) => <div className="route-decision" key={decision.id}><strong>{decision.question}</strong><p>{decision.impact}</p><small>系统推荐：{decision.recommendation}。未选择时将按推荐继续。</small><div><button className="button primary small" onClick={() => onDecision ? onDecision(decision.id, "accept") : window.dispatchEvent(new CustomEvent("travel.route.decision", { detail: { id: decision.id, choice: "accept" } }))}>采用推荐</button><button className="button secondary small" onClick={() => onDecision ? onDecision(decision.id, "reject") : window.dispatchEvent(new CustomEvent("travel.route.decision", { detail: { id: decision.id, choice: "reject" } }))}>调整路线</button></div></div>)}
    {["detailing","waiting_service","partial","stopped"].includes(visibleStage || "") && <div className="planning-banner"><span>已细化 {visibleProgress?.completed || 0}/{visibleProgress?.total || plan.days.length} 天{visibleProgress?.repairing ? " · AI 正在修复个别日期" : ""}{visibleProgress?.waiting || visibleStage === "waiting_service" ? " · 详细内容等待服务恢复，草案仍可用" : ""}{visibleStage === "stopped" ? " · 已停止，现有成果已保留" : ""}</span><button className="button secondary small" onClick={() => { const action = visibleStage === "stopped" ? "resume" : "stop"; if (onDetailAction) onDetailAction(action); else window.dispatchEvent(new CustomEvent("travel.detail.action", { detail: action })); }}>{visibleStage === "stopped" ? "恢复细化" : "停止细化"}</button></div>}
    {plan.days.map((day) => {
      const selected = selection.scope === "day" && selection.dayNumber === day.dayNumber;
      const choose = () => onSelectDay(day.dayNumber);
      return <article className={`day-card ${selected ? "selected" : ""}`} role="button" tabIndex={0} aria-pressed={selected} onClick={choose} onKeyDown={(event) => keySelect(event, choose)} key={day.dayNumber}>
        <h3>Day {day.dayNumber} <small>{day.date ? `${day.date} · ` : ""}{day.title}</small></h3>
        {day.activities.map((activity) => {
          const referenced = (activity.placeIds || []).map((id) => places.get(id)).filter((place): place is PlaceDefinition => Boolean(place));
          const groups = referenced.length ? referenced.map((place) => placeNameLines(place, activity.placeName, displayLanguage)) : [placeNameLines(undefined, activity.placeName, displayLanguage)];
          return <div className="activity" key={activity.id}><div><b>{activity.startTime}</b><small>{activity.endTime}</small></div><div>
            <strong className="activity-place-names">{groups.map((lines, index) => <span className="activity-place-name" key={`${activity.id}-${index}`}>{lines.map((line, lineIndex) => <span className={lineIndex ? "activity-place-english" : ""} key={`${line}-${lineIndex}`}>{line}</span>)}</span>)}{unlocatedActivityIds.has(activity.id) && <em>（未定位）</em>}</strong>
            <p>{activity.activity} · {activity.durationMinutes} 分钟</p><small>{activity.transportMode === "transit_advisory" ? "公共交通建议，未实时核验" : `${activity.transportMode} · 约 ${activity.transportMinutes} 分钟`} · {activity.costNote}</small>
          </div></div>;
        })}
      </article>;
    })}
    <footer className="warning"><strong>出发前核验：</strong>{plan.warnings.join(" ")}</footer>
  </section>;
}
