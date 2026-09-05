import { ArrowDown, ArrowUp, Clock3, Crosshair, GripVertical, Link, MapPin, Pencil, Plus, RefreshCw, Sparkles, Trash2, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { FinalRouteNodeStatus, Period, PlaceKind, TransportMode } from "./v2-types";
import type { AiActionType, ConversationStage, WorkspaceV3 } from "./v3-types";
import { placeNamePresentation } from "./place-name-presentation";
import {
  finalRouteDisplayRowsV3,
  finalRouteStatusLabelsV3,
  transportModeLabelsV3,
} from "./final-route-ui-v3";
import { proposalActionPath, type ProposalAction } from "./proposal-ui-v2";
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
const periodLabels: Record<Period, string> = { morning: "上午", afternoon: "下午", evening: "傍晚", night: "夜间", all_day: "全天" };

type AddDraft = { nameZh: string; kind: PlaceKind };
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
  const planningAreaByPlace = useMemo(() => new Map(plan.candidates
    .filter((candidate) => candidate.planningRole === "planning_area")
    .map((candidate) => [candidate.placeId, candidate])), [plan.candidates]);
  const normalRows = rows.filter((row) => row.node.status === "normal");
  const wholeAreaIds = [...new Set(normalRows.flatMap((row) => planningAreaByPlace.get(row.node.placeId)?.id ?? []))];
  const dirtyCount = workspace.routeStates.filter((item) => item.dirty).length;
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>({ nameZh: "", kind: "attraction" });
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const selectedRow = rows.find((row) => row.node.id === selectedNodeId) ?? null;
  const selectedStopOwner = selectedNodeId ? plan.days.find((day) => day.stops.some((stop) => stop.id === selectedNodeId)) ?? null : null;
  const [editDraft, setEditDraft] = useState<PlaceEditDraft | null>(null);
  const [detailDraft, setDetailDraft] = useState<DetailDraft | null>(null);
  const [preview, setPreview] = useState<GoogleMapsPreviewV3 | null>(null);
  const [editMessage, setEditMessage] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessage, setAiMessage] = useState("");
  const [segmentFrom, setSegmentFrom] = useState<string>("");
  const [segmentTo, setSegmentTo] = useState<string>("");

  useEffect(() => {
    if (!selectedRow?.place) {
      setEditDraft(null);
      setDetailDraft(null);
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
    setDetailDraft({
      activity: selectedRow.node.activity ?? selectedRow.place.nameZh,
      period: selectedRow.node.period ?? "",
      startTime: selectedRow.node.startTime ?? "",
      endTime: selectedRow.node.endTime ?? "",
      durationMinutes: selectedRow.node.durationMinutes === null ? "" : String(selectedRow.node.durationMinutes),
      notes: selectedRow.node.notes ?? "",
    });
    setPreview(null);
    setEditMessage("");
  }, [selectedRow?.node.id, selectedRow?.node.activity, selectedRow?.node.period, selectedRow?.node.startTime, selectedRow?.node.endTime, selectedRow?.node.durationMinutes, selectedRow?.node.notes, selectedRow?.place?.id, selectedRow?.place?.nameZh, selectedRow?.place?.nameLocal, selectedRow?.place?.nameEn, selectedRow?.place?.kind]);

  useEffect(() => {
    const ids = normalRows.map((row) => row.node.id);
    if (!ids.includes(segmentFrom)) setSegmentFrom(ids[0] ?? "");
    if (!ids.includes(segmentTo)) setSegmentTo(ids.at(-1) ?? "");
  }, [normalRows.map((row) => row.node.id).join("|")]);

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

  const saveDetail = async () => {
    if (!selectedRow || !selectedStopOwner || !detailDraft || aiBusy || busy) return;
    const durationText = detailDraft.durationMinutes.trim();
    const durationMinutes = durationText ? Number(durationText) : null;
    if (durationText && (!Number.isInteger(durationMinutes) || durationMinutes! < 0)) {
      setEditMessage("停留分钟数需要填写 0 或正整数。");
      return;
    }
    setAiBusy(true);
    setEditMessage("");
    try {
      await api(`/api/trips/${workspace.trip.id}/actions/cta`, {
        method: "POST",
        body: JSON.stringify({
          stage: "itinerary",
          actionType: "itinerary.edit",
          parameters: {
            stopId: selectedRow.node.id,
            changes: {
              activity: detailDraft.activity.trim() || selectedRow.place?.nameZh || "游览地点",
              period: detailDraft.period || null,
              startTime: detailDraft.startTime.trim() || null,
              endTime: detailDraft.endTime.trim() || null,
              durationMinutes,
              notes: detailDraft.notes.trim() || null,
            },
          },
          targetIds: [selectedRow.node.id],
          requestKey: crypto.randomUUID(),
        }),
      });
      setEditMessage("详细安排已保存；最终线路节点会同步更新。");
    } catch (cause) {
      setEditMessage(cause instanceof Error ? cause.message : "详细安排保存失败。");
    } finally {
      setAiBusy(false);
    }
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

  const startAi = async (stage: ConversationStage, actionType: AiActionType, parameters: Record<string, unknown>, targetIds: string[], message: string) => {
    if (aiBusy || busy) return;
    setAiBusy(true);
    setAiMessage("");
    try {
      await api(`/api/trips/${workspace.trip.id}/actions/cta`, {
        method: "POST",
        body: JSON.stringify({ stage, actionType, parameters, targetIds, requestKey: crypto.randomUUID() }),
      });
      setAiMessage(message);
    } catch (cause) {
      setAiMessage(cause instanceof Error ? cause.message : "AI 操作没有启动，请重试。");
    } finally {
      setAiBusy(false);
    }
  };

  const handleProposal = async (proposalId: string, action: ProposalAction) => {
    if (aiBusy || busy) return;
    setAiBusy(true);
    setAiMessage("");
    try {
      await api(proposalActionPath(workspace.trip.id, proposalId, action), { method: "POST", body: "{}" });
      setAiMessage(action === "apply" ? "已采用这次 AI 方案。" : action === "reject" ? "已保留当前安排。" : "已撤销这次 AI 方案。");
    } catch (cause) {
      setAiMessage(cause instanceof Error ? cause.message : "无法处理这次 AI 方案。");
    } finally {
      setAiBusy(false);
    }
  };

  const areaIdsForDay = (day: typeof plan.days[number] | undefined) => {
    if (!day) return [];
    const placeIds = [day.startAnchor.placeId, ...day.stops.map((stop) => stop.placeId), day.endAnchor.placeId].filter((id): id is string => Boolean(id));
    return [...new Set(placeIds.flatMap((placeId) => planningAreaByPlace.get(placeId)?.id ?? []))];
  };

  const segmentBounds = (() => {
    const fromIndex = rows.findIndex((row) => row.node.id === segmentFrom);
    const toIndex = rows.findIndex((row) => row.node.id === segmentTo);
    if (fromIndex < 0 || toIndex < 0) return null;
    return { start: Math.min(fromIndex, toIndex), end: Math.max(fromIndex, toIndex) };
  })();
  const segmentRows = segmentBounds ? rows.slice(segmentBounds.start, segmentBounds.end + 1).filter((row) => row.node.status === "normal") : [];
  const segmentAreaIds = [...new Set(segmentRows.flatMap((row) => planningAreaByPlace.get(row.node.placeId)?.id ?? []))];
  const visibleAiActions = workspace.actions.filter((action) => action.actionType === "itinerary.day.optimize" || action.actionType === "itinerary.repair" || action.actionType === "itinerary.refine");
  const visibleAiProposals = visibleAiActions.flatMap((action) => action.proposalId
    ? workspace.proposals.filter((proposal) => proposal.id === action.proposalId).map((proposal) => ({ action, proposal }))
    : []).slice(-6).reverse();

  return <section className="final-route-panel-v3">
    <header className="final-route-panel-head-v3">
      <div><p className="eyebrow">行程</p><h2>最终线路</h2><p>这就是实际保存的线路。Day、详细安排、地图和交通路线都跟着这里变化。</p></div>
      <button className="button primary" type="button" disabled={busy || aiBusy} onClick={() => setAddOpen((value) => !value)}><Plus size={15}/>添加地点</button>
    </header>

    <div className="final-route-summary-v3">
      <span><b>{rows.length}</b> 个线路地点</span>
      <span><b>{plan.days.length}</b> 天</span>
      <span><b>{rows.filter((row) => row.node.status === "tentative").length}</b> 待定</span>
      <span><b>{rows.filter((row) => row.node.status === "no_go").length}</b> 不去</span>
      {dirtyCount > 0 && <button className="button small" type="button" disabled={busy || aiBusy} onClick={() => void onRecalculateDirtyRoutes()}><RefreshCw size={13}/>更新 {dirtyCount} 天地图路线</button>}
    </div>
    {notice && <p className="final-route-notice-v3">{notice}</p>}

    <section className="final-route-add-v3 final-route-ai-tools-v3">
      <strong><Sparkles size={15}/>AI 辅助</strong>
      {!rows.length ? <div className="final-route-inline-actions-v3">
        <button className="button primary" type="button" disabled={busy || aiBusy || !plan.trip.brief.destination.trim()} onClick={() => void startAi("destinations", "destination.generate", { request: "生成主要地点" }, [], "AI 已开始生成主要地点，结果会直接进入最终线路。")}>生成主要地点</button>
        {!plan.trip.brief.destination.trim() && <small>先在“旅行需求”填写目的地。</small>}
      </div> : <>
        <div className="final-route-inline-actions-v3">
          <button className="button small" type="button" disabled={busy || aiBusy || !wholeAreaIds.length} onClick={() => void startAi("interests", "interest.discover", { request: "final-route-detail-scope:trip" }, wholeAreaIds, "AI 已开始补充详细地点，只会新增地点，不会移动现有线路。")}>生成详细地点</button>
          <button className="button small" type="button" disabled={busy || aiBusy || normalRows.length < 2} onClick={() => void startAi("itinerary", "itinerary.repair", { request: "优化全程" }, [], "AI 已开始分析全程顺序；完成后会给你一份可采用或拒绝的方案。")}>优化全程</button>
        </div>
        {normalRows.length >= 2 && <div className="final-route-segment-ai-v3">
          <label><span>这一段从</span><select value={segmentFrom} disabled={busy || aiBusy} onChange={(event) => setSegmentFrom(event.target.value)}>{normalRows.map((row) => <option key={row.node.id} value={row.node.id}>{row.index + 1}. {row.place?.nameZh ?? "未命名地点"}</option>)}</select></label>
          <label><span>到</span><select value={segmentTo} disabled={busy || aiBusy} onChange={(event) => setSegmentTo(event.target.value)}>{normalRows.map((row) => <option key={row.node.id} value={row.node.id}>{row.index + 1}. {row.place?.nameZh ?? "未命名地点"}</option>)}</select></label>
          <div className="final-route-inline-actions-v3">
            <button className="button small" type="button" disabled={busy || aiBusy || !segmentAreaIds.length || segmentFrom === segmentTo} onClick={() => void startAi("interests", "interest.discover", { request: `final-route-detail-scope:segment:${segmentFrom}:${segmentTo}` }, segmentAreaIds, "AI 已开始补充这一段的详细地点，不会移动已有节点。")}>补充这一段</button>
            <button className="button small" type="button" disabled={busy || aiBusy || segmentRows.length < 2 || segmentFrom === segmentTo} onClick={() => void startAi("itinerary", "itinerary.repair", { request: "优化这一段" }, [segmentFrom, segmentTo], "AI 已开始分析这一段；完成后由你决定是否采用新顺序。")}>优化这一段</button>
          </div>
        </div>}
      </>}
      <small>普通生成只能插入新地点；“完善这一天”只能补时间和备注。只有你明确点击“优化”时，AI 才能提出已有地点的重排方案。</small>
      {aiMessage && <small className="final-route-edit-message-v3">{aiMessage}</small>}
    </section>

    {visibleAiProposals.length > 0 && <section className="final-route-add-v3 final-route-ai-proposals-v3">
      <strong><WandSparkles size={15}/>AI 方案</strong>
      {visibleAiProposals.map(({ action, proposal }) => <article key={proposal.id} className={`phase6-proposal-card ${proposal.status}`}>
        <header><strong>{proposal.title}</strong><span>{action.actionType === "itinerary.refine" ? "详细安排" : "顺序优化"} · {proposal.status === "pending" ? "待你决定" : proposal.status === "applied" ? "已采用" : proposal.status === "rejected" ? "未采用" : proposal.status === "superseded" ? "已失效" : proposal.status === "undone" ? "已撤销" : proposal.status}</span></header>
        <p>{proposal.explanation}</p>
        {proposal.status === "pending" && <footer><button className="button" type="button" disabled={busy || aiBusy} onClick={() => void handleProposal(proposal.id, "reject")}>不采用</button><button className="button primary" type="button" disabled={busy || aiBusy || proposal.baseGeneration !== workspace.trip.contentGeneration} onClick={() => void handleProposal(proposal.id, "apply")}>采用这个方案</button></footer>}
        {proposal.status === "applied" && <footer><button className="button" type="button" disabled={busy || aiBusy || workspace.trip.contentGeneration !== proposal.baseGeneration + 1} onClick={() => void handleProposal(proposal.id, "undo")}>撤销这次方案</button></footer>}
      </article>)}
    </section>}

    {addOpen && <section className="final-route-add-v3">
      <strong>{selectedRow ? `添加在“${selectedRow.place?.nameZh ?? "当前地点"}”之后` : "添加到线路末尾"}</strong>
      <div><input autoFocus value={addDraft.nameZh} disabled={busy || aiBusy} placeholder="地点名称，例如：Hobbiton" onChange={(event) => setAddDraft((current) => ({ ...current, nameZh: event.target.value }))}/><select value={addDraft.kind} disabled={busy || aiBusy} onChange={(event) => setAddDraft((current) => ({ ...current, kind: event.target.value as PlaceKind }))}>{Object.entries(placeKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="button primary" type="button" disabled={busy || aiBusy || !addDraft.nameZh.trim()} onClick={() => void submitAdd()}>加入线路</button></div>
      <small>地点可以先加入、后定位。添加地点不会自动设置住宿，也不会移动现有地点。</small>
    </section>}

    {!rows.length ? <div className="final-route-empty-v3"><MapPin size={30}/><strong>最终线路还是空的</strong><p>可以手动添加，也可以让 AI 先生成主要地点。生成结果会直接成为最终线路。</p></div> : <div className="final-route-list-v3">
      {rows.map((row, rowIndex) => {
        const previous = rows[rowIndex - 1];
        const day = plan.days[row.dayNumber - 1];
        const showDay = !previous || previous.dayNumber !== row.dayNumber;
        const dayAreaIds = showDay ? areaIdsForDay(day) : [];
        const resolution = resolutions.get(row.node.placeId);
        const locationState = resolution?.status ?? "missing";
        const display = placeNamePresentation(row.place, workspace.trip.planLanguage, row.node.activity || "未命名地点");
        const selected = row.node.id === selectedNodeId;
        return <div className="final-route-row-wrap-v3" key={row.node.id}>
          {showDay && <div className="final-route-day-divider-v3"><b>Day {row.dayNumber}</b><span>{day?.date || "日期待定"}</span><div className="final-route-inline-actions-v3"><button className="button small" type="button" disabled={busy || aiBusy || !dayAreaIds.length} onClick={() => void startAi("interests", "interest.discover", { request: `final-route-detail-scope:day:${day?.id ?? ""}` }, dayAreaIds, "AI 已开始补充这一天的详细地点。")}>补充详细地点</button><button className="button small" type="button" disabled={busy || aiBusy || !day || day.stops.length < 1} onClick={() => day && void startAi("itinerary", "itinerary.refine", { dayIds: [day.id], request: "完善这一天" }, [day.id], "AI 已开始补充这一天的时间和活动说明；完成后由你决定是否采用。")}>完善这一天</button><button className="button small" type="button" disabled={busy || aiBusy || !day || day.stops.length < 2} onClick={() => day && void startAi("itinerary", "itinerary.day.optimize", { dayId: day.id, request: "优化这一天" }, [day.id], "AI 已开始分析这一天的顺序；完成后由你决定是否采用。")}>优化这一天</button></div></div>}
          <article
            className={`final-route-row-v3 status-${row.node.status} ${selected ? "selected" : ""}`}
            draggable={!busy && !aiBusy}
            onDragStart={() => setDraggedNodeId(row.node.id)}
            onDragEnd={() => setDraggedNodeId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!draggedNodeId || draggedNodeId === row.node.id) return;
              setDraggedNodeId(null);
              void onMoveNode(draggedNodeId, row.index);
            }}
          >
            <button className="final-route-drag-v3" type="button" aria-label="拖动地点排序" title="拖动排序"><GripVertical size={17}/></button>
            <button className="final-route-main-v3" type="button" onClick={() => onSelectNode(row.node.id)}>
              <span className="final-route-index-v3">{row.index + 1}</span>
              <span><strong>{display.primary}</strong>{display.secondary && <small>{display.secondary}</small>}<small>{placeKindLabels[row.place?.kind ?? "waypoint"]} · {resolutionLabel(locationState)}{row.node.startTime || row.node.scheduleText ? ` · ${row.node.startTime || row.node.scheduleText}` : ""}</small></span>
            </button>
            <div className="final-route-badges-v3"><span className={`status-pill-v3 ${row.node.status}`}>{finalRouteStatusLabelsV3[row.node.status]}</span>{row.node.endsDay && <span className={`stay-pill-v3 ${row.node.status !== "normal" ? "inactive" : ""}`}>住</span>}</div>
            <div className="final-route-quick-v3">
              <button type="button" disabled={busy || aiBusy || row.index === 0} aria-label="上移" onClick={() => void onMoveNode(row.node.id, row.index - 1)}><ArrowUp size={14}/></button>
              <button type="button" disabled={busy || aiBusy || row.index === rows.length - 1} aria-label="下移" onClick={() => void onMoveNode(row.node.id, row.index + 1)}><ArrowDown size={14}/></button>
              <button type="button" aria-label="地图聚焦" onClick={() => onFocusNode(row.node.id)}><Crosshair size={14}/></button>
            </div>
          </article>

          {selected && <section className="final-route-editor-v3">
            <div className="final-route-control-group-v3"><label>地点状态</label><div className="final-route-segmented-v3">{(["normal", "tentative", "no_go"] as FinalRouteNodeStatus[]).map((status) => <button type="button" key={status} className={row.node.status === status ? "active" : ""} disabled={busy || aiBusy || row.node.status === status} onClick={() => void onSetStatus(row.node.id, status)}>{finalRouteStatusLabelsV3[status]}</button>)}</div>{row.node.status !== "normal" && <small>保留在线路和地图原位置，但暂时不参与当前 Day 和交通路线。</small>}</div>

            <div className="final-route-control-group-v3"><label>当天是否在这里结束</label><div className="final-route-inline-actions-v3">{row.node.endsDay ? <><button className="button small" type="button" disabled={busy || aiBusy} onClick={() => void onSetBoundary(row.node.id, false)}>不住</button><button className="button small" type="button" disabled={busy || aiBusy || row.node.status !== "normal"} onClick={() => void onAddNight(row.node.id)}>多一晚</button></> : <button className="button small" type="button" disabled={busy || aiBusy || row.node.status !== "normal"} onClick={() => void onSetBoundary(row.node.id, true)}>住</button>}</div>{row.node.status !== "normal" && row.node.endsDay && <small>住宿分界仍保存，恢复“正常”后会在原位置重新生效。</small>}</div>

            <div className="final-route-control-group-v3"><label>到达这里的交通方式</label><select value={row.node.transportFromPrevious?.mode ?? ""} disabled={busy || aiBusy} onChange={(event) => void onSetTransport(row.node.id, event.target.value as TransportMode | "")}><option value="">未设置</option>{transportOptions.map((mode) => <option key={mode} value={mode}>{transportModeLabelsV3[mode]}</option>)}</select><small>这项设置属于当前地点：上一个当前有效地点变化时，它仍跟着当前地点保留。</small></div>

            {detailDraft && <details className="final-route-details-v3" open>
              <summary><Clock3 size={14}/>详细安排</summary>
              {selectedStopOwner ? <>
                <div className="final-route-edit-grid-v3">
                  <label><span>活动说明</span><input value={detailDraft.activity} disabled={busy || aiBusy} onChange={(event) => setDetailDraft((current) => current ? { ...current, activity: event.target.value } : current)}/></label>
                  <label><span>时段</span><select value={detailDraft.period} disabled={busy || aiBusy} onChange={(event) => setDetailDraft((current) => current ? { ...current, period: event.target.value as Period | "" } : current)}><option value="">未设置</option>{Object.entries(periodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label><span>开始时间</span><input type="time" value={detailDraft.startTime} disabled={busy || aiBusy} onChange={(event) => setDetailDraft((current) => current ? { ...current, startTime: event.target.value } : current)}/></label>
                  <label><span>结束时间</span><input type="time" value={detailDraft.endTime} disabled={busy || aiBusy} onChange={(event) => setDetailDraft((current) => current ? { ...current, endTime: event.target.value } : current)}/></label>
                  <label><span>停留分钟</span><input inputMode="numeric" value={detailDraft.durationMinutes} disabled={busy || aiBusy} placeholder="例如 90" onChange={(event) => setDetailDraft((current) => current ? { ...current, durationMinutes: event.target.value } : current)}/></label>
                  <label><span>备注</span><input value={detailDraft.notes} disabled={busy || aiBusy} onChange={(event) => setDetailDraft((current) => current ? { ...current, notes: event.target.value } : current)}/></label>
                </div>
                {row.node.scheduleText && <small>AI / 用户自然语言安排：{row.node.scheduleText}</small>}
                <div className="final-route-inline-actions-v3"><button className="button small" type="button" disabled={busy || aiBusy} onClick={() => void saveDetail()}>保存详细安排</button></div>
                <small>这里直接编辑当前线路节点的活动和时间；不会改变地点顺序、状态、住宿分界或 Provider 路线事实。</small>
              </> : <small>当前节点是这一天的结束位置，不作为当天中途 Stop 单独维护时间表；住宿分界和地点信息仍可在上方编辑。</small>}
            </details>}

            {editDraft && row.place && <details className="final-route-details-v3" open>
              <summary><Pencil size={14}/>编辑地点与定位</summary>
              <div className="final-route-edit-grid-v3">
                <label><span>中文名称</span><input value={editDraft.nameZh} disabled={busy || aiBusy} onChange={(event) => setEditDraft((current) => current ? { ...current, nameZh: event.target.value } : current)}/></label>
                <label><span>英文名称</span><input value={editDraft.nameEn ?? ""} disabled={busy || aiBusy} onChange={(event) => setEditDraft((current) => current ? { ...current, nameEn: event.target.value || null } : current)}/></label>
                <label><span>当地名称</span><input value={editDraft.nameLocal ?? ""} disabled={busy || aiBusy} onChange={(event) => setEditDraft((current) => current ? { ...current, nameLocal: event.target.value || null } : current)}/></label>
                <label><span>地点类型</span><select value={editDraft.kind} disabled={busy || aiBusy} onChange={(event) => setEditDraft((current) => current ? { ...current, kind: event.target.value as PlaceKind } : current)}>{Object.entries(placeKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              </div>
              <div className="final-route-inline-actions-v3"><button className="button small" type="button" disabled={busy || aiBusy} onClick={() => void savePlace()}>保存地点信息</button><button className="button small" type="button" disabled={busy || aiBusy} onClick={() => void onRetry([row.place!.id], true)}><RefreshCw size={13}/>重新识别</button><button className="button small" type="button" disabled={busy || aiBusy} onClick={() => onBeginMapPick(row.place!.id)}><Crosshair size={13}/>地图选点</button></div>
              <div className="final-route-google-v3"><label><span><Link size={13}/>Google Maps 链接（可选）</span><input value={editDraft.googleUrl} disabled={busy || aiBusy} placeholder="粘贴 Google Maps 地点链接" onChange={(event) => { setPreview(null); setEditDraft((current) => current ? { ...current, googleUrl: event.target.value } : current); }}/></label><button className="button small" type="button" disabled={busy || aiBusy || !editDraft.googleUrl.trim()} onClick={() => void previewGoogle()}>预览</button>{preview && <div className="final-route-google-preview-v3"><strong>{preview.name || "地图地点"}</strong><small>{preview.address || `${preview.latitude}, ${preview.longitude}`}</small>{preview.warning && <small>{preview.warning}</small>}<button className="button primary small" type="button" disabled={busy || aiBusy} onClick={() => void applyGoogle()}>使用这个定位</button></div>}</div>
              {editMessage && <small className="final-route-edit-message-v3">{editMessage}</small>}
            </details>}

            <div className="final-route-danger-v3"><button className="button danger small" type="button" disabled={busy || aiBusy} onClick={() => { if (window.confirm(`从最终线路移除“${display.primary}”这一次出现？`)) void onRemoveNode(row.node.id); }}><Trash2 size={13}/>从线路移除</button><small>只移除这一次线路节点；同一现实地点在其他位置的节点不会一起删除。</small></div>
          </section>}
        </div>;
      })}
    </div>}
  </section>;
}