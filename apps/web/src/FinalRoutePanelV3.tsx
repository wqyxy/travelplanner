import { ArrowDown, ArrowUp, Crosshair, GripVertical, Link, MapPin, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FinalRouteNodeStatus, PlaceKind, TransportMode } from "./v2-types";
import type { WorkspaceV3 } from "./v3-types";
import { placeNamePresentation } from "./place-name-presentation";
import {
  finalRouteDisplayRowsV3,
  finalRouteStatusLabelsV3,
  transportModeLabelsV3,
} from "./final-route-ui-v3";
import type { GoogleMapsPreviewV3, WorkflowPlaceEditChangesV3 } from "./CandidateWorkflowPanelV3";

const placeKindLabels: Record<PlaceKind, string> = {
  city: "城市",
  attraction: "景点 / 景区",
  lodging: "住宿地点",
  meal: "餐饮",
  airport: "机场",
  station: "车站",
  port: "港口",
  stop: "停靠点",
  waypoint: "途经点",
};

const transportOptions: TransportMode[] = ["walk", "drive", "bike", "transit", "rail", "flight", "ferry"];

type AddDraft = { nameZh: string; kind: PlaceKind };
type PlaceEditDraft = WorkflowPlaceEditChangesV3 & { googleUrl: string };

function resolutionLabel(status: "resolving" | "resolved" | "unresolved" | "missing") {
  if (status === "resolved") return "已定位";
  if (status === "resolving") return "定位中";
  if (status === "unresolved") return "未定位";
  return "待定位";
}

