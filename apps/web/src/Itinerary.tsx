import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { ItineraryLanguage, MapSnapshot, PlaceDefinition, TripPlan } from "./types";
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
};

export function Itinerary({ plan, language, onLanguageChange, unlocatedActivityIds: suppliedUnlocatedActivityIds = new Set<string>(), selection, onSelectAll, onSelectDay, fullscreen, onToggleFullscreen }: ItineraryProps) {
  const [mapUnlocatedActivityIds, setMapUnlocatedActivityIds] = useState<ReadonlySet<string>>(new Set());
  const [savedLanguage, setSavedLanguage] = useState<ItineraryLanguage>("bilingual");
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
  const changeLanguage = (next: ItineraryLanguage) => { setSavedLanguage(next); if (onLanguageChange) onLanguageChange(next); else window.dispatchEvent(new CustomEvent("travel.itinerary.language.change", { detail: next })); };
  const unlocatedActivityIds = mapUnlocatedActivityIds.size ? mapUnlocatedActivityIds : suppliedUnlocatedActivityIds;
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
