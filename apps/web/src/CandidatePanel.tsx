import { Check, ChevronRight, LocateFixed, MapPin, RefreshCw, Search, Sparkles, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CandidatePreference, ProviderPlaceCandidate, Workspace } from "./v2-types";
import { candidateCounts, candidateRows, filterCandidateRows, formatDuration, resolutionStatus, selectedUnresolvedRows, type CandidateFilter } from "./workspace-v2";

const preferenceLabels: Record<CandidatePreference, string> = { must_go: "必去", want_to_go: "想去", optional: "可选", excluded: "不去" };
const preferenceMarks: Record<CandidatePreference, string> = { must_go: "★", want_to_go: "✓", optional: "○", excluded: "×" };
const filterLabels: Record<CandidateFilter, string> = { all: "全部", must_go: "必去", want_to_go: "想去", optional: "可选", excluded: "不去", unresolved: "未定位" };

type ManualDraft = { placeId: string; name: string; latitude: string; longitude: string; address: string };
type ChoiceState = { placeId: string; loading: boolean; candidates: ProviderPlaceCandidate[]; error: string } | null;

export function CandidatePanel({ workspace, selectedCandidateId, busy, onSelectCandidate, onSetPreference, onDiscover, onGenerate, onRetry, onSearchCandidates, onSelectResolution, onManualResolution, onBeginMapPick }: {
  workspace: Workspace;
  selectedCandidateId: string | null;
  busy: boolean;
  onSelectCandidate: (candidateId: string) => void;
  onSetPreference: (candidateIds: string[], preference: CandidatePreference) => Promise<void>;
  onDiscover: () => Promise<void>;
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
  const [choice, setChoice] = useState<ChoiceState>(null);
  const [manual, setManual] = useState<ManualDraft | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const visible = useMemo(() => filterCandidateRows(rows, filter, query), [rows, filter, query]);
  const unresolvedSelected = useMemo(() => selectedUnresolvedRows(rows), [rows]);

  useEffect(() => {
    setChecked((current) => new Set([...current].filter((id) => rows.some((row) => row.candidate.id === id))));
  }, [rows]);
  useEffect(() => {
    if (!selectedCandidateId) return;
    cards.current.get(selectedCandidateId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedCandidateId]);

  const toggleChecked = (id: string) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
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
    const latitude = Number(manual.latitude); const longitude = Number(manual.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return;
    await onManualResolution(manual.placeId, latitude, longitude, manual.address.trim() || null);
    setManual(null);
  };

  return <section className="candidate-panel" aria-label="候选地点">
    <header className="candidate-panel-head">
      <div><p className="eyebrow">DISCOVER & CURATE</p><h2>地点推荐</h2><small>先决定真正想去的地方，再让 AI 排程。</small></div>
      <button className="button small" type="button" disabled={busy} onClick={() => void onDiscover()}><WandSparkles size={15}/>{rows.length ? "补充推荐" : "AI 推荐地点"}</button>
    </header>

    <div className="candidate-summary">
      <strong>{counts.selected}<span> / {counts.all}</span></strong><span>已选择地点</span>
      <div><i className="resolved-dot"/>已定位 {rows.filter((row) => resolutionStatus(row) === "resolved").length}<i className="unresolved-dot"/>未定位 {counts.unresolved}</div>
    </div>

    <div className="candidate-toolbar">
      <div className="candidate-filters" role="tablist" aria-label="地点筛选">
        {(Object.keys(filterLabels) as CandidateFilter[]).map((value) => <button type="button" role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{filterLabels[value]}<span>{counts[value]}</span></button>)}
      </div>
      <label className="candidate-search"><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索地点、城市或标签"/></label>
    </div>

    {checked.size > 0 && <div className="candidate-bulk-bar"><span>已选择 {checked.size} 个</span><button onClick={() => void setBulk("must_go")}>★ 必去</button><button onClick={() => void setBulk("want_to_go")}>✓ 想去</button><button onClick={() => void setBulk("optional")}>○ 可选</button><button onClick={() => void setBulk("excluded")}>× 不去</button><button aria-label="清除批量选择" onClick={() => setChecked(new Set())}><X size={14}/></button></div>}

    <div className="candidate-list">
      {!rows.length && <div className="candidate-empty"><Sparkles size={34}/><h3>先生成一组值得考虑的地点</h3><p>AI 只会推荐语义地点；坐标由地图服务解析。</p><button className="button primary" disabled={busy} onClick={() => void onDiscover()}>生成地点推荐</button></div>}
      {rows.length > 0 && !visible.length && <div className="candidate-empty compact"><Search size={24}/><p>当前筛选条件下没有地点。</p></div>}
      {visible.map((row) => {
        const status = resolutionStatus(row);
        const selected = selectedCandidateId === row.candidate.id;
        return <article
          ref={(node) => { if (node) cards.current.set(row.candidate.id, node); else cards.current.delete(row.candidate.id); }}
          className={`candidate-card preference-${row.candidate.preference} ${selected ? "selected" : ""}`}
          key={row.candidate.id}
          onClick={() => onSelectCandidate(row.candidate.id)}
        >
          <label className="candidate-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={checked.has(row.candidate.id)} onChange={() => toggleChecked(row.candidate.id)}/><span/></label>
          <div className="candidate-main">
            <div className="candidate-title-line"><span className="candidate-mark">{preferenceMarks[row.candidate.preference]}</span><div><h3>{row.place.nameZh}</h3>{row.place.nameEn && <small>{row.place.nameEn}</small>}</div>{row.candidate.aiScore !== null && <b className="candidate-score">{Math.round(row.candidate.aiScore)}</b>}</div>
            <p>{row.candidate.aiReason || "用户添加地点"}</p>
            <div className="candidate-meta"><span>{row.place.city || row.place.region || row.place.country || "区域待确认"}</span>{formatDuration(row.candidate.suggestedDurationMinutes) && <span>{formatDuration(row.candidate.suggestedDurationMinutes)}</span>}{row.candidate.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div>
            <div className={`resolution-line ${status}`}>{status === "resolved" ? <><Check size={14}/><span>已定位</span><small>{row.resolution?.address || `${row.resolution?.latitude?.toFixed(5)}, ${row.resolution?.longitude?.toFixed(5)}`}</small></> : status === "resolving" ? <><RefreshCw className="spin" size={14}/><span>定位中</span></> : <><MapPin size={14}/><span>未定位</span><small>{row.resolution?.errorMessage || "需要确认地图地点"}</small></>}</div>
            {status === "unresolved" && <div className="resolution-actions" onClick={(event) => event.stopPropagation()}><button disabled={busy} onClick={() => void onRetry([row.place.id])}><RefreshCw size={13}/>重新识别</button><button disabled={busy} onClick={() => void openChoices(row.place.id)}><LocateFixed size={13}/>选择地图地点</button><button disabled={busy} onClick={() => onBeginMapPick(row.place.id)}><MapPin size={13}/>地图点选</button><button disabled={busy} onClick={() => setManual({ placeId: row.place.id, name: row.place.nameZh, latitude: "", longitude: "", address: "" })}>手工坐标</button></div>}
          </div>
          <div className="candidate-preference" onClick={(event) => event.stopPropagation()}>{(Object.keys(preferenceLabels) as CandidatePreference[]).map((preference) => <button type="button" className={row.candidate.preference === preference ? "active" : ""} title={preferenceLabels[preference]} disabled={busy} key={preference} onClick={() => void onSetPreference([row.candidate.id], preference)}>{preferenceMarks[preference]}</button>)}</div>
          <ChevronRight className="candidate-chevron" size={16}/>
        </article>;
      })}
    </div>

    <footer className="candidate-footer">
      {unresolvedSelected.length > 0 && <button className="button" type="button" disabled={busy} onClick={() => void onRetry(unresolvedSelected.map((row) => row.place.id))}><RefreshCw size={14}/>批量重新定位 {unresolvedSelected.length} 个</button>}
      <button className="button primary generate-plan" type="button" disabled={busy || !counts.selected || unresolvedSelected.length > 0 || workspace.trip.plan.days.length > 0} onClick={() => void onGenerate()}><Sparkles size={15}/>{workspace.trip.plan.days.length ? "行程已生成" : unresolvedSelected.length ? `还有 ${unresolvedSelected.length} 个已选地点未定位` : "根据选中地点生成行程"}</button>
    </footer>

    {choice && <div className="candidate-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setChoice(null); }}><section className="candidate-dialog"><header><div><strong>选择地图地点</strong><small>坐标只取自地图 Provider</small></div><button className="icon-button" onClick={() => setChoice(null)}><X size={18}/></button></header><div className="provider-candidate-list">{choice.loading && <p><RefreshCw className="spin" size={15}/>正在查询地图服务…</p>}{choice.error && <p className="inline-error">{choice.error}</p>}{choice.candidates.map((candidate) => <button type="button" key={candidate.providerPlaceId} disabled={busy} onClick={() => void onSelectResolution(choice.placeId, candidate.providerPlaceId).then(() => setChoice(null))}><MapPin size={16}/><span><strong>{candidate.name || candidate.displayName.split(",")[0]}</strong><small>{candidate.displayName}</small><em>{candidate.provider} · {candidate.placeType || candidate.category || "地点"}</em></span><ChevronRight size={16}/></button>)}</div></section></div>}

    {manual && <div className="candidate-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setManual(null); }}><section className="candidate-dialog manual-coordinate-dialog"><header><div><strong>手工输入坐标</strong><small>{manual.name}</small></div><button className="icon-button" onClick={() => setManual(null)}><X size={18}/></button></header><div className="manual-coordinate-form"><label>纬度<input inputMode="decimal" value={manual.latitude} onChange={(event) => setManual({ ...manual, latitude: event.target.value })} placeholder="例如 34.994856"/></label><label>经度<input inputMode="decimal" value={manual.longitude} onChange={(event) => setManual({ ...manual, longitude: event.target.value })} placeholder="例如 135.785046"/></label><label className="wide">地址备注（可选）<input value={manual.address} onChange={(event) => setManual({ ...manual, address: event.target.value })} placeholder="地图地址或用户备注"/></label></div><footer><button className="button" onClick={() => setManual(null)}>取消</button><button className="button primary" disabled={busy || !manual.latitude || !manual.longitude} onClick={() => void submitManual()}>保存坐标</button></footer></section></div>}
  </section>;
}
