import { ArrowDown, ArrowRight, ArrowUp, Plus, RefreshCw, Save, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TransportMode } from "./v2-types";
import type { WorkspaceV3 } from "./v3-types";
import { candidateRows, effectiveCandidatePlanningRole } from "./workspace-v2";
import { skeletonDayBalanceV3, skeletonUiModelV3, type SkeletonEditDraftV3 } from "./skeleton-ui-v3";
import "./macro-detail-v3.css";

const transferLabels: Record<TransportMode, string> = {
  walk: "步行", drive: "驾车", bike: "骑行", transit: "公共交通", rail: "铁路", flight: "航班", ferry: "轮渡", none: "不需要跨区域交通",
};

export function MacroItineraryPanelV3({
  workspace,
  busy,
  selectedDayId,
  onSelectAll,
  onSelectDay,
  onGenerate,
  onUpdate,
  onSaveDraft,
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
  onSaveDraft?: (draft: SkeletonEditDraftV3) => Promise<void>;
  onRecalculate: (dayId: string) => void | Promise<void>;
  onRecalculateDirty: () => void | Promise<void>;
  onContinue: () => void | Promise<void>;
}) {
  const plan = workspace.trip.plan;
  const model = useMemo(() => skeletonUiModelV3(workspace as any), [workspace]);
  const [draft, setDraft] = useState<SkeletonEditDraftV3>(model.draft);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState<number | null>(null);
  useEffect(() => { setDraft(model.draft); setSelectedBlockIndex(null); }, [workspace.trip.contentGeneration]);

  const rows = useMemo(() => candidateRows(workspace as any), [workspace]);
  const planningAreas = rows.filter((row) => effectiveCandidatePlanningRole(row) === "planning_area" && row.candidate.preference !== "excluded");
  const areaById = new Map(planningAreas.map((row) => [row.candidate.id, row]));
  const represented = new Set(draft.stays.map((stay) => stay.planningAreaCandidateId));
  const availableToAdd = planningAreas.filter((row) => !represented.has(row.candidate.id));
  const balance = skeletonDayBalanceV3(plan, draft);
  const omittedById = new Map(draft.omittedPlanningAreas.map((item) => [item.candidateId, item]));
  const mustGoOmitted = planningAreas.filter((row) => row.candidate.preference === "must_go" && omittedById.has(row.candidate.id));
  const fullyAccounted = planningAreas.every((row) => represented.has(row.candidate.id) || omittedById.has(row.candidate.id));
  const canSave = balance.canSave && fullyAccounted && mustGoOmitted.length === 0;
  const changed = JSON.stringify(draft) !== JSON.stringify(model.draft);
  const macroStatus = workspace.itineraryUpdateState.macro.status;
  const routeStates = workspace.macroRouteStates;
  const dirtyRouteCount = routeStates.filter((state) => state.required && state.dirty).length;

  const updateStay = (index: number, changes: Partial<SkeletonEditDraftV3["stays"][number]>) => setDraft((current) => ({ ...current, stays: current.stays.map((stay, stayIndex) => stayIndex === index ? { ...stay, ...changes } : stay) }));
  const moveStay = (index: number, offset: -1 | 1) => setDraft((current) => {
    const target = index + offset;
    if (target < 0 || target >= current.stays.length) return current;
    const stays = [...current.stays];
    const [moved] = stays.splice(index, 1);
    stays.splice(target, 0, moved);
    return { ...current, stays };
  });
  const removeStay = (index: number) => setDraft((current) => {
    const stay = current.stays[index];
    const area = areaById.get(stay.planningAreaCandidateId);
    if (!area || area.candidate.preference === "must_go") return current;
    const stays = current.stays.filter((_, stayIndex) => stayIndex !== index);
    const stillRepresented = stays.some((item) => item.planningAreaCandidateId === stay.planningAreaCandidateId);
    const omittedPlanningAreas = stillRepresented || current.omittedPlanningAreas.some((item) => item.candidateId === stay.planningAreaCandidateId)
      ? current.omittedPlanningAreas
      : [...current.omittedPlanningAreas, { candidateId: stay.planningAreaCandidateId, reason: "手工调整路线时暂不安排这个候选。" }];
    return { stays, omittedPlanningAreas };
  });
  const addArea = (candidateId: string) => setDraft((current) => ({
    stays: [...current.stays, { planningAreaCandidateId: candidateId, stayDays: 1, transferModeFromPrevious: current.stays.length ? "drive" : "none" }],
    omittedPlanningAreas: current.omittedPlanningAreas.filter((item) => item.candidateId !== candidateId),
  }));

  if (!plan.days.length) return <section className="phase6-skeleton-panel empty">
    <header className="phase6-step-intro"><div><p className="eyebrow">STEP 3</p><h2>路线和天数</h2><p>现在才决定最终采用哪些停留地点、先后顺序和各住几天。普通景点和每天的具体玩法留到后面。</p></div></header>
    <div className="phase6-empty"><Sparkles size={32}/><strong>还没有路线和天数安排</strong><p>AI 会根据总天数、必去地点和重要游览地先排出一版。</p></div>
    <button className="button primary workspace-primary-cta-v3" type="button" disabled={busy || !planningAreas.length} onClick={() => void onGenerate()}><Sparkles size={15}/>生成路线和天数</button>
  </section>;

  return <section className="phase6-skeleton-panel">
    <header className="phase6-step-intro"><div><p className="eyebrow">STEP 3</p><h2>路线和天数</h2><p>每一张卡是一段连续停留。到达新地点的那一天属于新停留段，所以当天已经包含路上的时间。</p></div><button className="button small" type="button" onClick={onSelectAll}>查看整趟路线</button></header>

    {macroStatus === "needs_update" && <div className="phase6-update-card"><TriangleAlert size={16}/><div><strong>路线和天数需要重新确认</strong><p>前面的地点或旅行需求有变化。先确认这里，后面的景点补充和每日安排才能继续使用新的时间容量。</p><details><summary>查看原因</summary><small>系统只会重新处理真正受影响的停留段；没有受到影响的日期会尽量保留。</small></details></div><button className="button primary small" disabled={busy} onClick={() => void onUpdate()}><Sparkles size={14}/>更新受影响安排</button></div>}

    <div className={`phase6-day-balance ${balance.remainingDays === 0 ? "ready" : "attention"}`}><span>旅行共 <strong>{balance.totalDays ?? "?"}</strong> 天</span><span>当前安排 <strong>{balance.allocatedDays}</strong> 天</span><b>{balance.message}</b></div>

    <div className="phase6-stay-blocks">
      {draft.stays.map((stay, index) => {
        const area = areaById.get(stay.planningAreaCandidateId);
        const originalBlock = model.blocks[index];
        const routeDayId = originalBlock?.dayIds[0] ?? null;
        const routeState = routeDayId ? routeStates.find((state) => state.dayId === routeDayId) : null;
        const selected = selectedBlockIndex === index || Boolean(selectedDayId && originalBlock?.dayIds.includes(selectedDayId));
        return <article className={`phase6-stay-block ${selected ? "selected" : ""}`} key={`${stay.planningAreaCandidateId}:${index}`} onClick={() => { setSelectedBlockIndex(index); if (routeDayId) onSelectDay(routeDayId); }}>
          <div className="phase6-stay-order"><span>{index + 1}</span><button type="button" aria-label="向前移动" disabled={busy || index === 0} onClick={(event) => { event.stopPropagation(); moveStay(index, -1); }}><ArrowUp size={13}/></button><button type="button" aria-label="向后移动" disabled={busy || index === draft.stays.length - 1} onClick={(event) => { event.stopPropagation(); moveStay(index, 1); }}><ArrowDown size={13}/></button></div>
          <div className="phase6-stay-copy"><div><strong>{area?.place.nameZh || stay.planningAreaCandidateId}</strong>{area?.candidate.preference === "must_go" ? <em>★ 必去</em> : area?.candidate.preference === "want_to_go" ? <em>♡ 想去</em> : null}{originalBlock && !originalBlock.resolved && <span>尚未定位</span>}</div><small>{originalBlock ? `当前对应 Day ${originalBlock.firstDayNumber}${originalBlock.lastDayNumber === originalBlock.firstDayNumber ? "" : `–${originalBlock.lastDayNumber}`}` : "保存后会重新对应日期"}</small></div>
          <label className="phase6-stay-days" onClick={(event) => event.stopPropagation()}><span>停留天数</span><input type="number" min="1" max="90" value={stay.stayDays} disabled={busy} onChange={(event) => updateStay(index, { stayDays: Math.max(1, Math.min(90, Number(event.target.value) || 1)) })}/></label>
          <label className="phase6-stay-transfer" onClick={(event) => event.stopPropagation()}><span>从上一站怎么来</span><select value={stay.transferModeFromPrevious} disabled={busy || index === 0} onChange={(event) => updateStay(index, { transferModeFromPrevious: event.target.value as TransportMode })}>{Object.entries(transferLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <div className="phase6-stay-route">{index === 0 ? <small>旅程起点</small> : routeState?.route?.durationMinutes != null && !routeState.dirty ? <small>地图预计 {Math.round(routeState.route.durationMinutes)} 分钟</small> : routeState?.dirty ? <small>地图路线需要更新</small> : <small>地图路线待计算</small>}{routeDayId && index > 0 && <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); void onRecalculate(routeDayId); }}><RefreshCw size={13}/>更新地图路线</button>}</div>
          {area?.candidate.preference !== "must_go" && <button className="phase6-stay-remove" type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); removeStay(index); }}><Trash2 size={13}/>暂不安排</button>}
        </article>;
      })}
    </div>

    {availableToAdd.length > 0 && <div className="phase6-add-area"><span>还有候选没有进入当前路线</span>{availableToAdd.map((row) => <button className="button small" type="button" key={row.candidate.id} disabled={busy} onClick={() => addArea(row.candidate.id)}><Plus size={13}/>{row.place.nameZh}</button>)}</div>}

    {draft.omittedPlanningAreas.length > 0 && <div className="phase6-omitted"><details><summary>这版路线暂未采用的候选 · {draft.omittedPlanningAreas.length}</summary>{draft.omittedPlanningAreas.map((item) => { const area = areaById.get(item.candidateId); return <div key={item.candidateId}><span>{area?.place.nameZh || item.candidateId}{area?.candidate.preference === "want_to_go" ? " · ♡ 想去" : ""}</span><small>{item.reason}</small><button className="button small" type="button" onClick={() => addArea(item.candidateId)}>加入路线</button></div>; })}</details></div>}

    <footer className="phase6-step-footer phase6-skeleton-footer">
      <div><button className="button" type="button" disabled={busy} onClick={() => { setDraft(model.draft); setSelectedBlockIndex(null); }}><RefreshCw size={14}/>恢复当前安排</button>{dirtyRouteCount > 0 && <button className="button" type="button" disabled={busy} onClick={() => void onRecalculateDirty()}><RefreshCw size={14}/>更新 {dirtyRouteCount} 段地图路线</button>}<button className="button" type="button" disabled={busy} onClick={() => void onUpdate()}><Sparkles size={14}/>让 AI 重新安排</button></div>
      <div>{changed && onSaveDraft && <button className="button primary" type="button" disabled={busy || !canSave} title={canSave ? undefined : balance.message} onClick={() => void onSaveDraft(draft)}><Save size={14}/>保存这个调整</button>}<button className="button primary" type="button" disabled={busy || macroStatus === "needs_update" || changed || !canSave} onClick={() => void onContinue()}><ArrowRight size={15}/>下一步：补充景点（可选）</button></div>
    </footer>
  </section>;
}
