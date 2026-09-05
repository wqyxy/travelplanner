import { type FormEvent, useEffect, useRef, useState } from "react";
import { History, KeyRound, MapPinned, Menu, Moon, Plus, RefreshCw, Route, Sun, Trash2 } from "lucide-react";
import { api } from "./api";
import { AiTaskTopbar } from "./AiTaskTopbar";
import type { GoogleMapsPreviewV3, WorkflowPlaceEditChangesV3 } from "./CandidateWorkflowPanelV3";
import { FinalRouteMapV3, type FinalRouteMapFocusRequestV3 } from "./FinalRouteMapV3";
import { FinalRoutePanelV3 } from "./FinalRoutePanelV3";
import { PasswordDrawer } from "./PasswordDrawer";
import { PlanningAdvisoryListV3 } from "./PlanningAdvisoryListV3";
import { RequirementsPanelV3 } from "./RequirementsPanelV3";
import { VersionDrawerV2 } from "./VersionDrawerV2";
import { WorkflowAssistantV3 } from "./WorkflowAssistantV3";
import { newFinalRoutePlaceCommandsV3, transportFromModeV3 } from "./final-route-ui-v3";
import type { AppSettings, PlanCommand, TransportMode, Trip, TripFacts, WorkspaceSelection } from "./v2-types";
import type { AiAction, AiActionType, ConversationStage, WorkspaceV3 } from "./v3-types";
import { proposalActionPath, type ProposalAction } from "./proposal-ui-v2";

type User = { id: string; username: string };
type Model = { model: string; displayName?: string; supportedReasoningEfforts?: Array<string | { reasoningEffort?: string }> };
type CodexStatus = { signedIn: boolean; models: Model[]; error?: string };
type Bootstrap = { authenticated: boolean; configured: boolean; user: User | null; settings: AppSettings };
type WorkspaceSectionV3 = "planning" | "route";
type WorkspaceFocus = null | "map" | "panel";
type CommandResult = {
  idMappings: Record<string, string>;
  effects: { changedDayIds: string[]; routeDirtyDayIds: string[] };
  trip: Trip;
  generation: number;
};

const ACTIVE_TASKS = new Set(["starting", "running", "waiting", "reconnecting"]);
const defaultSettings: AppSettings = { ai: { model: "", reasoningEffort: "medium" }, ui: { workspaceSplitRatio: .56, theme: "light", sidebarOpen: true, mapCategoryColors: {} } };

function Login({ setup, onDone }: { setup: boolean; onDone: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await api<{ user: User }>(setup ? "/api/auth/setup" : "/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      onDone(result.user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败。"); }
  };
  return <main className="auth-page"><form className="auth-card" onSubmit={submit}><div className="brand-mark">✦</div><p>AI TRAVEL PLANNER</p><h1>{setup ? "创建本机旅行空间" : "欢迎回来"}</h1><small>旅行和对话只保存在这台电脑的 private_data 中。</small><input required minLength={3} maxLength={32} pattern="[A-Za-z0-9_-]+" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名"/><input required minLength={6} type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码（至少 6 位）"/>{error && <em>{error}</em>}<button className="button primary">{setup ? "创建并进入" : "登录"}</button></form></main>;
}

