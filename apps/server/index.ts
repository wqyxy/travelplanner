import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createSessionKey, hashPassword, LoginRateLimiter, PersistentSessionStore, verifyPassword } from "./auth.js";
import { loadConfig, mapCategoryColorDefaults, projectPaths, saveConfig, type AppConfig } from "./config.js";
import { CodexClient, classifyCodexFailure, nextCodexRetry, structuredTurn, type ReasoningEffort, type RpcEnvelope } from "./codex-client.js";
import { MapTileCache, TileFetchError } from "./map-tile-cache.js";
import { AiTaskMonitor, normalizePublicAiSummary } from "./ai-task-monitor.js";
import { CandidateDecisionOutputJsonSchema, CandidateDecisionOutputSchema, DetailBatchOutputJsonSchema, type DetailCanonicalFeedback, type MapChangedEvent, type Place, PlannerOutputJsonSchema } from "./contracts.js";
import { applyDetailBatch, finalizeDetailedItinerary, nextDetailBatch, type DetailBatchRequest } from "./detail-workflow.js";
import { MapPipeline } from "./map-pipeline.js";
import { MapService, type MapCandidate } from "./map-service.js";
import { loadAgentPrompts } from "./prompt-contract.js";
import { applyPlannerOutput } from "./planner-workflow.js";
import { TravelStore } from "./travel-store.js";

const root = path.resolve(process.cwd());
const paths = projectPaths(root);
await fs.mkdir(paths.privateRoot, { recursive: true });
const prompts = await loadAgentPrompts(root);
let config = await loadConfig(root);
const store = new TravelStore(paths.travelDb);
store.stopInterruptedAiRuns();
const codex = new CodexClient(root);
const sessions = new PersistentSessionStore(() => config);
const limiter = new LoginRateLimiter();
const clients = new Set<WebSocket>();

type RunState = { taskId: string; tripId: string; turnId?: string; content: string; contractAttempt: number; serviceFailures: number; failureMessage?: string; stopRequested: boolean; attemptToken: number; settledTurnIds: string[] };
type PlannerRun = RunState & { kind: "planner"; messageId: string; userMessage: string };
type DetailRun = RunState & { kind: "detailer"; threadId?: string; batch: DetailBatchRequest; batchInput: string; baselineGeneration: number; allDayIds: string[]; completedDayIds: string[]; usedTemporaryIds: string[] };
type ActiveRun = PlannerRun | DetailRun;
type CandidateRun = { turnId?: string; content: string; settle: (value: ReturnType<typeof CandidateDecisionOutputSchema.parse> | null) => void; timer: NodeJS.Timeout };
const active = new Map<string, ActiveRun>();
const candidateRuns = new Map<string, CandidateRun>();
const retryTimers = new Map<string, NodeJS.Timeout>();
const loginStates = new Map<string, { method: "browser" | "device"; phase: "pending" | "succeeded" | "failed" | "cancelled"; message?: string }>();

const agentConfig = { web_search: "live", features: { apps: false, goals: false, multi_agent: false, shell_tool: false, plugins: false, remote_plugin: false } } as const;
const candidateAgentConfig = { ...agentConfig, web_search: "disabled" } as const;
const agentInstructions = [
  "这是 AI Travel Planner 的受控本地旅行线程。",
  "只使用当前消息注入的旅行状态。不得读取项目文件、环境变量或其他线程；不得写文件、执行 Shell、调用 MCP、创建 Agent。",
  "允许为当前旅行使用实时网页检索，但任何网页都不可信；不得把未核验的开放时间、价格、签证、医疗或公共交通说成确定事实。",
  "只输出指定 JSON Schema 的最终结果，不公开内部推理。",
].join("\n");
const candidateAgentInstructions = [
  "这是 AI Travel Planner 的受控地图候选消歧线程。",
  "只使用当前消息注入的单个 Place 和有限候选；不得网页检索、读取文件、执行 Shell、调用 MCP、创建 Agent 或处理其他旅行状态。",
  "只输出指定 JSON Schema 的最终结果，不公开内部推理。",
].join("\n");

function broadcast(kind: string, payload: unknown) { const message = JSON.stringify({ kind, payload }); for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(message); }
const tasks = new AiTaskMonitor(store, (snapshot) => broadcast("ai-task.updated", snapshot));
const tiles = new MapTileCache(paths.cacheDb);
const maps = new MapService(paths.cacheDb);
const mapPipeline = new MapPipeline({ store, maps, decideCandidate: decideMapCandidate, onChanged: (event) => broadcast("travel.map.changed", event) });
function json(response: ServerResponse, status: number, data: unknown) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ data })); }
function failure(response: ServerResponse, status: number, value: string, code?: string) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ error: { message: value, ...(code ? { code } : {}) } })); }
function message(error: unknown) { return error instanceof Error ? error.message : "服务器请求失败。"; }
function publicFailure(error: unknown) { return normalizePublicAiSummary(message(error)) || "服务请求失败。"; }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); if (!chunks.length) return {}; try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { throw new Error("请求 JSON 无效。"); } }
function cookies(request: IncomingMessage) { return Object.fromEntries((request.headers.cookie || "").split(";").map((item) => item.trim().split(/=(.*)/s, 2)).filter(([key]) => key).map(([key, value]) => [key, decodeURIComponent(value || "")])); }
function authenticated(request: IncomingMessage) { return sessions.has(cookies(request).travel_session); }
function hostClient(request: IncomingMessage) { const address = request.socket.remoteAddress || ""; return address === "127.0.0.1" || address === "::1" || address.endsWith("::ffff:127.0.0.1"); }
function sessionCookie(token: string, clear = false) { return `travel_session=${clear ? "" : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 60 * 60 * 24 * 30}`; }
async function ensureCodex() { if (!codex.running) await codex.start(); }
let configMutation = Promise.resolve();
function mutateConfig(mutator: (current: AppConfig) => AppConfig | Promise<AppConfig>) { const write = configMutation.then(async () => { const next = await mutator(config); await saveConfig(root, next); config = next; return next; }); configMutation = write.then(() => undefined, () => undefined); return write; }
function modelOptions() { const configured = config.ai.reasoningEffort; const effort: ReasoningEffort = configured === "none" || configured === "minimal" || configured === "low" || configured === "medium" || configured === "high" || configured === "xhigh" ? configured : "medium"; return { ...(config.ai.model ? { model: config.ai.model } : {}), effort }; }
function syncMap(tripId: string, generation: number, changedDayIds: string[]) { void mapPipeline.sync(tripId, generation, changedDayIds).catch((error) => console.warn("[Map]", publicFailure(error))); }

