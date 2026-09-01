import { ArrowRight, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import type { WorkspaceV3 } from "./v3-types";
import { placeNamePresentation } from "./place-name-presentation";
import "./macro-detail-v3.css";

function placeName(workspace: WorkspaceV3, placeId: string | null) {
  if (!placeId) return "未设置";
  const place = workspace.trip.plan.places.find((item) => item.id === placeId);
  return placeNamePresentation(place, workspace.trip.planLanguage, placeId).combined;
}

export function MacroItineraryPanelV3({
  workspace,
  busy,
  selectedDayId,
  onSelectAll,
  onSelectDay,
  onGenerate,
  onUpdate,
  onRecalculate,
  onRecalculateDirty,
  onContinue,
}: {
  workspace: WorkspaceV3;
  busy: boolean;
  selectedDayId: string | null;
  onSelectAll: () => void;
  onSelectDay: (dayId: string) => void;
  onGenerate: () => void | Promise<void>;
  onUpdate: () => void | Promise<void>;
  onRecalculate: (dayId: string) => void | Promise<void>;
  onRecalculateDirty: () => void | Promise<void>;
  onContinue: () => void | Promise<void>;
}) {
  const plan = workspace.trip.plan;
  const macroStatus = workspace.itineraryUpdateState.macro.status;
  const routeStates = workspace.macroRouteStates;
  const dirtyRouteCount = routeStates.filter((state) => state.required && state.dirty).length;

  if (!plan.days.length) return <section className="workspace-requirements-v3">
    <div><p className="eyebrow">STEP 4</p><h2>行程骨架</h2><p>这一阶段只决定目的地顺序、每个目的地停留天数，以及哪一天发生跨目的地移动。不会安排具体兴趣点。</p></div>
    <button className="button primary workspace-primary-cta-v3" type="button" disabled={busy} onClick={() => void onGenerate()}><Sparkles size={15}/>生成行程骨架</button>
  </section>;

  return <section className="workspace-requirements-v3">
    {macroStatus === "needs_update" && <div className="workspace-warning-v3"><TriangleAlert size={16}/><div><b>行程骨架需更新</b><p>第二步目的地发生了会影响当前骨架的变化。未受影响的 Day 会保留，AI 只调整必要部分。</p></div></div>}

    <nav className="itinerary-map-scope-v3" aria-label="概览地图范围">
      <button type="button" className={selectedDayId === null ? "active" : ""} onClick={onSelectAll}>全览</button>
      {plan.days.map((day) => <button type="button" className={selectedDayId === day.id ? "active" : ""} key={day.id} onClick={() => onSelectDay(day.id)}>Day {day.dayNumber}</button>)}
    </nav>

    <div className="macro-days-v3">
      {plan.days.map((day) => {
        const transfer = day.startAnchor.placeId !== day.endAnchor.placeId;
        const route = routeStates.find((state) => state.dayId === day.id);
        const transferMode = (day as typeof day & { transferMode?: string }).transferMode ?? "none";
        return <div className={`macro-day-v3 ${selectedDayId === day.id ? "active" : ""}`} key={day.id} onClick={() => onSelectDay(day.id)}>
          <span>Day {day.dayNumber}</span>
          <b>{transfer ? `${placeName(workspace, day.startAnchor.placeId)} → ${placeName(workspace, day.endAnchor.placeId)}` : placeName(workspace, day.endAnchor.placeId)}</b>
          <small>{transfer ? `${transferMode}${route?.route?.durationMinutes != null ? ` · ${Math.round(route.route.durationMinutes)} 分钟` : route?.dirty ? " · 路线需更新" : " · 路线待定位"}` : "停留日"}</small>
          {transfer && <button className="button small" type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); void onRecalculate(day.id); }}><RefreshCw size={13}/>{route?.dirty || !route?.route ? "更新路线" : "重新计算"}</button>}
        </div>;
      })}
    </div>

    <div className="workspace-primary-actions-v3">
      {dirtyRouteCount > 0 && <button className="button" type="button" disabled={busy} title="只重新计算地图路线，不改变目的地顺序或停留天数" onClick={() => void onRecalculateDirty()}><RefreshCw size={15}/>更新 {dirtyRouteCount} 条 Macro 路线</button>}
      {macroStatus === "needs_update" ? <button className="button primary" type="button" disabled={busy} title="只让 AI 修补受目的地变化影响的 Day" onClick={() => void onUpdate()}><Sparkles size={15}/>更新受影响骨架</button> : <button className="button" type="button" disabled={busy} title="让 AI 重新决定整趟行程的目的地顺序和停留天数" onClick={() => void onUpdate()}><RefreshCw size={15}/>重新规划整个骨架</button>}
      <button className="button primary" type="button" disabled={busy || macroStatus === "needs_update"} onClick={() => void onContinue()}><ArrowRight size={15}/>进入第五步详细行程</button>
    </div>
    <p className="macro-actions-hint-v3">更新路线只重算地图线路；更新受影响骨架只修补受影响 Day；重新规划整个骨架会重新决定目的地顺序和停留天数。</p>
  </section>;
}
