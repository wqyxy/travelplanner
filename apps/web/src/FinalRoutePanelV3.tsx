import { GripVertical, MapPin, Pencil, Plus, RefreshCw, Route, Sparkles, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { FinalRouteEditorDrawerV4 } from "./FinalRouteEditorDrawerV4";
import type { FinalRouteNodeStatus, PlaceKind, TransportMode } from "./v2-types";
import type { AiActionType, ConversationStage, WorkspaceV3 } from "./v3-types";
import { placeNamePresentation } from "./place-name-presentation";
import {
  finalRouteDayViewsV4,
  finalRouteDisplayRowsV3,
  finalRouteStatusLabelsV3,
  finalRouteTransportConnectionsV4,
  transportModeLabelsV3,
  type FinalRouteTransportConnectionV4,
} from "./final-route-ui-v3";
import { formatDistance, formatRouteDuration } from "./workspace-v2";
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

type AddDraft = { nameZh: string; kind: PlaceKind };

function locationAttentionLabel(status: "resolving" | "resolved" | "unresolved" | "missing") {
  if (status === "resolved") return null;
  if (status === "resolving") return "定位中";
  return "未定位";
}

function dayRouteLabel(state: ReturnType<typeof finalRouteDayViewsV4>[number]["routeState"]) {
  if (state === "dirty") return "路线更新中";
  if (state === "attention") return "路线需注意";
  if (state === "calculating") return "路线计算中";
  if (state === "idle") return "路线待计算";
  return null;
}

function connectionText(connection: FinalRouteTransportConnectionV4) {
  if (connection.state === "same_place") return "同地停留";
  if (connection.state === "dirty") return "路线更新中";
  if (connection.state === "pending") return "路线待计算";
  const parts = [formatDistance(connection.distanceKm), formatRouteDuration(connection.durationMinutes)];
  if (connection.state === "attention") parts.push("需注意");
  return parts.join(" · ");
}

export function FinalRoutePanelV3({
  workspace,
  selectedNodeId,
  hoveredNodeId,
  editingNodeId,
  busy,
  notice,
  onSelectNode,
  onHoverNode,
  onFocusNode,
  onEditNode,
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
  hoveredNodeId: string | null;
  editingNodeId: string | null;
  busy: boolean;
  notice?: string;
  onSelectNode: (nodeId: string) => void;
  onHoverNode: (nodeId: string | null) => void;
  onFocusNode: (nodeId: string) => void;
  onEditNode: (nodeId: string | null) => void;
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
  onBeginMapPick: (placeId: string, nodeId: string) => void;
  onRecalculateDirtyRoutes: () => Promise<void>;
}) {
  const plan = workspace.trip.plan;
  const rows = useMemo(() => finalRouteDisplayRowsV3(plan), [plan]);
  const dayViews = useMemo(() => finalRouteDayViewsV4(plan, workspace.routeStates), [plan, workspace.routeStates]);
  const connections = useMemo(() => finalRouteTransportConnectionsV4(plan, workspace.routeStates), [plan, workspace.routeStates]);
  const connectionsByDestination = useMemo(() => new Map(connections.map((connection) => [connection.toNodeId, connection])), [connections]);
  const dayViewsByNumber = useMemo(() => new Map(dayViews.map((day) => [day.dayNumber, day])), [dayViews]);
  const resolutions = useMemo(() => new Map(workspace.resolutions.map((item) => [item.placeId, item])), [workspace.resolutions]);
  const placesById = useMemo(() => new Map(plan.places.map((place) => [place.id, place])), [plan.places]);
  const planningAreaByPlace = useMemo(() => new Map(plan.candidates
    .filter((candidate) => candidate.planningRole === "planning_area")
    .map((candidate) => [candidate.placeId, candidate])), [plan.candidates]);
  const normalRows = rows.filter((row) => row.node.status === "normal");
  const wholeAreaIds = [...new Set(normalRows.flatMap((row) => planningAreaByPlace.get(row.node.placeId)?.id ?? []))];
  const dirtyCount = workspace.routeStates.filter((item) => item.dirty).length;
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>({ nameZh: "", kind: "attraction" });
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [transportEditingNodeId, setTransportEditingNodeId] = useState<string | null>(null);
  const selectedRow = rows.find((row) => row.node.id === selectedNodeId) ?? null;
  const editingRow = rows.find((row) => row.node.id === editingNodeId) ?? null;
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessage, setAiMessage] = useState("");
  const [segmentFrom, setSegmentFrom] = useState<string>("");
  const [segmentTo, setSegmentTo] = useState<string>("");

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

  return <>
    <section className="final-route-panel-v3">
      <header className="final-route-panel-head-v3">
        <div><p className="eyebrow">行程</p><h2>最终线路</h2><p>地点是块、交通是线、住宿切出 Day。鼠标经过地点只高亮地图，点击地点才定位到地图。</p></div>
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
          const dayView = dayViewsByNumber.get(row.dayNumber) ?? null;
          const showDay = !previous || previous.dayNumber !== row.dayNumber;
          const dayAreaIds = showDay ? areaIdsForDay(day) : [];
          const resolution = resolutions.get(row.node.placeId);
          const locationState = resolution?.status ?? "missing";
          const locationAttention = locationAttentionLabel(locationState);
          const display = placeNamePresentation(row.place, workspace.trip.planLanguage, row.node.activity || "未命名地点");
          const selected = row.node.id === selectedNodeId;
          const hovered = row.node.id === hoveredNodeId;
          const editing = row.node.id === editingNodeId;
          const connection = row.node.status === "normal" ? connectionsByDestination.get(row.node.id) ?? null : null;
          const fromName = connection ? placesById.get(connection.fromPlaceId)?.nameZh ?? "上一地点" : "";
          const toName = connection ? placesById.get(connection.toPlaceId)?.nameZh ?? display.primary : "";
          return <div className="final-route-row-wrap-v3" key={row.node.id}>
            {showDay && <section className="final-route-day-divider-v3">
              <div className="final-route-day-title-v4"><b>Day {row.dayNumber}</b><div><strong>{dayView?.title || day?.title || "当日行程"}</strong><span>{dayView?.date || day?.date || "日期待定"}</span></div></div>
              <div className="final-route-day-route-v4">
                {dayView?.routeState === "ready" || dayView?.routeState === "attention" ? <><span>{formatDistance(dayView.distanceKm)}</span><span>{formatRouteDuration(dayView.durationMinutes)}</span></> : <span>{dayView ? dayRouteLabel(dayView.routeState) : "路线待计算"}</span>}
              </div>
              <div className="final-route-inline-actions-v3"><button className="button small" type="button" disabled={busy || aiBusy || !dayAreaIds.length} onClick={() => void startAi("interests", "interest.discover", { request: `final-route-detail-scope:day:${day?.id ?? ""}` }, dayAreaIds, "AI 已开始补充这一天的详细地点。")}>补充详细地点</button><button className="button small" type="button" disabled={busy || aiBusy || !day || day.stops.length < 1} onClick={() => day && void startAi("itinerary", "itinerary.refine", { dayIds: [day.id], request: "完善这一天" }, [day.id], "AI 已开始补充这一天的时间和活动说明；完成后由你决定是否采用。")}>完善这一天</button><button className="button small" type="button" disabled={busy || aiBusy || !day || day.stops.length < 2} onClick={() => day && void startAi("itinerary", "itinerary.day.optimize", { dayId: day.id, request: "优化这一天" }, [day.id], "AI 已开始分析这一天的顺序；完成后由你决定是否采用。")}>优化这一天</button></div>
              {dayView?.emptyDetail && <div className="final-route-day-empty-v4"><strong>这一天还没有详细安排</strong><span>目前是同一地点连续住宿形成的空日程，可以继续添加地点或让 AI 补充。</span></div>}
            </section>}

            {connection && <div className={`final-route-transport-connector-v4 state-${connection.state}`}>
              <button type="button" className="final-route-transport-main-v4" disabled={busy || aiBusy} title={connection.warning || undefined} onClick={() => setTransportEditingNodeId((current) => current === row.node.id ? null : row.node.id)}>
                <Route size={14}/><strong>{connection.mode ? transportModeLabelsV3[connection.mode] : "交通待定"}</strong><span>{connectionText(connection)}</span>{connection.skippedInactiveCount > 0 && <small>{fromName} → {toName} · 已跳过 {connection.skippedInactiveCount} 个待定/不去地点</small>}
              </button>
              {transportEditingNodeId === row.node.id && <div className="final-route-transport-editor-v4">
                <label><span>这段交通方式</span><select autoFocus value={row.node.transportFromPrevious?.mode ?? ""} disabled={busy || aiBusy} onChange={(event) => { const mode = event.target.value as TransportMode | ""; setTransportEditingNodeId(null); void onSetTransport(row.node.id, mode); }}><option value="">未设置</option>{transportOptions.map((mode) => <option key={mode} value={mode}>{transportModeLabelsV3[mode]}</option>)}</select></label>
                <small>交通方式保存在“到达 {toName}”的线路节点上；距离和时间仍由路线 Provider 计算。</small>
              </div>}
            </div>}

            <article
              className={`final-route-row-v3 status-${row.node.status} ${selected ? "map-selected" : ""} ${hovered ? "hover-linked" : ""} ${editing ? "editing" : ""}`}
              onMouseEnter={() => onHoverNode(row.node.id)}
              onMouseLeave={() => onHoverNode(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (!draggedNodeId || draggedNodeId === row.node.id) return;
                setDraggedNodeId(null);
                void onMoveNode(draggedNodeId, row.index);
              }}
            >
              <button className="final-route-drag-v3" type="button" draggable={!busy && !aiBusy} disabled={busy || aiBusy} aria-label="拖动地点排序" title="拖动排序" onDragStart={(event) => { event.stopPropagation(); setDraggedNodeId(row.node.id); }} onDragEnd={() => setDraggedNodeId(null)}><GripVertical size={17}/></button>
              <button className="final-route-main-v3" type="button" onClick={() => onFocusNode(row.node.id)}>
                <span className="final-route-index-v3">{row.index + 1}</span>
                <span><strong>{display.primary}</strong>{display.secondary && <small>{display.secondary}</small>}<small>{placeKindLabels[row.place?.kind ?? "waypoint"]}{row.node.startTime || row.node.scheduleText ? ` · ${row.node.startTime || row.node.scheduleText}` : ""}</small></span>
              </button>
              <div className="final-route-badges-v3">
                {row.node.status !== "normal" && <span className={`status-pill-v3 ${row.node.status}`}>{finalRouteStatusLabelsV3[row.node.status]}</span>}
                {locationAttention && <span className={`location-pill-v4 ${locationState}`}>{locationAttention}</span>}
                {row.node.status !== "normal" && row.node.endsDay && <span className="stay-pill-v3 inactive">住 · 暂不生效</span>}
              </div>
              <div className="final-route-quick-v4">
                {row.node.status === "normal" && !row.node.endsDay && <button className="final-route-stay-action-v4" type="button" disabled={busy || aiBusy} onClick={() => void onSetBoundary(row.node.id, true)}>+ 住</button>}
                {row.node.status === "normal" && row.node.endsDay && <details className="final-route-stay-menu-v4"><summary>住 ▾</summary><div><button type="button" disabled={busy || aiBusy} onClick={(event) => { event.preventDefault(); void onAddNight(row.node.id); }}>多一晚</button><button type="button" disabled={busy || aiBusy} onClick={(event) => { event.preventDefault(); void onSetBoundary(row.node.id, false); }}>不住</button></div></details>}
                <details className="final-route-status-menu-v4"><summary>状态</summary><div>{(["normal", "tentative", "no_go"] as FinalRouteNodeStatus[]).map((status) => <button type="button" key={status} disabled={busy || aiBusy || row.node.status === status} onClick={(event) => { event.preventDefault(); void onSetStatus(row.node.id, status); }}>{finalRouteStatusLabelsV3[status]}</button>)}</div></details>
                <button className={`final-route-edit-action-v4 ${editing ? "active" : ""}`} type="button" disabled={busy || aiBusy || !row.place} onClick={() => onEditNode(editing ? null : row.node.id)}><Pencil size={13}/>编辑</button>
              </div>
            </article>

            {row.node.status !== "normal" && <div className="final-route-inactive-note-v4">暂不参与当前 Day 和交通路线；恢复为“正常”后会在原位置重新生效。</div>}
          </div>;
        })}
      </div>}
    </section>

    {editingRow && <FinalRouteEditorDrawerV4
      workspace={workspace}
      row={editingRow}
      busy={busy || aiBusy}
      onClose={() => onEditNode(null)}
      onUpdatePlace={onUpdatePlace}
      onPreviewGoogleMapsLink={onPreviewGoogleMapsLink}
      onApplyGoogleMapsLink={onApplyGoogleMapsLink}
      onRetry={onRetry}
      onBeginMapPick={onBeginMapPick}
      onRemoveNode={onRemoveNode}
    />}
  </>;
}
