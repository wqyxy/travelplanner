import { ArrowRight, Link, MapPin, Pencil, Plus, RefreshCw, Sparkles, Trash2, WandSparkles } from "lucide-react";
import { useMemo, useState } from "react";
import type { CandidatePreference, PlaceKind, PlanningRole, Workspace } from "./v2-types";
import { candidateRows, effectiveCandidatePlanningRole, formatDuration, resolutionStatus } from "./workspace-v2";
import { placeNamePresentation } from "./place-name-presentation";

export type WorkflowCandidateDraftV3 = {
  nameZh: string;
  placeKind: PlaceKind;
  planningRole: PlanningRole;
  planningAreaCandidateId: string | null;
  suggestedDurationMinutes: number | null;
};

export type WorkflowPlaceEditChangesV3 = {
  nameZh: string;
  nameLocal: string | null;
  nameEn: string | null;
  kind: PlaceKind;
};

export type GoogleMapsPreviewV3 = {
  name: string | null;
  latitude: number;
  longitude: number;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  warning: string | null;
};

type CandidateEditState = {
  placeId: string;
  displayName: string;
  nameZh: string;
  nameLocal: string;
  nameEn: string;
  kind: PlaceKind;
  googleUrl: string;
  googleLoading: boolean;
  googlePreview: GoogleMapsPreviewV3 | null;
  error: string;
};

const placeKindLabels: Record<PlaceKind, string> = {
  city: "城市",
  attraction: "景点 / 景区",
  lodging: "住宿",
  meal: "餐饮",
  airport: "机场",
  station: "车站",
  port: "港口",
  stop: "停靠点",
  waypoint: "途经点",
};