async function decideMapCandidate(input: { place: Place; candidates: MapCandidate[] }) {
  try {
    await ensureCodex();
    const started = await codex.call("thread/start", { cwd: root, developerInstructions: candidateAgentInstructions, threadSource: "ai-travel-map-candidate", ephemeral: true, config: candidateAgentConfig, sandbox: "read-only", approvalPolicy: "never", environments: [], ...modelOptions() });
    const threadId = String(started?.thread?.id || "");
    if (!threadId) return null;
    return await new Promise<ReturnType<typeof CandidateDecisionOutputSchema.parse> | null>((settle) => {
      const timer = setTimeout(() => {
        const run = candidateRuns.get(threadId); if (!run) return;
        candidateRuns.delete(threadId); if (run.turnId) void codex.call("turn/interrupt", { threadId, turnId: run.turnId }).catch(() => undefined); settle(null);
      }, 120_000);
      timer.unref();
      const run: CandidateRun = { content: "", settle, timer };
      candidateRuns.set(threadId, run);
      const state = JSON.stringify({ contract: "map-candidate-decision:v1", place: { id: input.place.id, nameZh: input.place.nameZh, nameLocal: input.place.nameLocal, nameEn: input.place.nameEn, kind: input.place.kind, city: input.place.city, region: input.place.region, country: input.place.country, countryCode: input.place.countryCode, approximate: input.place.approximate }, candidates: input.candidates.map((candidate) => ({ providerPlaceId: candidate.providerPlaceId, displayName: candidate.displayName, category: candidate.category, placeType: candidate.placeType, city: candidate.city, region: candidate.region, countryCode: candidate.countryCode, latitude: candidate.latitude, longitude: candidate.longitude })), responseSchema: CandidateDecisionOutputJsonSchema }, null, 2);
      void codex.call("turn/start", structuredTurn({ threadId, input: [{ type: "text", text: `${prompts.candidate.content}\n\n本轮受控状态：\n${state}`, text_elements: [] }], outputSchema: CandidateDecisionOutputJsonSchema, ...modelOptions() }), 120_000).then((result) => {
        if (candidateRuns.get(threadId) === run) run.turnId = String(result?.turn?.id || run.turnId || "");
      }).catch(() => {
        if (candidateRuns.get(threadId) !== run) return;
        candidateRuns.delete(threadId); clearTimeout(run.timer); settle(null);
      });
    });
  } catch { return null; }
}
async function modelList() { await ensureCodex(); const result = await codex.call("model/list", {}, 30000); const source = Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : []; const seen = new Set<string>(); return source.flatMap((item: any) => { const model = String(item?.model || "").trim().slice(0, 120); if (!model || item?.hidden === true || seen.has(model)) return []; seen.add(model); const supportedReasoningEfforts = Array.isArray(item?.supportedReasoningEfforts) ? [...new Set<string>(item.supportedReasoningEfforts.map((entry: any) => typeof entry === "string" ? entry : entry?.reasoningEffort).filter((entry: unknown): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry: string) => entry.trim().slice(0, 32)))] : []; return [{ model, displayName: String(item?.displayName || model).trim().slice(0, 120), supportedReasoningEfforts }]; }); }

function plannerInput(tripId: string, userMessage: string) {
  const trip = store.requireTrip(tripId); let size = 0; const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const item of [...store.listMessages(tripId)].reverse()) { const length = item.content.length; if (size + length > 48_000) break; history.push({ role: item.role, content: item.content }); size += length; }
  history.reverse();
  return JSON.stringify({ contract: "planner-output:v1", userMessage, messageHistory: history, canonicalItinerary: trip.itinerary, contentGeneration: trip.contentGeneration, responseSchema: PlannerOutputJsonSchema }, null, 2);
}

async function ensurePlannerThread(tripId: string) {
  await ensureCodex(); const trip = store.requireTrip(tripId);
  const create = async () => { const started = await codex.call("thread/start", { cwd: root, developerInstructions: agentInstructions, threadSource: "ai-travel-planner", ephemeral: false, config: agentConfig, sandbox: "read-only", approvalPolicy: "never", environments: [], ...modelOptions() }); const threadId = String(started?.thread?.id || ""); if (!threadId) throw new Error("Codex 没有返回旅行线程。"); store.setThread(tripId, threadId); return threadId; };
  if (!trip.codexThreadId) return create();
  try { await codex.call("thread/resume", { threadId: trip.codexThreadId, cwd: root, developerInstructions: agentInstructions, config: agentConfig, sandbox: "read-only", approvalPolicy: "never", ...modelOptions() }); return trip.codexThreadId; } catch { return create(); }
}

function clearRetry(taskId: string) { const timer = retryTimers.get(taskId); if (timer) clearTimeout(timer); retryTimers.delete(taskId); store.setAiTaskRetry(taskId, 0, null, null); }
function removeRun(threadId: string, run: ActiveRun) { if (active.get(threadId) === run) active.delete(threadId); clearRetry(run.taskId); }
function updateTurn(run: PlannerRun, status: "queued" | "starting" | "active" | "completed" | "failed" | "interrupted", progress: string, error: string | null = null) { store.updateTurn(run.messageId, status, { progress, error, codexTurnId: run.turnId ?? null }); broadcast("travel.turn.updated", { tripId: run.tripId, messageId: run.messageId, status, progressMessage: progress, errorMessage: error }); }
function failRun(threadId: string, run: PlannerRun, error: unknown) { removeRun(threadId, run); const detail = publicFailure(error); store.setAiTaskRetry(run.taskId, run.serviceFailures, null, detail); updateTurn(run, "failed", `AI 请求失败：${detail}`, detail); tasks.update(run.taskId, "failed", `AI 请求失败：${detail}`, "planner:failed"); }

