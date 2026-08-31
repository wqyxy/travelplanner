import { ArrowRight, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import type { WorkspaceV3 } from "./v3-types";

function placeName(workspace: WorkspaceV3, placeId: string | null) {
  if (!placeId) return "未设置";
  return workspace.trip.plan.places.find((place) => place.id === placeId)?.nameZh ?? placeId;
}

function visits(workspace: WorkspaceV3) {
  const result: Array<{ placeId: string; name: string; startDay: number; endDay: number; stayDays: number }> = [];
  for (const day of workspace.trip.plan.days) {
    const placeId = day.endAnchor.placeId;
    if (!placeId) continue;
    const last = result[result.length - 1];
    if (last?.placeId === placeId) {
      last.endDay = day.dayNumber;
      last.stayDays += 1;
    } else {
      result.push({ placeId, name: placeName(workspace, placeId), startDay: day.dayNumber, endDay: day.dayNumber, stayDays: 1 });
    }
  }
  return result;
}

export function MacroItineraryPanelV3({
  workspace,
  busy,
  selectedDayId,
  onSelectDay,
  onGenerate,
  onUpdate,
  onContinue,
}: {
  workspace: WorkspaceV3;
  busy: boolean;
  selectedDayId: string | null;
  onSelectDay: (dayId: string) => void;
  onGenerate: () => void | Promise<void>;
  onUpdate: () => void | Promise<void>;
  onContinue: () => void | Promise<void>;
}) {
  const plan = workspace.trip.plan;
  const macroStatus = workspace.itineraryUpdateState.macro.status;
  const routeStates = workspace.macroRouteStates;
  const itineraryVisits = visits(workspace);

  if (!plan.days.length) return <section className="workspace-requirements-v3">
    <div><p className="eyebrow">STEP 4</p><h2>行程骨架</h2><p>这一阶段只决定目的地顺序、每个目的地停留天数，以及哪一天发生跨目的地移动。不会安排具体兴趣点。</p></div>
    <button className="button primary workspace-primary-cta-v3" type="button" disabled={busy} onClick={() => void onGenerate()}><Sparkles size={15}/>生成行程骨架</button>
  </section>;

  return <section className="workspace-requirements-v3">
    <div>
      <p className="eyebrow">STEP 4 · MACRO</p>
      <h2>行程骨架</h2>
      <p>共 {plan.days.length} 天 · {itineraryVisits.length} 个目的地。转移日计入到达目的地。</p>
    </div>

    {macroStatus === "needs_update" && <div className="workspace-warning-v3"><TriangleAlert size={16}/><div><b>行程骨架需更新</b><p>第二步目的地发生了会影响当前骨架的变化。未受影响的 Day 会保留，AI 只调整必要部分。</p></div></div>}

    <div className="macro-visits-v3">
      {itineraryVisits.map((visit, index) => <div className="macro-visit-v3" key={`${visit.placeId}:${visit.startDay}`}>
        <div><strong>{visit.name}</strong><small>Day {visit.startDay}{visit.endDay !== visit.startDay ? `–${visit.endDay}` : ""} · {visit.stayDays} 天</small></div>
        {index < itineraryVisits.length - 1 && <ArrowRight size={16}/>} 
      </div>)}
    </div>

    <div className="macro-days-v3">
      {plan.days.map((day) => {
        const transfer = day.startAnchor.placeId !== day.endAnchor.placeId;
        const route = routeStates.find((state) => state.dayId === day.id);
        const transferMode = (day as typeof day & { transferMode?: string }).transferMode ?? "none";
        return <button type="button" className={`macro-day-v3 ${selectedDayId === day.id ? "active" : ""}`} key={day.id} onClick={() => onSelectDay(day.id)}>
          <span>Day {day.dayNumber}</span>
          <b>{transfer ? `${placeName(workspace, day.startAnchor.placeId)} → ${placeName(workspace, day.endAnchor.placeId)}` : placeName(workspace, day.endAnchor.placeId)}</b>
          <small>{transfer ? `${transferMode}${route?.route?.durationMinutes != null ? ` · ${Math.round(route.route.durationMinutes)} 分钟` : route?.dirty ? " · 路线需更新" : " · 路线待定位"}` : "停留日"}</small>
        </button>;
      })}
    </div>

    <div className="workspace-primary-actions-v3">
      {macroStatus === "needs_update" ? <button className="button primary" type="button" disabled={busy} onClick={() => void onUpdate()}><Sparkles size={15}/>更新受影响骨架</button> : <button className="button" type="button" disabled={busy} onClick={() => void onUpdate()}><RefreshCw size={15}/>重新规划骨架</button>}
      <button className="button primary" type="button" disabled={busy || macroStatus === "needs_update"} onClick={() => void onContinue()}><ArrowRight size={15}/>进入第五步详细行程</button>
    </div>
  </section>;
}