export default function AppFinalRouteV3() {
  const [user, setUser] = useState<User | null | undefined>();
  const [configured, setConfigured] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceV3 | null>(null);
  const [section, setSection] = useState<WorkspaceSectionV3>("planning");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [mapPickPlaceId, setMapPickPlaceId] = useState<string | null>(null);
  const [mapFocusRequest, setMapFocusRequest] = useState<FinalRouteMapFocusRequestV3 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [routeNotice, setRouteNotice] = useState("");
  const [trash, setTrash] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [focus, setFocus] = useState<WorkspaceFocus>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const workspaceElement = useRef<HTMLDivElement>(null);
  const loadToken = useRef(0);
  const selectedTripId = useRef<string | null>(null);
  const mapFocusSequence = useRef(0);
  selectedTripId.current = workspace?.trip.id ?? null;

  const trip = workspace?.trip ?? null;
  const tasks = workspace?.tasks ?? [];
  const requirementsMessages = workspace?.messages.requirements ?? [];
  const activeTurn = [...requirementsMessages].reverse().find((item) => item.role === "user" && item.turn && ["queued", "starting", "active"].includes(item.turn.status));
  const aiActive = tasks.some((task) => ACTIVE_TASKS.has(task.status));
  const working = busy || Boolean(activeTurn) || aiActive;
  const selectedNode = trip?.plan.finalRoute?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedPlaceId = selectedNode?.placeId ?? null;
  const assistantSelection: WorkspaceSelection = { type: "trip", id: null };

  const applySettings = (next: AppSettings) => { setSettings(next); setSidebar(next.ui.sidebarOpen); };
  const refreshTrips = async (showTrash = trash) => setTrips((await api<{ trips: Trip[] }>(`/api/trips?view=${showTrash ? "trash" : "active"}`)).trips);
  const refreshCodex = async () => setCodex(await api<CodexStatus>("/api/codex/status"));
  const saveUi = async (patch: Partial<AppSettings["ui"]>) => { const result = await api<{ settings: AppSettings }>("/api/settings/ui", { method: "PUT", body: JSON.stringify(patch) }); applySettings(result.settings); return result.settings; };

  const loadTrip = async (id: string, resetSection = true) => {
    const token = ++loadToken.current;
    setError("");
    try {
      const next = await api<WorkspaceV3>(`/api/trips/${id}/workspace`);
      if (token !== loadToken.current) return;
      setWorkspace(next);
      setMenu(null);
      if (resetSection) setSection(next.trip.plan.finalRoute?.nodes.length ? "route" : "planning");
      setSelectedNodeId((current) => current && next.trip.plan.finalRoute?.nodes.some((node) => node.id === current) ? current : null);
      if (window.matchMedia("(max-width: 900px)").matches) setSidebar(false);
    } catch (cause) { if (token === loadToken.current) setError(cause instanceof Error ? cause.message : "无法加载旅行工作台。"); }
  };
  const refreshWorkspace = async () => { const id = selectedTripId.current; if (id) await loadTrip(id, false); };
  const runAction = async <T,>(operation: () => Promise<T>, fallback: string) => {
    setBusy(true); setError("");
    try { return await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : fallback); return undefined; }
    finally { setBusy(false); }
  };

  useEffect(() => { void api<Bootstrap>("/api/bootstrap").then((value) => { setUser(value.user); setConfigured(value.configured); applySettings(value.settings); if (value.authenticated) { void refreshTrips(false); void refreshCodex(); } }).catch(() => setUser(null)); }, []);
  useEffect(() => { document.documentElement.dataset.theme = settings.ui.theme; }, [settings.ui.theme]);
  useEffect(() => { if (user) void refreshTrips(trash); }, [trash, user?.id]);
  useEffect(() => { const timer = window.setTimeout(() => window.dispatchEvent(new Event("travel-workspace-resize")), 220); return () => window.clearTimeout(timer); }, [sidebar, focus, settings.ui.workspaceSplitRatio]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setFocus(null); setMapPickPlaceId(null); } }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, []);
  useEffect(() => {
    if (!user) return;
    let closed = false; let socket: WebSocket | null = null; let retryTimer: number | undefined;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
      socket.onopen = () => { void refreshWorkspace(); };
      socket.onmessage = (event) => {
        try {
          const item = JSON.parse(String(event.data)) as { kind: string; payload: any };
          if (item.payload?.tripId !== selectedTripId.current) return;
          if (item.kind === "ai-task.updated") {
            setWorkspace((current) => current ? { ...current, tasks: [item.payload, ...current.tasks.filter((task) => task.id !== item.payload.id)] } : current);
            if (!ACTIVE_TASKS.has(String(item.payload?.status))) void refreshWorkspace();
            return;
          }
          if (["travel.document.changed", "travel.resolution.changed", "travel.route.changed", "travel.proposal.changed", "travel.action.changed", "travel.turn.changed"].includes(item.kind)) { void refreshWorkspace(); void refreshTrips(false); }
        } catch { /* ignore malformed event */ }
      };
      socket.onclose = () => { if (!closed) retryTimer = window.setTimeout(connect, 1500); };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => { closed = true; if (retryTimer) window.clearTimeout(retryTimer); socket?.close(); };
  }, [user?.id]);

  const createTrip = async () => { await runAction(async () => { const result = await api<{ trip: Trip }>("/api/trips", { method: "POST", body: "{}" }); setTrash(false); await refreshTrips(false); await loadTrip(result.trip.id); setSection("planning"); }, "无法新建旅行。"); };
  const send = async (messageStage: ConversationStage, message: string, currentSelection: WorkspaceSelection) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/stages/${messageStage}/turns`, { method: "POST", body: JSON.stringify({ message, selection: currentSelection }) }); await refreshWorkspace(); }, "无法发送消息。"); };
  const startCta = async (actionStage: ConversationStage, actionType: AiActionType, parameters: Record<string, unknown> = {}, targetIds: string[] = []) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/actions/cta`, { method: "POST", body: JSON.stringify({ stage: actionStage, actionType, parameters, targetIds, requestKey: crypto.randomUUID() }) }); await refreshWorkspace(); }, "无法启动这个操作。"); };
  const confirmAction = async (action: AiAction) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/actions/${encodeURIComponent(action.id)}/confirm`, { method: "POST", body: JSON.stringify({ expectedGeneration: action.baseGeneration }) }); await refreshWorkspace(); }, "无法确认操作。"); };
  const cancelAction = async (action: AiAction) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/actions/${encodeURIComponent(action.id)}/cancel`, { method: "POST", body: JSON.stringify({ expectedGeneration: action.baseGeneration }) }); await refreshWorkspace(); }, "无法取消操作。"); };
  const proposalAction = async (proposalId: string, action: ProposalAction) => { if (!trip) return; await runAction(async () => { await api(proposalActionPath(trip.id, proposalId, action), { method: "POST", body: "{}" }); await loadTrip(trip.id, false); if (action !== "reject") await refreshTrips(false); }, "无法处理这个调整方案。"); };
  const stopTask = async (taskId: string) => { if (trip) await runAction(async () => { await api(`/api/trips/${trip.id}/ai-tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST", body: "{}" }); }, "无法停止任务。"); };

  const executeCommands = async (commands: PlanCommand[], fallback = "无法修改最终线路。") => {
    if (!trip) return null;
    return (await runAction(async () => {
      setRouteNotice("");
      const result = await api<CommandResult>(`/api/trips/${trip.id}/commands`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, commands }) });
      if (result.effects.routeDirtyDayIds.length) {
        try {
          await api(`/api/trips/${trip.id}/routes/recalculate`, { method: "POST", body: JSON.stringify({ expectedGeneration: result.generation }) });
        } catch {
          setRouteNotice("线路已经保存，但地图路线暂时没有全部更新。地点和顺序不会回滚，可以稍后点击“更新地图路线”。");
        }
      }
      await loadTrip(trip.id, false);
      await refreshTrips(false);
      return result;
    }, fallback)) ?? null;
  };

  const addRoutePlace = async (draft: { nameZh: string; kind: Trip["plan"]["places"][number]["kind"] }, index: number) => {
    const temporaryPlaceId = `tmp-place-${crypto.randomUUID()}`;
    const temporaryCandidateId = `tmp-candidate-${crypto.randomUUID()}`;
    const temporaryNodeId = `tmp-route-${crypto.randomUUID()}`;
    const result = await executeCommands(newFinalRoutePlaceCommandsV3({ index, temporaryPlaceId, temporaryCandidateId, temporaryNodeId, ...draft }), "无法把地点加入最终线路。");
    return result?.idMappings[temporaryNodeId] ?? null;
  };
  const moveRouteNode = async (nodeId: string, targetIndex: number) => { await executeCommands([{ type: "move_final_route_node", nodeId, targetIndex }]); };
  const setRouteStatus = async (nodeId: string, status: "normal" | "tentative" | "no_go") => { await executeCommands([{ type: "set_final_route_status", nodeId, status }]); };
  const setRouteBoundary = async (nodeId: string, endsDay: boolean) => { await executeCommands([{ type: "set_final_route_boundary", nodeId, endsDay }]); };
  const addRouteNight = async (nodeId: string) => { await executeCommands([{ type: "add_final_route_night", nodeId, newNodeId: `tmp-route-${crypto.randomUUID()}` }]); };
  const setRouteTransport = async (nodeId: string, mode: TransportMode | "") => { await executeCommands([{ type: "set_final_route_transport", nodeId, transportFromPrevious: transportFromModeV3(mode) }]); };
  const removeRouteNode = async (nodeId: string) => { const result = await executeCommands([{ type: "remove_final_route_node", nodeId }]); if (result && selectedNodeId === nodeId) setSelectedNodeId(null); };
  const updatePlace = async (placeId: string, changes: WorkflowPlaceEditChangesV3) => Boolean(await executeCommands([{ type: "update_place", placeId, changes }], "无法保存地点信息。"));

  const previewGoogleMapsLink = async (placeId: string, url: string) => {
    if (!trip) throw new Error("请先选择旅行。");
    return api<GoogleMapsPreviewV3>(`/api/trips/${trip.id}/places/${encodeURIComponent(placeId)}/google-maps`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, url }) });
  };
  const applyGoogleMapsLink = async (placeId: string, url: string, changes: WorkflowPlaceEditChangesV3) => {
    if (!trip) return false;
    return Boolean(await runAction(async () => {
      await api(`/api/trips/${trip.id}/places/${encodeURIComponent(placeId)}/google-maps`, { method: "PUT", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, url, changes }) });
      await loadTrip(trip.id, false);
      return true;
    }, "无法通过 Google Maps 链接保存地点。"));
  };
  const retryResolutions = async (placeIds: string[], force = false) => {
    if (!trip || !placeIds.length) return false;
    return Boolean(await runAction(async () => {
      await api(`/api/trips/${trip.id}/resolutions/retry`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, placeIds, force }) });
      await loadTrip(trip.id, false);
      return true;
    }, force ? "无法重新定位地点。" : "无法重新识别地点。"));
  };
  const setManualResolution = async (placeId: string, latitude: number, longitude: number) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/resolutions/${encodeURIComponent(placeId)}/manual`, { method: "PUT", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, method: "map_pick", latitude, longitude, address: null }) }); setMapPickPlaceId(null); await loadTrip(trip.id, false); }, "无法保存地点位置。"); };
  const recalculateDirtyRoutes = async () => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/routes/recalculate`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration }) }); setRouteNotice(""); await loadTrip(trip.id, false); }, "无法更新地图路线。"); };

  const saveBrief = async (changes: Partial<TripFacts["brief"]>) => {
    if (!trip) return false;
    let saved = false;
    await runAction(async () => {
      const started = await api<{ action: AiAction }>(`/api/trips/${trip.id}/actions/cta`, { method: "POST", body: JSON.stringify({ stage: "requirements", actionType: "requirements.update", parameters: { changes: { brief: changes } }, targetIds: [], requestKey: crypto.randomUUID() }) });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const next = await api<WorkspaceV3>(`/api/trips/${trip.id}/workspace`); setWorkspace(next);
        const action = next.actions.find((item) => item.id === started.action.id);
        if (action?.status === "applied") { saved = true; await refreshTrips(false); return; }
        if (action?.status === "failed" || action?.status === "superseded") throw new Error(action.errorSummary || "保存旅行需求失败。");
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
      throw new Error("旅行需求保存超时，请重试。");
    }, "无法保存旅行需求。");
    return saved;
  };
  const saveLanguage = async (planLanguage: Trip["planLanguage"]) => { if (!trip || planLanguage === trip.planLanguage) return; await runAction(async () => { await api(`/api/trips/${trip.id}`, { method: "PATCH", body: JSON.stringify({ planLanguage }) }); await loadTrip(trip.id, false); }, "保存地点名称语言失败。"); };

  const manage = async (item: Trip, action: "rename" | "duplicate" | "trash" | "restore" | "permanent") => {
    await runAction(async () => {
      if (action === "rename") { const title = window.prompt("旅行名称", item.title)?.trim(); if (!title) return; await api(`/api/trips/${item.id}`, { method: "PATCH", body: JSON.stringify({ title }) }); if (trip?.id === item.id) await loadTrip(item.id, false); }
      if (action === "duplicate") { const result = await api<{ trip: Trip }>(`/api/trips/${item.id}/duplicate`, { method: "POST", body: "{}" }); setTrash(false); await refreshTrips(false); await loadTrip(result.trip.id); }
      if (action === "trash") { if (!window.confirm(`将“${item.title}”移入回收站？`)) return; await api(`/api/trips/${item.id}`, { method: "DELETE" }); if (trip?.id === item.id) { loadToken.current += 1; setWorkspace(null); setSelectedNodeId(null); } await refreshTrips(false); }
      if (action === "restore") { await api(`/api/trips/${item.id}/restore`, { method: "POST", body: "{}" }); await refreshTrips(true); }
      if (action === "permanent") { if (!window.confirm(`永久删除“${item.title}”及其本机对话和版本？此操作不可恢复。`)) return; await api(`/api/trips/${item.id}/permanent`, { method: "DELETE" }); await refreshTrips(true); }
    }, "旅行管理操作失败。");
    setMenu(null);
  };

  const resize = () => {
    const rect = workspaceElement.current?.getBoundingClientRect(); if (!rect) return;
    let value = settings.ui.workspaceSplitRatio;
    const move = (event: PointerEvent) => { value = Math.max(.34, Math.min(.7, (event.clientX - rect.left) / rect.width)); setSettings((current) => ({ ...current, ui: { ...current.ui, workspaceSplitRatio: value } })); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); void saveUi({ workspaceSplitRatio: value }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  if (user === undefined) return <main className="loading-screen">正在加载旅行空间…</main>;
  if (!user) return <Login setup={!configured} onDone={(next) => { setUser(next); void refreshTrips(false); void refreshCodex(); }}/>;

  const models = (codex?.models || []).filter((item) => item.model);
  const routeCount = (value: Trip) => value.plan.finalRoute?.nodes.length ?? 0;
  return <main className={`app-shell app-shell-v3 ${sidebar ? "sidebar-open" : "sidebar-closed"}`}>
    <aside className={`sidebar ${sidebar ? "open" : ""}`}><div className="sidebar-head"><div className="brand-lockup"><span className="brand-mark">✦</span><span>AI Travel<small>可视化旅行工作台</small></span></div></div><button className="button primary new-trip" disabled={working || trash} onClick={() => void createTrip()}><Plus size={16}/>新建旅行</button><div className="sidebar-title"><span>{trash ? "回收站" : "我的旅行"}</span><button type="button" onClick={() => { setTrash((value) => !value); setWorkspace(null); setSelectedNodeId(null); }}>{trash ? "返回" : <Trash2 size={14}/>}</button></div><nav>{trips.map((item) => <div className={`trip-nav-item ${trip?.id === item.id ? "selected" : ""}`} key={item.id}><button className="trip-select" onClick={() => !trash && void loadTrip(item.id)}><b>{item.title}</b><small>{routeCount(item)} 个线路地点 · {item.plan.days.length ? `${item.plan.days.length} 天` : "待规划"}</small></button><button className="trip-menu" onClick={() => setMenu(menu === item.id ? null : item.id)}>•••</button>{menu === item.id && <div className="trip-actions">{trash ? <><button onClick={() => void manage(item, "restore")}>恢复</button><button className="danger" onClick={() => void manage(item, "permanent")}>永久删除</button></> : <><button onClick={() => void manage(item, "rename")}>重命名</button><button onClick={() => void manage(item, "duplicate")}>复制</button><button className="danger" onClick={() => void manage(item, "trash")}>移入回收站</button></>}</div>}</div>)}{!trips.length && <span className="sidebar-empty">{trash ? "回收站为空" : "还没有旅行"}</span>}</nav><footer><span>{user.username}</span><button onClick={() => void api("/api/auth/logout", { method: "POST", body: "{}" }).then(() => { setUser(null); setWorkspace(null); })}>退出登录</button></footer></aside>
    <section className="main-panel">
      <header className="topbar"><div className="topbar-page-identity"><button className="icon-button sidebar-toggle" aria-label={sidebar ? "收起旅行菜单" : "打开旅行菜单"} onClick={() => void saveUi({ sidebarOpen: !sidebar })}><Menu size={21}/></button><div><h1>{trip?.title || (trash ? "回收站" : "旅行工作台")}</h1><small>{trip ? (section === "planning" ? "规划 · 旅行需求" : "行程 · 最终线路") : "地图用于展示，旅行修改都在右侧完成"}</small></div></div><div className="model-status">{trip && workspace && workspace.tasks.length > 0 && <AiTaskTopbar tasks={workspace.tasks} onStop={stopTask}/>}<span className={codex?.signedIn ? "status-dot connected" : "status-dot"}/>{codex?.signedIn ? <select className="ai-model-select-v3" aria-label="AI 模型" value={settings.ai.model} onChange={(event) => void api<{ settings: AppSettings }>("/api/settings/ai-model", { method: "PUT", body: JSON.stringify({ model: event.target.value, reasoningEffort: settings.ai.reasoningEffort }) }).then((value) => applySettings(value.settings))}>{models.map((model) => <option key={model.model} value={model.model}>{model.displayName || model.model}</option>)}</select> : <button className="button small" onClick={() => void api<{ authUrl: string }>("/api/codex/login/browser", { method: "POST", body: "{}" }).then((value) => window.open(value.authUrl, "_blank", "noopener,noreferrer"))}>登录 AI</button>}{trip && <select className="plan-language-select-v3" aria-label="地点名称语言" value={trip.planLanguage} onChange={(event) => void saveLanguage(event.target.value as Trip["planLanguage"])}><option value="zh">中文</option><option value="en">English</option><option value="bilingual">中英对照</option></select>}<button className="icon-button" aria-label="刷新 AI 状态" onClick={() => void refreshCodex()}><RefreshCw size={16}/></button><button className="icon-button" aria-label="切换主题" onClick={() => void saveUi({ theme: settings.ui.theme === "light" ? "dark" : "light" })}>{settings.ui.theme === "light" ? <Moon size={18}/> : <Sun size={18}/>}</button><button className="icon-button" aria-label="版本历史" disabled={!trip} onClick={() => setHistoryOpen(true)}><History size={18}/></button><button className="icon-button" aria-label="修改密码" onClick={() => setPasswordOpen(true)}><KeyRound size={17}/></button></div></header>
      <div className="main-workspace main-workspace-v3"><div className={`travel-workspace travel-workspace-v3 ${focus ? `focus-${focus}` : ""}`} ref={workspaceElement} style={{ gridTemplateColumns: `${settings.ui.workspaceSplitRatio}fr 10px ${1 - settings.ui.workspaceSplitRatio}fr` }}>
        {workspace ? <FinalRouteMapV3 workspace={workspace} selectedNodeId={selectedNodeId} focusRequest={mapFocusRequest} mapPickPlaceId={mapPickPlaceId} fullscreen={focus === "map"} onSelectNode={(nodeId) => { setSection("route"); setSelectedNodeId(nodeId); setMapFocusRequest(null); }} onMapPick={(placeId, latitude, longitude) => void setManualResolution(placeId, latitude, longitude)} onFocusHandled={(requestId) => setMapFocusRequest((current) => current?.requestId === requestId ? null : current)} onToggleFullscreen={() => setFocus((current) => current === "map" ? null : "map")}/> : <section className="workspace-map-v2 no-trip"><div className="map-empty-overlay"><MapPinned size={34}/><strong>地图只展示规划结果</strong><span>所有旅行修改都从右侧开始</span></div></section>}
        <div className="splitter" onPointerDown={resize}/>
        <div className="workspace-side-v3">{workspace ? <>
          <nav className="final-route-workspace-nav-v3" aria-label="旅行工作区"><button type="button" className={section === "planning" ? "active" : ""} onClick={() => { setSection("planning"); setMapPickPlaceId(null); }}><span>1</span><b>规划 · 旅行需求</b></button><button type="button" className={section === "route" ? "active" : ""} onClick={() => setSection("route")}><span>2</span><b>行程 · 最终线路</b></button></nav>
          {section === "planning" ? <PlanningAdvisoryListV3 advisories={workspace.advisories ?? []} step="requirements"/> : <PlanningAdvisoryListV3 advisories={workspace.advisories ?? []} steps={["backbone", "skeleton", "interests", "detail"]}/>}          
          <div className="workspace-step-content-v3">{section === "planning"
            ? <RequirementsPanelV3 facts={workspace.trip.plan.trip} busy={working} onSave={saveBrief} onGenerate={async () => setSection("route")}/>
            : <FinalRoutePanelV3 workspace={workspace} selectedNodeId={selectedNodeId} busy={working} notice={routeNotice} onSelectNode={setSelectedNodeId} onFocusNode={(nodeId) => { setSelectedNodeId(nodeId); setMapFocusRequest({ nodeId, requestId: ++mapFocusSequence.current }); }} onAddPlace={addRoutePlace} onMoveNode={moveRouteNode} onSetStatus={setRouteStatus} onSetBoundary={setRouteBoundary} onAddNight={addRouteNight} onSetTransport={setRouteTransport} onRemoveNode={removeRouteNode} onUpdatePlace={updatePlace} onPreviewGoogleMapsLink={previewGoogleMapsLink} onApplyGoogleMapsLink={applyGoogleMapsLink} onRetry={retryResolutions} onBeginMapPick={(placeId) => { setMapPickPlaceId(placeId); setFocus("map"); }} onRecalculateDirtyRoutes={recalculateDirtyRoutes}/>}</div>
          {section === "planning" && <WorkflowAssistantV3 workflowStep="requirements" stage="requirements" workspace={workspace} selection={assistantSelection} busy={working} error={error} onSend={send} onConfirmAction={confirmAction} onCancelAction={cancelAction} onProposalAction={proposalAction} onStopTask={stopTask} onRetryCurrent={async () => { await refreshWorkspace(); }}/>}          
          {section === "route" && error && <p className="inline-error final-route-app-error-v3">{error}</p>}
        </> : <div className="workspace-empty-v3"><span className="brand-mark">✦</span><h2>选择一趟旅行</h2><p>地图用于展示，所有业务操作都集中在右侧。</p></div>}</div>
      </div></div>
    </section>
    <VersionDrawerV2 tripId={trip?.id || null} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestored={() => { if (trip) void loadTrip(trip.id, false); void refreshTrips(false); }}/><PasswordDrawer open={passwordOpen} onClose={() => setPasswordOpen(false)}/>
  </main>;
}