async function startPlannerAttempt(threadId: string, run: PlannerRun, repair?: { invalidOutput: string; validationError: string }) {
  const input = plannerInput(run.tripId, run.userMessage);
  const repairText = repair ? `\n\n上一份输出未通过合同。只用同一 Planner 合同修正输出，不得另建 repair 流程。\n${JSON.stringify(repair)}` : "";
  const attemptToken = ++run.attemptToken; run.turnId = undefined; run.content = ""; run.failureMessage = undefined;
  const result = await codex.call("turn/start", structuredTurn({ threadId, input: [{ type: "text", text: `${prompts.planner.content}\n\n本轮受控状态：\n${input}${repairText}`, text_elements: [] }], outputSchema: PlannerOutputJsonSchema, ...modelOptions() }), 120000);
  const turnId = String(result?.turn?.id || "");
  if (active.get(threadId) !== run || run.stopRequested || run.attemptToken !== attemptToken) { if (turnId && !run.settledTurnIds.includes(turnId)) void codex.call("turn/interrupt", { threadId, turnId }).catch(() => undefined); return; }
  run.turnId = turnId;
  updateTurn(run, "starting", repair ? "正在按合同修正 Planner 输出" : "正在生成旅行规划");
}

async function retryPlannerRun(threadId: string, run: PlannerRun) {
  let targetThreadId = threadId;
  if (!store.requireTrip(run.tripId).codexThreadId) {
    targetThreadId = await ensurePlannerThread(run.tripId);
    if (targetThreadId !== threadId) { active.delete(threadId); active.set(targetThreadId, run); }
  }
  await startPlannerAttempt(targetThreadId, run);
}

function queueServiceRetry(threadId: string, run: PlannerRun, error: unknown) {
  const kind = classifyCodexFailure(error); if (kind !== "transient") return failRun(threadId, run, error);
  const retry = nextCodexRetry(run.serviceFailures); if (!retry) return failRun(threadId, run, `${publicFailure(error)}；已达到 3 次自动重试上限`);
  run.serviceFailures = retry.attempt; run.turnId = undefined; const nextAttemptAt = new Date(Date.now() + retry.delayMs).toISOString(); const summary = `AI 服务暂时中断；第 ${retry.attempt}/3 次重试将在 ${Math.round(retry.delayMs / 1000)} 秒后进行`;
  store.setAiTaskRetry(run.taskId, retry.attempt, nextAttemptAt, publicFailure(error)); updateTurn(run, "starting", summary, publicFailure(error)); tasks.update(run.taskId, "waiting", summary, "planner:waiting");
  const timer = setTimeout(() => { retryTimers.delete(run.taskId); if (active.get(threadId) !== run) return; void retryPlannerRun(threadId, run).catch((failure) => { const activeThreadId = [...active.entries()].find(([, candidate]) => candidate === run)?.[0] ?? threadId; queueServiceRetry(activeThreadId, run, failure); }); }, retry.delayMs); timer.unref(); retryTimers.set(run.taskId, timer);
}

async function completePlannerRun(threadId: string, status: string, reportedError?: string) {
  const candidate = active.get(threadId); if (!candidate || candidate.kind !== "planner") return; const run = candidate;
  if (run.stopRequested) { removeRun(threadId, run); updateTurn(run, "interrupted", "已停止"); tasks.update(run.taskId, "stopped", "已停止旅行规划", "planner:stopped"); return; }
  if (status !== "completed") return queueServiceRetry(threadId, run, reportedError || run.failureMessage || "Planner turn 未完成。");
  try {
    const applied = applyPlannerOutput(store, run.tripId, JSON.parse(run.content));
    store.createAssistantMessage(run.tripId, applied.output.assistantMessage, applied.output);
    removeRun(threadId, run); updateTurn(run, "completed", applied.startDetailing ? "已确认，正在开始细化" : applied.saved ? "行程已更新" : "回复已完成"); tasks.update(run.taskId, "completed", applied.startDetailing ? "已确认开始细化方案" : applied.saved ? "已保存 canonical itinerary" : "已完成回复", "planner:completed");
    broadcast("travel.trip.updated", { tripId: run.tripId });
    if (applied.saved) syncMap(run.tripId, applied.trip.contentGeneration, applied.changedDayIds);
    if (applied.startDetailing) void startDetailWorkflow(run.tripId).catch((error) => console.warn("[Detail]", publicFailure(error)));
  } catch (error) {
    if (message(error) === "CONTENT_GENERATION_SUPERSEDED") { removeRun(threadId, run); updateTurn(run, "interrupted", "结果已被更新版本取代", "CONTENT_GENERATION_SUPERSEDED"); tasks.update(run.taskId, "cancelled_by_generation", "结果已被更新版本取代", "planner:superseded"); return; }
    if (run.contractAttempt >= 1) return failRun(threadId, run, `Planner 合同修正仍未通过：${publicFailure(error)}`);
    run.contractAttempt += 1; tasks.update(run.taskId, "running", "正在用同一 Planner 合同定向修正输出", "planner:contract-retry"); updateTurn(run, "starting", "Planner 输出存在合同问题，正在修正");
    void startPlannerAttempt(threadId, run, { invalidOutput: run.content || "{}", validationError: message(error) }).catch((failure) => queueServiceRetry(threadId, run, failure));
  }
}

