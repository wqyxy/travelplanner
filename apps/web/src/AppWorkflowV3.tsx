import { type FormEvent, useEffect, useRef, useState } from "react";
import { History, KeyRound, Menu, Moon, Plus, RefreshCw, Sparkles, Sun, Trash2, TriangleAlert } from "lucide-react";
import { api } from "./api";
import { AiTaskTopbar } from "./AiTaskTopbar";
import { CandidateWorkflowPanelV3, type WorkflowCandidateDraftV3 } from "./CandidateWorkflowPanelV3";
import { DailyItineraryPanelV3 } from "./DailyItineraryPanelV3";
import { MacroItineraryPanelV3 } from "./MacroItineraryPanelV3";
import { PasswordDrawer } from "./PasswordDrawer";
import { RequirementsPanelV3 } from "./RequirementsPanelV3";
import { VersionDrawerV2 } from "./VersionDrawerV2";
import { WorkflowAssistantV3 } from "./WorkflowAssistantV3";
import { WorkspaceMapV2 } from "./WorkspaceMapV2";
import { proposalActionPath, type ProposalAction } from "./proposal-ui-v2";
import type { SkeletonEditDraftV3 } from "./skeleton-ui-v3";
import type { AppSettings, CandidatePreference, PlanCommand, PlanningRole, Trip, TripFacts, WorkspaceSelection } from "./v2-types";
import type { AiAction, AiActionType, ConversationStage, WorkflowStepV3, WorkspaceV3 } from "./v3-types";
import {
  defaultWorkflowStepV3,
  detailResolutionSummaryV3,
  latestRequiredWorkflowStepV3,
  selectionForWorkflowStepV3,
  stageForWorkflowStepV3,
  WORKFLOW_STEPS_V3,
} from "./workflow-ui-v3";

 type User = { id: string; username: string };
type Model = { model: string; displayName?: string; supportedReasoningEfforts?: Array<string | { reasoningEffort?: string }> };
type CodexStatus = { signedIn: boolean; models: Model[]; error?: string };
type Bootstrap = { authenticated: boolean; configured: boolean; user: User | null; settings: AppSettings };
type WorkspaceFocus = null | "map" | "panel";
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

function effectiveRole(candidate: Trip["plan"]["candidates"][number], trip: Trip): PlanningRole {
  const place = trip.plan.places.find((item) => item.id === candidate.placeId);
  return candidate.planningRole ?? (place?.kind === "city" ? "planning_area" : "detail_interest");
}

