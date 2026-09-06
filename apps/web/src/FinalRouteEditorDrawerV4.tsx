import { Crosshair, Link, MapPin, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { FinalRouteDisplayRowV3 } from "./final-route-ui-v3";
import type { Period, PlaceKind } from "./v2-types";
import type { WorkspaceV3 } from "./v3-types";
import type { GoogleMapsPreviewV3, WorkflowPlaceEditChangesV3 } from "./CandidateWorkflowPanelV3";
import { placeNamePresentation } from "./place-name-presentation";

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
const periodLabels: Record<Period, string> = { morning: "上午", afternoon: "下午", evening: "傍晚", night: "夜间", all_day: "全天" };

type PlaceEditDraft = WorkflowPlaceEditChangesV3 & { googleUrl: string };
type DetailDraft = {
  activity: string;
  period: Period | "";
  startTime: string;
  endTime: string;
  durationMinutes: string;
  notes: string;
};

function resolutionLabel(status: "resolving" | "resolved" | "unresolved" | "missing") {
  if (status === "resolved") return "已定位";
  if (status === "resolving") return "定位中";
  if (status === "unresolved") return "未定位";
  return "待定位";
}

export function FinalRouteEditorDrawerV4({
  workspace,
  row,
  busy,
  onClose,
  onUpdatePlace,
  onPreviewGoogleMapsLink,
  onApplyGoogleMapsLink,
  onRetry,
  onBeginMapPick,
  onRemoveNode,
}: {
  workspace: WorkspaceV3;
  row: FinalRouteDisplayRowV3;
  busy: boolean;
  onClose: () => void;
  onUpdatePlace: (placeId: string, changes: WorkflowPlaceEditChangesV3) => Promise<boolean>;
  onPreviewGoogleMapsLink: (placeId: string, url: string) => Promise<GoogleMapsPreviewV3>;
  onApplyGoogleMapsLink: (placeId: string, url: string, changes: WorkflowPlaceEditChangesV3) => Promise<boolean>;
  onRetry: (placeIds: string[], force?: boolean) => Promise<boolean>;
  onBeginMapPick: (placeId: string, nodeId: string) => void;
  onRemoveNode: (nodeId: string) => Promise<void>;
}) {
  const plan = workspace.trip.plan;
  const stopOwner = useMemo(() => plan.days.find((day) => day.stops.some((stop) => stop.id === row.node.id)) ?? null, [plan.days, row.node.id]);
  const resolution = workspace.resolutions.find((item) => item.placeId === row.node.placeId) ?? null;
  const locationState = resolution?.status ?? "missing";
  const display = placeNamePresentation(row.place, workspace.trip.planLanguage, row.node.activity || "未命名地点");
  const [editDraft, setEditDraft] = useState<PlaceEditDraft | null>(null);
  const [detailDraft, setDetailDraft] = useState<DetailDraft | null>(null);
  const [preview, setPreview] = useState<GoogleMapsPreviewV3 | null>(null);
  const [message, setMessage] = useState("");
  const [savingDetail, setSavingDetail] = useState(false);

  useEffect(() => {
    if (!row.place) {
      setEditDraft(null);
      setDetailDraft(null);
      setPreview(null);
      setMessage("");
      return;
    }
    setEditDraft({
      nameZh: row.place.nameZh,
      nameLocal: row.place.nameLocal,
      nameEn: row.place.nameEn,
      kind: row.place.kind,
      googleUrl: "",
    });
    setDetailDraft({
      activity: row.node.activity ?? row.place.nameZh,
      period: row.node.period ?? "",
      startTime: row.node.startTime ?? "",
      endTime: row.node.endTime ?? "",
      durationMinutes: row.node.durationMinutes === null ? "" : String(row.node.durationMinutes),
      notes: row.node.notes ?? "",
    });
    setPreview(null);
    setMessage("");
  }, [row.node.id, row.node.activity, row.node.period, row.node.startTime, row.node.endTime, row.node.durationMinutes, row.node.notes, row.place?.id, row.place?.nameZh, row.place?.nameLocal, row.place?.nameEn, row.place?.kind]);

  const savePlace = async () => {
    if (!row.place || !editDraft) return;
    const changes: WorkflowPlaceEditChangesV3 = {
      nameZh: editDraft.nameZh.trim(),
      nameLocal: editDraft.nameLocal?.trim() || null,
      nameEn: editDraft.nameEn?.trim() || null,
      kind: editDraft.kind,
    };
    if (!changes.nameZh) { setMessage("中文名称不能为空。"); return; }
    setMessage(await onUpdatePlace(row.place.id, changes) ? "地点信息已保存。" : "地点信息保存失败。");
  };

  const saveDetail = async () => {
    if (!row.place || !stopOwner || !detailDraft || savingDetail || busy) return;
    const durationText = detailDraft.durationMinutes.trim();
    const durationMinutes = durationText ? Number(durationText) : null;
    if (durationText && (!Number.isInteger(durationMinutes) || durationMinutes! < 0)) {
      setMessage("停留分钟数需要填写 0 或正整数。");
      return;
    }
    setSavingDetail(true);
    setMessage("");
    try {
      await api(`/api/trips/${workspace.trip.id}/actions/cta`, {
        method: "POST",
        body: JSON.stringify({
          stage: "itinerary",
          actionType: "itinerary.edit",
          parameters: {
            stopId: row.node.id,
            changes: {
              activity: detailDraft.activity.trim() || row.place.nameZh || "游览地点",
              period: detailDraft.period || null,
              startTime: detailDraft.startTime.trim() || null,
              endTime: detailDraft.endTime.trim() || null,
              durationMinutes,
              notes: detailDraft.notes.trim() || null,
            },
          },
          targetIds: [row.node.id],
          requestKey: crypto.randomUUID(),
        }),
      });
      setMessage("详细安排已保存；最终线路节点会同步更新。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "详细安排保存失败。");
    } finally {
      setSavingDetail(false);
    }
  };

  const previewGoogle = async () => {
    if (!row.place || !editDraft?.googleUrl.trim()) return;
    setMessage("");
    try {
      setPreview(await onPreviewGoogleMapsLink(row.place.id, editDraft.googleUrl.trim()));
    } catch (cause) {
      setPreview(null);
      setMessage(cause instanceof Error ? cause.message : "无法读取 Google Maps 链接。");
    }
  };

  const applyGoogle = async () => {
    if (!row.place || !editDraft?.googleUrl.trim()) return;
    const changes: WorkflowPlaceEditChangesV3 = {
      nameZh: editDraft.nameZh.trim(),
      nameLocal: editDraft.nameLocal?.trim() || null,
      nameEn: editDraft.nameEn?.trim() || null,
      kind: editDraft.kind,
    };
    const saved = await onApplyGoogleMapsLink(row.place.id, editDraft.googleUrl.trim(), changes);
    setMessage(saved ? "地点和定位已按 Google Maps 链接保存。" : "Google Maps 链接保存失败。");
    if (saved) setPreview(null);
  };

  return <aside className="final-route-editor-drawer-v4" aria-label={`编辑 ${display.primary}`}>
    <header className="final-route-editor-drawer-head-v4">
      <div><small>编辑地点</small><strong>{display.primary}</strong>{display.secondary && <span>{display.secondary}</span>}</div>
      <button className="icon-button" type="button" aria-label="关闭地点编辑" onClick={onClose}><X size={18}/></button>
    </header>

    <div className="final-route-editor-drawer-body-v4">
      <section className="final-route-editor-section-v4">
        <h3><Pencil size={15}/>行程安排</h3>
        {detailDraft && stopOwner ? <>
          <div className="final-route-edit-grid-v3">
            <label><span>活动说明</span><input value={detailDraft.activity} disabled={busy || savingDetail} onChange={(event) => setDetailDraft((current) => current ? { ...current, activity: event.target.value } : current)}/></label>
            <label><span>时段</span><select value={detailDraft.period} disabled={busy || savingDetail} onChange={(event) => setDetailDraft((current) => current ? { ...current, period: event.target.value as Period | "" } : current)}><option value="">未设置</option>{Object.entries(periodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>开始时间</span><input type="time" value={detailDraft.startTime} disabled={busy || savingDetail} onChange={(event) => setDetailDraft((current) => current ? { ...current, startTime: event.target.value } : current)}/></label>
            <label><span>结束时间</span><input type="time" value={detailDraft.endTime} disabled={busy || savingDetail} onChange={(event) => setDetailDraft((current) => current ? { ...current, endTime: event.target.value } : current)}/></label>
            <label><span>停留分钟</span><input inputMode="numeric" value={detailDraft.durationMinutes} disabled={busy || savingDetail} placeholder="例如 90" onChange={(event) => setDetailDraft((current) => current ? { ...current, durationMinutes: event.target.value } : current)}/></label>
            <label><span>备注</span><input value={detailDraft.notes} disabled={busy || savingDetail} onChange={(event) => setDetailDraft((current) => current ? { ...current, notes: event.target.value } : current)}/></label>
          </div>
          {row.node.scheduleText && <small className="final-route-editor-note-v4">自然语言安排：{row.node.scheduleText}</small>}
          <button className="button small primary" type="button" disabled={busy || savingDetail} onClick={() => void saveDetail()}>保存详细安排</button>
        </> : <p className="final-route-editor-note-v4">这个节点是当天结束位置，不作为当天中途 Stop 单独维护时间表。住宿分界在地点块上操作。</p>}
      </section>

      {editDraft && row.place && <section className="final-route-editor-section-v4">
        <h3><Pencil size={15}/>地点信息</h3>
        <div className="final-route-edit-grid-v3">
          <label><span>中文名称</span><input value={editDraft.nameZh} disabled={busy} onChange={(event) => setEditDraft((current) => current ? { ...current, nameZh: event.target.value } : current)}/></label>
          <label><span>英文名称</span><input value={editDraft.nameEn ?? ""} disabled={busy} onChange={(event) => setEditDraft((current) => current ? { ...current, nameEn: event.target.value || null } : current)}/></label>
          <label><span>当地名称</span><input value={editDraft.nameLocal ?? ""} disabled={busy} onChange={(event) => setEditDraft((current) => current ? { ...current, nameLocal: event.target.value || null } : current)}/></label>
          <label><span>地点类型</span><select value={editDraft.kind} disabled={busy} onChange={(event) => setEditDraft((current) => current ? { ...current, kind: event.target.value as PlaceKind } : current)}>{Object.entries(placeKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <button className="button small" type="button" disabled={busy} onClick={() => void savePlace()}>保存地点信息</button>
      </section>}

      {row.place && <section className="final-route-editor-section-v4">
        <h3><MapPin size={15}/>地图定位</h3>
        <div className={`final-route-location-summary-v4 ${locationState}`}>
          <strong>{resolutionLabel(locationState)}</strong>
          <span>{resolution?.address || (resolution?.latitude !== null && resolution?.latitude !== undefined && resolution?.longitude !== null && resolution?.longitude !== undefined ? `${resolution.latitude.toFixed(5)}, ${resolution.longitude.toFixed(5)}` : "还没有可靠地址或坐标")}</span>
        </div>
        <div className="final-route-inline-actions-v3">
          <button className="button small" type="button" disabled={busy} onClick={() => void onRetry([row.place!.id], true)}><RefreshCw size={13}/>重新识别</button>
          <button className="button small" type="button" disabled={busy} onClick={() => onBeginMapPick(row.place!.id, row.node.id)}><Crosshair size={13}/>地图选点</button>
        </div>
        {editDraft && <div className="final-route-google-v3">
          <label><span><Link size={13}/>Google Maps 链接（可选）</span><input value={editDraft.googleUrl} disabled={busy} placeholder="粘贴 Google Maps 地点链接" onChange={(event) => { setPreview(null); setEditDraft((current) => current ? { ...current, googleUrl: event.target.value } : current); }}/></label>
          <button className="button small" type="button" disabled={busy || !editDraft.googleUrl.trim()} onClick={() => void previewGoogle()}>预览</button>
          {preview && <div className="final-route-google-preview-v3"><strong>{preview.name || "地图地点"}</strong><small>{preview.address || `${preview.latitude}, ${preview.longitude}`}</small>{preview.warning && <small>{preview.warning}</small>}<button className="button primary small" type="button" disabled={busy} onClick={() => void applyGoogle()}>使用这个定位</button></div>}
        </div>}
      </section>}

      {message && <p className="final-route-edit-message-v3">{message}</p>}

      <section className="final-route-editor-section-v4 danger">
        <h3><Trash2 size={15}/>线路操作</h3>
        <button className="button danger small" type="button" disabled={busy} onClick={() => { if (window.confirm(`从最终线路移除“${display.primary}”这一次出现？`)) void onRemoveNode(row.node.id); }}><Trash2 size={13}/>从线路移除</button>
        <small>只移除这一次线路节点；同一现实地点在其他位置的节点不会一起删除。</small>
      </section>
    </div>
  </aside>;
}