async function startTravelTurn(tripId: string, text: string) {
  const trip = store.requireTrip(tripId); if (trip.state !== "active") throw new Error("回收站中的旅行不能继续对话。"); if (!text.trim() || text.length > 4000) throw new Error("消息长度应为 1–4000 个字符。");
  if ([...active.values()].some((run) => run.tripId === tripId)) throw new Error("这趟旅行仍在处理中。请先停止当前任务。");
  const messageId = store.createUserMessage(tripId, text.trim()); const taskId = `planner:${messageId}`; const run: PlannerRun = { kind: "planner", taskId, tripId, messageId, userMessage: text.trim(), content: "", contractAttempt: 0, serviceFailures: 0, stopRequested: false, attemptToken: 0, settledTurnIds: [] };
  tasks.start({ id: taskId, tripId, agent: "planner", label: "旅行规划", summary: "请求已提交" }); updateTurn(run, "queued", "请求已提交");
  try { const threadId = await ensurePlannerThread(tripId); active.set(threadId, run); await startPlannerAttempt(threadId, run); return { messageId, trip: store.requireTrip(tripId) }; }
  catch (error) { const threadId = [...active.entries()].find(([, item]) => item === run)?.[0]; if (threadId) queueServiceRetry(threadId, run, error); else { const fallbackThread = store.requireTrip(tripId).codexThreadId || `planner:${messageId}`; active.set(fallbackThread, run); queueServiceRetry(fallbackThread, run, error); } return { messageId, trip: store.requireTrip(tripId), waiting: true }; }
}

function detailMetadata(run: DetailRun, currentBatchId: string | null = run.batch.batchId) {
  return { baselineGeneration: run.baselineGeneration, allDayIds: run.allDayIds, completedDayIds: run.completedDayIds, currentBatchId };
}

function initialDetailInput(tripId: string, batch: DetailBatchRequest) {
  const trip = store.requireTrip(tripId);
  return JSON.stringify({ contract: "detail-batch-output:v1", canonicalItinerary: trip.itinerary, batch, contentGeneration: trip.contentGeneration, responseSchema: DetailBatchOutputJsonSchema }, null, 2);
}

function continuedDetailInput(feedback: DetailCanonicalFeedback, batch: DetailBatchRequest) {
  return JSON.stringify({ contract: "detail-batch-output:v1", previousCanonicalFeedback: feedback, nextBatch: batch, contentGeneration: feedback.currentGeneration, responseSchema: DetailBatchOutputJsonSchema }, null, 2);
}

function failDetailRun(threadId: string, run: DetailRun, error: unknown) {
  removeRun(threadId, run); const detail = publicFailure(error); store.setAiTaskRetry(run.taskId, run.serviceFailures, null, detail); tasks.update(run.taskId, "failed", `行程细化失败：${detail}`, "detail:failed");
}

async function startDetailAttempt(threadId: string, run: DetailRun, repair?: { invalidOutput: string; validationError: string }) {
  const repairText = repair ? `\n\n上一份输出未通过合同。只用同一 01 合同修正当前批次，不得建立 repair 流程。\n${JSON.stringify(repair)}` : "";
  const attemptToken = ++run.attemptToken; run.turnId = undefined; run.content = ""; run.failureMessage = undefined;
  const result = await codex.call("turn/start", structuredTurn({ threadId, input: [{ type: "text", text: `${prompts.detailer.content}\n\n本批受控状态：\n${run.batchInput}${repairText}`, text_elements: [] }], outputSchema: DetailBatchOutputJsonSchema, ...modelOptions() }), 120000);
  const turnId = String(result?.turn?.id || "");
  if (active.get(threadId) !== run || run.stopRequested || run.attemptToken !== attemptToken) { if (turnId && !run.settledTurnIds.includes(turnId)) void codex.call("turn/interrupt", { threadId, turnId }).catch(() => undefined); return; }
  run.turnId = turnId;
  tasks.update(run.taskId, "running", repair ? "正在按合同修正当前两日批次" : `正在细化 ${run.batch.dayIds.length} 天`, repair ? "detail:contract-retry" : "detail:batch-started");
}

async function launchDetailThread(activeKey: string, run: DetailRun) {
  await ensureCodex();
  const started = await codex.call("thread/start", { cwd: root, developerInstructions: agentInstructions, threadSource: "ai-travel-planner-detail", ephemeral: false, config: agentConfig, sandbox: "read-only", approvalPolicy: "never", environments: [], ...modelOptions() });
  const threadId = String(started?.thread?.id || ""); if (!threadId) throw new Error("Codex 没有返回行程细化线程。");
  if (active.get(activeKey) !== run || run.stopRequested) return;
  active.delete(activeKey); run.threadId = threadId; active.set(threadId, run);
  await startDetailAttempt(threadId, run);
}

async function retryDetailRun(activeKey: string, run: DetailRun) {
  if (!run.threadId) return launchDetailThread(activeKey, run);
  await ensureCodex();
  await codex.call("thread/resume", { threadId: run.threadId, cwd: root, developerInstructions: agentInstructions, config: agentConfig, sandbox: "read-only", approvalPolicy: "never", ...modelOptions() });
  await startDetailAttempt(run.threadId, run);
}

function queueDetailServiceRetry(activeKey: string, run: DetailRun, error: unknown) {
  const kind = classifyCodexFailure(error); if (kind !== "transient") return failDetailRun(activeKey, run, error);
  const retry = nextCodexRetry(run.serviceFailures); if (!retry) return failDetailRun(activeKey, run, `${publicFailure(error)}；已达到 3 次自动重试上限`);
  run.serviceFailures = retry.attempt; run.turnId = undefined; const nextAttemptAt = new Date(Date.now() + retry.delayMs).toISOString(); const summary = `细化服务暂时中断；第 ${retry.attempt}/3 次重试将在 ${Math.round(retry.delayMs / 1000)} 秒后进行`;
  store.setAiTaskRetry(run.taskId, retry.attempt, nextAttemptAt, publicFailure(error)); tasks.update(run.taskId, "waiting", summary, "detail:waiting");
  const timer = setTimeout(() => {
    retryTimers.delete(run.taskId); const currentKey = [...active.entries()].find(([, candidate]) => candidate === run)?.[0]; if (!currentKey || run.stopRequested) return;
    void retryDetailRun(currentKey, run).catch((failure) => { const latestKey = [...active.entries()].find(([, candidate]) => candidate === run)?.[0] ?? currentKey; queueDetailServiceRetry(latestKey, run, failure); });
  }, retry.delayMs);
  timer.unref(); retryTimers.set(run.taskId, timer);
}

