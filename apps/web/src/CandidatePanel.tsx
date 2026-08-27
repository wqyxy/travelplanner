import { Check, ChevronRight, LocateFixed, MapPin, Plus, RefreshCw, Search, Sparkles, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CandidatePreference, PlaceKind, ProviderPlaceCandidate, Workspace } from "./v2-types";
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
};

const emptyCandidateForm = (): NewCandidateForm => ({
  nameZh: "",
  nameLocal: "",
  nameEn: "",
  kind: "attraction",
  city: "",
  region: "",
  country: "",
  countryCode: "",
  duration: "",
  tags: "",
});

export function CandidatePanel({
  workspace,
  selectedCandidateId,
  busy,
  onSelectCandidate,
  onSetPreference,
  onDiscover,
  onAddCandidate,
  onGenerate,
  onRetry,
  onSearchCandidates,
  onSelectResolution,
  onManualResolution,
  onBeginMapPick,
}: {
  workspace: Workspace;
  selectedCandidateId: string | null;
  busy: boolean;
  onSelectCandidate: (candidateId: string) => void;
  onSetPreference: (candidateIds: string[], preference: CandidatePreference) => Promise<void>;
  onDiscover: () => Promise<void>;
  onAddCandidate: (draft: NewCandidateDraft) => Promise<void>;
  onGenerate: () => Promise<void>;
  onRetry: (placeIds: string[]) => Promise<void>;
  onSearchCandidates: (placeId: string) => Promise<ProviderPlaceCandidate[]>;
  onSelectResolution: (placeId: string, providerPlaceId: string) => Promise<void>;
  onManualResolution: (placeId: string, latitude: number, longitude: number, address: string | null) => Promise<void>;
  onBeginMapPick: (placeId: string) => void;
}) {
  const rows = useMemo(() => candidateRows(workspace), [workspace]);
  const counts = useMemo(() => candidateCounts(rows), [rows]);
  const [filter, setFilter] = useState<CandidateFilter>("all");
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsedAreas, setCollapsedAreas] = useState<Set<string>>(new Set());
  const [choice, setChoice] = useState<ChoiceState>(null);
  const [manual, setManual] = useState<ManualDraft | null>(null);
  const [newCandidate, setNewCandidate] = useState<NewCandidateForm | null>(null);
  const [newCandidateError, setNewCandidateError] = useState("");
  const cards = useRef(new Map<string, HTMLElement>());
  const visible = useMemo(() => filterCandidateRows(rows, filter, query), [rows, filter, query]);
  const groups = useMemo(() => candidateAreaGroups(visible), [visible]);
  const unresolvedSelected = useMemo(() => selectedUnresolvedRows(rows), [rows]);
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
      });
      setNewCandidate(null);
    } catch (error) {
      setNewCandidateError(error instanceof Error ? error.message : "无法添加地点。");
    }
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
        <p>{areaExcluded && !macroCity ? "所属城市已标记为不去，生成时该地点不会参与规划。" : row.candidate.aiReason || "用户添加地点"}</p>
        <div className="candidate-meta"><span>{macroCity ? "城市 / 区域规划节点" : row.place.city || row.place.region || row.place.country || "区域待确认"}</span>{formatDuration(row.candidate.suggestedDurationMinutes) && <span>{formatDuration(row.candidate.suggestedDurationMinutes)}</span>}{row.candidate.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div>
        <div className={`resolution-line ${status}`}>{status === "resolved" ? <><Check size={14}/><span>{macroCity ? "城市位置已定位" : "已定位"}</span><small>{row.resolution?.address || `${row.resolution?.latitude?.toFixed(5)}, ${row.resolution?.longitude?.toFixed(5)}`}</small></> : status === "resolving" ? <><RefreshCw className="spin" size={14}/><span>定位中</span></> : <><MapPin size={14}/><span>{macroCity ? "城市位置未定位" : "未定位"}</span><small>{row.resolution?.errorMessage || "生成时会自动尝试定位"}</small></>}</div>
        {status === "unresolved" && <div className="resolution-actions" onClick={(event) => event.stopPropagation()}><button disabled={busy} onClick={() => void onRetry([row.place.id])}><RefreshCw size={13}/>重新识别</button><button disabled={busy} onClick={() => void openChoices(row.place.id)}><LocateFixed size={13}/>选择地图地点</button><button disabled={busy} onClick={() => onBeginMapPick(row.place.id)}><MapPin size={13}/>地图点选</button><button disabled={busy} onClick={() => setManual({ placeId: row.place.id, name: row.place.nameZh, latitude: "", longitude: "", address: "" })}>手工坐标</button></div>}
      </div>
      <div className="candidate-preference" onClick={(event) => event.stopPropagation()}>{(Object.keys(preferenceLabels) as CandidatePreference[]).map((preference) => <button type="button" className={row.candidate.preference === preference ? "active" : ""} title={preferenceLabels[preference]} disabled={busy} key={preference} onClick={() => void onSetPreference([row.candidate.id], preference)}>{preferenceMarks[preference]}</button>)}</div>
      <ChevronRight className="candidate-chevron" size={16}/>
    </article>;
  };

  return <section className="candidate-panel" aria-label="候选地点">
    <header className="candidate-panel-head">
      <div><p className="eyebrow">DISCOVER & CURATE</p><h2>地点推荐</h2><small>城市控制宏观路线，具体景点控制城市内行程；调整优先级后可直接生成。</small></div>
      <div className="candidate-head-actions">
        <button className="button small" type="button" disabled={busy} onClick={() => setNewCandidate(emptyCandidateForm())}><Plus size={15}/>手动添加</button>
        <button className="button small" type="button" disabled={busy} onClick={() => void onDiscover()}><WandSparkles size={15}/>{rows.length ? "补充推荐" : "AI 推荐地点"}</button>
      </div>
    </header>

    <div className="candidate-summary">
      <strong>{counts.selected}<span> / {counts.all}</span></strong><span>参与规划</span>
      <div><i className="resolved-dot"/>已定位 {rows.filter((row) => resolutionStatus(row) === "resolved").length}<i className="unresolved-dot"/>未定位 {counts.unresolved}</div>
    </div>

    <div className="candidate-toolbar">
      <div className="candidate-filters" role="tablist" aria-label="地点筛选">
        {(Object.keys(filterLabels) as CandidateFilter[]).map((value) => <button type="button" role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{filterLabels[value]}<span>{counts[value]}</span></button>)}
      </div>
      <label className="candidate-search"><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索地点、城市或标签"/></label>
      {visible.length > 0 && <button className="button small ghost" type="button" onClick={toggleVisible}>{allVisibleChecked ? "取消全选" : `全选当前 ${visible.length} 个`}</button>}
    </div>

    {checked.size > 0 && <div className="candidate-bulk-bar"><span>已选择 {checked.size} 个</span><button onClick={() => void setBulk("must_go")}>★ 必去</button><button onClick={() => void setBulk("want_to_go")}>✓ 想去</button><button onClick={() => void setBulk("optional")}>○ 可选</button><button onClick={() => void setBulk("excluded")}>× 不去</button><button aria-label="清除批量选择" onClick={() => setChecked(new Set())}><X size={14}/></button></div>}

    <div className="candidate-list">
      {!rows.length && <div className="candidate-empty"><Sparkles size={34}/><h3>先生成一组城市和具体地点</h3><p>AI 会同时建立宏观城市节点和城市内具体景点；坐标仍由地图服务解析。</p><div><button className="button" disabled={busy} onClick={() => setNewCandidate(emptyCandidateForm())}>手动添加地点</button><button className="button primary" disabled={busy} onClick={() => void onDiscover()}>生成地点推荐</button></div></div>}
      {rows.length > 0 && !visible.length && <div className="candidate-empty compact"><Search size={24}/><p>当前筛选条件下没有地点。</p></div>}
      {groups.map((group) => {
        const collapsed = collapsedAreas.has(group.key);
        const cityPreference = group.cityRow?.candidate.preference ?? null;
        const areaExcluded = cityPreference === "excluded";
        const concreteCount = group.rows.filter((row) => row.place.kind !== "city").length;
        const participatingCount = areaExcluded ? 0 : group.rows.filter((row) => row.candidate.preference !== "excluded").length;
        return <section className={`candidate-area-group ${areaExcluded ? "excluded" : ""}`} key={group.key}>
          <button className="candidate-area-head" type="button" onClick={() => toggleArea(group.key)}>
            <ChevronRight className={collapsed ? "" : "open"} size={16}/>
            <span><strong>{group.label}</strong><small>{group.cityRow ? "城市级规划 · " : "区域分组 · "}{concreteCount} 个具体地点 · {participatingCount} 个参与规划{areaExcluded ? " · 整座城市不去" : ""}</small></span>
            {group.cityRow && <em>{preferenceMarks[group.cityRow.candidate.preference]} {preferenceLabels[group.cityRow.candidate.preference]}</em>}
          </button>
          {!collapsed && <div className="candidate-area-cards">{group.rows.map((row) => renderCandidate(row, areaExcluded))}</div>}
        </section>;
      })}
    </div>

    <footer className="candidate-footer">
      {unresolvedSelected.length > 0 && <button className="button" type="button" disabled={busy} onClick={() => void onRetry(unresolvedSelected.map((row) => row.place.id))}><RefreshCw size={14}/>批量重新定位 {unresolvedSelected.length} 个</button>}
      <button className="button primary generate-plan" type="button" disabled={busy || !counts.selected || workspace.trip.plan.days.length > 0} onClick={() => void onGenerate()}><Sparkles size={15}/>{workspace.trip.plan.days.length ? "行程已生成" : "生成行程与路线"}</button>
    </footer>

    {choice && <div className="candidate-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setChoice(null); }}><section className="candidate-dialog"><header><div><strong>选择地图地点</strong><small>坐标只取自地图 Provider</small></div><button className="icon-button" onClick={() => setChoice(null)}><X size={18}/></button></header><div className="provider-candidate-list">{choice.loading && <p><RefreshCw className="spin" size={15}/>正在查询地图服务…</p>}{choice.error && <p className="inline-error">{choice.error}</p>}{choice.candidates.map((candidate) => <button type="button" key={candidate.providerPlaceId} disabled={busy} onClick={() => void onSelectResolution(choice.placeId, candidate.providerPlaceId).then(() => setChoice(null))}><MapPin size={16}/><span><strong>{candidate.name || candidate.displayName.split(",")[0]}</strong><small>{candidate.displayName}</small><em>{candidate.provider} · {candidate.placeType || candidate.category || "地点"}</em></span><ChevronRight size={16}/></button>)}</div></section></div>}

    {manual && <div className="candidate-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setManual(null); }}><section className="candidate-dialog manual-coordinate-dialog"><header><div><strong>手工输入坐标</strong><small>{manual.name}</small></div><button className="icon-button" onClick={() => setManual(null)}><X size={18}/></button></header><div className="manual-coordinate-form"><label>纬度<input inputMode="decimal" value={manual.latitude} onChange={(event) => setManual({ ...manual, latitude: event.target.value })} placeholder="例如 34.994856"/></label><label>经度<input inputMode="decimal" value={manual.longitude} onChange={(event) => setManual({ ...manual, longitude: event.target.value })} placeholder="例如 135.785046"/></label><label className="wide">地址备注（可选）<input value={manual.address} onChange={(event) => setManual({ ...manual, address: event.target.value })} placeholder="地图地址或用户备注"/></label></div><footer><button className="button" onClick={() => setManual(null)}>取消</button><button className="button primary" disabled={busy || !manual.latitude || !manual.longitude} onClick={() => void submitManual()}>保存坐标</button></footer></section></div>}

    {newCandidate && <div className="candidate-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewCandidate(null); }}><section className="candidate-dialog manual-coordinate-dialog"><header><div><strong>手动添加地点</strong><small>城市用于宏观规划；景点、住宿和交通点用于真实线路</small></div><button className="icon-button" onClick={() => setNewCandidate(null)}><X size={18}/></button></header><div className="manual-coordinate-form">
      <label className="wide">地点名称（必填）<input value={newCandidate.nameZh} onChange={(event) => setNewCandidate({ ...newCandidate, nameZh: event.target.value })} placeholder="例如：京都铁道博物馆"/></label>
      <label>本地名称<input value={newCandidate.nameLocal} onChange={(event) => setNewCandidate({ ...newCandidate, nameLocal: event.target.value })} placeholder="Kyoto Railway Museum"/></label>
      <label>英文名称<input value={newCandidate.nameEn} onChange={(event) => setNewCandidate({ ...newCandidate, nameEn: event.target.value })} placeholder="可选"/></label>
      <label>类型<select value={newCandidate.kind} onChange={(event) => setNewCandidate({ ...newCandidate, kind: event.target.value as PlaceKind })}>{(Object.keys(kindLabels) as PlaceKind[]).map((kind) => <option value={kind} key={kind}>{kindLabels[kind]}</option>)}</select></label>
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
