import { ArrowRight, MapPin, Plus, RefreshCw, Sparkles, Trash2, WandSparkles } from "lucide-react";
import { useMemo, useState } from "react";
import type { CandidatePreference, PlanningRole, Workspace } from "./v2-types";
import { candidateRows, effectiveCandidatePlanningRole, formatDuration, resolutionStatus } from "./workspace-v2";
import { placeNamePresentation } from "./place-name-presentation";

export type WorkflowCandidateDraftV3 = {
  nameZh: string;
  planningRole: PlanningRole;
  planningAreaCandidateId: string | null;
  suggestedDurationMinutes: number | null;
};

function PreferenceButtons({ value, busy, onChange }: { value: CandidatePreference; busy: boolean; onChange: (value: CandidatePreference) => void }) {
  return <div className="phase6-preference-actions" aria-label="地点偏好">
    <button type="button" className={value === "must_go" ? "active" : ""} disabled={busy} onClick={() => onChange(value === "must_go" ? "optional" : "must_go")}>★ 必去</button>
    <button type="button" className={value === "want_to_go" ? "active" : ""} disabled={busy} onClick={() => onChange(value === "want_to_go" ? "optional" : "want_to_go")}>♡ 想去</button>
  </div>;
}

export function CandidateWorkflowPanelV3({
  mode,
  workspace,
  selectedCandidateId,
  busy,
  macroNeedsUpdate,
  onSelectCandidate,
  onSetPreference,
  onDiscover,
  onAddCandidate,
  onRemoveCandidate,
  onContinue,
  onGoToSkeleton,
  onRetry,
  onBeginMapPick,
}: {
  mode: "backbone" | "interests";
  workspace: Workspace;
  selectedCandidateId: string | null;
  busy: boolean;
  macroNeedsUpdate: boolean;
  onSelectCandidate: (candidateId: string) => void;
  onSetPreference: (candidateIds: string[], preference: CandidatePreference) => Promise<void>;
  onDiscover: () => Promise<void>;
  onAddCandidate: (draft: WorkflowCandidateDraftV3) => Promise<void>;
  onRemoveCandidate: (candidateId: string, cascade: boolean) => Promise<void>;
  onContinue: () => Promise<void>;
  onGoToSkeleton: () => void;
  onRetry: (placeIds: string[]) => Promise<void>;
  onBeginMapPick: (placeId: string) => void;
}) {
  const rows = useMemo(() => candidateRows(workspace), [workspace]);
  const planningAreas = rows.filter((row) => effectiveCandidatePlanningRole(row) === "planning_area" && row.candidate.preference !== "excluded");
  const representedAreaIds = new Set(workspace.trip.plan.days.flatMap((day) => planningAreas.filter((row) => row.place.id === day.endAnchor.placeId).map((row) => row.candidate.id)));
  const adoptedAreas = workspace.trip.plan.days.length ? planningAreas.filter((row) => representedAreaIds.has(row.candidate.id)) : planningAreas;
  const visibleRows = rows.filter((row) => {
    if (row.candidate.preference === "excluded") return false;
    const role = effectiveCandidatePlanningRole(row);
    if (mode === "backbone") return role === "planning_area" || role === "core_visit";
    return role === "detail_interest" && adoptedAreas.some((area) => area.candidate.id === row.candidate.planningAreaCandidateId);
  });
  const coreRows = rows.filter((row) => row.candidate.preference !== "excluded" && effectiveCandidatePlanningRole(row) === "core_visit" && adoptedAreas.some((area) => area.candidate.id === row.candidate.planningAreaCandidateId));
  const [adding, setAdding] = useState<null | "planning_area" | "core_visit" | "detail_interest">(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [duration, setDuration] = useState("");
  const [addError, setAddError] = useState("");

  const submitAdd = async () => {
    if (!adding || !name.trim()) return;
    const needsParent = adding !== "planning_area";
    if (needsParent && !parentId) { setAddError("请选择所属停留地点。"); return; }
    const parsed = duration.trim() ? Number(duration) : null;
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0 || parsed > 10080)) { setAddError("停留时间请输入分钟整数。"); return; }
    setAddError("");
    await onAddCandidate({ nameZh: name.trim(), planningRole: adding, planningAreaCandidateId: needsParent ? parentId : null, suggestedDurationMinutes: parsed });
    setAdding(null); setName(""); setParentId(""); setDuration("");
  };

  const renderRow = (row: typeof rows[number]) => {
    const role = effectiveCandidatePlanningRole(row);
    const status = resolutionStatus(row);
    const nameText = placeNamePresentation(row.place, workspace.trip.planLanguage);
    const roleLabel = role === "planning_area" ? "停留地点" : role === "core_visit" ? "重要游览地" : "普通景点";
    const parent = row.candidate.planningAreaCandidateId ? planningAreas.find((area) => area.candidate.id === row.candidate.planningAreaCandidateId) : null;
    const blocking = mode === "interests" && row.candidate.preference === "must_go" && status !== "resolved";
    return <article className={`phase6-candidate-card ${selectedCandidateId === row.candidate.id ? "selected" : ""} ${blocking ? "blocking" : ""}`} key={row.candidate.id} onClick={() => onSelectCandidate(row.candidate.id)}>
      <div className="phase6-candidate-copy">
        <div className="phase6-candidate-title"><strong>{nameText.primary}</strong><span>{roleLabel}</span>{row.candidate.preference === "must_go" ? <em>★ 必去</em> : row.candidate.preference === "want_to_go" ? <em>♡ 想去</em> : null}</div>
        {nameText.secondary && <small>{nameText.secondary}</small>}
        <p>{row.candidate.aiReason || (role === "planning_area" ? "用于安排住宿和路线顺序" : role === "core_visit" ? "会明显占用半天或全天，需要提前留时间" : "可按当天容量安排")}</p>
        <div className="phase6-candidate-meta">{parent && <span>属于 {parent.place.nameZh}</span>}{formatDuration(row.candidate.suggestedDurationMinutes) && <span>建议 {formatDuration(row.candidate.suggestedDurationMinutes)}</span>}<span className={status === "resolved" ? "ready" : blocking ? "blocking" : "muted"}>{status === "resolved" ? "已定位" : blocking ? "需要定位后才能安排" : "尚未定位"}</span></div>
      </div>
      <div className="phase6-candidate-controls" onClick={(event) => event.stopPropagation()}>
        <PreferenceButtons value={row.candidate.preference} busy={busy} onChange={(value) => void onSetPreference([row.candidate.id], value)}/>
        {status !== "resolved" && <div className="phase6-location-actions"><button type="button" disabled={busy} onClick={() => void onRetry([row.place.id])}><RefreshCw size={13}/>重新识别</button><button type="button" disabled={busy} onClick={() => onBeginMapPick(row.place.id)}><MapPin size={13}/>地图点选</button></div>}
        <button type="button" className="phase6-remove" disabled={busy} onClick={() => void onRemoveCandidate(row.candidate.id, role === "planning_area")}><Trash2 size={13}/>移除</button>
      </div>
    </article>;
  };

  const startAdd = (role: "planning_area" | "core_visit" | "detail_interest") => { setAdding(role); setAddError(""); setName(""); setDuration(""); setParentId((mode === "interests" ? adoptedAreas[0] : planningAreas[0])?.candidate.id ?? ""); };

  return <section className="phase6-candidate-panel">
    <header className="phase6-step-intro">
      <div><p className="eyebrow">STEP {mode === "backbone" ? "2" : "4"}</p><h2>{mode === "backbone" ? "想去哪些地方" : "补充景点"}{mode === "interests" && <span className="phase6-optional-badge">可选</span>}</h2><p>{mode === "backbone" ? "先做愿望清单：选出想考虑的停留地点和重要游览地。下一步才会根据总天数安排最终路线。" : "路线和天数已经确定。需要更多普通景点时再补充；地点已经够用也可以直接进入每日行程。"}</p></div>
      <div className="phase6-intro-actions">{mode === "backbone" ? <><button className="button small" type="button" disabled={busy} onClick={() => startAdd("planning_area")}><Plus size={14}/>添加停留地点</button>{planningAreas.length > 0 && <button className="button small" type="button" disabled={busy} onClick={() => startAdd("core_visit")}><Plus size={14}/>添加重要游览地</button>}</> : <button className="button small" type="button" disabled={busy || !adoptedAreas.length} onClick={() => startAdd("detail_interest")}><Plus size={14}/>添加普通景点</button>}</div>
    </header>

    {mode === "interests" && coreRows.length > 0 && <details className="phase6-context-details"><summary>已确定的重要游览地 · {coreRows.length} 个</summary><p>{coreRows.map((row) => row.place.nameZh).join("、")}</p><small>这些地点已经在“想去哪些地方”中确定，这里只作为每天时间容量的参考。</small></details>}
    {mode === "interests" && macroNeedsUpdate && <div className="phase6-blocking-card"><strong>路线和天数需要重新确认</strong><p>你仍可以查看和整理景点，但补充推荐暂时不可用。先确认新的路线和停留天数，再继续使用当前容量补充景点。</p><button className="button primary small" type="button" onClick={onGoToSkeleton}>去更新路线和天数</button></div>}

    <div className="phase6-candidate-list">
      {!visibleRows.length && <div className="phase6-empty"><Sparkles size={30}/><strong>{mode === "backbone" ? "还没有愿望清单" : "还没有补充普通景点"}</strong><p>{mode === "backbone" ? "可以让 AI 推荐，也可以手动添加。" : "这是正常状态：这一步可以直接跳过。"}</p></div>}
      {mode === "backbone" ? planningAreas.map((area) => {
        const children = visibleRows.filter((row) => row.candidate.planningAreaCandidateId === area.candidate.id && effectiveCandidatePlanningRole(row) === "core_visit");
        return <section className="phase6-area-group" key={area.candidate.id}>{renderRow(area)}{children.length > 0 && <div className="phase6-core-list"><small>重要游览地</small>{children.map(renderRow)}</div>}</section>;
      }) : visibleRows.map(renderRow)}
    </div>

    <footer className="phase6-step-footer">
      <button className="button" type="button" disabled={busy || (mode === "interests" && macroNeedsUpdate)} onClick={() => void onDiscover()}><WandSparkles size={15}/>{mode === "backbone" ? (visibleRows.length ? "再推荐一些" : "帮我推荐") : "帮我补充景点"}</button>
      {mode === "backbone" ? <button className="button primary" type="button" disabled={busy || !planningAreas.length} onClick={() => void onContinue()}><ArrowRight size={15}/>下一步：路线和天数</button> : macroNeedsUpdate ? <button className="button primary" type="button" onClick={onGoToSkeleton}><ArrowRight size={15}/>先确认路线和天数</button> : <button className="button primary" type="button" disabled={busy || !workspace.trip.plan.days.length} onClick={() => void onContinue()}><ArrowRight size={15}/>下一步：每日行程</button>}
    </footer>

    {adding && <div className="phase6-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAdding(null); }}><section className="phase6-dialog"><header><strong>{adding === "planning_area" ? "添加停留地点" : adding === "core_visit" ? "添加重要游览地" : "添加普通景点"}</strong><button type="button" onClick={() => setAdding(null)}>×</button></header><label>地点名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：蒂阿瑙 / 米尔福德峡湾"/></label>{adding !== "planning_area" && <label>所属停留地点<select value={parentId} onChange={(event) => setParentId(event.target.value)}>{(mode === "interests" ? adoptedAreas : planningAreas).map((area) => <option value={area.candidate.id} key={area.candidate.id}>{area.place.nameZh}</option>)}</select></label>}<label>预计停留分钟（可选）<input type="number" min="0" max="10080" value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="例如 180"/></label>{addError && <p className="inline-error">{addError}</p>}<button className="button primary" type="button" disabled={busy || !name.trim()} onClick={() => void submitAdd()}>添加</button></section></div>}
  </section>;
}