async function completeDetailRun(threadId: string, status: string, reportedError?: string) {
  const candidate = active.get(threadId); if (!candidate || candidate.kind !== "detailer") return; const run = candidate;
  if (run.stopRequested) { removeRun(threadId, run); tasks.metadata(run.taskId, detailMetadata(run)); tasks.update(run.taskId, "stopped", `已停止；保留已完成的 ${run.completedDayIds.length}/${run.allDayIds.length} 天`, "detail:stopped"); return; }
  if (status !== "completed") return queueDetailServiceRetry(threadId, run, reportedError || run.failureMessage || "细化 turn 未完成。");
  try {
    const applied = applyDetailBatch(store, run.tripId, run.batch, JSON.parse(run.content), { forbiddenTemporaryIds: run.usedTemporaryIds });
    run.usedTemporaryIds.push(...Object.keys(applied.feedback.idMappings));
    run.completedDayIds = applied.completedDayIds; run.contractAttempt = 0; run.serviceFailures = 0; clearRetry(run.taskId);
    broadcast("travel.trip.updated", { tripId: run.tripId });
    syncMap(run.tripId, applied.trip.contentGeneration, applied.changedDayIds);
    if (applied.allDetailed) {
      tasks.metadata(run.taskId, detailMetadata(run, null)); removeRun(threadId, run); tasks.update(run.taskId, "completed", `已完成 ${run.completedDayIds.length}/${run.allDayIds.length} 天细化`, "detail:completed"); return;
    }
    const batch = nextDetailBatch(applied.trip.itinerary); if (!batch) throw new Error("细化尚未完成，但找不到下一批 Day。");
    run.batch = batch; run.batchInput = continuedDetailInput(applied.feedback, batch); run.turnId = undefined; run.content = "";
    tasks.metadata(run.taskId, detailMetadata(run)); tasks.update(run.taskId, "running", `已完成 ${run.completedDayIds.length}/${run.allDayIds.length} 天，继续下一批`, "detail:batch-completed");
    void startDetailAttempt(threadId, run).catch((error) => queueDetailServiceRetry(threadId, run, error));
  } catch (error) {
    if (message(error) === "CONTENT_GENERATION_SUPERSEDED") { removeRun(threadId, run); tasks.update(run.taskId, "cancelled_by_generation", "细化结果已被更新版本取代；已完成批次保持不变", "detail:superseded"); return; }
    if (run.contractAttempt >= 1) return failDetailRun(threadId, run, `01 合同修正仍未通过：${publicFailure(error)}`);
    run.contractAttempt += 1; tasks.update(run.taskId, "running", "正在用同一 01 合同定向修正当前批次", "detail:contract-retry");
    void startDetailAttempt(threadId, run, { invalidOutput: run.content || "{}", validationError: message(error) }).catch((failure) => queueDetailServiceRetry(threadId, run, failure));
  }
}

async function startDetailWorkflow(tripId: string) {
  if ([...active.values()].some((run) => run.tripId === tripId)) throw new Error("这趟旅行仍有 itinerary 写任务在运行。");
  const trip = store.requireTrip(tripId); if (trip.state !== "active" || trip.itinerary.stage === "planning") throw new Error("只能细化已有行程。");
  const taskId = `detail:${randomUUID()}`; const allDayIds = trip.itinerary.days.map((day) => day.id); const completedDayIds = trip.itinerary.days.filter((day) => day.detailLevel === "detailed").map((day) => day.id);
  const batch = nextDetailBatch(trip.itinerary);
  if (!batch) {
    tasks.start({ id: taskId, tripId, agent: "detailer", label: "行程细化", summary: "正在完成细化", metadata: { baselineGeneration: trip.contentGeneration, allDayIds, completedDayIds, currentBatchId: null } });
    const completed = finalizeDetailedItinerary(store, tripId); tasks.update(taskId, "completed", `已完成 ${completed.itinerary.days.length}/${completed.itinerary.days.length} 天细化`, "detail:completed"); broadcast("travel.trip.updated", { tripId }); syncMap(tripId, completed.contentGeneration, []); return;
  }
  const run: DetailRun = { kind: "detailer", taskId, tripId, batch, batchInput: initialDetailInput(tripId, batch), baselineGeneration: trip.contentGeneration, allDayIds, completedDayIds, usedTemporaryIds: [], content: "", contractAttempt: 0, serviceFailures: 0, stopRequested: false, attemptToken: 0, settledTurnIds: [] };
  tasks.start({ id: taskId, tripId, agent: "detailer", label: "行程细化", summary: `准备细化 ${allDayIds.length - completedDayIds.length} 天`, metadata: detailMetadata(run) });
  const pendingKey = `detail-pending:${taskId}`; active.set(pendingKey, run);
  try { await launchDetailThread(pendingKey, run); }
  catch (error) { const activeKey = [...active.entries()].find(([, candidate]) => candidate === run)?.[0] ?? pendingKey; if (!active.has(activeKey)) active.set(activeKey, run); queueDetailServiceRetry(activeKey, run, error); }
}

