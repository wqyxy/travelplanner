import { type FormEvent, useEffect, useRef, useState } from "react";
import { History, KeyRound, Menu, Moon, Plus, RefreshCw, Settings, Sun, Trash2 } from "lucide-react";
import { api } from "./api";
import { AiTaskTopbar } from "./AiTaskTopbar";
import { AssistantDrawer } from "./AssistantDrawer";
import { Itinerary, type MapSelection } from "./Itinerary";
import { MapPanel } from "./MapPanel";
import { PasswordDrawer } from "./PasswordDrawer";
import { SettingsDrawer, defaultMapCategoryColors } from "./SettingsDrawer";
import { VersionDrawer } from "./VersionDrawer";
import type { AiTask, AppSettings, Chat, ItineraryLanguage, MapState, Trip } from "./types";

type User = { id: string; username: string };
type Model = { model: string; displayName?: string; supportedReasoningEfforts?: Array<string | { reasoningEffort?: string }> };
type CodexStatus = { signedIn: boolean; models: Model[]; error?: string };
type Bootstrap = { authenticated: boolean; configured: boolean; user: User | null; settings: AppSettings };
type WorkspaceFocus = null | "map" | "itinerary";
const ACTIVE_TASKS = new Set(["starting", "running", "waiting", "reconnecting"]);
const tripStateLabels = { active: "当前行程", trashed: "回收站" } as const;
const defaultSettings: AppSettings = { ai: { model: "", reasoningEffort: "medium" }, ui: { workspaceSplitRatio: .52, theme: "light", sidebarOpen: true, mapCategoryColors: { ...defaultMapCategoryColors } } };