function defaultKindForRole(role: PlanningRole): PlaceKind {
  return role === "planning_area" ? "city" : "attraction";
}

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
  onFocusCandidate,
  onSetPreference,
  onDiscover,
  onAddCandidate,
  onUpdatePlace,
  onPreviewGoogleMapsLink,
  onApplyGoogleMapsLink,
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
  onFocusCandidate: (candidateId: string) => void;
  onSetPreference: (candidateIds: string[], preference: CandidatePreference) => Promise<void>;
  onDiscover: () => Promise<void>;
  onAddCandidate: (draft: WorkflowCandidateDraftV3) => Promise<void>;
  onUpdatePlace: (placeId: string, changes: WorkflowPlaceEditChangesV3) => Promise<boolean>;
  onPreviewGoogleMapsLink: (placeId: string, url: string) => Promise<GoogleMapsPreviewV3>;
  onApplyGoogleMapsLink: (placeId: string, url: string, changes: WorkflowPlaceEditChangesV3) => Promise<boolean>;
  onRemoveCandidate: (candidateId: string, cascade: boolean) => Promise<void>;
  onContinue: () => Promise<void>;
  onGoToSkeleton: () => void;
  onRetry: (placeIds: string[], force?: boolean) => Promise<boolean>;
  onBeginMapPick: (placeId: string) => void;
}) {
  const rows = useMemo(() => candidateRows(workspace), [workspace]);
  const planningAreas = rows.filter((row) => effectiveCandidatePlanningRole(row) === "planning_area");
  const visibleRows = rows.filter((row) => {
    const role = effectiveCandidatePlanningRole(row);
    if (mode === "backbone") return role === "planning_area" || role === "core_visit";
    return role === "detail_interest";
  });
  const coreRows = rows.filter((row) => effectiveCandidatePlanningRole(row) === "core_visit");
  const [adding, setAdding] = useState<null | "planning_area" | "core_visit" | "detail_interest">(null);
  const [name, setName] = useState("");
  const [placeKind, setPlaceKind] = useState<PlaceKind>("attraction");
  const [parentId, setParentId] = useState("");
  const [duration, setDuration] = useState("");
  const [addError, setAddError] = useState("");
  const [editing, setEditing] = useState<CandidateEditState | null>(null);

  const submitAdd = async () => {
    if (!adding || !name.trim()) return;
    const parsed = duration.trim() ? Number(duration) : null;
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0 || parsed > 10080)) { setAddError("停留时间请输入分钟整数。"); return; }
    setAddError("");
    await onAddCandidate({ nameZh: name.trim(), placeKind, planningRole: adding, planningAreaCandidateId: adding === "planning_area" ? null : (parentId || null), suggestedDurationMinutes: parsed });
    setAdding(null); setName(""); setParentId(""); setDuration("");
  };

  const openEdit = (row: typeof rows[number]) => {
    setEditing({
      placeId: row.place.id,
      displayName: placeNamePresentation(row.place, workspace.trip.planLanguage).primary,
      nameZh: row.place.nameZh,
      nameLocal: row.place.nameLocal ?? "",
      nameEn: row.place.nameEn ?? "",
      kind: row.place.kind,
      googleUrl: "",
      googleLoading: false,
      googlePreview: null,
      error: "",
    });
  };
  const placeChanges = (value: CandidateEditState): WorkflowPlaceEditChangesV3 => ({
    nameZh: value.nameZh.trim(),
    nameLocal: value.nameLocal.trim() || null,
    nameEn: value.nameEn.trim() || null,
    kind: value.kind,
  });
  const saveNames = async () => {
    if (!editing) return;
    const changes = placeChanges(editing);
    if (!changes.nameZh) { setEditing({ ...editing, error: "请输入地点中文名称。" }); return; }
    try {
      if (!await onUpdatePlace(editing.placeId, changes)) { setEditing({ ...editing, error: "无法保存地点信息。" }); return; }
      setEditing(null);
    } catch (error) { setEditing({ ...editing, error: error instanceof Error ? error.message : "无法保存地点信息。" }); }
  };
  const previewGoogleMapsLink = async () => {
    if (!editing) return;
    const url = editing.googleUrl.trim();
    if (!url) { setEditing({ ...editing, error: "请粘贴单个地点的 Google Maps 分享链接。" }); return; }
    setEditing({ ...editing, googleLoading: true, googlePreview: null, error: "" });
    try {
      const preview = await onPreviewGoogleMapsLink(editing.placeId, url);
      setEditing((current) => current?.placeId === editing.placeId ? { ...current, googleLoading: false, googlePreview: preview, error: "" } : current);
    } catch (error) {
      setEditing((current) => current?.placeId === editing.placeId ? { ...current, googleLoading: false, googlePreview: null, error: error instanceof Error ? error.message : "无法解析 Google Maps 链接。" } : current);
    }
  };
  const applyGoogleMapsLink = async () => {
    if (!editing?.googlePreview) return;
    const changes = placeChanges(editing);
    if (!changes.nameZh) { setEditing({ ...editing, error: "请输入地点中文名称。" }); return; }
    try {
      if (!await onApplyGoogleMapsLink(editing.placeId, editing.googleUrl, changes)) { setEditing({ ...editing, error: "无法通过 Google Maps 链接保存地点。" }); return; }
      setEditing(null);
    } catch (error) { setEditing({ ...editing, error: error instanceof Error ? error.message : "无法通过 Google Maps 链接保存地点。" }); }
  };
  const forceRelocate = async () => {
    if (!editing) return;
    try {
      if (!await onRetry([editing.placeId], true)) { setEditing({ ...editing, error: "无法重新定位地点。" }); return; }
      setEditing(null);
    } catch (error) { setEditing({ ...editing, error: error instanceof Error ? error.message : "无法重新定位地点。" }); }
  };

  const confirmRemoval = (row: typeof rows[number], role: PlanningRole) => {
    if (role === "detail_interest") return true;
    const childCount = rows.filter((item) => item.candidate.planningAreaCandidateId === row.candidate.id).length;
    const affectedDays = workspace.trip.plan.days.filter((day) => day.startAnchor.placeId === row.place.id || day.endAnchor.placeId === row.place.id).length;
    if (role === "planning_area") {
      const impacts = [childCount ? `${childCount} 个所属游览地` : "", affectedDays ? `${affectedDays} 天现有路线` : ""].filter(Boolean).join("、");
      return window.confirm(`移除“${row.place.nameZh}”${impacts ? `会同时影响 ${impacts}` : "会改变候选路线"}。确认移除吗？`);
    }
    if (workspace.trip.plan.days.length || row.candidate.preference === "must_go") return window.confirm(`移除重要游览地“${row.place.nameZh}”可能影响已经安排的时间容量。确认移除吗？`);
    return true;
  };

  const renderRow = (row: typeof rows[number]) => {
    const role = effectiveCandidatePlanningRole(row);
    const status = resolutionStatus(row);
    const nameText = placeNamePresentation(row.place, workspace.trip.planLanguage);
    const roleLabel = role === "planning_area" ? "停留地点" : role === "core_visit" ? "重要游览地" : "普通景点";
    const parent = row.candidate.planningAreaCandidateId ? planningAreas.find((area) => area.candidate.id === row.candidate.planningAreaCandidateId) : null;
    const selected = selectedCandidateId === row.candidate.id;
    return <article className={`phase6-candidate-card ${selected ? "selected" : ""}`} key={row.candidate.id} onClick={() => selected ? onFocusCandidate(row.candidate.id) : onSelectCandidate(row.candidate.id)}>
      <div className="phase6-candidate-copy">
        <div className="phase6-candidate-title"><strong>{nameText.primary}</strong><span>{roleLabel}</span>{row.candidate.preference === "must_go" ? <em>★ 必去</em> : row.candidate.preference === "want_to_go" ? <em>♡ 想去</em> : row.candidate.preference === "excluded" ? <em>不考虑</em> : null}</div>
        {nameText.secondary && <small>{nameText.secondary}</small>}
        <p>{row.candidate.aiReason || (role === "planning_area" ? "用于安排住宿和路线顺序" : role === "core_visit" ? "会明显占用半天或全天，需要提前留时间" : "可按当天容量安排")}</p>
        <div className="phase6-candidate-meta"><span>{placeKindLabels[row.place.kind]}</span>{parent ? <span>属于 {parent.place.nameZh}</span> : role !== "planning_area" ? <span>尚未归入路线区域</span> : null}{formatDuration(row.candidate.suggestedDurationMinutes) && <span>建议 {formatDuration(row.candidate.suggestedDurationMinutes)}</span>}<span className={status === "resolved" ? "ready" : "muted"}>{status === "resolved" ? "已定位" : "尚未定位 · 仍可继续规划"}</span></div>
      </div>
      <div className="phase6-candidate-controls" onClick={(event) => event.stopPropagation()}>
        <PreferenceButtons value={row.candidate.preference} busy={busy} onChange={(value) => void onSetPreference([row.candidate.id], value)}/>
        <div className="phase6-candidate-management-actions">
          <button type="button" className="phase6-edit" disabled={busy} onClick={() => openEdit(row)}><Pencil size={13}/>编辑</button>
          <button type="button" className="phase6-remove" disabled={busy} onClick={() => { if (confirmRemoval(row, role)) void onRemoveCandidate(row.candidate.id, role === "planning_area"); }}><Trash2 size={13}/>移除</button>
        </div>
      </div>
    </article>;
  };

  const startAdd = (role: "planning_area" | "core_visit" | "detail_interest") => { setAdding(role); setPlaceKind(defaultKindForRole(role)); setAddError(""); setName(""); setDuration(""); setParentId(planningAreas[0]?.candidate.id ?? ""); };

  return <section className="phase6-candidate-panel">
    <header className="phase6-step-intro">
      <div><p className="eyebrow">STEP {mode === "backbone" ? "2" : "4"}</p><h2>{mode === "backbone" ? "想去哪些地方" : "补充景点"}{mode === "interests" && <span className="phase6-optional-badge">可选</span>}</h2><p>{mode === "backbone" ? "先做愿望清单：选出想考虑的停留地点和重要游览地。地点类型和它在旅行里的规划角色彼此独立。" : "这里是可选的景点补充区。路线未确认、地点未定位或暂时没有父区域，都不影响你继续添加、研究或进入每日行程。"}</p></div>
      <div className="phase6-intro-actions">{mode === "backbone" ? <><button className="button small" type="button" disabled={busy} onClick={() => startAdd("planning_area")}><Plus size={14}/>添加停留地点</button><button className="button small" type="button" disabled={busy} onClick={() => startAdd("core_visit")}><Plus size={14}/>添加重要游览地</button></> : <button className="button small" type="button" disabled={busy} onClick={() => startAdd("detail_interest")}><Plus size={14}/>添加普通景点</button>}</div>
    </header>

    {mode === "interests" && coreRows.length > 0 && <details className="phase6-context-details"><summary>已有重要游览地 · {coreRows.length} 个</summary><p>{coreRows.map((row) => row.place.nameZh).join("、")}</p><small>这些地点来自“想去哪些地方”，这里只作为每日时间容量的参考；即使当前路线尚未采用它们，也不会从计划中消失。</small></details>}

    {mode === "interests" && macroNeedsUpdate && <div className="phase6-update-card"><strong>路线和天数可能需要重新确认</strong><p>当前景点仍然保留，你也可以继续补充。需要时再回第 3 步更新路线和停留天数。</p><button className="button small" type="button" onClick={onGoToSkeleton}>查看路线和天数</button></div>}

    <div className="phase6-candidate-list">
      {!visibleRows.length && <div className="phase6-empty"><Sparkles size={30}/><strong>{mode === "backbone" ? "还没有愿望清单" : "还没有补充普通景点"}</strong><p>{mode === "backbone" ? "可以让 AI 推荐，也可以手动添加。" : "这是正常状态：这一步可以直接跳过，也可以随时补充。"}</p></div>}
      {mode === "backbone" ? planningAreas.map((area) => {
        const children = visibleRows.filter((row) => row.candidate.planningAreaCandidateId === area.candidate.id && effectiveCandidatePlanningRole(row) === "core_visit");
        return <section className="phase6-area-group" key={area.candidate.id}>{renderRow(area)}{children.length > 0 && <div className="phase6-core-list"><small>重要游览地</small>{children.map(renderRow)}</div>}</section>;
      }) : visibleRows.map(renderRow)}
    </div>

    <footer className="phase6-step-footer">
      <button className="button" type="button" disabled={busy} onClick={() => void onDiscover()}><WandSparkles size={15}/>{mode === "backbone" ? (visibleRows.length ? "再推荐一些" : "帮我推荐") : "帮我补充景点"}</button>
      {mode === "backbone" ? <button className="button primary" type="button" disabled={busy} onClick={() => void onContinue()}><ArrowRight size={15}/>下一步：路线和天数</button> : <button className="button primary" type="button" disabled={busy} onClick={() => void onContinue()}><ArrowRight size={15}/>下一步：每日行程</button>}
    </footer>

    {adding && <div className="phase6-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAdding(null); }}><section className="phase6-dialog"><header><strong>{adding === "planning_area" ? "添加停留地点" : adding === "core_visit" ? "添加重要游览地" : "添加普通景点"}</strong><button type="button" onClick={() => setAdding(null)}>×</button></header><label>地点名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：蒂阿瑙 / 米尔福德峡湾"/></label><label>地点类型<select value={placeKind} onChange={(event) => setPlaceKind(event.target.value as PlaceKind)}>{Object.entries(placeKindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>地点类型描述现实世界中的地点，不决定它在旅行中扮演的规划角色。</small></label>{adding !== "planning_area" && <label>所属停留地点（可选）<select value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">暂不归类</option>{planningAreas.map((area) => <option value={area.candidate.id} key={area.candidate.id}>{area.place.nameZh}{area.candidate.preference === "excluded" ? " · 不考虑" : ""}</option>)}</select></label>}<label>预计停留分钟（可选）<input type="number" min="0" max="10080" value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="例如 180"/></label>{addError && <p className="inline-error">{addError}</p>}<button className="button primary" type="button" disabled={busy || !name.trim()} onClick={() => void submitAdd()}>添加</button></section></div>}
    {editing && <div className="phase6-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null); }}>
      <section className="phase6-dialog phase6-candidate-edit-dialog" aria-label={`编辑${editing.displayName}`}>
        <header><div><strong>编辑地点</strong><small>{editing.displayName}</small></div><button type="button" aria-label="关闭编辑" onClick={() => setEditing(null)}>×</button></header>
        <label>中文名称<input autoFocus value={editing.nameZh} onChange={(event) => setEditing({ ...editing, nameZh: event.target.value, error: "" })}/></label>
        <label>本地名称（可选）<input value={editing.nameLocal} onChange={(event) => setEditing({ ...editing, nameLocal: event.target.value, error: "" })}/></label>
        <label>英文名称（可选）<input value={editing.nameEn} onChange={(event) => setEditing({ ...editing, nameEn: event.target.value, error: "" })}/></label>
        <label>地点类型<select value={editing.kind} onChange={(event) => setEditing({ ...editing, kind: event.target.value as PlaceKind, error: "" })}>{Object.entries(placeKindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>修改地点类型不会改变 Candidate 的 planningRole。</small></label>
        <section className="phase6-location-editor">
          <div><strong>更新位置</strong><small>地点信息保存与位置更新互不覆盖。</small></div>
          <div className="phase6-location-editor-actions">
            <button className="button small" type="button" disabled={busy} onClick={() => void forceRelocate()}><RefreshCw size={13}/>重新定位</button>
            <button className="button small" type="button" disabled={busy} onClick={() => { const placeId = editing.placeId; setEditing(null); onBeginMapPick(placeId); }}><MapPin size={13}/>地图点选</button>
          </div>
          <label>Google Maps 分享链接<input value={editing.googleUrl} onChange={(event) => setEditing({ ...editing, googleUrl: event.target.value, googlePreview: null, error: "" })} placeholder="https://maps.google.com/..."/></label>
          <button className="button small" type="button" disabled={busy || editing.googleLoading} onClick={() => void previewGoogleMapsLink()}><Link size={13}/>{editing.googleLoading ? "正在解析…" : "预览链接"}</button>
          {editing.googlePreview && <div className="phase6-google-preview"><strong>{editing.googlePreview.name || "已读取地点坐标"}</strong><span>{editing.googlePreview.latitude.toFixed(6)}, {editing.googlePreview.longitude.toFixed(6)}</span>{editing.googlePreview.address && <small>{editing.googlePreview.address}</small>}{editing.googlePreview.warning && <small className="warning">{editing.googlePreview.warning}</small>}<button className="button small primary" type="button" disabled={busy} onClick={() => void applyGoogleMapsLink()}>使用此链接定位</button></div>}
        </section>
        {editing.error && <p className="inline-error">{editing.error}</p>}
        <footer><button className="button" type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="button primary" type="button" disabled={busy} onClick={() => void saveNames()}>保存地点信息</button></footer>
      </section>
    </div>}
  </section>;
}