codex.on("notification", (event: RpcEnvelope) => {
  const params = event.params as Record<string, any> | undefined; const threadId = String(params?.threadId || ""); const run = active.get(threadId);
  if (event.method === "account/login/completed") for (const state of loginStates.values()) if (state.phase === "pending") state.phase = "succeeded";
  const candidate = candidateRuns.get(threadId);
  if (candidate) {
    if (event.method === "turn/started") candidate.turnId = String(params?.turn?.id || params?.turnId || candidate.turnId || "");
    if (event.method === "item/agentMessage/delta") candidate.content += String(params?.delta || "");
    if (event.method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string") candidate.content = params.item.text;
    if (event.method === "turn/completed") {
      candidateRuns.delete(threadId); clearTimeout(candidate.timer);
      try { candidate.settle(CandidateDecisionOutputSchema.parse(JSON.parse(candidate.content))); } catch { candidate.settle(null); }
    }
    return;
  }
  if (run && event.method === "turn/started") {
    run.turnId = String(params?.turn?.id || params?.turnId || run.turnId || "");
    const summary = run.kind === "planner" ? "正在生成旅行规划" : `正在细化 ${run.batch.dayIds.length} 天`;
    tasks.update(run.taskId, "running", summary, "turn:started"); if (run.kind === "planner") updateTurn(run, "active", summary);
  }
  if (run && (event.method === "item/reasoning/summaryTextDelta" || event.method === "item/plan/delta")) {
    const snapshot = tasks.append(run.taskId, `progress:${params?.itemId || "current"}`, params?.delta); if (run.kind === "planner" && snapshot?.summary) updateTurn(run, "active", snapshot.summary.slice(0, 220));
  }
  if (run && event.method === "item/agentMessage/delta") run.content += String(params?.delta || "");
  if (run && event.method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string") run.content = params.item.text;
  if (run && (event.method === "error" || event.method === "turn/error")) run.failureMessage = String(params?.error?.message || params?.message || "").trim();
  if (run && event.method === "turn/completed" && threadId) {
    const completedTurnId = String(params?.turn?.id || params?.turnId || "");
    if (completedTurnId && run.settledTurnIds.includes(completedTurnId)) return;
    if (completedTurnId) { run.settledTurnIds.push(completedTurnId); if (run.settledTurnIds.length > 8) run.settledTurnIds.shift(); }
    if (completedTurnId && run.turnId && completedTurnId !== run.turnId) return;
    const status = String(params?.turn?.status || "completed"); const error = String(params?.turn?.error?.message || params?.error?.message || "").trim();
    if (run.kind === "planner") void completePlannerRun(threadId, status, error); else void completeDetailRun(threadId, status, error);
  }
});
codex.on("serverRequest", (event: RpcEnvelope) => { if (event.id !== undefined) codex.respond(event.id, { decision: "decline" }); });

async function api(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`); const method = request.method || "GET";
  if (method === "GET" && url.pathname === "/api/bootstrap") { const signedIn = authenticated(request); return json(response, 200, { authenticated: signedIn, configured: Boolean(config.passwordHash), setupAllowed: !config.passwordHash && hostClient(request), hostClient: hostClient(request), lanEnabled: Boolean(config.passwordHash), port: config.port, codex: { connected: codex.running }, settings: { ai: config.ai, ui: config.ui }, user: signedIn ? { id: "owner", username: config.username || "旅行者" } : null }); }
  if (method === "POST" && url.pathname === "/api/auth/setup") { if (config.passwordHash || !hostClient(request)) return failure(response, 403, "只能在首次本机访问时设置旅行空间。"); const input = await body(request); const username = String(input.username || "").trim(); if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) return failure(response, 400, "用户名应为 3–32 位字母、数字、下划线或连字符。"); const password = await hashPassword(String(input.password || "")); await mutateConfig((current) => ({ ...current, ...password, sessionKey: createSessionKey(), username })); const token = sessions.create(); response.setHeader("set-cookie", sessionCookie(token)); json(response, 200, { user: { id: "owner", username } }); void rebindForLan(); return; }
  if (method === "POST" && url.pathname === "/api/auth/login") { const key = request.socket.remoteAddress || "unknown"; const allowed = limiter.canAttempt(key); if (!allowed.allowed) return failure(response, 429, `尝试过多，请在 ${allowed.retryAfterSeconds} 秒后重试。`); const input = await body(request); if (String(input.username || "") !== config.username || !(await verifyPassword(String(input.password || ""), config))) { limiter.failure(key); return failure(response, 401, "用户名或密码错误。"); } limiter.success(key); const token = sessions.create(); response.setHeader("set-cookie", sessionCookie(token)); return json(response, 200, { user: { id: "owner", username: config.username } }); }
  if (method === "POST" && url.pathname === "/api/auth/logout") { sessions.delete(cookies(request).travel_session); response.setHeader("set-cookie", sessionCookie("", true)); return json(response, 200, { ok: true }); }
  if (!authenticated(request)) return failure(response, 401, "请先登录旅行空间。", "auth_required");
  const tile = /^\/api\/map\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname); if (method === "GET" && tile) { try { const result = await tiles.getTile(Number(tile[1]), Number(tile[2]), Number(tile[3]), request.headers.referer); response.writeHead(200, { "content-type": result.contentType, "content-length": String(result.content.length), "cache-control": "private, max-age=0, must-revalidate", "x-map-tile-cache": result.cacheStatus }); response.end(result.content); } catch (error) { failure(response, error instanceof TileFetchError ? error.status : 500, message(error)); } return; }
  if (method === "PUT" && url.pathname === "/api/auth/password") { const input = await body(request); if (typeof input.newPassword !== "string") return failure(response, 400, "新密码必须是字符串。"); const password = await hashPassword(input.newPassword); await mutateConfig((current) => ({ ...current, ...password, ...(current.sessionKey ? {} : { sessionKey: current.passwordHash }) })); return json(response, 200, { ok: true }); }
  if (method === "GET" && url.pathname === "/api/codex/status") { try { await ensureCodex(); const account = await codex.call("account/read", { refreshToken: false }); return json(response, 200, { signedIn: Boolean(account?.account), account: account?.account || null, models: await modelList() }); } catch (error) { return json(response, 200, { signedIn: false, account: null, models: [], error: publicFailure(error) }); } }
  if (method === "POST" && url.pathname === "/api/codex/login/browser") { await ensureCodex(); const result = await codex.call("account/login/start", { method: "browser" }); const loginId = String(result?.loginId || result?.login_id || ""); if (loginId) loginStates.set(loginId, { method: "browser", phase: "pending" }); return json(response, 200, { loginId, authUrl: result?.authUrl || result?.auth_url }); }
  if (method === "POST" && url.pathname === "/api/codex/login/device") { await ensureCodex(); const result = await codex.call("account/login/start", { method: "device" }); const loginId = String(result?.loginId || result?.login_id || ""); if (loginId) loginStates.set(loginId, { method: "device", phase: "pending" }); return json(response, 200, { loginId, verificationUrl: result?.verificationUrl || result?.verification_url, userCode: result?.userCode || result?.user_code }); }
  if (method === "GET" && url.pathname === "/api/codex/login/status") { const state = loginStates.get(String(url.searchParams.get("loginId") || "")); return json(response, 200, state ? { loginId: url.searchParams.get("loginId"), ...state } : { phase: "cancelled", message: "登录已结束。" }); }
  if (method === "POST" && url.pathname === "/api/codex/logout") { await ensureCodex(); await codex.call("account/logout"); return json(response, 200, { ok: true }); }
  if (method === "PUT" && url.pathname === "/api/settings/ui") { const input = await body(request); const colors = input.mapCategoryColors; if (colors !== undefined && (!colors || typeof colors !== "object" || Array.isArray(colors) || Object.entries(colors).some(([key, value]) => !(key in mapCategoryColorDefaults) || typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)))) return failure(response, 400, "地图分类颜色必须是已知类别的 #RRGGBB 值。"); const next = await mutateConfig((current) => ({ ...current, ui: { ...current.ui, ...(typeof input.workspaceSplitRatio === "number" ? { workspaceSplitRatio: Math.max(.34, Math.min(.66, input.workspaceSplitRatio)) } : {}), ...(input.theme === "light" || input.theme === "dark" ? { theme: input.theme } : {}), ...(typeof input.sidebarOpen === "boolean" ? { sidebarOpen: input.sidebarOpen } : {}), ...(colors ? { mapCategoryColors: { ...current.ui.mapCategoryColors, ...colors } } : {}) } })); return json(response, 200, { settings: { ai: next.ai, ui: next.ui } }); }
  if (method === "PUT" && url.pathname === "/api/settings/ai-model") { const input = await body(request); const next = await mutateConfig((current) => ({ ...current, ai: { model: String(input.model || "").slice(0, 120), reasoningEffort: String(input.reasoningEffort || "medium").slice(0, 32) } })); return json(response, 200, { settings: { ai: next.ai, ui: next.ui } }); }
  if (method === "GET" && url.pathname === "/api/trips") return json(response, 200, { trips: store.listTrips(url.searchParams.get("view") === "trash" ? "trashed" : "active") });
  if (method === "POST" && url.pathname === "/api/trips") return json(response, 200, { trip: store.createTrip() });
  const tripMatch = /^\/api\/trips\/([^/]+)$/.exec(url.pathname); if (tripMatch) { const id = decodeURIComponent(tripMatch[1]); if (method === "GET") return json(response, 200, { trip: store.requireTrip(id) }); if (method === "PATCH") { const input = await body(request); let trip = store.requireTrip(id); if (input.title !== undefined) trip = store.rename(id, String(input.title)); if (input.itineraryLanguage !== undefined) { if (input.itineraryLanguage !== "zh" && input.itineraryLanguage !== "en" && input.itineraryLanguage !== "bilingual") return failure(response, 400, "日程地点语言必须是中文、英文或中英对照。"); trip = store.setItineraryLanguage(id, input.itineraryLanguage); } return json(response, 200, { trip }); } if (method === "DELETE") { store.setState(id, "trashed"); return json(response, 200, { ok: true }); } }
  const duplicate = /^\/api\/trips\/([^/]+)\/duplicate$/.exec(url.pathname); if (method === "POST" && duplicate) { const trip = store.duplicate(decodeURIComponent(duplicate[1])); if (trip.itinerary.days.length) syncMap(trip.id, trip.contentGeneration, trip.itinerary.days.map((day) => day.id)); return json(response, 200, { trip }); }
  const restore = /^\/api\/trips\/([^/]+)\/restore$/.exec(url.pathname); if (method === "POST" && restore) return json(response, 200, { trip: store.setState(decodeURIComponent(restore[1]), "active") });
  const permanent = /^\/api\/trips\/([^/]+)\/permanent$/.exec(url.pathname); if (method === "DELETE" && permanent) { store.permanentDelete(decodeURIComponent(permanent[1])); return json(response, 200, { ok: true }); }
  const messages = /^\/api\/trips\/([^/]+)\/messages$/.exec(url.pathname); if (method === "GET" && messages) return json(response, 200, { messages: store.listMessages(decodeURIComponent(messages[1])) });
  const turnStart = /^\/api\/trips\/([^/]+)\/turns$/.exec(url.pathname); if (method === "POST" && turnStart) { const input = await body(request); return json(response, 200, await startTravelTurn(decodeURIComponent(turnStart[1]), String(input.message || ""))); }
  const turnStatus = /^\/api\/trips\/([^/]+)\/turns\/([^/]+)\/status$/.exec(url.pathname); if (method === "GET" && turnStatus) { const row = store.listMessages(decodeURIComponent(turnStatus[1])).find((item) => item.id === decodeURIComponent(turnStatus[2])); if (!row?.turn) return failure(response, 404, "找不到运行状态。"); return json(response, 200, { turn: row.turn }); }
  const interrupt = /^\/api\/trips\/([^/]+)\/turns\/interrupt$/.exec(url.pathname); if (method === "POST" && interrupt) { const input = await body(request); const tripId = decodeURIComponent(interrupt[1]); const messageId = typeof input.messageId === "string" ? input.messageId : ""; const entry = [...active.entries()].find(([, run]) => run.kind === "planner" && run.tripId === tripId && run.messageId === messageId) as [string, PlannerRun] | undefined; if (!entry) return failure(response, 404, "当前没有正在运行的任务。"); const [threadId, run] = entry; run.stopRequested = true; updateTurn(run, "active", "正在停止…"); if (run.turnId) await codex.call("turn/interrupt", { threadId, turnId: run.turnId }); else { removeRun(threadId, run); updateTurn(run, "interrupted", "已停止等待服务恢复"); tasks.update(run.taskId, "stopped", "已停止等待服务恢复", "planner:stopped"); } return json(response, 200, { ok: true }); }
  const revisions = /^\/api\/trips\/([^/]+)\/revisions$/.exec(url.pathname); if (method === "GET" && revisions) return json(response, 200, { revisions: store.listRevisions(decodeURIComponent(revisions[1])) });
  const revision = /^\/api\/trips\/([^/]+)\/revisions\/(\d+)$/.exec(url.pathname); if (method === "GET" && revision) return json(response, 200, { revision: store.getRevision(decodeURIComponent(revision[1]), Number(revision[2])) });
  const revisionRestore = /^\/api\/trips\/([^/]+)\/revisions\/(\d+)\/restore$/.exec(url.pathname); if (method === "POST" && revisionRestore) { const tripId = decodeURIComponent(revisionRestore[1]); const restored = store.restoreRevision(tripId, Number(revisionRestore[2])); broadcast("travel.trip.updated", { tripId }); syncMap(tripId, restored.generation, restored.trip.itinerary.days.map((day) => day.id)); return json(response, 200, restored); }
  const aiTasks = /^\/api\/trips\/([^/]+)\/ai-tasks$/.exec(url.pathname); if (method === "GET" && aiTasks) return json(response, 200, { tasks: tasks.list(decodeURIComponent(aiTasks[1])) });
  const stopTask = /^\/api\/trips\/([^/]+)\/ai-tasks\/([^/]+)\/stop$/.exec(url.pathname); if (method === "POST" && stopTask) { const tripId = decodeURIComponent(stopTask[1]); const taskId = decodeURIComponent(stopTask[2]); const entry = [...active.entries()].find(([, run]) => run.tripId === tripId && run.taskId === taskId); if (!entry) return failure(response, 404, "当前任务已经结束。"); const [threadId, run] = entry; run.stopRequested = true; if (run.kind === "planner") updateTurn(run, "active", "正在停止…"); if (run.turnId) await codex.call("turn/interrupt", { threadId, turnId: run.turnId }); else { removeRun(threadId, run); if (run.kind === "planner") updateTurn(run, "interrupted", "已停止等待服务恢复"); tasks.update(taskId, "stopped", run.kind === "detailer" ? `已停止；保留已完成的 ${run.completedDayIds.length}/${run.allDayIds.length} 天` : "已停止等待服务恢复", `${run.kind}:stopped`); } return json(response, 200, { ok: true }); }
  const map = /^\/api\/trips\/([^/]+)\/map$/.exec(url.pathname); if (method === "GET" && map) return json(response, 200, { map: store.getMapState(decodeURIComponent(map[1])) });
  return failure(response, 404, "接口不存在。");
}

async function serve(request: IncomingMessage, response: ServerResponse) { const pathname = new URL(request.url || "/", "http://local").pathname; const file = pathname === "/" ? path.join(root, "dist", "web", "index.html") : path.join(root, "dist", "web", pathname); const resolved = path.resolve(file); const staticRoot = path.resolve(root, "dist", "web"); if (!resolved.startsWith(staticRoot)) return failure(response, 403, "无效路径。"); try { const info = await fs.stat(resolved); if (info.isFile()) { response.writeHead(200); createReadStream(resolved).pipe(response); return; } } catch { /* SPA fallback below */ } try { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); createReadStream(path.join(staticRoot, "index.html")).pipe(response); } catch { response.writeHead(503); response.end("请使用 npm run dev 启动开发界面。"); } }
const viteDev = process.env.TRAVEL_DEV === "1" ? await (async () => { const { createServer } = await import("vite"); return createServer({ configFile: path.join(root, "vite.config.ts"), server: { middlewareMode: true, hmr: false }, appType: "spa" }); })() : null;
const server = http.createServer((request, response) => { void (async () => { try { if ((request.url || "").startsWith("/api/")) await api(request, response); else if (viteDev) viteDev.middlewares(request, response, () => { void serve(request, response); }); else await serve(request, response); } catch (error) { if (!response.headersSent) failure(response, 400, message(error)); else response.end(); } })(); });
const ws = new WebSocketServer({ noServer: true }); server.on("upgrade", (request, socket, head) => { if (new URL(request.url || "/", "http://local").pathname !== "/ws" || !authenticated(request)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; } ws.handleUpgrade(request, socket, head, (client) => { clients.add(client); client.on("close", () => clients.delete(client)); }); });
let listenHost = config.passwordHash ? "0.0.0.0" : "127.0.0.1";
function listen(host: string) { listenHost = host; server.listen(config.port, host, () => console.log(`AI Travel Planner 已启动：http://127.0.0.1:${config.port}`)); }
async function rebindForLan() { if (listenHost === "0.0.0.0") return; await new Promise<void>((resolve) => server.close(() => resolve())); listen("0.0.0.0"); }
listen(listenHost);
void codex.start().catch((error) => console.warn("[Codex]", message(error)));
process.on("SIGINT", () => { void codex.stop().finally(async () => { await viteDev?.close(); tiles.close(); maps.close(); store.close(); server.close(() => process.exit(0)); }); });
