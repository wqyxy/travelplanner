import { ArrowRight, Bike, BusFront, Car, Footprints, GripVertical, Plane, Plus, RefreshCw, Route, Save, ShipWheel, Sparkles, TrainFront, Trash2, TriangleAlert } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { TransportMode } from "./v2-types";
import type { WorkspaceV3 } from "./v3-types";
import { candidateRows, effectiveCandidatePlanningRole } from "./workspace-v2";
import { skeletonDayBalanceV3, skeletonUiModelV3, type SkeletonEditDraftV3, type SkeletonStayBlockUiV3 } from "./skeleton-ui-v3";
import "./macro-detail-v3.css";

const transferLabels: Record<TransportMode, string> = {
  walk: "步行", drive: "驾车", bike: "骑行", transit: "公共交通", rail: "铁路", flight: "航班", ferry: "轮渡", none: "不需要跨区域交通",
};
const dragThreshold = 4;
type DragSnapshot = { stays: SkeletonEditDraftV3["stays"]; uiIds: string[] };
type PointerDrag = DragSnapshot & { pointerId: number; uiId: string; startX: number; startY: number; x: number; y: number; active: boolean };
type KeyboardDrag = DragSnapshot & { uiId: string };

function TransferIcon({ mode }: { mode: TransportMode }) {
  const Icon = mode === "walk" ? Footprints
    : mode === "drive" ? Car
      : mode === "bike" ? Bike
        : mode === "transit" ? BusFront
          : mode === "rail" ? TrainFront
            : mode === "flight" ? Plane
              : mode === "ferry" ? ShipWheel
                : Route;
  return <Icon size={15}/>;
}

function formatRouteMetrics(route: WorkspaceV3["macroRouteStates"][number]["route"]) {
  if (!route) return null;
  const distance = route.distanceKm == null ? null : `${route.distanceKm < 10 ? route.distanceKm.toFixed(1) : Math.round(route.distanceKm)} km`;
  const roundedMinutes = route.durationMinutes == null ? null : Math.max(0, Math.round(route.durationMinutes));
  const duration = roundedMinutes == null ? null : roundedMinutes >= 60
    ? `预计 ${Math.floor(roundedMinutes / 60)} 小时${roundedMinutes % 60 ? ` ${roundedMinutes % 60} 分钟` : ""}`
    : `预计 ${roundedMinutes} 分钟`;
  const metrics = [distance, duration].filter((value): value is string => value !== null);
  return metrics.length ? metrics.join(" · ") : "地图路线已生成";
}