export default function AppWorkflowV3() {
  const [user, setUser] = useState<User | null | undefined>();
  const [configured, setConfigured] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceV3 | null>(null);
  const [step, setStep] = useState<WorkflowStepV3>("requirements");
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
  const handledRequiredAction = useRef<string | null>(null);
  selectedTripId.current = workspace?.trip.id ?? null;

  const stage = stageForWorkflowStepV3(step);
  const trip = workspace?.trip ?? null;
  const tasks = workspace?.tasks ?? [];
  const stageMessages = workspace?.messages[stage] ?? [];
  const activeTurn = [...stageMessages].reverse().find((item) => item.role === "user" && item.turn && ["queued", "starting", "active"].includes(item.turn.status));
  const aiActionActive = tasks.some((task) => task.agent === "action" && ACTIVE_TASKS.has(task.status));
  const stageDialogueActive = tasks.some((task) => task.agent === "dialogue" && ACTIVE_TASKS.has(task.status) && task.metadata?.stage === stage);
  const working = busy || Boolean(activeTurn) || aiActionActive || stageDialogueActive;
  const selectedStop = selection.type === "stop" && trip ? trip.plan.days.flatMap((day) => day.stops.map((stop) => ({ day, stop }))).find((item) => item.stop.id === selection.id) ?? null : null;
  const selectedDayId = selection.type === "day" ? selection.id : selectedStop?.day.id ?? null;
  const selectedCandidateId = selection.type === "candidate" ? selection.id : selectedStop?.stop.candidateId ?? null;
  const selectedStopId = selectedStop?.stop.id ?? null;

  const gotoStep = (next: WorkflowStepV3) => { setStep(next); setSelection(selectionForWorkflowStepV3(next)); setMapPickPlaceId(null); setFocus(null); };
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
      setWorkspace(next); setMenu(null);
      if (resetSelection) { const nextStep = defaultWorkflowStepV3(next); setStep(nextStep); setSelection(selectionForWorkflowStepV3(nextStep)); handledRequiredAction.current = null; }
      if (window.matchMedia("(max-width: 900px)").matches) setSidebar(false);
    } catch (cause) { if (token === loadToken.current) setError(cause instanceof Error ? cause.message : "无法加载旅行工作台。"); }
  };
  const refreshWorkspace = async () => { const id = selectedTripId.current; if (id) await loadTrip(id, false); };
  const runAction = async <T,>(operation: () => Promise<T>, fallback: string) => { setBusy(true); setError(""); try { return await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : fallback); return undefined; } finally { setBusy(false); } };

  useEffect(() => { void api<Bootstrap>("/api/bootstrap").then((value) => { setUser(value.user); setConfigured(value.configured); applySettings(value.settings); if (value.authenticated) { void refreshTrips(false); void refreshCodex(); } }).catch(() => setUser(null)); }, []);
  useEffect(() => { document.documentElement.dataset.theme = settings.ui.theme; }, [settings.ui.theme]);
  useEffect(() => { if (user) void refreshTrips(trash); }, [trash, user?.id]);
  useEffect(() => { const timer = window.setTimeout(() => window.dispatchEvent(new Event("travel-workspace-resize")), 220); return () => window.clearTimeout(timer); }, [sidebar, focus, settings.ui.workspaceSplitRatio]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setFocus(null); setMapPickPlaceId(null); } }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, []);
  useEffect(() => {
    if (!workspace) return;
    const required = latestRequiredWorkflowStepV3(workspace);
    if (!required || handledRequiredAction.current === required.actionId) return;
    handledRequiredAction.current = required.actionId;
    gotoStep(required.step);
  }, [workspace?.actions.map((action) => `${action.id}:${action.status}:${action.resultRef}`).join("|")]);
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
          if (item.kind === "ai-task.updated") { setWorkspace((current) => current ? { ...current, tasks: [item.payload, ...current.tasks.filter((task) => task.id !== item.payload.id)] } : current); if (!ACTIVE_TASKS.has(String(item.payload?.status))) void refreshWorkspace(); return; }
          if (["travel.document.changed", "travel.resolution.changed", "travel.route.changed", "travel.proposal.changed", "travel.action.changed", "travel.turn.changed"].includes(item.kind)) { void refreshWorkspace(); void refreshTrips(false); }
        } catch { /* ignore malformed event */ }
      };
      socket.onclose = () => { if (!closed) retryTimer = window.setTimeout(connect, 1500); };
      socket.onerror = () => socket?.close();
    };
    connect(); return () => { closed = true; if (retryTimer) window.clearTimeout(retryTimer); socket?.close(); };
  }, [user?.id]);

  const createTrip = async () => { await runAction(async () => { const result = await api<{ trip: Trip }>("/api/trips", { method: "POST", body: "{}" }); setTrash(false); await refreshTrips(false); await loadTrip(result.trip.id); gotoStep("requirements"); }, "无法新建旅行。"); };
  const send = async (messageStage: ConversationStage, message: string, currentSelection: WorkspaceSelection) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/stages/${messageStage}/turns`, { method: "POST", body: JSON.stringify({ message, selection: currentSelection }) }); await refreshWorkspace(); }, "无法发送消息。"); };
  const startCta = async (actionStage: ConversationStage, actionType: AiActionType, parameters: Record<string, unknown> = {}, targetIds: string[] = []) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/actions/cta`, { method: "POST", body: JSON.stringify({ stage: actionStage, actionType, parameters, targetIds, requestKey: crypto.randomUUID() }) }); await refreshWorkspace(); }, "无法启动这个操作。"); };
  const confirmAction = async (action: AiAction) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/actions/${encodeURIComponent(action.id)}/confirm`, { method: "POST", body: JSON.stringify({ expectedGeneration: action.baseGeneration }) }); await refreshWorkspace(); }, "无法确认操作。"); };
  const cancelAction = async (action: AiAction) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/actions/${encodeURIComponent(action.id)}/cancel`, { method: "POST", body: JSON.stringify({ expectedGeneration: action.baseGeneration }) }); await refreshWorkspace(); }, "无法取消操作。"); };
  const proposalAction = async (proposalId: string, action: ProposalAction) => { if (!trip) return; await runAction(async () => { await api(proposalActionPath(trip.id, proposalId, action), { method: "POST", body: "{}" }); await loadTrip(trip.id, false); if (action !== "reject") await refreshTrips(false); }, "无法处理这个调整方案。"); };
  const stopTask = async (taskId: string) => { if (trip) await runAction(async () => { await api(`/api/trips/${trip.id}/ai-tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST", body: "{}" }); }, "无法停止任务。"); };

  const setPreference = async (candidateIds: string[], preference: CandidatePreference) => {
    if (!trip || !candidateIds.length) return;
    await runAction(async () => {
      if (candidateIds.length === 1) await api(`/api/trips/${trip.id}/candidates/${encodeURIComponent(candidateIds[0])}`, { method: "PATCH", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, preference }) });
      else await api(`/api/trips/${trip.id}/candidates/batch`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, candidateIds, preference }) });
      await loadTrip(trip.id, false); await refreshTrips(false);
    }, "无法修改地点偏好。");
  };
  const runPlanCommand = async (command: PlanCommand) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/commands`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, commands: [command] }) }); await loadTrip(trip.id, false); await refreshTrips(false); }, "无法修改旅行计划。"); };
  const addCandidate = async (draft: WorkflowCandidateDraftV3) => {
    if (!trip) return;
    const parent = draft.planningAreaCandidateId ? trip.plan.candidates.find((candidate) => candidate.id === draft.planningAreaCandidateId) : null;
    const parentPlace = parent ? trip.plan.places.find((place) => place.id === parent.placeId) : null;
    const placeId = `tmp-place-${crypto.randomUUID()}`; const candidateId = `tmp-candidate-${crypto.randomUUID()}`;
    await runPlanCommand({ type: "add_candidate", place: { id: placeId, nameZh: draft.nameZh, nameLocal: null, nameEn: null, kind: draft.planningRole === "planning_area" ? "city" : "attraction", city: parentPlace?.nameZh ?? null, region: parentPlace?.region ?? null, country: parentPlace?.country ?? null, countryCode: parentPlace?.countryCode ?? null, approximate: false }, candidate: { id: candidateId, placeId, planningAreaCandidateId: draft.planningAreaCandidateId, planningRole: draft.planningRole, preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: draft.suggestedDurationMinutes, tags: [] } });
  };
  const removeCandidate = async (candidateId: string, cascade: boolean) => { await runPlanCommand(cascade ? { type: "remove_candidate_tree", candidateId } : { type: "remove_candidate", candidateId }); setSelection({ type: "candidate_pool", id: null }); };
  const retryResolutions = async (placeIds: string[]) => { if (!trip || !placeIds.length) return; await runAction(async () => { await api(`/api/trips/${trip.id}/resolutions/retry`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, placeIds }) }); await loadTrip(trip.id, false); }, "无法重新识别地点。"); };
  const setManualResolution = async (placeId: string, latitude: number, longitude: number) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/resolutions/${encodeURIComponent(placeId)}/manual`, { method: "PUT", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, method: "map_pick", latitude, longitude, address: null }) }); setMapPickPlaceId(null); await loadTrip(trip.id, false); }, "无法保存地点位置。"); };
  const recalculateRoute = async (dayId: string) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/routes/${encodeURIComponent(dayId)}/recalculate`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration }) }); await loadTrip(trip.id, false); }, "无法更新地图路线。"); };
  const recalculateDirtyRoutes = async () => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/routes/recalculate`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration }) }); await loadTrip(trip.id, false); }, "无法批量更新地图路线。"); };
  const recalculateMacroRoute = async (dayId: string) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/macro-routes/${encodeURIComponent(dayId)}/recalculate`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration }) }); await loadTrip(trip.id, false); }, "无法更新区域间路线。"); };
  const recalculateDirtyMacroRoutes = async () => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/macro-routes/recalculate`, { method: "POST", body: JSON.stringify({ expectedGeneration: trip.contentGeneration }) }); await loadTrip(trip.id, false); }, "无法批量更新区域间路线。"); };
  const refine = async (dayIds: string[]) => { if (trip) await startCta("itinerary", "itinerary.refine", { dayIds }, dayIds); };
  const saveSkeletonDraft = async (draft: SkeletonEditDraftV3) => { if (!trip) return; await runAction(async () => { await api(`/api/trips/${trip.id}/skeleton`, { method: "PUT", body: JSON.stringify({ expectedGeneration: trip.contentGeneration, draft }) }); await loadTrip(trip.id, false); await refreshTrips(false); }, "无法保存路线和天数调整。"); };
  const saveBrief = async (changes: Partial<TripFacts["brief"]>) => {
    if (!trip) return false;
    let saved = false;
    await runAction(async () => {
      const started = await api<{ action: AiAction }>(`/api/trips/${trip.id}/actions/cta`, { method: "POST", body: JSON.stringify({ stage: "requirements", actionType: "requirements.update", parameters: { changes: { brief: changes } }, targetIds: [], requestKey: crypto.randomUUID() }) });
      for (let attempt = 0; attempt < 20; attempt += 1) { const next = await api<WorkspaceV3>(`/api/trips/${trip.id}/workspace`); setWorkspace(next); const action = next.actions.find((item) => item.id === started.action.id); if (action?.status === "applied") { saved = true; await refreshTrips(false); return; } if (action?.status === "failed" || action?.status === "superseded") throw new Error(action.errorSummary || "保存旅行需求失败。"); await new Promise((resolve) => window.setTimeout(resolve, 25)); }
      throw new Error("旅行需求保存超时，请重试。");
    }, "无法保存旅行需求。");
    return saved;
  };
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

  const resize = () => { const rect = workspaceElement.current?.getBoundingClientRect(); if (!rect) return; let value = settings.ui.workspaceSplitRatio; const move = (event: PointerEvent) => { value = Math.max(.34, Math.min(.7, (event.clientX - rect.left) / rect.width)); setSettings((current) => ({ ...current, ui: { ...current.ui, workspaceSplitRatio: value } })); }; const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); void saveUi({ workspaceSplitRatio: value }); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); };

  if (user === undefined) return <main className="loading-screen">正在加载旅行空间…</main>;
  if (!user) return <Login setup={!configured} onDone={(next) => { setUser(next); void refreshTrips(false); void refreshCodex(); }}/>;

  const models = (codex?.models || []).filter((item) => item.model);
  const legacyWorkspace = workspace as any;
  const planningAreaIds = new Set<string>();
  if (trip) for (const candidate of trip.plan.candidates) if (effectiveRole(candidate, trip) === "planning_area") planningAreaIds.add(candidate.id);
  const adoptedAreaIds = new Set<string>();
  if (trip) for (const day of trip.plan.days) { const area = trip.plan.candidates.find((candidate) => effectiveRole(candidate, trip) === "planning_area" && candidate.placeId === day.endAnchor.placeId); if (area) adoptedAreaIds.add(area.id); }
  const mapWorkspace = workspace ? (() => {
    if (step === "detail") return legacyWorkspace;
    if (step === "skeleton") return { ...legacyWorkspace, trip: { ...workspace.trip, plan: { ...workspace.trip.plan, candidates: workspace.trip.plan.candidates.filter((candidate) => effectiveRole(candidate, workspace.trip) === "planning_area"), days: workspace.trip.plan.days.map((day) => ({ ...day, stops: [] })) } }, routeStates: workspace.macroRouteStates };
    if (step === "backbone") return { ...legacyWorkspace, trip: { ...workspace.trip, plan: { ...workspace.trip.plan, candidates: workspace.trip.plan.candidates.filter((candidate) => effectiveRole(candidate, workspace.trip) !== "detail_interest") } } };
    if (step === "interests") return { ...legacyWorkspace, trip: { ...workspace.trip, plan: { ...workspace.trip.plan, candidates: workspace.trip.plan.candidates.filter((candidate) => { const role = effectiveRole(candidate, workspace.trip); return role !== "planning_area" && Boolean(candidate.planningAreaCandidateId && adoptedAreaIds.has(candidate.planningAreaCandidateId)); }) } } };
    return legacyWorkspace;
  })() : null;
  const macroNeedsUpdate = workspace?.itineraryUpdateState.macro.status === "needs_update";
  const detailNeedsUpdate = workspace?.itineraryUpdateState.detail.status === "needs_update";
  const detailAffectedDayIds = workspace?.itineraryUpdateState.detail.affectedDayIds ?? [];
  const hasDetailedDays = Boolean(workspace?.trip.plan.days.some((day) => day.detailLevel === "detailed"));
  const detailReadiness = workspace ? detailResolutionSummaryV3(workspace) : { blocking: [], blockingCount: 0, nonBlockingNames: [] };
  const planningAreaCount = trip ? trip.plan.candidates.filter((candidate) => effectiveRole(candidate, trip) === "planning_area" && candidate.preference !== "excluded").length : 0;
  const currentStepMeta = WORKFLOW_STEPS_V3.find((item) => item.step === step)!;
  const retryCurrent = async () => {
    if (!trip) return;
    if (step === "backbone") return startCta("destinations", "destination.generate");
    if (step === "skeleton") return startCta("destinations", trip.plan.days.length ? "itinerary.replan" : "itinerary.generate");
    if (step === "interests") return startCta("interests", "interest.supplement");
    if (step === "detail") return startCta("itinerary", hasDetailedDays && detailNeedsUpdate ? "itinerary.detail.update" : "itinerary.detail.generate", hasDetailedDays && detailNeedsUpdate ? { dayIds: detailAffectedDayIds } : {}, hasDetailedDays && detailNeedsUpdate ? detailAffectedDayIds : []);
  };

  return <main className={`app-shell app-shell-v3 ${sidebar ? "sidebar-open" : "sidebar-closed"}`}>
    <aside className={`sidebar ${sidebar ? "open" : ""}`}><div className="sidebar-head"><div className="brand-lockup"><span className="brand-mark">✦</span><span>AI Travel<small>可视化旅行工作台</small></span></div></div><button className="button primary new-trip" disabled={working || trash} onClick={() => void createTrip()}><Plus size={16}/>新建旅行</button><div className="sidebar-title"><span>{trash ? "回收站" : "我的旅行"}</span><button type="button" onClick={() => { setTrash((value) => !value); setWorkspace(null); setSelection({ type: "trip", id: null }); }}>{trash ? "返回" : <Trash2 size={14}/>}</button></div><nav>{trips.map((item) => <div className={`trip-nav-item ${trip?.id === item.id ? "selected" : ""}`} key={item.id}><button className="trip-select" onClick={() => !trash && void loadTrip(item.id)}><b>{item.title}</b><small>{item.plan.candidates.length} 个地点 · {item.plan.days.length ? `${item.plan.days.length} 天` : "待安排"}</small></button><button className="trip-menu" onClick={() => setMenu(menu === item.id ? null : item.id)}>•••</button>{menu === item.id && <div className="trip-actions">{trash ? <><button onClick={() => void manage(item, "restore")}>恢复</button><button className="danger" onClick={() => void manage(item, "permanent")}>永久删除</button></> : <><button onClick={() => void manage(item, "rename")}>重命名</button><button onClick={() => void manage(item, "duplicate")}>复制</button><button className="danger" onClick={() => void manage(item, "trash")}>移入回收站</button></>}</div>}</div>)}{!trips.length && <span className="sidebar-empty">{trash ? "回收站为空" : "还没有旅行"}</span>}</nav><footer><span>{user.username}</span><button onClick={() => void api("/api/auth/logout", { method: "POST", body: "{}" }).then(() => { setUser(null); setWorkspace(null); })}>退出登录</button></footer></aside>
    <section className="main-panel">
      <header className="topbar"><div className="topbar-page-identity"><button className="icon-button sidebar-toggle" aria-label={sidebar ? "收起旅行菜单" : "打开旅行菜单"} onClick={() => void saveUi({ sidebarOpen: !sidebar })}><Menu size={21}/></button><div><h1>{trip?.title || (trash ? "回收站" : "旅行工作台")}</h1><small>{trip ? `第 ${currentStepMeta.number} 步 · ${currentStepMeta.label}${currentStepMeta.optional ? "（可选）" : ""}` : "所有旅行操作都从右侧控制台开始"}</small></div></div><div className="model-status">{trip && workspace && workspace.tasks.length > 0 && <AiTaskTopbar tasks={workspace.tasks} onStop={stopTask}/>}<span className={codex?.signedIn ? "status-dot connected" : "status-dot"}/>{codex?.signedIn ? <select className="ai-model-select-v3" aria-label="AI 模型" value={settings.ai.model} onChange={(event) => void api<{ settings: AppSettings }>("/api/settings/ai-model", { method: "PUT", body: JSON.stringify({ model: event.target.value, reasoningEffort: settings.ai.reasoningEffort }) }).then((value) => applySettings(value.settings))}>{models.map((model) => <option key={model.model} value={model.model}>{model.displayName || model.model}</option>)}</select> : <button className="button small" onClick={() => void api<{ authUrl: string }>("/api/codex/login/browser", { method: "POST", body: "{}" }).then((value) => window.open(value.authUrl, "_blank", "noopener,noreferrer"))}>登录 AI</button>}{trip && <select className="plan-language-select-v3" aria-label="地点名称语言" value={trip.planLanguage} onChange={(event) => void saveLanguage(event.target.value as Trip["planLanguage"])}><option value="zh">中文</option><option value="en">English</option><option value="bilingual">中英对照</option></select>}<button className="icon-button" aria-label="刷新 AI 状态" onClick={() => void refreshCodex()}><RefreshCw size={16}/></button><button className="icon-button" aria-label="切换主题" onClick={() => void saveUi({ theme: settings.ui.theme === "light" ? "dark" : "light" })}>{settings.ui.theme === "light" ? <Moon size={18}/> : <Sun size={18}/>}</button><button className="icon-button" aria-label="版本历史" disabled={!trip} onClick={() => setHistoryOpen(true)}><History size={18}/></button><button className="icon-button" aria-label="修改密码" onClick={() => setPasswordOpen(true)}><KeyRound size={17}/></button></div></header>
      <div className="main-workspace main-workspace-v3"><div className={`travel-workspace travel-workspace-v3 ${focus ? `focus-${focus}` : ""}`} ref={workspaceElement} style={{ gridTemplateColumns: `${settings.ui.workspaceSplitRatio}fr 10px ${1 - settings.ui.workspaceSplitRatio}fr` }}>
        {workspace ? <WorkspaceMapV2 workspace={mapWorkspace as any} view={(step === "skeleton" || step === "detail") ? "itinerary" : "candidates"} selectedCandidateId={selectedCandidateId} selectedDayId={(step === "skeleton" || step === "detail") ? selectedDayId : null} selectedStopId={step === "detail" ? selectedStopId : null} mapPickPlaceId={mapPickPlaceId} fullscreen={focus === "map"} onSelectCandidate={(candidateId) => setSelection({ type: "candidate", id: candidateId })} onSelectStop={(stopId) => setSelection({ type: "stop", id: stopId })} onMapPick={(placeId, latitude, longitude) => void setManualResolution(placeId, latitude, longitude)} onToggleFullscreen={() => setFocus((current) => current === "map" ? null : "map")}/> : <section className="workspace-map-v2 no-trip"><div className="map-empty-overlay"><span className="brand-mark">✦</span><strong>地图只展示规划结果</strong><span>所有旅行操作都从右侧开始</span></div></section>}
        <div className="splitter" onPointerDown={resize}/>
        <div className="workspace-side-v3">{workspace ? <>
          <header className="workspace-flow-head-v3"><nav className="workspace-flow-nav-v3 phase6-flow-nav" aria-label="旅行规划步骤">{WORKFLOW_STEPS_V3.map((item) => { const disabled = item.step === "skeleton" ? planningAreaCount === 0 : item.step === "interests" || item.step === "detail" ? workspace.trip.plan.days.length === 0 : false; const needsUpdate = item.step === "skeleton" ? macroNeedsUpdate : item.step === "detail" ? detailNeedsUpdate : false; return <button type="button" key={item.step} className={step === item.step ? "active" : ""} disabled={disabled} onClick={() => gotoStep(item.step)}><span>{item.number}</span><b>{item.label}</b>{item.optional && <em>可选</em>}{needsUpdate && <i>需更新</i>}</button>; })}</nav></header>
          <div className="workspace-step-content-v3">
            {step === "requirements" ? <RequirementsPanelV3 facts={workspace.trip.plan.trip} busy={working} onSave={saveBrief} onGenerate={async () => gotoStep("backbone")}/>
            : step === "backbone" ? <CandidateWorkflowPanelV3 mode="backbone" workspace={legacyWorkspace} selectedCandidateId={selectedCandidateId} busy={working} macroNeedsUpdate={Boolean(macroNeedsUpdate)} onSelectCandidate={(candidateId) => setSelection({ type: "candidate", id: candidateId })} onSetPreference={setPreference} onDiscover={() => startCta("destinations", "destination.generate")} onAddCandidate={addCandidate} onRemoveCandidate={removeCandidate} onContinue={async () => gotoStep("skeleton")} onGoToSkeleton={() => gotoStep("skeleton")} onRetry={retryResolutions} onBeginMapPick={(placeId) => { setMapPickPlaceId(placeId); setFocus("map"); }}/>
            : step === "skeleton" ? <MacroItineraryPanelV3 workspace={workspace} selectedDayId={selectedDayId} busy={working} onSelectAll={() => setSelection({ type: "trip", id: null })} onSelectDay={(dayId) => setSelection({ type: "day", id: dayId })} onGenerate={() => startCta("destinations", "itinerary.generate")} onUpdate={() => startCta("destinations", "itinerary.replan")} onSaveDraft={saveSkeletonDraft} onRecalculate={recalculateMacroRoute} onRecalculateDirty={recalculateDirtyMacroRoutes} onContinue={async () => gotoStep("interests")}/>
            : step === "interests" ? <CandidateWorkflowPanelV3 mode="interests" workspace={legacyWorkspace} selectedCandidateId={selectedCandidateId} busy={working} macroNeedsUpdate={Boolean(macroNeedsUpdate)} onSelectCandidate={(candidateId) => setSelection({ type: "candidate", id: candidateId })} onSetPreference={setPreference} onDiscover={() => startCta("interests", "interest.supplement")} onAddCandidate={addCandidate} onRemoveCandidate={removeCandidate} onContinue={async () => gotoStep("detail")} onGoToSkeleton={() => gotoStep("skeleton")} onRetry={retryResolutions} onBeginMapPick={(placeId) => { setMapPickPlaceId(placeId); setFocus("map"); }}/>
            : <section className="phase6-detail-step">
                {macroNeedsUpdate ? <div className="phase6-blocking-card"><strong>路线和天数需要重新确认</strong><p>前面的地点或旅行需求已经影响到当前路线。先确认第 3 步，再继续安排每天怎么玩。</p><button className="button primary small" type="button" onClick={() => gotoStep("skeleton")}>去更新路线和天数</button></div>
                : detailReadiness.blockingCount > 0 ? <div className="phase6-blocking-card"><strong>{detailReadiness.blockingCount} 个当前行程需要的地点尚未定位</strong><p>{detailReadiness.blocking.map((item) => item.message).join("；")}</p><button className="button primary small" type="button" onClick={() => gotoStep(detailReadiness.blocking[0].step)}>去处理这些地点</button></div> : null}
                {detailReadiness.nonBlockingNames.length > 0 && <details className="phase6-context-details"><summary>{detailReadiness.nonBlockingNames.length} 个非必去地点尚未定位</summary><p>{detailReadiness.nonBlockingNames.join("、")}</p><small>这些地点不会阻止其他已定位地点继续生成每日行程。</small></details>}
                {detailNeedsUpdate && hasDetailedDays && !macroNeedsUpdate && <div className="phase6-update-card"><TriangleAlert size={16}/><div><strong>{detailAffectedDayIds.length} 天需要更新，其他 {Math.max(0, workspace.trip.plan.days.length - detailAffectedDayIds.length)} 天保持不变</strong><p>只重新安排真正受前面修改影响的日期。</p><details><summary>查看原因</summary><small>地点偏好、重要游览地或停留安排发生了变化；未受影响日期继续沿用。</small></details></div>{detailReadiness.blockingCount ? <button className="button primary small" onClick={() => gotoStep(detailReadiness.blocking[0].step)}>先处理未定位地点</button> : <button className="button primary small" disabled={working} onClick={() => void startCta("itinerary", "itinerary.detail.update", { dayIds: detailAffectedDayIds }, detailAffectedDayIds)}><Sparkles size={14}/>更新受影响的 {detailAffectedDayIds.length} 天</button>}</div>}
                {!hasDetailedDays && !macroNeedsUpdate && <section className="phase6-generate-detail"><div><p className="eyebrow">STEP 5</p><h2>每日行程</h2><p>路线和天数已经固定。现在把重要游览地和已有普通景点安排到具体日期；即使第 4 步没有补充景点，也可以直接开始。</p></div><button className="button primary" type="button" disabled={working || detailReadiness.blockingCount > 0} onClick={() => void startCta("itinerary", "itinerary.detail.generate")}><Sparkles size={15}/>生成每日行程</button></section>}
                {hasDetailedDays && <DailyItineraryPanelV3 workspace={legacyWorkspace} selectedDayId={selectedDayId} selectedStopId={selectedStopId} busy={working} onSelectAll={() => setSelection({ type: "trip", id: null })} onSelectDay={(dayId) => setSelection({ type: "day", id: dayId })} onSelectStop={(stopId) => setSelection({ type: "stop", id: stopId })} onRecalculate={recalculateRoute} onRecalculateDirty={recalculateDirtyRoutes} onImproveDay={refine}/>} 
              </section>}
          </div>
          <WorkflowAssistantV3 workflowStep={step} stage={stage} workspace={workspace} selection={selection} busy={working} error={error} onSend={send} onConfirmAction={confirmAction} onCancelAction={cancelAction} onProposalAction={proposalAction} onStopTask={stopTask} onRetryCurrent={retryCurrent}/>
        </> : <div className="workspace-empty-v3"><span className="brand-mark">✦</span><h2>选择一趟旅行</h2><p>所有 AI 输入和旅行修改都从这个右侧控制台开始。</p></div>}</div>
      </div></div>
    </section>
    <VersionDrawerV2 tripId={trip?.id || null} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestored={() => { if (trip) void loadTrip(trip.id, false); void refreshTrips(false); }}/><PasswordDrawer open={passwordOpen} onClose={() => setPasswordOpen(false)}/>
  </main>;
}