export function FinalRoutePanelV3({
  workspace,
  selectedNodeId,
  busy,
  notice,
  onSelectNode,
  onFocusNode,
  onAddPlace,
  onMoveNode,
  onSetStatus,
  onSetBoundary,
  onAddNight,
  onSetTransport,
  onRemoveNode,
  onUpdatePlace,
  onPreviewGoogleMapsLink,
  onApplyGoogleMapsLink,
  onRetry,
  onBeginMapPick,
  onRecalculateDirtyRoutes,
}: {
  workspace: WorkspaceV3;
  selectedNodeId: string | null;
  busy: boolean;
  notice?: string;
  onSelectNode: (nodeId: string) => void;
  onFocusNode: (nodeId: string) => void;
  onAddPlace: (draft: AddDraft, index: number) => Promise<string | null>;
  onMoveNode: (nodeId: string, targetIndex: number) => Promise<void>;
  onSetStatus: (nodeId: string, status: FinalRouteNodeStatus) => Promise<void>;
  onSetBoundary: (nodeId: string, endsDay: boolean) => Promise<void>;
  onAddNight: (nodeId: string) => Promise<void>;
  onSetTransport: (nodeId: string, mode: TransportMode | "") => Promise<void>;
  onRemoveNode: (nodeId: string) => Promise<void>;
  onUpdatePlace: (placeId: string, changes: WorkflowPlaceEditChangesV3) => Promise<boolean>;
  onPreviewGoogleMapsLink: (placeId: string, url: string) => Promise<GoogleMapsPreviewV3>;
  onApplyGoogleMapsLink: (placeId: string, url: string, changes: WorkflowPlaceEditChangesV3) => Promise<boolean>;
  onRetry: (placeIds: string[], force?: boolean) => Promise<boolean>;
  onBeginMapPick: (placeId: string) => void;
  onRecalculateDirtyRoutes: () => Promise<void>;
}) {
  const plan = workspace.trip.plan;
  const rows = useMemo(() => finalRouteDisplayRowsV3(plan), [plan]);
  const resolutions = useMemo(() => new Map(workspace.resolutions.map((item) => [item.placeId, item])), [workspace.resolutions]);
  const dirtyCount = workspace.routeStates.filter((item) => item.dirty).length;
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>({ nameZh: "", kind: "attraction" });
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const selectedRow = rows.find((row) => row.node.id === selectedNodeId) ?? null;
  const [editDraft, setEditDraft] = useState<PlaceEditDraft | null>(null);
  const [preview, setPreview] = useState<GoogleMapsPreviewV3 | null>(null);
  const [editMessage, setEditMessage] = useState("");

  useEffect(() => {
    if (!selectedRow?.place) {
      setEditDraft(null);
      setPreview(null);
      setEditMessage("");
      return;
    }
    setEditDraft({
      nameZh: selectedRow.place.nameZh,
      nameLocal: selectedRow.place.nameLocal,
      nameEn: selectedRow.place.nameEn,
      kind: selectedRow.place.kind,
      googleUrl: "",
    });
    setPreview(null);
    setEditMessage("");
  }, [selectedRow?.node.id, selectedRow?.place?.id, selectedRow?.place?.nameZh, selectedRow?.place?.nameLocal, selectedRow?.place?.nameEn, selectedRow?.place?.kind]);

  const addIndex = selectedRow ? selectedRow.index + 1 : rows.length;
  const submitAdd = async () => {
    const nameZh = addDraft.nameZh.trim();
    if (!nameZh || busy) return;
    const nodeId = await onAddPlace({ ...addDraft, nameZh }, addIndex);
    if (!nodeId) return;
    setAddDraft({ nameZh: "", kind: "attraction" });
    setAddOpen(false);
    onSelectNode(nodeId);
  };

  const savePlace = async () => {
    if (!selectedRow?.place || !editDraft) return;
    const changes: WorkflowPlaceEditChangesV3 = {
      nameZh: editDraft.nameZh.trim(),
      nameLocal: editDraft.nameLocal?.trim() || null,
      nameEn: editDraft.nameEn?.trim() || null,
      kind: editDraft.kind,
    };
    if (!changes.nameZh) { setEditMessage("中文名称不能为空。"); return; }
    setEditMessage(await onUpdatePlace(selectedRow.place.id, changes) ? "地点信息已保存。" : "地点信息保存失败。");
  };

  const previewGoogle = async () => {
    if (!selectedRow?.place || !editDraft?.googleUrl.trim()) return;
    setEditMessage("");
    try {
      setPreview(await onPreviewGoogleMapsLink(selectedRow.place.id, editDraft.googleUrl.trim()));
    } catch (cause) {
      setPreview(null);
      setEditMessage(cause instanceof Error ? cause.message : "无法读取 Google Maps 链接。");
    }
  };

  const applyGoogle = async () => {
    if (!selectedRow?.place || !editDraft?.googleUrl.trim()) return;
    const changes: WorkflowPlaceEditChangesV3 = {
      nameZh: editDraft.nameZh.trim(),
      nameLocal: editDraft.nameLocal?.trim() || null,
      nameEn: editDraft.nameEn?.trim() || null,
      kind: editDraft.kind,
    };
    const saved = await onApplyGoogleMapsLink(selectedRow.place.id, editDraft.googleUrl.trim(), changes);
    setEditMessage(saved ? "地点和定位已按 Google Maps 链接保存。" : "Google Maps 链接保存失败。");
    if (saved) setPreview(null);
  };

  return <section className="final-route-panel-v3">
    <header className="final-route-panel-head-v3">
      <div><p className="eyebrow">行程</p><h2>最终线路</h2><p>这就是实际保存的线路。Day、地图和交通路线都跟着这里变化。</p></div>
      <button className="button primary" type="button" disabled={busy} onClick={() => setAddOpen((value) => !value)}><Plus size={15}/>添加地点</button>
    </header>

    <div className="final-route-summary-v3">
      <span><b>{rows.length}</b> 个线路地点</span>
      <span><b>{plan.days.length}</b> 天</span>
      <span><b>{rows.filter((row) => row.node.status === "tentative").length}</b> 待定</span>
      <span><b>{rows.filter((row) => row.node.status === "no_go").length}</b> 不去</span>
      {dirtyCount > 0 && <button className="button small" type="button" disabled={busy} onClick={() => void onRecalculateDirtyRoutes()}><RefreshCw size={13}/>更新 {dirtyCount} 天地图路线</button>}
    </div>
    {notice && <p className="final-route-notice-v3">{notice}</p>}

    {addOpen && <section className="final-route-add-v3">
      <strong>{selectedRow ? `添加在“${selectedRow.place?.nameZh ?? "当前地点"}”之后` : "添加到线路末尾"}</strong>
      <div><input autoFocus value={addDraft.nameZh} disabled={busy} placeholder="地点名称，例如：Hobbiton" onChange={(event) => setAddDraft((current) => ({ ...current, nameZh: event.target.value }))}/><select value={addDraft.kind} disabled={busy} onChange={(event) => setAddDraft((current) => ({ ...current, kind: event.target.value as PlaceKind }))}>{Object.entries(placeKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="button primary" type="button" disabled={busy || !addDraft.nameZh.trim()} onClick={() => void submitAdd()}>加入线路</button></div>
      <small>地点可以先加入、后定位。添加地点不会自动设置住宿，也不会移动现有地点。</small>
    </section>}

    {!rows.length ? <div className="final-route-empty-v3"><MapPin size={30}/><strong>最终线路还是空的</strong><p>先手动添加地点。Phase 3 会把“生成主要地点 / 生成详细地点”也直接接到这里。</p></div> : <div className="final-route-list-v3">
      {rows.map((row, rowIndex) => {
        const previous = rows[rowIndex - 1];
        const day = plan.days[row.dayNumber - 1];
        const showDay = !previous || previous.dayNumber !== row.dayNumber;
        const resolution = resolutions.get(row.node.placeId);
        const locationState = resolution?.status ?? "missing";
        const display = placeNamePresentation(row.place, workspace.trip.planLanguage, row.node.activity || "未命名地点");
        const selected = row.node.id === selectedNodeId;
        return <div className="final-route-row-wrap-v3" key={row.node.id}>
          {showDay && <div className="final-route-day-divider-v3"><b>Day {row.dayNumber}</b><span>{day?.date || "日期待定"}</span></div>}
          <article
            className={`final-route-row-v3 status-${row.node.status} ${selected ? "selected" : ""}`}
            draggable={!busy}
            onDragStart={() => setDraggedNodeId(row.node.id)}
            onDragEnd={() => setDraggedNodeId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!draggedNodeId || draggedNodeId === row.node.id) return;
              const sourceIndex = rows.findIndex((item) => item.node.id === draggedNodeId);
              const targetIndex = sourceIndex >= 0 && sourceIndex < row.index ? Math.max(0, row.index - 1) : row.index;
              setDraggedNodeId(null);
              void onMoveNode(draggedNodeId, targetIndex);
            }}
          >
            <button className="final-route-drag-v3" type="button" aria-label="拖动地点排序" title="拖动排序"><GripVertical size={17}/></button>
            <button className="final-route-main-v3" type="button" onClick={() => onSelectNode(row.node.id)}>
              <span className="final-route-index-v3">{row.index + 1}</span>
              <span><strong>{display.primary}</strong>{display.secondary && <small>{display.secondary}</small>}<small>{placeKindLabels[row.place?.kind ?? "waypoint"]} · {resolutionLabel(locationState)}</small></span>
            </button>
            <div className="final-route-badges-v3"><span className={`status-pill-v3 ${row.node.status}`}>{finalRouteStatusLabelsV3[row.node.status]}</span>{row.node.endsDay && <span className={`stay-pill-v3 ${row.node.status !== "normal" ? "inactive" : ""}`}>住</span>}</div>
            <div className="final-route-quick-v3">
              <button type="button" disabled={busy || row.index === 0} aria-label="上移" onClick={() => void onMoveNode(row.node.id, row.index - 1)}><ArrowUp size={14}/></button>
              <button type="button" disabled={busy || row.index === rows.length - 1} aria-label="下移" onClick={() => void onMoveNode(row.node.id, row.index + 1)}><ArrowDown size={14}/></button>
              <button type="button" aria-label="地图聚焦" onClick={() => onFocusNode(row.node.id)}><Crosshair size={14}/></button>
            </div>
          </article>

          {selected && <section className="final-route-editor-v3">
            <div className="final-route-control-group-v3"><label>地点状态</label><div className="final-route-segmented-v3">{(["normal", "tentative", "no_go"] as FinalRouteNodeStatus[]).map((status) => <button type="button" key={status} className={row.node.status === status ? "active" : ""} disabled={busy} onClick={() => void onSetStatus(row.node.id, status)}>{finalRouteStatusLabelsV3[status]}</button>)}</div>{row.node.status !== "normal" && <small>保留在线路和地图原位置，但暂时不参与当前 Day 和交通路线。</small>}</div>

            <div className="final-route-control-group-v3"><label>当天是否在这里结束</label><div className="final-route-inline-actions-v3">{row.node.endsDay ? <><button className="button small" type="button" disabled={busy} onClick={() => void onSetBoundary(row.node.id, false)}>不住</button><button className="button small" type="button" disabled={busy || row.node.status !== "normal"} onClick={() => void onAddNight(row.node.id)}>多一晚</button></> : <button className="button small" type="button" disabled={busy || row.node.status !== "normal"} onClick={() => void onSetBoundary(row.node.id, true)}>住</button>}</div>{row.node.status !== "normal" && row.node.endsDay && <small>住宿分界仍保存，恢复“正常”后会在原位置重新生效。</small>}</div>

            <div className="final-route-control-group-v3"><label>到达这里的交通方式</label><select value={row.node.transportFromPrevious?.mode ?? ""} disabled={busy} onChange={(event) => void onSetTransport(row.node.id, event.target.value as TransportMode | "")}><option value="">未设置</option>{transportOptions.map((mode) => <option key={mode} value={mode}>{transportModeLabelsV3[mode]}</option>)}</select><small>这项设置属于当前地点：上一个当前有效地点变化时，它仍跟着当前地点保留。</small></div>

            {editDraft && row.place && <details className="final-route-details-v3" open>
              <summary><Pencil size={14}/>编辑地点与定位</summary>
              <div className="final-route-edit-grid-v3">
                <label><span>中文名称</span><input value={editDraft.nameZh} disabled={busy} onChange={(event) => setEditDraft((current) => current ? { ...current, nameZh: event.target.value } : current)}/></label>
                <label><span>英文名称</span><input value={editDraft.nameEn ?? ""} disabled={busy} onChange={(event) => setEditDraft((current) => current ? { ...current, nameEn: event.target.value || null } : current)}/></label>
                <label><span>当地名称</span><input value={editDraft.nameLocal ?? ""} disabled={busy} onChange={(event) => setEditDraft((current) => current ? { ...current, nameLocal: event.target.value || null } : current)}/></label>
                <label><span>地点类型</span><select value={editDraft.kind} disabled={busy} onChange={(event) => setEditDraft((current) => current ? { ...current, kind: event.target.value as PlaceKind } : current)}>{Object.entries(placeKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              </div>
              <div className="final-route-inline-actions-v3"><button className="button small" type="button" disabled={busy} onClick={() => void savePlace()}>保存地点信息</button><button className="button small" type="button" disabled={busy} onClick={() => void onRetry([row.place!.id], true)}><RefreshCw size={13}/>重新识别</button><button className="button small" type="button" disabled={busy} onClick={() => onBeginMapPick(row.place!.id)}><Crosshair size={13}/>地图选点</button></div>
              <div className="final-route-google-v3"><label><span><Link size={13}/>Google Maps 链接（可选）</span><input value={editDraft.googleUrl} disabled={busy} placeholder="粘贴 Google Maps 地点链接" onChange={(event) => { setPreview(null); setEditDraft((current) => current ? { ...current, googleUrl: event.target.value } : current); }}/></label><button className="button small" type="button" disabled={busy || !editDraft.googleUrl.trim()} onClick={() => void previewGoogle()}>预览</button>{preview && <div className="final-route-google-preview-v3"><strong>{preview.name || "地图地点"}</strong><small>{preview.address || `${preview.latitude}, ${preview.longitude}`}</small>{preview.warning && <small>{preview.warning}</small>}<button className="button primary small" type="button" disabled={busy} onClick={() => void applyGoogle()}>使用这个定位</button></div>}</div>
              {editMessage && <small className="final-route-edit-message-v3">{editMessage}</small>}
            </details>}

            <div className="final-route-danger-v3"><button className="button danger small" type="button" disabled={busy} onClick={() => { if (window.confirm(`从最终线路移除“${display.primary}”这一次出现？`)) void onRemoveNode(row.node.id); }}><Trash2 size={13}/>从线路移除</button><small>只移除这一次线路节点；同一现实地点在其他位置的节点不会一起删除。</small></div>
          </section>}
        </div>;
      })}
    </div>}
  </section>;
}
