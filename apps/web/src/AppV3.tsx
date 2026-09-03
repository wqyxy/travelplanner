import { type FormEvent, useEffect, useRef, useState } from "react";
import { History, KeyRound, Menu, Moon, Plus, RefreshCw, Sparkles, Sun, Trash2, TriangleAlert } from "lucide-react";
import { api } from "./api";
import { CandidatePanel, type GoogleMapsPreview, type NewCandidateDraft, type PlaceEditChanges } from "./CandidatePanel";
import { AiTaskTopbar } from "./AiTaskTopbar";
import { ItineraryPanelV2 } from "./ItineraryPanelV2";
import { MacroItineraryPanelV3 } from "./MacroItineraryPanelV3";
import { buildPlanCommandBatchRequest } from "./editor-actions-v2";
import { proposalActionPath, type ProposalAction } from "./proposal-ui-v2";
import { RequirementsPanelV3 } from "./RequirementsPanelV3";
import { PasswordDrawer } from "./PasswordDrawer";
import { VersionDrawerV2 } from "./VersionDrawerV2";
import { WorkspaceAssistantV3 } from "./WorkspaceAssistantV3";
import { WorkspaceMapV2 } from "./WorkspaceMapV2";
import type { AppSettings, CandidatePreference, PlanCommand, ProviderPlaceCandidate, Trip, TripFacts, WorkspaceSelection } from "./v2-types";
import type { AiAction, AiActionType, ConversationStage, PlannerStepV3, WorkspaceV3 } from "./v3-types";

type User = { id: string; username: string };
type Model = { model: string; displayName?: string; supportedReasoningEfforts?: Array<string | { reasoningEffort?: string }> };
type CodexStatus = { signedIn: boolean; models: Model[]; error?: string };
type Bootstrap = { authenticated: boolean; configured: boolean; user: User | null; settings: AppSettings };
type WorkspaceFocus = null | "map" | "panel";
const ACTIVE_TASKS = new Set(["starting", "running", "waiting", "reconnecting"]);
const tripStateLabels = { active: "当前行程", trashed: "回收站" } as const;
const defaultSettings: AppSettings = { ai: { model: "", reasoningEffort: "medium" }, ui: { workspaceSplitRatio: .56, theme: "light", sidebarOpen: true, mapCategoryColors: {} } };

function conversationStage(step: PlannerStepV3): ConversationStage {
  return step === "detail" ? "itinerary" : step;
}

function defaultWorkspaceStep(workspace: WorkspaceV3): PlannerStepV3 {
  if (workspace.trip.plan.days.some((day) => day.detailLevel === "detailed")) return "detail";
  if (workspace.trip.plan.days.length) return "itinerary";
  const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place]));
  if (workspace.trip.plan.candidates.some((candidate) => places.get(candidate.placeId)?.kind !== "city")) return "interests";
  if (workspace.trip.plan.candidates.length) return "destinations";
  return "requirements";
}

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
  return <main className="auth-page"><form className="auth-card" onSubmit={submit}>
    <div className="brand-mark">✦</div><p>AI TRAVEL PLANNER</p><h1>{setup ? "创建本机旅行空间" : "欢迎回来"}</h1>
    <small>旅行和对话只保存在这台电脑的 private_data 中。</small>
    <input required minLength={3} maxLength={32} pattern="[A-Za-z0-9_-]+" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名"/>
    <input required minLength={6} type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码（至少 6 位）"/>
    {error && <em>{error}</em>}<button className="button primary">{setup ? "创建并进入" : "登录"}</button>
  </form></main>;
}

