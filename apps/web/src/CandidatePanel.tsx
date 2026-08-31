import { Check, ChevronRight, LocateFixed, MapPin, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CandidatePreference, Place, PlaceKind, ProviderPlaceCandidate, Workspace } from "./v2-types";
import {
  candidateAreaGroups,
  candidateCounts,
  candidateRows,
  filterCandidateRows,
  formatDuration,
  resolutionStatus,
  selectedUnresolvedRows,
  type CandidateFilter,
  type CandidateRow,
} from "./workspace-v2";

const preferenceLabels: Record<CandidatePreference, string> = { must_go: "必去", want_to_go: "想去", optional: "可选", excluded: "不去" };
const preferenceMarks: Record<CandidatePreference, string> = { must_go: "★", want_to_go: "✓", optional: "○", excluded: "×" };
const filterLabels: Record<CandidateFilter, string> = { all: "全部", must_go: "必去", want_to_go: "想去", optional: "可选", excluded: "不去", unresolved: "未定位" };
const kindLabels: Record<PlaceKind, string> = {
  city: "城市",
  attraction: "景点",
  lodging: "住宿",
  meal: "餐饮",
  airport: "机场",
  station: "车站",
  port: "港口",
  stop: "停靠点",
  waypoint: "途经点",
};

type ManualDraft = { placeId: string; name: string; latitude: string; longitude: string; address: string };
type ChoiceState = { placeId: string; loading: boolean; candidates: ProviderPlaceCandidate[]; error: string } | null;
type EditDraft = Pick<Place, "id" | "nameZh" | "nameLocal" | "nameEn" | "kind" | "city" | "region" | "country" | "countryCode">;
type DeleteState = { row: CandidateRow; descendantRows: CandidateRow[]; affectedDays: Array<{ id: string; dayNumber: number; title: string; nodeCount: number }> } | null;

export type PlaceEditChanges = Pick<Place, "nameZh" | "nameLocal" | "nameEn" | "city" | "region" | "country" | "countryCode">;

type NewCandidateForm = {
  nameZh: string;
  nameLocal: string;
  nameEn: string;
  kind: PlaceKind;
  city: string;
  region: string;
  country: string;
  countryCode: string;
  duration: string;
  tags: string;
  planningAreaCandidateId: string;
};

export type NewCandidateDraft = {
  nameZh: string;
  nameLocal: string;
  nameEn: string;
  kind: PlaceKind;
  city: string;
  region: string;
  country: string;
  countryCode: string;
  suggestedDurationMinutes: number | null;
  tags: string[];
  planningAreaCandidateId: string | null;
};

const emptyCandidateForm = (kind: PlaceKind = "attraction"): NewCandidateForm => ({
  nameZh: "",
  nameLocal: "",
  nameEn: "",
  kind,
  city: "",
  region: "",
  country: "",
  countryCode: "",
  duration: "",
  tags: "",
  planningAreaCandidateId: "",
});