function Login({ setup, onDone }: { setup: boolean; onDone: (user: User) => void }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); try { const result = await api<{ user: User }>(setup ? "/api/auth/setup" : "/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }); onDone(result.user); } catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败。"); } };
  return <main className="auth-page"><form className="auth-card" onSubmit={submit}><div className="brand-mark">✦</div><p>AI TRAVEL PLANNER</p><h1>{setup ? "创建本机旅行空间" : "欢迎回来"}</h1><small>旅行和对话只保存在这台电脑的 private_data 中。</small><input required minLength={3} maxLength={32} pattern="[A-Za-z0-9_-]+" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名"/><input required minLength={6} type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码（至少 6 位）"/>{error && <em>{error}</em>}<button className="button primary">{setup ? "创建并进入" : "登录"}</button></form></main>;
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>();
  const [configured, setConfigured] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [messages, setMessages] = useState<Chat[]>([]);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [mapState, setMapState] = useState<MapState | null>(null);
  const [selection, setSelection] = useState<MapSelection>({ scope: "all" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trash, setTrash] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [focus, setFocus] = useState<WorkspaceFocus>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [mapSettingsOpen, setMapSettingsOpen] = useState(false);
  const [previewColors, setPreviewColors] = useState<Record<string, string> | null>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const loadToken = useRef(0);
  const selectedTripId = useRef<string | null>(null);
  selectedTripId.current = trip?.id ?? null;

  const activeTurn = [...messages].reverse().find((item) => item.role === "user" && item.turn && ["queued", "starting", "active"].includes(item.turn.status));
  const itineraryTaskActive = tasks.some((task) => (task.agent === "planner" || task.agent === "detailer") && ACTIVE_TASKS.has(task.status));
  const working = busy || Boolean(activeTurn) || itineraryTaskActive;
  const applySettings = (next: AppSettings) => { setSettings(next); setSidebar(next.ui.sidebarOpen); };
  const refreshTrips = async (showTrash = trash) => setTrips((await api<{ trips: Trip[] }>(`/api/trips?view=${showTrash ? "trash" : "active"}`)).trips);
  const refreshCodex = async () => setCodex(await api<CodexStatus>("/api/codex/status"));
  const loadMap = async (tripId: string) => { const token = loadToken.current; const result = await api<{ map: MapState | null }>(`/api/trips/${tripId}/map`); if (token === loadToken.current && selectedTripId.current === tripId) setMapState(result.map); };
  const retryMap = async () => { if (!trip) return; try { const result = await api<{ map: MapState | null }>(`/api/trips/${trip.id}/map/retry`, { method: "POST", body: "{}" }); setMapState(result.map); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法重新生成地图。"); } };
  const saveUi = async (patch: Partial<AppSettings["ui"]>) => { const result = await api<{ settings: AppSettings }>("/api/settings/ui", { method: "PUT", body: JSON.stringify(patch) }); applySettings(result.settings); return result.settings; };
  const loadTrip = async (id: string, resetSelection = true) => {
    const token = ++loadToken.current; setError("");
    try {
      const [detail, chat, ai, map] = await Promise.all([api<{ trip: Trip }>(`/api/trips/${id}`), api<{ messages: Chat[] }>(`/api/trips/${id}/messages`), api<{ tasks: AiTask[] }>(`/api/trips/${id}/ai-tasks`), api<{ map: MapState | null }>(`/api/trips/${id}/map`)]);
      if (token !== loadToken.current) return;
      setTrip(detail.trip); setMessages(chat.messages); setTasks(ai.tasks); setMapState(map.map); setMenu(null);
      if (resetSelection) setSelection({ scope: "all" });
      if (window.matchMedia("(max-width: 900px)").matches) setSidebar(false);
    } catch (cause) { if (token === loadToken.current) setError(cause instanceof Error ? cause.message : "无法加载旅行。"); }
  };

  useEffect(() => { void api<Bootstrap>("/api/bootstrap").then((value) => { setUser(value.user); setConfigured(value.configured); applySettings(value.settings); if (value.authenticated) { void refreshTrips(false); void refreshCodex(); } }).catch(() => setUser(null)); }, []);
  useEffect(() => { document.documentElement.dataset.theme = settings.ui.theme; }, [settings.ui.theme]);
  useEffect(() => { if (user) void refreshTrips(trash); }, [trash, user?.id]);
  useEffect(() => { if (selection.scope === "day" && !trip?.itinerary.days.some((day) => day.dayNumber === selection.dayNumber)) setSelection({ scope: "all" }); }, [trip?.id, trip?.contentGeneration, selection]);
  useEffect(() => { const timer = window.setTimeout(() => window.dispatchEvent(new Event("travel-workspace-resize")), 220); return () => window.clearTimeout(timer); }, [sidebar, focus, settings.ui.workspaceSplitRatio]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setFocus(null); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, []);
  useEffect(() => {
    if (!user) return; let closed = false; let socket: WebSocket | null = null; let retryTimer: number | undefined;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
      socket.onopen = () => { if (trip?.id) void loadTrip(trip.id, false); };
      socket.onmessage = (event) => { try {
        const item = JSON.parse(String(event.data)) as { kind: string; payload: any };
        if (item.payload?.tripId !== trip?.id) return;
        if (item.kind === "travel.turn.updated") {
          setMessages((rows) => rows.map((row) => row.id !== item.payload.messageId || !row.turn ? row : { ...row, status: item.payload.status === "completed" ? "completed" : ["failed", "interrupted"].includes(item.payload.status) ? "failed" : "pending", turn: { ...row.turn, status: item.payload.status, progressMessage: item.payload.progressMessage ?? row.turn.progressMessage, errorMessage: item.payload.errorMessage ?? null } }));
          if (["completed", "failed", "interrupted"].includes(item.payload.status)) { void loadTrip(String(item.payload.tripId), false); void refreshTrips(false); }
        }
        if (item.kind === "travel.trip.updated") { void loadTrip(String(item.payload.tripId), false); void refreshTrips(false); }
        if (item.kind === "ai-task.updated") setTasks((rows) => [item.payload as AiTask, ...rows.filter((row) => row.id !== item.payload.id)]);
        if (item.kind === "travel.map.changed") void loadMap(String(item.payload.tripId));
      } catch { /* Ignore malformed or unrelated socket messages. */ } };
      socket.onclose = () => { if (!closed) retryTimer = window.setTimeout(connect, 1500); };
      socket.onerror = () => socket?.close();
    };
    connect(); return () => { closed = true; if (retryTimer) window.clearTimeout(retryTimer); socket?.close(); };
  }, [user?.id, trip?.id]);

  const createTrip = async () => { setBusy(true); try { const result = await api<{ trip: Trip }>("/api/trips", { method: "POST", body: "{}" }); setTrash(false); await refreshTrips(false); await loadTrip(result.trip.id); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法新建旅行。"); } finally { setBusy(false); } };
  const send = async (text: string) => { if (!trip || working) return; setBusy(true); setError(""); try { await api(`/api/trips/${trip.id}/turns`, { method: "POST", body: JSON.stringify({ message: text }) }); setMessages((await api<{ messages: Chat[] }>(`/api/trips/${trip.id}/messages`)).messages); } catch (cause) { setError(cause instanceof Error ? cause.message : "发送失败。"); } finally { setBusy(false); } };
  const stopTurn = async (messageId: string) => { if (trip) await api(`/api/trips/${trip.id}/turns/interrupt`, { method: "POST", body: JSON.stringify({ messageId }) }); };
  const stopTask = async (taskId: string) => { if (trip) await api(`/api/trips/${trip.id}/ai-tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST", body: "{}" }); };
  const saveLanguage = async (language: ItineraryLanguage) => { if (!trip || language === trip.itineraryLanguage) return; try { const result = await api<{ trip: Trip }>(`/api/trips/${trip.id}`, { method: "PATCH", body: JSON.stringify({ itineraryLanguage: language }) }); setTrip(result.trip); setTrips((rows) => rows.map((row) => row.id === result.trip.id ? result.trip : row)); } catch (cause) { setError(cause instanceof Error ? cause.message : "保存地点名称语言失败。"); } };
  const manage = async (item: Trip, action: "rename" | "duplicate" | "trash" | "restore" | "permanent") => { try {
    if (action === "rename") { const title = window.prompt("旅行名称", item.title)?.trim(); if (!title) return; await api(`/api/trips/${item.id}`, { method: "PATCH", body: JSON.stringify({ title }) }); if (trip?.id === item.id) await loadTrip(item.id, false); }
    if (action === "duplicate") { const result = await api<{ trip: Trip }>(`/api/trips/${item.id}/duplicate`, { method: "POST", body: "{}" }); setTrash(false); await refreshTrips(false); await loadTrip(result.trip.id); }
    if (action === "trash") { if (!window.confirm(`将“${item.title}”移入回收站？`)) return; await api(`/api/trips/${item.id}`, { method: "DELETE" }); if (trip?.id === item.id) { loadToken.current += 1; setTrip(null); setMessages([]); setTasks([]); setMapState(null); setSelection({ scope: "all" }); } await refreshTrips(false); }
    if (action === "restore") { await api(`/api/trips/${item.id}/restore`, { method: "POST", body: "{}" }); await refreshTrips(true); }
    if (action === "permanent") { if (!window.confirm(`永久删除“${item.title}”及其本机对话和版本？此操作不可恢复。`)) return; await api(`/api/trips/${item.id}/permanent`, { method: "DELETE" }); await refreshTrips(true); }
  } catch (cause) { setError(cause instanceof Error ? cause.message : "旅行管理操作失败。"); } finally { setMenu(null); } };
  const resize = () => { const rect = workspace.current?.getBoundingClientRect(); if (!rect) return; let value = settings.ui.workspaceSplitRatio; const move = (event: PointerEvent) => { value = Math.max(.34, Math.min(.66, (event.clientX - rect.left) / rect.width)); setSettings((current) => ({ ...current, ui: { ...current.ui, workspaceSplitRatio: value } })); }; const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); void saveUi({ workspaceSplitRatio: value }); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); };

  if (user === undefined) return <main className="loading-screen">正在加载旅行空间…</main>;
  if (!user) return <Login setup={!configured} onDone={(next) => { setUser(next); void refreshTrips(false); void refreshCodex(); }}/>;
  const models = (codex?.models || []).filter((item) => item.model);
  const efforts = [...new Set((models.find((item) => item.model === settings.ai.model)?.supportedReasoningEfforts || ["medium"]).map((item) => typeof item === "string" ? item : item.reasoningEffort).filter((item): item is string => Boolean(item)))];
  const colors = previewColors || settings.ui.mapCategoryColors;

  return <main className={`app-shell ${sidebar ? "sidebar-open" : "sidebar-closed"}`}>
    <aside className={`sidebar ${sidebar ? "open" : ""}`}><div className="sidebar-head"><div className="brand-lockup"><span className="brand-mark">✦</span><span>AI Travel<small>旅行规划助手</small></span></div></div><button className="button primary new-trip" disabled={working || trash} onClick={() => void createTrip()}><Plus size={16}/>新建旅行</button><div className="sidebar-title"><span>{trash ? "回收站" : "我的旅行"}</span><button type="button" onClick={() => { setTrash((value) => !value); setTrip(null); setMessages([]); setTasks([]); setMapState(null); setSelection({ scope: "all" }); }}>{trash ? "返回" : <Trash2 size={14}/>}</button></div><nav>{trips.map((item) => <div className={`trip-nav-item ${trip?.id === item.id ? "selected" : ""}`} key={item.id}><button className="trip-select" onClick={() => !trash && void loadTrip(item.id)}><b>{item.title}</b><small>{tripStateLabels[item.state]}</small></button><button className="trip-menu" onClick={() => setMenu(menu === item.id ? null : item.id)}>•••</button>{menu === item.id && <div className="trip-actions">{trash ? <><button onClick={() => void manage(item, "restore")}>恢复</button><button className="danger" onClick={() => void manage(item, "permanent")}>永久删除</button></> : <><button onClick={() => void manage(item, "rename")}>重命名</button><button onClick={() => void manage(item, "duplicate")}>复制</button><button className="danger" onClick={() => void manage(item, "trash")}>移入回收站</button></>}</div>}</div>)}{!trips.length && <span className="sidebar-empty">{trash ? "回收站为空" : "还没有旅行"}</span>}</nav><footer><span>{user.username}</span><button onClick={() => void api("/api/auth/logout", { method: "POST", body: "{}" }).then(() => { setUser(null); setTrip(null); })}>退出登录</button></footer></aside>
    <section className="main-panel"><header className="topbar"><div className="topbar-page-identity"><button className="icon-button sidebar-toggle" type="button" aria-label={sidebar ? "收起旅行菜单" : "打开旅行菜单"} onClick={() => void saveUi({ sidebarOpen: !sidebar })}><Menu size={21}/></button><div><h1>{trip?.title || (trash ? "回收站" : "旅行工作台")}</h1><small>{trip ? tripStateLabels[trip.state] : "让 AI 从模糊想法开始设计"}</small></div></div>{trip && <AiTaskTopbar tasks={tasks} onStop={stopTask}/>}<div className="model-status"><span className={codex?.signedIn ? "status-dot connected" : "status-dot"}/>{codex?.signedIn ? <><select aria-label="AI 模型" value={settings.ai.model} onChange={(event) => void api<{ settings: AppSettings }>("/api/settings/ai-model", { method: "PUT", body: JSON.stringify({ model: event.target.value, reasoningEffort: settings.ai.reasoningEffort }) }).then((value) => applySettings(value.settings))}>{models.map((model) => <option key={model.model} value={model.model}>{model.displayName || model.model}</option>)}</select><select aria-label="推理强度" value={settings.ai.reasoningEffort} onChange={(event) => void api<{ settings: AppSettings }>("/api/settings/ai-model", { method: "PUT", body: JSON.stringify({ model: settings.ai.model, reasoningEffort: event.target.value }) }).then((value) => applySettings(value.settings))}>{efforts.map((item) => <option key={item}>{item}</option>)}</select></> : <><button className="button small" onClick={() => void api<{ authUrl: string }>("/api/codex/login/browser", { method: "POST", body: "{}" }).then((value) => window.open(value.authUrl, "_blank", "noopener,noreferrer"))}>浏览器登录</button><button className="button small" onClick={() => void api<{ verificationUrl?: string; userCode?: string }>("/api/codex/login/device", { method: "POST", body: "{}" }).then((value) => { if (value.verificationUrl) window.open(value.verificationUrl, "_blank", "noopener,noreferrer"); window.prompt("请在打开的页面输入设备代码", value.userCode || ""); })}>设备码</button></>}<button className="icon-button" aria-label="刷新 Codex 状态" onClick={() => void refreshCodex()}><RefreshCw size={16}/></button><button className="icon-button" aria-label="切换主题" onClick={() => void saveUi({ theme: settings.ui.theme === "light" ? "dark" : "light" })}>{settings.ui.theme === "light" ? <Moon size={18}/> : <Sun size={18}/>}</button><button className="icon-button" aria-label="地图显示设置" onClick={() => setMapSettingsOpen(true)}><Settings size={18}/></button><button className="icon-button" aria-label="版本历史" disabled={!trip} onClick={() => setHistoryOpen(true)}><History size={18}/></button><button className="icon-button" aria-label="修改密码" onClick={() => setPasswordOpen(true)}><KeyRound size={17}/></button></div></header>
      <div className="main-workspace"><div className={`travel-workspace ${focus ? `focus-${focus}` : ""}`} ref={workspace} style={{ gridTemplateColumns: `${settings.ui.workspaceSplitRatio}fr 10px ${1 - settings.ui.workspaceSplitRatio}fr` }}><MapPanel itinerary={trip?.itinerary || null} state={mapState} language={trip?.itineraryLanguage || "bilingual"} categoryColors={colors} selection={selection} fullscreen={focus === "map"} onToggleFullscreen={() => setFocus((current) => current === "map" ? null : "map")} onRetry={() => void retryMap()}/><div className="splitter" onPointerDown={resize}/><div className="itinerary-column">{trip ? <Itinerary itinerary={trip.itinerary} generation={trip.contentGeneration} mapState={mapState} language={trip.itineraryLanguage} selection={selection} onSelectAll={() => setSelection({ scope: "all" })} onSelectDay={(dayNumber) => setSelection({ scope: "day", dayNumber })} onLanguageChange={(language) => void saveLanguage(language)} fullscreen={focus === "itinerary"} onToggleFullscreen={() => setFocus((current) => current === "itinerary" ? null : "itinerary")}/> : <p className="empty-itinerary">新建或选择一趟旅行，然后从 AI Chat 开始。</p>}</div></div></div>
      <AssistantDrawer title={trip?.title || null} chat={messages} busy={working} error={error} onSend={send} onStop={stopTurn} onRetry={async (_id, text) => send(text)}/>
    </section>
    <VersionDrawer tripId={trip?.id || null} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestored={() => { setSelection({ scope: "all" }); if (trip) void loadTrip(trip.id); void refreshTrips(false); }}/>
    <PasswordDrawer open={passwordOpen} onClose={() => setPasswordOpen(false)}/>
    {mapSettingsOpen && (
      <SettingsDrawer colors={settings.ui.mapCategoryColors} onPreview={setPreviewColors} onClose={() => { setPreviewColors(null); setMapSettingsOpen(false); }} onSave={async (mapCategoryColors) => { await saveUi({ mapCategoryColors }); setPreviewColors(null); }}/>
    )}
  </main>;
}