export default function AppV3() {
  const [user, setUser] = useState<User | null | undefined>();
  const [configured, setConfigured] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceV3 | null>(null);
  const [step, setStep] = useState<PlannerStepV3>("requirements");
  const [selection, setSelection] = useState<WorkspaceSelection>({ type: "trip", id: null });
  const [mapPickPlaceId, setMapPickPlaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trash, setTrash] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [focus, setFocus] = useState<WorkspaceFocus>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const workspaceElement = useRef<HTMLDivElement>(null);
  const loadToken = useRef(0);
  const selectedTripId = useRef<string | null>(null);
  selectedTripId.current = workspace?.trip.id ?? null;

  const stage = conversationStage(step);
  const trip = workspace?.trip ?? null;
  const tasks = workspace?.tasks ?? [];
  const stageMessages = workspace?.messages[stage] ?? [];
  const activeTurn = [...stageMessages].reverse().find((item) => item.role === "user" && item.turn && ["queued", "starting", "active"].includes(item.turn.status));
  const aiActionActive = tasks.some((task) => task.agent === "action" && ACTIVE_TASKS.has(task.status));
  const stageDialogueActive = tasks.some((task) => task.agent === "dialogue" && ACTIVE_TASKS.has(task.status) && task.metadata?.stage === stage);
  const working = busy || Boolean(activeTurn) || aiActionActive || stageDialogueActive;
  const selectedStop = selection.type === "stop" && trip ? trip.plan.days.flatMap((day) => day.stops.map((stop) => ({ day, stop }))).find((item) => item.stop.id === selection.id) ?? null : null;
  const selectedDayId = selection.type === "day" ? selection.id : selectedStop?.day.id ?? null;
  const selectedCandidateId = selection.type === "candidate" ? selection.id : selectedStop?.stop.candidateId ?? (selectedStop && trip ? trip.plan.candidates.find((candidate) => candidate.placeId === selectedStop.stop.placeId)?.id ?? null : null);
  const selectedStopId = selectedStop?.stop.id ?? null;

  const applySettings = (next: AppSettings) => { setSettings(next); setSidebar(next.ui.sidebarOpen); };
  const refreshTrips = async (showTrash = trash) => setTrips((await api<{ trips: Trip[] }>(`/api/trips?view=${showTrash ? "trash" : "active"}`)).trips);
  const refreshCodex = async () => setCodex(await api<CodexStatus>("/api/codex/status"));
  const saveUi = async (patch: Partial<AppSettings["ui"]>) => { const result = await api<{ settings: AppSettings }>("/api/settings/ui", { method: "PUT", body: JSON.stringify(patch) }); applySettings(result.settings); return result.settings; };

  const loadTrip = async (id: string, resetSelection = true) => {
    const token = ++loadToken.current;
    setError("");
    try {
      const next = await api<WorkspaceV3>(`/api/trips/${id}/workspace`);
      if (token !== loadToken.current) return;
      setWorkspace(next);
      setMenu(null);
      if (resetSelection) {
        const nextStep = defaultWorkspaceStep(next);
        setStep(nextStep);
        if (nextStep === "itinerary" || nextStep === "detail" || nextStep === "requirements") setSelection({ type: "trip", id: null });
        else setSelection({ type: "candidate_pool", id: null });
      }
      if (window.matchMedia("(max-width: 900px)").matches) setSidebar(false);
    } catch (cause) { if (token === loadToken.current) setError(cause instanceof Error ? cause.message : "无法加载旅行工作台。"); }
  };
  const refreshWorkspace = async () => { const id = selectedTripId.current; if (id) await loadTrip(id, false); };
  const runAction = async <T,>(operation: () => Promise<T>, fallback: string) => { setBusy(true); setError(""); try { return await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : fallback); return undefined; } finally { setBusy(false); } };

  useEffect(() => { void api<Bootstrap>("/api/bootstrap").then((value) => { setUser(value.user); setConfigured(value.configured); applySettings(value.settings); if (value.authenticated) { void refreshTrips(false); void refreshCodex(); } }).catch(() => setUser(null)); }, []);
  useEffect(() => { document.documentElement.dataset.theme = settings.ui.theme; }, [settings.ui.theme]);
  useEffect(() => { if (user) void refreshTrips(trash); }, [trash, user?.id]);
  useEffect(() => { const timer = window.setTimeout(() => window.dispatchEvent(new Event("travel-workspace-resize")), 220); return () => window.clearTimeout(timer); }, [sidebar, focus, settings.ui.workspaceSplitRatio]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setFocus(null); setMapPickPlaceId(null); } };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, []);
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
        } catch { /* Ignore malformed events. */ }
      };
      socket.onclose = () => { if (!closed) retryTimer = window.setTimeout(connect, 1500); };
      socket.onerror = () => socket?.close();
    };
    connect(); return () => { closed = true; if (retryTimer) window.clearTimeout(retryTimer); socket?.close(); };
  }, [user?.id]);

  const createTrip = async () => { await runAction(async () => { const result = await api<{ trip: Trip }>("/api/trips", { method: "POST", body: "{}" }); setTrash(false); await refreshTrips(false); await loadTrip(result.trip.id); setStep("requirements"); setSelection({ type: "trip", id: null }); }, "无法新建旅行。"); };
  const send = async (messageStage: ConversationStage, message: string, currentSelection: WorkspaceSelection) => {
    if (!trip) return;
    await runAction(async () => { await api(`/api/trips/${trip.id}/stages/${messageStage}/turns`, { method: "POST", body: JSON.stringify({ message, selection: currentSelection }) }); await refreshWorkspace(); }, `无法发送${messageStage}阶段消息。`);
  };
  const startCta = async (actionStage: ConversationStage, actionType: AiActionType, parameters: Record<string, unknown> = {}, targetIds: string[] = []) => {
    if (!trip) return;
    await runAction(async () => { await api(`/api/trips/${trip.id}/actions/cta`, { method: "POST", body: JSON.stringify({ stage: actionStage, actionType, parameters, targetIds, requestKey: crypto.randomUUID() }) }); await refreshWorkspace(); }, "无法启动 AI 动作。");
  };
  const confirmAction = async (action: AiAction) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/actions/${encodeURIComponent(action.id)}/confirm`, { method: "POST", body: JSON.stringify({ expectedGeneration: action.baseGeneration }) }); await refreshWorkspace(); }, "无法确认动作。"); };
  const cancelAction = async (action: AiAction) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/actions/${encodeURIComponent(action.id)}/cancel`, { method: "POST", body: JSON.stringify({ expectedGeneration: action.baseGeneration }) }); await refreshWorkspace(); }, "无法取消动作。"); };
  const proposalAction = async (proposalId: string, action: ProposalAction) => { if (!trip) return; await runAction(async () => { await api(proposalActionPath(trip.id, proposalId, action), { method: "POST", body: "{}" }); await loadTrip(trip.id, false); if (action !== "reject") await refreshTrips(false); }, action === "apply" ? "无法应用 AI 修改建议。" : action === "undo" ? "无法撤销 AI 修改建议。" : "无法拒绝 AI 修改建议。"); };
  const stopTask = async (taskId: string) => { if (trip) await runAction(async () => { await api(`/api/trips/${trip.id}/ai-tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST", body: "{}" }); }, "无法停止任务。"); };

  const setPreference = async (candidateIds: string[], preference: CandidatePreference) => {
    if (!trip || !candidateIds.length) return;
    if (preference === "excluded") {
      const affected = trip.plan.days.flatMap((day) => day.stops.filter((stop) => stop.candidateId && candidateIds.includes(stop.candidateId)).map(() => `Day ${day.dayNumber}`));
      if (affected.length && !window.confirm(`这些地点已排入 ${[...new Set(affected)].join("、")}。标记为“不去”会让对应日期进入“需更新”，是否继续？`)) return;
    }
    await runAction(async () => {
      if (candidateIds.length === 1) await api(`/api/trips/${trip.id}/candidates/${encodeURIComponent(candidateIds[0])}`, { method: "PATCH", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, preference }) });
      else await api(`/api/trips/${trip.id}/candidates/batch`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, candidateIds, preference }) });
      await loadTrip(trip.id, false); await refreshTrips(false);
    }, "无法修改地点优先级。");
  };
  const retryResolutions = async (placeIds: string[]) => { if (!trip || !placeIds.length) return; await runAction(async () => { await api(`/api/trips/${trip.id}/resolutions/retry`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, placeIds }) }); await loadTrip(trip.id, false); }, "无法重新定位地点。"); };
  const searchResolutionCandidates = async (placeId: string) => trip ? (await api<{ candidates: ProviderPlaceCandidate[] }>(`/api/trips/${trip.id}/resolutions/${encodeURIComponent(placeId)}/candidates?expectedGeneration=${trip.contentGeneration}`)).candidates : [];
  const selectResolution = async (placeId: string, providerPlaceId: string) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/resolutions/${encodeURIComponent(placeId)}/select`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, providerPlaceId }) }); await loadTrip(trip.id, false); }, "无法选择地图地点。"); };
  const setManualResolution = async (placeId: string, latitude: number, longitude: number, address: string | null, method: "map_pick" | "manual_coordinates" = "manual_coordinates") => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/resolutions/${encodeURIComponent(placeId)}/manual`, { method: "PUT", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, method, latitude, longitude, address }) }); setMapPickPlaceId(null); await loadTrip(trip.id, false); }, "无法保存地点坐标。"); };
  const recalculateRoute = async (dayId: string) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/routes/${encodeURIComponent(dayId)}/recalculate`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration }) }); await loadTrip(trip.id, false); }, "无法更新路线。"); };
  const recalculateDirtyRoutes = async () => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/routes/recalculate`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration }) }); await loadTrip(trip.id, false); }, "无法批量更新路线。"); };
  const recalculateMacroRoute = async (dayId: string) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/macro-routes/${encodeURIComponent(dayId)}/recalculate`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration }) }); await loadTrip(trip.id, false); }, "无法更新 Macro Route。"); };
  const recalculateDirtyMacroRoutes = async () => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/macro-routes/recalculate`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration }) }); await loadTrip(trip.id, false); }, "无法批量更新 Macro Route。"); };
  const refine = async (dayIds?: string[]) => { if (!trip) return; const targets = dayIds?.length ? dayIds : []; await startCta("itinerary", "itinerary.refine", { dayIds: targets }, targets); };
  const runPlanCommand = async (command: PlanCommand) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/commands`, { method: "POST", body: JSON.stringify(buildPlanCommandBatchRequest(trip.contentGeneration, command)) }); await loadTrip(trip.id, false); await refreshTrips(false); }, "无法编辑旅行计划。"); };
  const addCandidate = async (draft: NewCandidateDraft) => {
    const placeId = `tmp-place-${crypto.randomUUID()}`; const candidateId = `tmp-candidate-${crypto.randomUUID()}`;
    await runPlanCommand({ type: "add_candidate", place: { id: placeId, nameZh: draft.nameZh.trim(), nameLocal: draft.nameLocal.trim() || null, nameEn: draft.nameEn.trim() || null, kind: draft.kind, city: draft.city.trim() || null, region: draft.region.trim() || null, country: draft.country.trim() || null, countryCode: draft.countryCode.trim() ? draft.countryCode.trim().toUpperCase() : null, approximate: false }, candidate: { id: candidateId, placeId, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: draft.suggestedDurationMinutes, tags: draft.tags, planningAreaCandidateId: draft.kind === "city" ? null : draft.planningAreaCandidateId } });
  };
  const updatePlace = async (placeId: string, changes: PlaceEditChanges) => runPlanCommand({ type: "update_place", placeId, changes });
  const previewGoogleMapsLink = async (placeId: string, url: string) => {
    if (!trip) throw new Error("请先选择旅行。");
    return api<GoogleMapsPreview>(`/api/trips/${trip.id}/places/${encodeURIComponent(placeId)}/google-maps`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, url }) });
  };
  const saveBrief = async (changes: Partial<TripFacts["brief"]>) => {
    if (!trip) return false;
    let saved = false;
    await runAction(async () => {
      const started = await api<{ action: AiAction }>(`/api/trips/${trip.id}/actions/cta`, { method: "POST", body: JSON.stringify({ stage: "requirements", actionType: "requirements.update", parameters: { changes: { brief: changes } }, targetIds: [], requestKey: crypto.randomUUID() }) });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const next = await api<WorkspaceV3>(`/api/trips/${trip.id}/workspace`);
        setWorkspace(next);
        const action = next.actions.find((item) => item.id === started.action.id);
        if (action?.status === "applied") { saved = true; await refreshTrips(false); return; }
        if (action?.status === "failed" || action?.status === "superseded") throw new Error(action.errorSummary || "保存旅行需求失败。");
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
      throw new Error("旅行需求保存超时，请重试。");
    }, "无法保存旅行需求。");
    return saved;
  };
  const applyGoogleMapsLink = async (placeId: string, url: string, changes: PlaceEditChanges) => {
    if (!trip) return;
    await runAction(async () => { await api(`/api/trips/${trip.id}/places/${encodeURIComponent(placeId)}/google-maps`, { method: "PUT", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, url, changes }) }); await loadTrip(trip.id, false); await refreshTrips(false); }, "无法通过 Google Maps 链接保存地点。");
  };
  const removeCandidate = async (candidateId: string, cascade: boolean) => { await runPlanCommand(cascade ? { type: "remove_candidate_tree", candidateId } : { type: "remove_candidate", candidateId }); setSelection({ type: "candidate_pool", id: null }); };
  const saveLanguage = async (planLanguage: Trip["planLanguage"]) => { if (!trip || planLanguage === trip.planLanguage) return; await runAction(async () => { await api(`/api/trips/${trip.id}`, { method: "PATCH", body: JSON.stringify({ planLanguage }) }); await loadTrip(trip.id, false); }, "保存地点名称语言失败。"); };

  const manage = async (item: Trip, action: "rename" | "duplicate" | "trash" | "restore" | "permanent") => {
    await runAction(async () => {
      if (action === "rename") { const title = window.prompt("旅行名称", item.title)?.trim(); if (!title) return; await api(`/api/trips/${item.id}`, { method: "PATCH", body: JSON.stringify({ title }) }); if (trip?.id === item.id) await loadTrip(item.id, false); }
      if (action === "duplicate") { const result = await api<{ trip: Trip }>(`/api/trips/${item.id}/duplicate`, { method: "POST", body: "{}" }); setTrash(false); await refreshTrips(false); await loadTrip(result.trip.id); }
      if (action === "trash") { if (!window.confirm(`将“${item.title}”移入回收站？`)) return; await api(`/api/trips/${item.id}`, { method: "DELETE" }); if (trip?.id === item.id) { loadToken.current += 1; setWorkspace(null); setSelection({ type: "trip", id: null }); } await refreshTrips(false); }
      if (action === "restore") { await api(`/api/trips/${item.id}/restore`, { method: "POST", body: "{}" }); await refreshTrips(true); }
      if (action === "permanent") { if (!window.confirm(`永久删除“${item.title}”及其本机对话和版本？此操作不可恢复。`)) return; await api(`/api/trips/${item.id}/permanent`, { method: "DELETE" }); await refreshTrips(true); }
    }, "旅行管理操作失败。"); setMenu(null);
  };

  const resize = () => {
    const rect = workspaceElement.current?.getBoundingClientRect(); if (!rect) return; let value = settings.ui.workspaceSplitRatio;
    const move = (event: PointerEvent) => { value = Math.max(.34, Math.min(.7, (event.clientX - rect.left) / rect.width)); setSettings((current) => ({ ...current, ui: { ...current.ui, workspaceSplitRatio: value } })); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); void saveUi({ workspaceSplitRatio: value }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  if (user === undefined) return <main className="loading-screen">正在加载旅行空间…</main>;
  if (!user) return <Login setup={!configured} onDone={(next) => { setUser(next); void refreshTrips(false); void refreshCodex(); }}/>;
  const models = (codex?.models || []).filter((item) => item.model);
  const legacyWorkspace = workspace as any;
  const macroMapWorkspace = workspace ? {
    ...legacyWorkspace,
    trip: {
      ...workspace.trip,
      plan: {
        ...workspace.trip.plan,
        candidates: workspace.trip.plan.candidates.filter((candidate) => workspace.trip.plan.places.find((place) => place.id === candidate.placeId)?.kind === "city"),
        days: workspace.trip.plan.days.map((day) => ({ ...day, stops: [] })),
      },
    },
    routeStates: workspace.macroRouteStates,
  } : null;
  const mapWorkspace = step === "itinerary" ? macroMapWorkspace : legacyWorkspace;
  const detailNeedsUpdate = workspace?.itineraryUpdateState.detail.status === "needs_update";
  const detailAffectedDayIds = workspace?.itineraryUpdateState.detail.affectedDayIds ?? [];
  const hasDetailedDays = Boolean(workspace?.trip.plan.days.some((day) => day.detailLevel === "detailed"));
  const macroCandidates = workspace ? workspace.trip.plan.candidates.filter((candidate) => workspace.trip.plan.places.find((place) => place.id === candidate.placeId)?.kind === "city" && candidate.preference !== "excluded") : [];

  return <main className={`app-shell app-shell-v3 ${sidebar ? "sidebar-open" : "sidebar-closed"}`}>
    <aside className={`sidebar ${sidebar ? "open" : ""}`}>
      <div className="sidebar-head"><div className="brand-lockup"><span className="brand-mark">✦</span><span>AI Travel<small>可视化旅行工作台</small></span></div></div>
      <button className="button primary new-trip" disabled={working || trash} onClick={() => void createTrip()}><Plus size={16}/>新建旅行</button>
      <div className="sidebar-title"><span>{trash ? "回收站" : "我的旅行"}</span><button type="button" onClick={() => { setTrash((value) => !value); setWorkspace(null); setSelection({ type: "trip", id: null }); }}>{trash ? "返回" : <Trash2 size={14}/>}</button></div>
      <nav>{trips.map((item) => <div className={`trip-nav-item ${trip?.id === item.id ? "selected" : ""}`} key={item.id}><button className="trip-select" onClick={() => !trash && void loadTrip(item.id)}><b>{item.title}</b><small>{item.plan.candidates.length} 个地点 · {item.plan.days.length ? `${item.plan.days.length} 天` : "待排程"}</small></button><button className="trip-menu" onClick={() => setMenu(menu === item.id ? null : item.id)}>•••</button>{menu === item.id && <div className="trip-actions">{trash ? <><button onClick={() => void manage(item, "restore")}>恢复</button><button className="danger" onClick={() => void manage(item, "permanent")}>永久删除</button></> : <><button onClick={() => void manage(item, "rename")}>重命名</button><button onClick={() => void manage(item, "duplicate")}>复制</button><button className="danger" onClick={() => void manage(item, "trash")}>移入回收站</button></>}</div>}</div>)}{!trips.length && <span className="sidebar-empty">{trash ? "回收站为空" : "还没有旅行"}</span>}</nav>
      <footer><span>{user.username}</span><button onClick={() => void api("/api/auth/logout", { method: "POST", body: "{}" }).then(() => { setUser(null); setWorkspace(null); })}>退出登录</button></footer>
    </aside>
    <section className="main-panel">
      <header className="topbar"><div className="topbar-page-identity"><button className="icon-button sidebar-toggle" aria-label={sidebar ? "收起旅行菜单" : "打开旅行菜单"} onClick={() => void saveUi({ sidebarOpen: !sidebar })}><Menu size={21}/></button><div><h1>{trip?.title || (trash ? "回收站" : "旅行工作台")}</h1><small>{trip ? `${tripStateLabels[trip.state]} · ${step === "requirements" ? "需求" : step === "destinations" ? "目的地" : step === "interests" ? "兴趣点" : step === "itinerary" ? "概览" : "行程"}` : "所有旅行操作都从右侧控制台开始"}</small></div></div>
        <div className="model-status">{trip && workspace && workspace.tasks.length > 0 && <AiTaskTopbar tasks={workspace.tasks} onStop={stopTask}/>}<span className={codex?.signedIn ? "status-dot connected" : "status-dot"}/>{codex?.signedIn ? <select className="ai-model-select-v3" aria-label="AI 模型" value={settings.ai.model} onChange={(event) => void api<{ settings: AppSettings }>("/api/settings/ai-model", { method: "PUT", body: JSON.stringify({ model: event.target.value, reasoningEffort: settings.ai.reasoningEffort }) }).then((value) => applySettings(value.settings))}>{models.map((model) => <option key={model.model} value={model.model}>{model.displayName || model.model}</option>)}</select> : <><button className="button small" onClick={() => void api<{ authUrl: string }>("/api/codex/login/browser", { method: "POST", body: "{}" }).then((value) => window.open(value.authUrl, "_blank", "noopener,noreferrer"))}>浏览器登录</button><button className="button small" onClick={() => void api<{ verificationUrl?: string; userCode?: string }>("/api/codex/login/device", { method: "POST", body: "{}" }).then((value) => { if (value.verificationUrl) window.open(value.verificationUrl, "_blank", "noopener,noreferrer"); window.prompt("请在打开的页面输入设备代码", value.userCode || ""); })}>设备码</button></>}{trip && <select className="plan-language-select-v3" aria-label="地点名称语言" value={trip.planLanguage} onChange={(event) => void saveLanguage(event.target.value as Trip["planLanguage"])}><option value="zh">中文</option><option value="en">English</option><option value="bilingual">中英对照</option></select>}
          <button className="icon-button" aria-label="刷新 Codex 状态" onClick={() => void refreshCodex()}><RefreshCw size={16}/></button><button className="icon-button" aria-label="切换主题" onClick={() => void saveUi({ theme: settings.ui.theme === "light" ? "dark" : "light" })}>{settings.ui.theme === "light" ? <Moon size={18}/> : <Sun size={18}/>}</button><button className="icon-button" aria-label="版本历史" disabled={!trip} onClick={() => setHistoryOpen(true)}><History size={18}/></button><button className="icon-button" aria-label="修改密码" onClick={() => setPasswordOpen(true)}><KeyRound size={17}/></button>
        </div>
      </header>
      <div className="main-workspace main-workspace-v3"><div className={`travel-workspace travel-workspace-v3 ${focus ? `focus-${focus}` : ""}`} ref={workspaceElement} style={{ gridTemplateColumns: `${settings.ui.workspaceSplitRatio}fr 10px ${1 - settings.ui.workspaceSplitRatio}fr` }}>
        {workspace ? <WorkspaceMapV2 workspace={mapWorkspace as any} view={(step === "itinerary" || step === "detail") ? "itinerary" : "candidates"} selectedCandidateId={selectedCandidateId} selectedDayId={(step === "itinerary" || step === "detail") ? selectedDayId : null} selectedStopId={step === "detail" ? selectedStopId : null} mapPickPlaceId={mapPickPlaceId} fullscreen={focus === "map"} onSelectCandidate={(candidateId) => { const candidate = workspace.trip.plan.candidates.find((item) => item.id === candidateId); const place = candidate ? workspace.trip.plan.places.find((item) => item.id === candidate.placeId) : null; setSelection({ type: "candidate", id: candidateId }); setStep(place?.kind === "city" ? "destinations" : "interests"); }} onSelectStop={(stopId) => { setSelection({ type: "stop", id: stopId }); setStep("detail"); }} onMapPick={(placeId, latitude, longitude) => void setManualResolution(placeId, latitude, longitude, null, "map_pick")} onToggleFullscreen={() => setFocus((current) => current === "map" ? null : "map")}/> : <section className="workspace-map-v2 no-trip"><div className="map-empty-overlay"><span className="brand-mark">✦</span><strong>地图只展示规划结果</strong><span>所有旅行操作都从右侧开始</span></div></section>}
        <div className="splitter" onPointerDown={resize}/>
        <div className="workspace-side-v3">{workspace ? <>
          <header className="workspace-flow-head-v3"><nav className="workspace-flow-nav-v3" aria-label="旅行规划步骤">
            <button type="button" className={step === "requirements" ? "active" : ""} onClick={() => { setStep("requirements"); setSelection({ type: "trip", id: null }); }}><span>1</span>需求</button>
            <button type="button" className={step === "destinations" ? "active" : ""} onClick={() => { setStep("destinations"); setSelection({ type: "candidate_pool", id: null }); }}><span>2</span>目的地</button>
            <button type="button" className={step === "interests" ? "active" : ""} disabled={!workspace.trip.plan.candidates.length} onClick={() => { setStep("interests"); setSelection({ type: "candidate_pool", id: null }); }}><span>3</span>兴趣点</button>
            <button type="button" className={step === "itinerary" ? "active" : ""} disabled={!macroCandidates.length} onClick={() => { setStep("itinerary"); setSelection({ type: "trip", id: null }); }}><span>4</span>概览{workspace.itineraryUpdateState.macro.status === "needs_update" ? <em>需更新</em> : null}</button>
            <button type="button" className={step === "detail" ? "active" : ""} disabled={!workspace.trip.plan.days.length} onClick={() => { setStep("detail"); setSelection({ type: "trip", id: null }); }}><span>5</span>行程{detailNeedsUpdate ? <em>需更新</em> : null}</button>
          </nav></header>
          <div className="workspace-step-content-v3">
            {step === "requirements" ? <RequirementsPanelV3 facts={workspace.trip.plan.trip} busy={working} onSave={saveBrief} onGenerate={async () => { setStep("destinations"); setSelection({ type: "candidate_pool", id: null }); await startCta("destinations", "destination.generate"); }}/>
            : step === "destinations" ? <CandidatePanel view="macro" workspace={legacyWorkspace} selectedCandidateId={selectedCandidateId} busy={working} onSelectCandidate={(candidateId) => setSelection({ type: "candidate", id: candidateId })} onSetPreference={setPreference} onDiscover={() => startCta("destinations", "destination.generate")} onAddCandidate={addCandidate} onUpdatePlace={updatePlace} onPreviewGoogleMapsLink={previewGoogleMapsLink} onApplyGoogleMapsLink={applyGoogleMapsLink} onRemoveCandidate={removeCandidate} onContinue={async () => { setStep("interests"); setSelection({ type: "candidate_pool", id: null }); }} onRetry={retryResolutions} onSearchCandidates={searchResolutionCandidates} onSelectResolution={selectResolution} onBeginMapPick={(placeId) => { setMapPickPlaceId(placeId); setFocus("map"); }}/>
            : step === "interests" ? <CandidatePanel view="micro" workspace={legacyWorkspace} selectedCandidateId={selectedCandidateId} busy={working} onSelectCandidate={(candidateId) => setSelection({ type: "candidate", id: candidateId })} onSetPreference={setPreference} onDiscover={() => startCta("interests", "interest.supplement")} onAddCandidate={addCandidate} onUpdatePlace={updatePlace} onPreviewGoogleMapsLink={previewGoogleMapsLink} onApplyGoogleMapsLink={applyGoogleMapsLink} onRemoveCandidate={removeCandidate} onContinue={async () => { setStep("itinerary"); setSelection({ type: "trip", id: null }); if (!workspace.trip.plan.days.length) await startCta("itinerary", "itinerary.generate"); }} onRetry={retryResolutions} onSearchCandidates={searchResolutionCandidates} onSelectResolution={selectResolution} onBeginMapPick={(placeId) => { setMapPickPlaceId(placeId); setFocus("map"); }}/>
            : step === "itinerary" ? <MacroItineraryPanelV3 workspace={workspace} busy={working} previewedDayId={null} focusedDayId={null} onPreviewDay={() => {}} onToggleFocusDay={() => {}} onSelectAll={() => setSelection({ type: "trip", id: null })} onGenerate={() => startCta("itinerary", "itinerary.generate")} onUpdate={() => startCta("itinerary", "itinerary.replan")} onRecalculate={recalculateMacroRoute} onRecalculateDirty={recalculateDirtyMacroRoutes} onContinue={async () => { setStep("detail"); setSelection({ type: "trip", id: null }); if (!hasDetailedDays) await startCta("itinerary", "itinerary.detail.generate"); }}/>
            : <section className="workspace-detail-step-v3">
                {detailNeedsUpdate && <div className="workspace-warning-v3"><TriangleAlert size={16}/><div><b>每日详细行程需更新</b><p>{detailAffectedDayIds.length} 天受到第二/三/四步修改影响。其他日期保持原样。</p><button className="button primary small" type="button" disabled={working} onClick={() => void startCta("itinerary", "itinerary.detail.update", { dayIds: detailAffectedDayIds }, detailAffectedDayIds)}><Sparkles size={14}/>只更新这 {detailAffectedDayIds.length} 天</button></div></div>}
                {!hasDetailedDays && <section className="workspace-requirements-v3"><div><p className="eyebrow">STEP 5</p><h2>每日详细行程</h2><p>第四步骨架已经固定。现在才会选择具体兴趣点、安排时间和每天的详细线路。</p></div><button className="button primary workspace-primary-cta-v3" type="button" disabled={working || workspace.itineraryUpdateState.macro.status === "needs_update"} onClick={() => void startCta("itinerary", "itinerary.detail.generate")}><Sparkles size={15}/>生成每日详细行程</button></section>}
                {hasDetailedDays && <ItineraryPanelV2 workspace={legacyWorkspace} selectedDayId={selectedDayId} selectedStopId={selectedStopId} busy={working} onSelectAll={() => setSelection({ type: "trip", id: null })} onSelectDay={(dayId) => setSelection({ type: "day", id: dayId })} onSelectStop={(stopId) => setSelection({ type: "stop", id: stopId })} onRecalculate={recalculateRoute} onRecalculateDirty={recalculateDirtyRoutes} onRefine={refine} onCommand={runPlanCommand}/>}
              </section>}
          </div>
          <WorkspaceAssistantV3 stage={stage} workspace={workspace} selection={selection} busy={working} error={error} onSend={send} onConfirmAction={confirmAction} onCancelAction={cancelAction} onProposalAction={proposalAction} onStopTask={stopTask} onRetryGenerate={() => startCta("itinerary", "itinerary.generate")}/>
        </> : <div className="workspace-empty-v3"><span className="brand-mark">✦</span><h2>选择一趟旅行</h2><p>所有 AI 输入、Action 和 Proposal 都只出现在这个右侧控制台。</p></div>}</div>
      </div></div>
    </section>
    <VersionDrawerV2 tripId={trip?.id || null} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestored={() => { if (trip) void loadTrip(trip.id, false); void refreshTrips(false); }}/>
    <PasswordDrawer open={passwordOpen} onClose={() => setPasswordOpen(false)}/>
  </main>;
}