export function CandidatePanel({
  view,
  workspace,
  selectedCandidateId,
  busy,
  onSelectCandidate,
  onSetPreference,
  onDiscover,
  onAddCandidate,
  onUpdatePlace,
  onRemoveCandidate,
  onContinue,
  onRetry,
  onSearchCandidates,
  onSelectResolution,
  onManualResolution,
  onBeginMapPick,
}: {
  view: "macro" | "micro";
  workspace: Workspace;
  selectedCandidateId: string | null;
  busy: boolean;
  onSelectCandidate: (candidateId: string) => void;
  onSetPreference: (candidateIds: string[], preference: CandidatePreference) => Promise<void>;
  onDiscover: () => Promise<void>;
  onAddCandidate: (draft: NewCandidateDraft) => Promise<void>;
  onUpdatePlace: (placeId: string, changes: PlaceEditChanges) => Promise<void>;
  onRemoveCandidate: (candidateId: string, cascade: boolean) => Promise<void>;
  onContinue: () => Promise<void>;
  onRetry: (placeIds: string[]) => Promise<void>;
  onSearchCandidates: (placeId: string) => Promise<ProviderPlaceCandidate[]>;
  onSelectResolution: (placeId: string, providerPlaceId: string) => Promise<void>;
  onManualResolution: (placeId: string, latitude: number, longitude: number, address: string | null) => Promise<void>;
  onBeginMapPick: (placeId: string) => void;
}) {
  const allRows = useMemo(() => candidateRows(workspace), [workspace]);
  const rows = useMemo(() => allRows.filter((row) => view === "macro" ? row.place.kind === "city" : row.place.kind !== "city"), [allRows, view]);
  const counts = useMemo(() => candidateCounts(rows, allRows), [rows, allRows]);
  const isMacro = view === "macro";
  const macroRows = useMemo(() => allRows.filter((row) => row.place.kind === "city" && row.candidate.preference !== "excluded"), [allRows]);
  const coverageByMacroId = useMemo(() => new Map(workspace.coverage.map((item) => [item.macroCandidateId, item])), [workspace.coverage]);
  const [filter, setFilter] = useState<CandidateFilter>("all");
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsedAreas, setCollapsedAreas] = useState<Set<string>>(new Set());
  const [choice, setChoice] = useState<ChoiceState>(null);
  const [manual, setManual] = useState<ManualDraft | null>(null);
  const [newCandidate, setNewCandidate] = useState<NewCandidateForm | null>(null);
  const [newCandidateError, setNewCandidateError] = useState("");
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState("");
  const [deleting, setDeleting] = useState<DeleteState>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const visible = useMemo(() => filterCandidateRows(rows, filter, query), [rows, filter, query]);
  const groups = useMemo(() => {
    const visibleCandidateIds = new Set(visible.map((row) => row.candidate.id));
    return candidateAreaGroups(allRows)
      .map((group) => ({ ...group, rows: group.rows.filter((row) => visibleCandidateIds.has(row.candidate.id)) }))
      .filter((group) => group.rows.length > 0);
  }, [allRows, visible]);
  const unresolvedSelected = useMemo(() => selectedUnresolvedRows(rows, allRows), [rows, allRows]);
  const unresolvedMustGo = useMemo(() => unresolvedSelected.filter((row) => row.candidate.preference === "must_go"), [unresolvedSelected]);
  const visibleIds = useMemo(() => visible.map((row) => row.candidate.id), [visible]);
  const allVisibleChecked = visibleIds.length > 0 && visibleIds.every((id) => checked.has(id));

  useEffect(() => {
    setChecked((current) => new Set([...current].filter((id) => rows.some((row) => row.candidate.id === id))));
  }, [rows]);
  useEffect(() => {
    if (!selectedCandidateId) return;
    const group = groups.find((item) => item.rows.some((row) => row.candidate.id === selectedCandidateId));
    if (!group) return;
    setCollapsedAreas((current) => {
      if (!current.has(group.key)) return current;
      const next = new Set(current);
      next.delete(group.key);
      return next;
    });
  }, [groups, selectedCandidateId]);
  useEffect(() => {
    if (!selectedCandidateId) return;
    cards.current.get(selectedCandidateId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [collapsedAreas, selectedCandidateId]);

  const toggleChecked = (id: string) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleVisible = () => setChecked((current) => {
    const next = new Set(current);
    if (allVisibleChecked) visibleIds.forEach((id) => next.delete(id));
    else visibleIds.forEach((id) => next.add(id));
    return next;
  });
  const toggleArea = (key: string) => setCollapsedAreas((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const setBulk = async (preference: CandidatePreference) => {
    const ids = [...checked];
    if (!ids.length) return;
    await onSetPreference(ids, preference);
    setChecked(new Set());
  };
  const openChoices = async (placeId: string) => {
    setChoice({ placeId, loading: true, candidates: [], error: "" });
    try {
      const candidates = await onSearchCandidates(placeId);
      setChoice({ placeId, loading: false, candidates, error: candidates.length ? "" : "地图服务没有返回候选地点。" });
    } catch (error) {
      setChoice({ placeId, loading: false, candidates: [], error: error instanceof Error ? error.message : "无法读取地图候选。" });
    }
  };
  const submitManual = async () => {
    if (!manual) return;
    const latitude = Number(manual.latitude);
    const longitude = Number(manual.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return;
    await onManualResolution(manual.placeId, latitude, longitude, manual.address.trim() || null);
    setManual(null);
  };
  const submitNewCandidate = async () => {
    if (!newCandidate) return;
    setNewCandidateError("");
    const nameZh = newCandidate.nameZh.trim();
    const duration = newCandidate.duration.trim() ? Number(newCandidate.duration) : null;
    const countryCode = newCandidate.countryCode.trim().toUpperCase();
    if (!nameZh) { setNewCandidateError("请输入具体地点名称。"); return; }
    if (!isMacro && !newCandidate.planningAreaCandidateId) { setNewCandidateError("请选择这个兴趣点所属的目的地。"); return; }
    if (duration !== null && (!Number.isInteger(duration) || duration < 0 || duration > 10080)) {
      setNewCandidateError("建议停留时间必须是 0–10080 的整数分钟。");
      return;
    }
    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
      setNewCandidateError("国家代码应为两个英文字母，例如 JP、CN、US。");
      return;
    }
    try {
      await onAddCandidate({
        nameZh,
        nameLocal: newCandidate.nameLocal,
        nameEn: newCandidate.nameEn,
        kind: newCandidate.kind,
        city: newCandidate.city,
        region: newCandidate.region,
        country: newCandidate.country,
        countryCode,
        suggestedDurationMinutes: duration,
        tags: [...new Set(newCandidate.tags.split(/[，,]/u).map((tag) => tag.trim()).filter(Boolean))].slice(0, 30),
        planningAreaCandidateId: isMacro ? null : newCandidate.planningAreaCandidateId,
      });
      setNewCandidate(null);
    } catch (error) {
      setNewCandidateError(error instanceof Error ? error.message : "无法添加地点。");
    }
  };

  const submitEdit = async () => {
    if (!edit) return;
    setEditError("");
    const nameZh = edit.nameZh.trim();
    const countryCode = edit.countryCode?.trim().toUpperCase() || null;
    if (!nameZh) { setEditError("请输入地点中文名称。"); return; }
    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) { setEditError("国家代码应为两个英文字母，例如 NZ、JP。"); return; }
    try {
      await onUpdatePlace(edit.id, {
        nameZh,
        nameLocal: edit.nameLocal?.trim() || null,
        nameEn: edit.nameEn?.trim() || null,
        city: edit.city?.trim() || null,
        region: edit.region?.trim() || null,
        country: edit.country?.trim() || null,
        countryCode,
      });
      setEdit(null);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "无法保存地点信息。");
    }
  };

  const beginDelete = (row: CandidateRow) => {
    const ids = new Set<string>([row.candidate.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidateRow of allRows) {
        if (!candidateRow.candidate.planningAreaCandidateId || !ids.has(candidateRow.candidate.planningAreaCandidateId) || ids.has(candidateRow.candidate.id)) continue;
        ids.add(candidateRow.candidate.id);
        changed = true;
      }
    }
    const descendantRows = allRows.filter((candidateRow) => candidateRow.candidate.id !== row.candidate.id && ids.has(candidateRow.candidate.id));
    const placeIds = new Set(allRows.filter((candidateRow) => ids.has(candidateRow.candidate.id)).map((candidateRow) => candidateRow.place.id));
    const affectedDays = workspace.trip.plan.days.flatMap((day) => {
      const stopCount = day.stops.filter((stop) => stop.candidateId && ids.has(stop.candidateId)).length;
      const anchorCount = Number(Boolean(day.startAnchor.placeId && placeIds.has(day.startAnchor.placeId))) + Number(Boolean(day.endAnchor.placeId && placeIds.has(day.endAnchor.placeId)));
      const nodeCount = stopCount + anchorCount;
      return nodeCount ? [{ id: day.id, dayNumber: day.dayNumber, title: day.title, nodeCount }] : [];
    });
    setDeleting({ row, descendantRows, affectedDays });
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    await onRemoveCandidate(deleting.row.candidate.id, deleting.row.place.kind === "city");
    setDeleting(null);
  };

  const renderCandidate = (row: CandidateRow, areaExcluded: boolean) => {
    const status = resolutionStatus(row);
    const selected = selectedCandidateId === row.candidate.id;
    const macroCity = row.place.kind === "city";
    return <article
      ref={(node) => { if (node) cards.current.set(row.candidate.id, node); else cards.current.delete(row.candidate.id); }}
      className={`candidate-card preference-${row.candidate.preference} ${selected ? "selected" : ""} ${macroCity ? "city-macro" : ""} ${areaExcluded && !macroCity ? "area-suppressed" : ""}`}
      key={row.candidate.id}
      onClick={() => onSelectCandidate(row.candidate.id)}
    >
      <label className="candidate-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={checked.has(row.candidate.id)} onChange={() => toggleChecked(row.candidate.id)}/><span/></label>
      <div className="candidate-main">
        <div className="candidate-title-line"><span className="candidate-mark">{preferenceMarks[row.candidate.preference]}</span><div><h3>{row.place.nameZh}{macroCity && <em className="candidate-area-badge">宏观规划</em>}</h3>{(row.place.nameLocal || row.place.nameEn) && <small>{row.place.nameLocal || row.place.nameEn}</small>}</div>{row.candidate.aiScore !== null && <b className="candidate-score" title="AI 推荐度，不是地图平台用户评分">{Math.round(row.candidate.aiScore)}</b>}</div>
        <p>{areaExcluded && !macroCity ? "所属目的地已标记为不去，生成时该地点不会参与规划。" : row.candidate.aiReason || "用户添加地点"}</p>
        <div className="candidate-meta"><span>{macroCity ? "目的地规划节点" : row.place.city || row.place.region || row.place.country || "区域待确认"}</span>{formatDuration(row.candidate.suggestedDurationMinutes) && <span>{formatDuration(row.candidate.suggestedDurationMinutes)}</span>}{row.candidate.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div>
        <div className={`resolution-line ${status}`}>{status === "resolved" ? <><Check size={14}/><span>{macroCity ? "目的地位置已定位" : "已定位"}</span><small>{row.resolution?.address || `${row.resolution?.latitude?.toFixed(5)}, ${row.resolution?.longitude?.toFixed(5)}`}</small></> : status === "resolving" ? <><RefreshCw className="spin" size={14}/><span>定位中</span></> : <><MapPin size={14}/><span>{macroCity ? "目的地位置未定位" : "未定位"}</span><small>{row.resolution?.errorMessage || "生成时会自动尝试定位"}</small></>}</div>
        {status === "unresolved" && <div className="resolution-actions" onClick={(event) => event.stopPropagation()}><button disabled={busy} onClick={() => void onRetry([row.place.id])}><RefreshCw size={13}/>重新识别</button><button disabled={busy} onClick={() => void openChoices(row.place.id)}><LocateFixed size={13}/>选择地图地点</button><button disabled={busy} onClick={() => onBeginMapPick(row.place.id)}><MapPin size={13}/>地图点选</button><button disabled={busy} onClick={() => setManual({ placeId: row.place.id, name: row.place.nameZh, latitude: "", longitude: "", address: "" })}>手工坐标</button></div>}
        <div className="resolution-actions candidate-edit-actions" onClick={(event) => event.stopPropagation()}><button disabled={busy} onClick={() => { setEditError(""); setEdit({ id: row.place.id, nameZh: row.place.nameZh, nameLocal: row.place.nameLocal, nameEn: row.place.nameEn, kind: row.place.kind, city: row.place.city, region: row.place.region, country: row.place.country, countryCode: row.place.countryCode }); }}><Pencil size={13}/>编辑地点</button><button className="danger" disabled={busy} onClick={() => beginDelete(row)}><Trash2 size={13}/>删除地点</button></div>
      </div>
      <div className="candidate-preference" onClick={(event) => event.stopPropagation()}>{(Object.keys(preferenceLabels) as CandidatePreference[]).map((preference) => <button type="button" className={row.candidate.preference === preference ? "active" : ""} title={preferenceLabels[preference]} disabled={busy} key={preference} onClick={() => void onSetPreference([row.candidate.id], preference)}>{preferenceMarks[preference]}</button>)}</div>
      <ChevronRight className="candidate-chevron" size={16}/>
    </article>;
  };

  return <section className="candidate-panel" aria-label="候选地点">
    <div className="candidate-summary">
      <strong>{counts.selected}<span> / {counts.all}</span></strong><span>参与规划</span>
      <div><i className="resolved-dot"/>已定位 {rows.filter((row) => resolutionStatus(row) === "resolved").length}<i className="unresolved-dot"/>未定位 {counts.unresolved}</div>
    </div>

    <div className="candidate-toolbar">
      <div className="candidate-filters" role="tablist" aria-label="地点筛选">
        {(Object.keys(filterLabels) as CandidateFilter[]).map((value) => <button type="button" role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{filterLabels[value]}<span>{counts[value]}</span></button>)}
      </div>
      <label className="candidate-search"><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索地点、城市或标签"/></label>
      <div className="candidate-compact-actions">
        {visible.length > 0 && <button className="button small ghost" type="button" onClick={toggleVisible}>{allVisibleChecked ? "取消全选" : `全选当前 ${visible.length} 个`}</button>}
        <button className="button small" type="button" disabled={busy} onClick={() => setNewCandidate(emptyCandidateForm(isMacro ? "city" : "attraction"))}><Plus size={15}/>手动添加{isMacro ? "目的地" : "兴趣点"}</button>
      </div>
    </div>

    {checked.size > 0 && <div className="candidate-bulk-bar"><span>已选择 {checked.size} 个</span><button onClick={() => void setBulk("must_go")}>★ 必去</button><button onClick={() => void setBulk("want_to_go")}>✓ 想去</button><button onClick={() => void setBulk("optional")}>○ 可选</button><button onClick={() => void setBulk("excluded")}>× 不去</button><button aria-label="清除批量选择" onClick={() => setChecked(new Set())}><X size={14}/></button></div>}

    <div className="candidate-list">
      {!rows.length && <div className="candidate-empty"><Sparkles size={34}/><h3>{isMacro ? "还没有目的地建议" : "还没有详细兴趣点"}</h3><p>{isMacro ? "使用下方唯一主操作生成城市 / 区域建议。" : "先在“目的地”步骤确认范围，再从下方生成详细兴趣点。"}</p></div>}
      {rows.length > 0 && !visible.length && <div className="candidate-empty compact"><Search size={24}/><p>当前筛选条件下没有地点。</p></div>}
      {isMacro ? visible.map((row) => renderCandidate(row, row.candidate.preference === "excluded")) : groups.map((group) => {
        const collapsed = collapsedAreas.has(group.key);
        const cityPreference = group.cityRow?.candidate.preference ?? null;
        const areaExcluded = cityPreference === "excluded";
        const coverage = group.cityRow ? coverageByMacroId.get(group.cityRow.candidate.id) ?? null : null;
        const concreteCount = coverage?.microCandidateCount ?? group.rows.filter((row) => row.place.kind !== "city").length;
        const participatingCount = areaExcluded ? 0 : group.rows.filter((row) => row.candidate.preference !== "excluded").length;
        return <section className={`candidate-area-group ${areaExcluded ? "excluded" : ""}`} key={group.key}>
          <button className="candidate-area-head" type="button" onClick={() => toggleArea(group.key)}>
            <ChevronRight className={collapsed ? "" : "open"} size={16}/>
            <span><strong>{group.label}</strong><small>{group.cityRow ? "目的地规划 · " : "区域分组 · "}{concreteCount} 个具体地点{coverage ? ` · ${coverage.participatingResolvedMicroCount} 个已定位可用` : ` · ${participatingCount} 个参与规划`}{areaExcluded ? " · 本次不去" : coverage?.status === "blocked" ? " · 需要补充具体地点" : coverage?.status === "attention" ? " · 建议补充具体地点" : ""}</small></span>
            {group.cityRow && <em>{preferenceMarks[group.cityRow.candidate.preference]} {preferenceLabels[group.cityRow.candidate.preference]}</em>}
          </button>
          {!collapsed && <div className="candidate-area-cards">{group.rows.map((row) => renderCandidate(row, areaExcluded))}</div>}
        </section>;
      })}
    </div>

    <footer className="candidate-footer candidate-footer-flow-v3">
      <div>{!isMacro && unresolvedSelected.length > 0 && <button className="button" type="button" disabled={busy} onClick={() => void onRetry(unresolvedSelected.map((row) => row.place.id))}><RefreshCw size={14}/>批量重新定位 {unresolvedSelected.length} 个</button>}<button className="button" type="button" disabled={busy} onClick={() => void onDiscover()}><WandSparkles size={15}/>{isMacro ? (rows.length ? "重新生成目的地建议" : "生成目的地建议") : (rows.length ? "补齐兴趣点" : "生成兴趣点")}</button></div>
      {!isMacro && unresolvedSelected.length > 0 && <small className="candidate-generation-warning">{unresolvedMustGo.length ? `${unresolvedMustGo.length} 个“必去”地点未定位，请先编辑或定位` : `${unresolvedSelected.length} 个未定位地点不会进入按天行程`}</small>}
      <button className="button primary generate-plan" type="button" disabled={busy || !counts.selected || (!isMacro && (workspace.trip.plan.days.length > 0 || unresolvedMustGo.length > 0))} onClick={() => void onContinue()}><Sparkles size={15}/>{isMacro ? "生成详细兴趣点" : workspace.trip.plan.days.length ? "行程已生成" : "生成行程与路线"}</button>
    </footer>

    {choice && <div className="candidate-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setChoice(null); }}><section className="candidate-dialog"><header><div><strong>选择地图地点</strong><small>坐标只取自地图 Provider</small></div><button className="icon-button" onClick={() => setChoice(null)}><X size={18}/></button></header><div className="provider-candidate-list">{choice.loading && <p><RefreshCw className="spin" size={15}/>正在查询地图服务…</p>}{choice.error && <p className="inline-error">{choice.error}</p>}{choice.candidates.map((candidate) => <button type="button" key={candidate.providerPlaceId} disabled={busy} onClick={() => void onSelectResolution(choice.placeId, candidate.providerPlaceId).then(() => setChoice(null))}><MapPin size={16}/><span><strong>{candidate.name || candidate.displayName.split(",")[0]}</strong><small>{candidate.displayName}</small><em>{candidate.provider} · {candidate.placeType || candidate.category || "地点"}</em></span><ChevronRight size={16}/></button>)}</div></section></div>}

    {edit && <div className="candidate-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEdit(null); }}><section className="candidate-dialog manual-coordinate-dialog"><header><div><strong>编辑地点</strong><small>保存后旧定位会失效，并自动使用新名称重新定位</small></div><button className="icon-button" onClick={() => setEdit(null)}><X size={18}/></button></header><div className="manual-coordinate-form">
      <label className="wide">中文名称（必填）<input value={edit.nameZh} onChange={(event) => setEdit({ ...edit, nameZh: event.target.value })}/></label>
      <label>本地名称<input value={edit.nameLocal ?? ""} onChange={(event) => setEdit({ ...edit, nameLocal: event.target.value || null })}/></label>
      <label>英文名称<input value={edit.nameEn ?? ""} onChange={(event) => setEdit({ ...edit, nameEn: event.target.value || null })}/></label>
      <label>类型<input value={kindLabels[edit.kind]} disabled/></label>
      <label>城市<input value={edit.city ?? ""} onChange={(event) => setEdit({ ...edit, city: event.target.value || null })}/></label>
      <label>区域<input value={edit.region ?? ""} onChange={(event) => setEdit({ ...edit, region: event.target.value || null })}/></label>
      <label>国家<input value={edit.country ?? ""} onChange={(event) => setEdit({ ...edit, country: event.target.value || null })}/></label>
      <label>国家代码<input maxLength={2} value={edit.countryCode ?? ""} onChange={(event) => setEdit({ ...edit, countryCode: event.target.value.toUpperCase() || null })}/></label>
      {editError && <p className="inline-error wide">{editError}</p>}
    </div><footer><button className="button" onClick={() => setEdit(null)}>取消</button><button className="button primary" disabled={busy || !edit.nameZh.trim()} onClick={() => void submitEdit()}>保存并重新定位</button></footer></section></div>}

    {deleting && <div className="candidate-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleting(null); }}><section className="candidate-dialog"><header><div><strong>删除“{deleting.row.place.nameZh}”</strong><small>此操作会写入一个可从版本历史恢复的新版本</small></div><button className="icon-button" onClick={() => setDeleting(null)}><X size={18}/></button></header><div className="provider-candidate-list delete-impact-list"><p>将删除该候选地点{deleting.descendantRows.length ? `及其下属 ${deleting.descendantRows.length} 个兴趣点` : ""}。</p>{deleting.descendantRows.length > 0 && <p><strong>下属地点：</strong>{deleting.descendantRows.map((row) => row.place.nameZh).join("、")}</p>}{deleting.affectedDays.length > 0 ? <p><strong>同时移除行程节点：</strong>{deleting.affectedDays.map((day) => `Day ${day.dayNumber} ${day.title}（${day.nodeCount} 个）`).join("、")}</p> : <p>当前按天行程不引用此地点。</p>}</div><footer><button className="button" onClick={() => setDeleting(null)}>取消</button><button className="button danger" disabled={busy} onClick={() => void confirmDelete()}><Trash2 size={14}/>确认删除</button></footer></section></div>}

    {manual && <div className="candidate-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setManual(null); }}><section className="candidate-dialog manual-coordinate-dialog"><header><div><strong>手工输入坐标</strong><small>{manual.name}</small></div><button className="icon-button" onClick={() => setManual(null)}><X size={18}/></button></header><div className="manual-coordinate-form"><label>纬度<input inputMode="decimal" value={manual.latitude} onChange={(event) => setManual({ ...manual, latitude: event.target.value })} placeholder="例如 34.994856"/></label><label>经度<input inputMode="decimal" value={manual.longitude} onChange={(event) => setManual({ ...manual, longitude: event.target.value })} placeholder="例如 135.785046"/></label><label className="wide">地址备注（可选）<input value={manual.address} onChange={(event) => setManual({ ...manual, address: event.target.value })} placeholder="地图地址或用户备注"/></label></div><footer><button className="button" onClick={() => setManual(null)}>取消</button><button className="button primary" disabled={busy || !manual.latitude || !manual.longitude} onClick={() => void submitManual()}>保存坐标</button></footer></section></div>}

    {newCandidate && <div className="candidate-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewCandidate(null); }}><section className="candidate-dialog manual-coordinate-dialog"><header><div><strong>手动添加地点</strong><small>城市用于宏观规划；景点、住宿和交通点用于真实线路</small></div><button className="icon-button" onClick={() => setNewCandidate(null)}><X size={18}/></button></header><div className="manual-coordinate-form">
      <label className="wide">地点名称（必填）<input value={newCandidate.nameZh} onChange={(event) => setNewCandidate({ ...newCandidate, nameZh: event.target.value })} placeholder="例如：京都铁道博物馆"/></label>
      <label>本地名称<input value={newCandidate.nameLocal} onChange={(event) => setNewCandidate({ ...newCandidate, nameLocal: event.target.value })} placeholder="Kyoto Railway Museum"/></label>
      <label>英文名称<input value={newCandidate.nameEn} onChange={(event) => setNewCandidate({ ...newCandidate, nameEn: event.target.value })} placeholder="可选"/></label>
      {!isMacro && <label className="wide">所属目的地<select value={newCandidate.planningAreaCandidateId} onChange={(event) => setNewCandidate({ ...newCandidate, planningAreaCandidateId: event.target.value })}><option value="">请选择目的地</option>{macroRows.map((row) => <option key={row.candidate.id} value={row.candidate.id}>{row.place.nameZh}</option>)}</select></label>}
      <label>类型<select value={newCandidate.kind} disabled={isMacro} onChange={(event) => setNewCandidate({ ...newCandidate, kind: event.target.value as PlaceKind })}>{(Object.keys(kindLabels) as PlaceKind[]).filter((kind) => isMacro ? kind === "city" : kind !== "city").map((kind) => <option value={kind} key={kind}>{kindLabels[kind]}</option>)}</select></label>
      <label>城市<input value={newCandidate.city} onChange={(event) => setNewCandidate({ ...newCandidate, city: event.target.value })} placeholder="京都"/></label>
      <label>区域<input value={newCandidate.region} onChange={(event) => setNewCandidate({ ...newCandidate, region: event.target.value })} placeholder="京都府"/></label>
      <label>国家<input value={newCandidate.country} onChange={(event) => setNewCandidate({ ...newCandidate, country: event.target.value })} placeholder="日本"/></label>
      <label>国家代码<input maxLength={2} value={newCandidate.countryCode} onChange={(event) => setNewCandidate({ ...newCandidate, countryCode: event.target.value.toUpperCase() })} placeholder="JP"/></label>
      <label>建议停留分钟<input type="number" min="0" max="10080" value={newCandidate.duration} onChange={(event) => setNewCandidate({ ...newCandidate, duration: event.target.value })} placeholder="120"/></label>
      <label className="wide">标签（逗号分隔）<input value={newCandidate.tags} onChange={(event) => setNewCandidate({ ...newCandidate, tags: event.target.value })} placeholder="亲子, 室内, 博物馆"/></label>
      {newCandidateError && <p className="inline-error wide">{newCandidateError}</p>}
    </div><footer><button className="button" onClick={() => setNewCandidate(null)}>取消</button><button className="button primary" disabled={busy || !newCandidate.nameZh.trim()} onClick={() => void submitNewCandidate()}>添加并定位</button></footer></section></div>}
  </section>;
}