export function MacroItineraryPanelV3({ workspace, busy, previewedDayId, focusedDayId, onPreviewDay, onToggleFocusDay, onSelectAll, onGenerate, onUpdate, onSaveDraft, onRecalculate, onRecalculateDirty, onContinue }: {
  workspace: WorkspaceV3;
  busy: boolean;
  previewedDayId: string | null;
  focusedDayId: string | null;
  onPreviewDay: (dayId: string | null) => void;
  onToggleFocusDay: (dayId: string) => void;
  onSelectAll: () => void;
  onGenerate: () => void | Promise<void>;
  onUpdate: () => void | Promise<void>;
  onSaveDraft?: (draft: SkeletonEditDraftV3) => Promise<void>;
  onRecalculate: (dayId: string) => void | Promise<void>;
  onRecalculateDirty: () => void | Promise<void>;
  onContinue: () => void | Promise<void>;
}) {
  const plan = workspace.trip.plan;
  const model = useMemo(() => skeletonUiModelV3(workspace as any), [workspace]);
  const uiIdCounter = useRef(0);
  const originalBlockByUiId = useRef(new Map<string, SkeletonStayBlockUiV3>());
  const createUiId = () => `stay-ui-${++uiIdCounter.current}`;
  const createUiIds = (stays: SkeletonEditDraftV3["stays"], blocks: SkeletonStayBlockUiV3[]) => {
    const ids = stays.map(() => createUiId());
    const originalBlocks = new Map<string, SkeletonStayBlockUiV3>();
    ids.forEach((id, index) => { if (blocks[index]) originalBlocks.set(id, blocks[index]); });
    originalBlockByUiId.current = originalBlocks;
    return ids;
  };
  const [draft, setDraft] = useState<SkeletonEditDraftV3>(model.draft);
  const [stayUiIds, setStayUiIds] = useState<string[]>(() => createUiIds(model.draft.stays, model.blocks));
  const stayUiIdsRef = useRef(stayUiIds);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [pointerDrag, setPointerDrag] = useState<PointerDrag | null>(null);
  const pointerDragRef = useRef<PointerDrag | null>(null);
  const [keyboardDrag, setKeyboardDrag] = useState<KeyboardDrag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  stayUiIdsRef.current = stayUiIds;
  pointerDragRef.current = pointerDrag;

  useEffect(() => {
    setDraft(model.draft);
    setStayUiIds(createUiIds(model.draft.stays, model.blocks));
    setPointerDrag(null);
    setKeyboardDrag(null);
  }, [workspace.trip.contentGeneration]);

  const rows = useMemo(() => candidateRows(workspace as any), [workspace]);
  const planningAreas = rows.filter((row) => effectiveCandidatePlanningRole(row) === "planning_area");
  const areaById = new Map(planningAreas.map((row) => [row.candidate.id, row]));
  const represented = new Set(draft.stays.map((stay) => stay.planningAreaCandidateId));
  const availableToAdd = planningAreas.filter((row) => !represented.has(row.candidate.id));
  const balance = skeletonDayBalanceV3(plan, draft);
  const changed = JSON.stringify(draft) !== JSON.stringify(model.draft);
  const macroStatus = workspace.itineraryUpdateState.macro.status;
  const routeStates = workspace.macroRouteStates;
  const dirtyRouteCount = routeStates.filter((state) => state.required && state.dirty).length;
  const origin = plan.trip.originPlaceId ? plan.places.find((place) => place.id === plan.trip.originPlaceId) ?? null : null;

  const reorderStay = (uiId: string, insertionIndex: number) => {
    const ids = stayUiIdsRef.current;
    const sourceIndex = ids.indexOf(uiId);
    if (sourceIndex < 0) return;
    const nextIds = ids.filter((id) => id !== uiId);
    const nextStays = draft.stays.filter((_, index) => index !== sourceIndex);
    const target = Math.max(0, Math.min(insertionIndex, nextIds.length));
    nextIds.splice(target, 0, uiId);
    nextStays.splice(target, 0, draft.stays[sourceIndex]);
    setStayUiIds(nextIds);
    setDraft((current) => ({ ...current, stays: nextStays }));
  };
  const restoreSnapshot = (snapshot: DragSnapshot) => {
    setStayUiIds(snapshot.uiIds);
    setDraft((current) => ({ ...current, stays: snapshot.stays }));
  };
  const insertionForPointer = (uiId: string, clientY: number) => {
    const ids = stayUiIdsRef.current.filter((id) => id !== uiId);
    for (let index = 0; index < ids.length; index += 1) {
      const rect = cardRefs.current.get(ids[index])?.getBoundingClientRect();
      if (rect && clientY < rect.top + rect.height / 2) return index;
    }
    return ids.length;
  };
  const updatePointerDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const currentDrag = pointerDragRef.current;
    if (!currentDrag || currentDrag.pointerId !== event.pointerId) return;
    const active = currentDrag.active || Math.hypot(event.clientX - currentDrag.startX, event.clientY - currentDrag.startY) >= dragThreshold;
    if (active) {
      const scrollContainer = event.currentTarget.closest<HTMLElement>(".phase6-skeleton-panel");
      const bounds = scrollContainer?.getBoundingClientRect();
      if (scrollContainer && bounds) {
        if (event.clientY < bounds.top + 48) scrollContainer.scrollBy({ top: -18 });
        else if (event.clientY > bounds.bottom - 48) scrollContainer.scrollBy({ top: 18 });
      }
      reorderStay(currentDrag.uiId, insertionForPointer(currentDrag.uiId, event.clientY));
    }
    const nextDrag = { ...currentDrag, x: event.clientX, y: event.clientY, active };
    pointerDragRef.current = nextDrag;
    setPointerDrag(nextDrag);
  };
  const updateStay = (index: number, changes: Partial<SkeletonEditDraftV3["stays"][number]>) => setDraft((current) => ({ ...current, stays: current.stays.map((stay, stayIndex) => stayIndex === index ? { ...stay, ...changes } : stay) }));
  const removeStay = (index: number) => {
    const stay = draft.stays[index];
    const area = areaById.get(stay.planningAreaCandidateId);
    if (!area) return;
    const stays = draft.stays.filter((_, stayIndex) => stayIndex !== index);
    const stillRepresented = stays.some((item) => item.planningAreaCandidateId === stay.planningAreaCandidateId);
    const omittedPlanningAreas = stillRepresented || draft.omittedPlanningAreas.some((item) => item.candidateId === stay.planningAreaCandidateId) ? draft.omittedPlanningAreas : [...draft.omittedPlanningAreas, { candidateId: stay.planningAreaCandidateId, reason: "手工调整路线时暂不安排这个候选。" }];
    const removedUiId = stayUiIdsRef.current[index];
    if (removedUiId) originalBlockByUiId.current.delete(removedUiId);
    setStayUiIds((ids) => ids.filter((_, stayIndex) => stayIndex !== index));
    setDraft({ stays, omittedPlanningAreas });
  };
  const addArea = (candidateId: string) => {
    setDraft((current) => ({ stays: [...current.stays, { planningAreaCandidateId: candidateId, stayDays: 1, transferModeFromPrevious: current.stays.length ? "drive" : "none" }], omittedPlanningAreas: current.omittedPlanningAreas.filter((item) => item.candidateId !== candidateId) }));
    setStayUiIds((ids) => [...ids, createUiId()]);
  };
  const startKeyboardDrag = (uiId: string) => {
    setKeyboardDrag({ uiId, stays: draft.stays, uiIds: stayUiIdsRef.current });
    setAnnouncement("已拿起路线卡。使用上下方向键调整位置，空格确认，Esc 取消。");
  };
  const handleDragKey = (event: React.KeyboardEvent<HTMLButtonElement>, uiId: string) => {
    if (event.key === " ") {
      event.preventDefault();
      if (keyboardDrag?.uiId === uiId) { setKeyboardDrag(null); setAnnouncement("路线顺序已确定。"); } else startKeyboardDrag(uiId);
      return;
    }
    if (event.key === "Escape" && keyboardDrag?.uiId === uiId) {
      event.preventDefault();
      restoreSnapshot(keyboardDrag);
      setKeyboardDrag(null);
      setAnnouncement("已取消路线排序。");
      return;
    }
    if (keyboardDrag?.uiId !== uiId || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const index = stayUiIdsRef.current.indexOf(uiId);
    const target = event.key === "ArrowUp" ? index - 1 : index + 1;
    if (target >= 0 && target < stayUiIdsRef.current.length) {
      reorderStay(uiId, target);
      setAnnouncement(`已移动到第 ${event.key === "ArrowUp" ? index : index + 2} 段。`);
    }
  };

  if (!plan.days.length) return <section className="phase6-skeleton-panel empty">
    <header className="phase6-step-intro"><div><p className="eyebrow">STEP 3</p><h2>路线和天数</h2><p>现在才决定最终采用哪些停留地点、先后顺序和各住几天。普通景点和每天的具体玩法留到后面。</p></div></header>
    <div className="phase6-empty"><Sparkles size={32}/><strong>还没有路线和天数安排</strong><p>你可以让 AI 先给一版，也可以回前面的步骤继续补充地点；即使信息还不完整，也不会锁住本步骤。</p></div>
    <button className="button primary workspace-primary-cta-v3" type="button" disabled={busy} onClick={() => void onGenerate()}><Sparkles size={15}/>生成路线和天数</button>
  </section>;

  const draggedStay = pointerDrag ? draft.stays[stayUiIds.indexOf(pointerDrag.uiId)] : null;
  const draggedArea = draggedStay ? areaById.get(draggedStay.planningAreaCandidateId) : null;
  return <section className="phase6-skeleton-panel">
    <header className="phase6-step-intro"><div><p className="eyebrow">STEP 3</p><h2>路线和天数</h2><p>每一张卡是一段连续停留。到达新地点的那一天属于新停留段，所以当天已经包含路上的时间。</p></div><button className="button small" type="button" onClick={onSelectAll}>查看整趟路线</button></header>
    {macroStatus === "needs_update" && <div className="phase6-update-card"><TriangleAlert size={16}/><div><strong>路线和天数可能需要更新</strong><p>前面的地点或旅行需求有变化。当前安排仍会保留，你可以继续往后规划，也可以现在让 AI 更新受影响部分。</p><details><summary>查看原因</summary><small>系统只会重新处理真正受影响的停留段；没有受到影响的日期会尽量保留。</small></details></div><button className="button primary small" disabled={busy} onClick={() => void onUpdate()}><Sparkles size={14}/>更新受影响安排</button></div>}
    <div className={`phase6-day-balance ${balance.remainingDays === 0 ? "ready" : "attention"}`}><span>旅行共 <strong>{balance.totalDays ?? "?"}</strong> 天</span><span>当前安排 <strong>{balance.allocatedDays}</strong> 天</span><b>{balance.message}</b></div>
    <div className="phase6-stay-blocks">
      {draft.stays.map((stay, index) => {
        const uiId = stayUiIds[index];
        const area = areaById.get(stay.planningAreaCandidateId);
        const originalBlock = originalBlockByUiId.current.get(uiId);
        const routeDayId = originalBlock?.dayIds[0] ?? null;
        const routeState = routeDayId ? routeStates.find((state) => state.dayId === routeDayId) : null;
        const highlighted = routeDayId !== null && (focusedDayId === routeDayId || (!focusedDayId && previewedDayId === routeDayId));
        const isDragging = pointerDrag?.uiId === uiId && pointerDrag.active;
        const hasStartConnection = index === 0 && origin !== null && origin.id !== area?.place.id;
        const hasConnection = index > 0 || hasStartConnection;
        const routeSummary = changed
          ? "保存后自动更新"
          : originalBlock && !originalBlock.resolved
            ? "地点尚未定位"
          : routeState?.dirty
            ? "地图路线需要更新"
            : routeState?.route?.status === "attention"
              ? "地图路线待确认"
              : formatRouteMetrics(routeState?.route ?? null) ?? "地图路线待计算";
        const mapInteractive = !changed && routeDayId !== null;
        const connectorHandlers = mapInteractive ? {
          onPointerEnter: () => { if (!focusedDayId) onPreviewDay(routeDayId); },
          onPointerLeave: () => { if (!focusedDayId) onPreviewDay(null); },
          onClick: () => onToggleFocusDay(routeDayId),
        } : {};
        return <Fragment key={uiId}>
          {hasConnection && <div className={`phase6-transfer-connector ${highlighted ? "selected" : ""} ${changed ? "pending" : ""}`} {...connectorHandlers}>
            <div className="phase6-transfer-rail" aria-hidden="true"><span/><TransferIcon mode={stay.transferModeFromPrevious}/><span/></div>
            <div className="phase6-transfer-content">
              {hasStartConnection && <small className="phase6-transfer-origin">从 {origin.nameZh} 出发</small>}
              <label className="phase6-transfer-control" onClick={(event) => event.stopPropagation()}><span className="sr-only">{hasStartConnection ? "前往首站的交通方式" : "前往下一地点的交通方式"}</span><select value={stay.transferModeFromPrevious} disabled={busy} onChange={(event) => updateStay(index, { transferModeFromPrevious: event.target.value as TransportMode })}>{Object.entries(transferLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
              <small className="phase6-transfer-metrics">{routeSummary}</small>
            </div>
            <button className="phase6-transfer-refresh" type="button" disabled={busy || changed || !routeDayId} title={changed ? "请先保存路线调整" : undefined} onClick={(event) => { event.stopPropagation(); if (routeDayId) void onRecalculate(routeDayId); }}><RefreshCw size={13}/>重新生成</button>
          </div>}
          <article ref={(node) => { if (node) cardRefs.current.set(uiId, node); else cardRefs.current.delete(uiId); }} className={`phase6-stay-block ${highlighted ? "selected" : ""} ${isDragging ? "dragging" : ""}`} onPointerEnter={() => { if (!focusedDayId && routeDayId) onPreviewDay(routeDayId); }} onPointerLeave={() => { if (!focusedDayId && routeDayId) onPreviewDay(null); }} onClick={() => { if (routeDayId) onToggleFocusDay(routeDayId); }}>
            <div className="phase6-stay-order"><span>{index + 1}</span><button className="phase6-stay-drag" type="button" aria-label="拖动调整顺序" aria-pressed={keyboardDrag?.uiId === uiId} title="拖动调整顺序" disabled={busy} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); const nextDrag = { uiId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, stays: draft.stays, uiIds: stayUiIdsRef.current }; pointerDragRef.current = nextDrag; setPointerDrag(nextDrag); }} onPointerMove={updatePointerDrag} onPointerUp={(event) => { if (pointerDragRef.current?.pointerId === event.pointerId) { event.currentTarget.releasePointerCapture(event.pointerId); pointerDragRef.current = null; setPointerDrag(null); } }} onPointerCancel={() => { const currentDrag = pointerDragRef.current; if (currentDrag) restoreSnapshot(currentDrag); pointerDragRef.current = null; setPointerDrag(null); }} onKeyDown={(event) => handleDragKey(event, uiId)}><GripVertical size={15}/></button></div>
            <div className="phase6-stay-copy"><div><strong>{area?.place.nameZh || stay.planningAreaCandidateId}</strong>{area?.candidate.preference === "must_go" ? <em>★ 必去</em> : area?.candidate.preference === "want_to_go" ? <em>♡ 想去</em> : area?.candidate.preference === "excluded" ? <em>不考虑</em> : null}{originalBlock && !originalBlock.resolved && <span>尚未定位</span>}</div><small>{originalBlock ? `当前对应 Day ${originalBlock.firstDayNumber}${originalBlock.lastDayNumber === originalBlock.firstDayNumber ? "" : `–${originalBlock.lastDayNumber}`}` : "保存后会重新对应日期"}</small></div>
            <label className="phase6-stay-days" onClick={(event) => event.stopPropagation()}><span>停留天数</span><input type="number" min="1" value={stay.stayDays} disabled={busy} onChange={(event) => updateStay(index, { stayDays: Math.max(1, Number(event.target.value) || 1) })}/></label>
            <button className="phase6-stay-remove" type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); removeStay(index); }}><Trash2 size={13}/>暂不安排</button>
          </article>
        </Fragment>;
      })}
    </div>
    {pointerDrag?.active && draggedArea && <div className="phase6-stay-drag-preview" style={{ left: pointerDrag.x + 14, top: pointerDrag.y + 14 }}><GripVertical size={16}/><strong>{draggedArea.place.nameZh}</strong><small>{draggedStay?.stayDays} 天</small></div>}
    <span className="sr-only" aria-live="polite">{announcement}</span>
    {availableToAdd.length > 0 && <div className="phase6-add-area"><span>还有候选没有进入当前路线</span>{availableToAdd.map((row) => <button className="button small" type="button" key={row.candidate.id} disabled={busy} onClick={() => addArea(row.candidate.id)}><Plus size={13}/>{row.place.nameZh}{row.candidate.preference === "excluded" ? " · 不考虑" : ""}</button>)}</div>}
    {draft.omittedPlanningAreas.length > 0 && <div className="phase6-omitted"><details><summary>这版路线暂未采用的候选 · {draft.omittedPlanningAreas.length}</summary>{draft.omittedPlanningAreas.map((item) => { const area = areaById.get(item.candidateId); return <div key={item.candidateId}><span>{area?.place.nameZh || item.candidateId}{area?.candidate.preference === "must_go" ? " · ★ 必去" : area?.candidate.preference === "want_to_go" ? " · ♡ 想去" : area?.candidate.preference === "excluded" ? " · 不考虑" : ""}</span><small>{item.reason}</small><button className="button small" type="button" onClick={() => addArea(item.candidateId)}>加入路线</button></div>; })}</details></div>}
    <footer className="phase6-step-footer phase6-skeleton-footer"><div><button className="button" type="button" disabled={busy} onClick={() => { setDraft(model.draft); setStayUiIds(createUiIds(model.draft.stays, model.blocks)); setKeyboardDrag(null); }}><RefreshCw size={14}/>恢复当前安排</button>{dirtyRouteCount > 0 && <button className="button" type="button" disabled={busy} onClick={() => void onRecalculateDirty()}><RefreshCw size={14}/>更新 {dirtyRouteCount} 段地图路线</button>}<button className="button" type="button" disabled={busy} onClick={() => void onUpdate()}><Sparkles size={14}/>让 AI 重新安排</button></div><div>{changed && onSaveDraft && <button className="button primary" type="button" disabled={busy} onClick={() => void onSaveDraft(draft)}><Save size={14}/>保存这个调整</button>}<button className="button primary" type="button" disabled={busy || changed} title={changed ? "请先保存或恢复当前未保存调整" : undefined} onClick={() => void onContinue()}><ArrowRight size={15}/>下一步：补充景点（可选）</button></div></footer>
  </section>;
}