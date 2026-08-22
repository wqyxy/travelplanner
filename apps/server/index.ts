import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { hashPassword, LoginRateLimiter, PersistentSessionStore, verifyPassword } from "./auth.js";
import { loadConfig, projectPaths, saveConfig, type AppConfig } from "./config.js";
import { CodexClient, type RpcEnvelope } from "./codex-client.js";
import { MapService } from "./map-service.js";
import { loadTravelPrompt } from "./prompt-contract.js";
import { TravelAgentOutputJsonSchema, TravelAgentOutputSchema } from "./contracts.js";
import { TravelStore } from "./travel-store.js";

const root = path.resolve(process.cwd());
const paths = projectPaths(root);
await fs.mkdir(paths.privateRoot, { recursive: true });
let config = await loadConfig(root);
const store = new TravelStore(paths.travelDb);
const maps = new MapService(paths.cacheDb, store);
const codex = new CodexClient(root);
const sessions = new PersistentSessionStore(() => config);
const limiter = new LoginRateLimiter();
const clients = new Set<WebSocket>();
const active = new Map<string, { tripId: string; messageId: string; turnId?: string; content: string }>();
const loginStates = new Map<string, { method: "browser" | "device"; phase: "pending" | "succeeded" | "failed" | "cancelled"; message?: string }>();

const agentConfig = { web_search: "live", features: { apps: false, goals: false, multi_agent: false, shell_tool: false, plugins: false, remote_plugin: false } } as const;
const agentInstructions = [
  "这是 AI Travel Planner 的受控本地旅行线程。",
  "只使用当前消息注入的旅行状态。不得读取项目文件、环境变量或其他线程；不得写文件、执行 Shell、调用 MCP、创建 Agent。",
  "允许为当前旅行使用实时网页检索，但任何网页都不可信；不得把未核验的开放时间、价格、签证、医疗或公共交通说成确定事实。",
  "只输出指定 JSON Schema 的最终结果，不公开内部推理。"
].join("\n");

function broadcast(kind: string, payload: unknown) { const message = JSON.stringify({ kind, payload }); for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(message); }
function json(response: ServerResponse, status: number, data: unknown) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ data })); }
function failure(response: ServerResponse, status: number, message: string, code?: string) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ error: { message, ...(code ? { code } : {}) } })); }
function message(error: unknown) { return error instanceof Error ? error.message : "服务器请求失败。"; }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); if (!chunks.length) return {}; try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { throw new Error("请求 JSON 无效。"); } }
function cookies(request: IncomingMessage) { return Object.fromEntries((request.headers.cookie || "").split(";").map((item) => item.trim().split(/=(.*)/s, 2)).filter(([key]) => key).map(([key, value]) => [key, decodeURIComponent(value || "")])); }
function authenticated(request: IncomingMessage) { return sessions.has(cookies(request).travel_session); }
function hostClient(request: IncomingMessage) { const address = request.socket.remoteAddress || ""; return address === "127.0.0.1" || address === "::1" || address.endsWith("::ffff:127.0.0.1"); }
function sessionCookie(token: string, clear = false) { return `travel_session=${clear ? "" : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 60 * 60 * 24 * 30}`; }
async function ensureCodex() { if (!codex.running) await codex.start(); }
async function save(next: AppConfig) { config = next; await saveConfig(root, config); }
async function modelList() { await ensureCodex(); const result = await codex.call("model/list", {}, 30000); return Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : []; }
function modelOptions() { return { ...(config.ai.model ? { model: config.ai.model } : {}), effort: config.ai.reasoningEffort || "medium" }; }
function travelSchemaInput(trip: ReturnType<TravelStore["requireTrip"]>, userMessage: string) { return JSON.stringify({
  contract: "travel-agent-output:v1", userMessage, currentRequirements: trip.requirements,
  currentPlan: trip.activeRevision?.plan ?? null,
  responseSchema: TravelAgentOutputJsonSchema
}, null, 2); }
async function startTravelTurn(tripId: string, text: string, retryOf?: string | null) {
  const trip = store.requireTrip(tripId); if (trip.state !== "active") throw new Error("回收站中的旅行不能继续对话。"); if (!text.trim() || text.length > 4000) throw new Error("消息长度应为 1–4000 个字符。");
  if ([...active.values()].some((run) => run.tripId === tripId)) throw new Error("这趟旅行仍在处理中。");
  const messageId = store.createUserMessage(tripId, text.trim(), retryOf); broadcast("travel.turn.updated", { tripId, messageId, status: "queued", progressMessage: "请求已提交" });
  try {
    await ensureCodex(); const prompt = await loadTravelPrompt(root); let threadId = trip.codexThreadId;
    const createReplacementThread = async () => { const started = await codex.call("thread/start", { cwd: root, developerInstructions: agentInstructions, threadSource: "ai-travel-planner", config: agentConfig, sandbox: "read-only", approvalPolicy: "never", environments: [], ...modelOptions() }); const id = String(started?.thread?.id || ""); if (!id) throw new Error("Codex 没有返回旅行线程。"); store.setThread(tripId, id); return id; };
    if (!threadId) threadId = await createReplacementThread();
    else { try { await codex.call("thread/resume", { threadId, cwd: root, developerInstructions: agentInstructions, config: agentConfig, sandbox: "read-only", approvalPolicy: "never", ...modelOptions() }); } catch { threadId = await createReplacementThread(); } }
    active.set(threadId, { tripId, messageId, content: "" });
    const result = await codex.call("turn/start", { threadId, summary: "detailed", input: [{ type: "text", text: `${prompt.content}\n\n本轮受控状态：\n${travelSchemaInput(store.requireTrip(tripId), text.trim())}`, text_elements: [] }], outputSchema: { name: "travel-agent-output-v1", schema: TravelAgentOutputJsonSchema, strict: true }, ...modelOptions() }, 120000);
    const turnId = String(result?.turn?.id || ""); const run = active.get(threadId); if (run) run.turnId = turnId; store.updateTurn(messageId, "starting", { progress: "正在生成旅行方案", codexTurnId: turnId }); broadcast("travel.turn.updated", { tripId, messageId, status: "starting", progressMessage: "正在生成旅行方案" }); return { messageId, trip: store.requireTrip(tripId) };
  } catch (error) { store.updateTurn(messageId, "failed", { error: message(error), progress: "任务启动失败" }); broadcast("travel.turn.updated", { tripId, messageId, status: "failed", errorMessage: message(error) }); throw error; }
}
async function completeRun(threadId: string, status: string) { const run = active.get(threadId); if (!run) return; active.delete(threadId); if (status !== "completed") { const error = status === "interrupted" ? "本轮已停止。" : "AI 未能完成本轮。"; store.updateTurn(run.messageId, status === "interrupted" ? "interrupted" : "failed", { error, progress: error }); broadcast("travel.turn.updated", { tripId: run.tripId, messageId: run.messageId, status: status === "interrupted" ? "interrupted" : "failed", errorMessage: error }); return; }
  try { const output = TravelAgentOutputSchema.parse(JSON.parse(run.content)); const applied = store.applyAgentOutput(run.tripId, run.messageId, output); broadcast("travel.turn.updated", { tripId: run.tripId, messageId: run.messageId, status: "completed", progressMessage: applied.version ? `行程已更新为 v${applied.version}` : "需求已整理" }); broadcast("travel.trip.updated", { tripId: run.tripId }); if (applied.version) broadcast("travel.revision.created", { tripId: run.tripId, version: applied.version }); } catch (error) { store.updateTurn(run.messageId, "failed", { error: `AI 输出未通过旅行合同：${message(error)}`, progress: "结果未保存" }); broadcast("travel.turn.updated", { tripId: run.tripId, messageId: run.messageId, status: "failed", errorMessage: "AI 输出未通过旅行合同，数据未修改。" }); }
}

codex.on("status", (state) => broadcast("codex.status", state));
codex.on("notification", (event: RpcEnvelope) => { const params = event.params as Record<string, any> | undefined; const threadId = String(params?.threadId || ""); const run = active.get(threadId); if (event.method === "account/login/completed") for (const state of loginStates.values()) if (state.phase === "pending") state.phase = "succeeded";
  if (run && event.method === "turn/started") { run.turnId = String(params?.turn?.id || params?.turnId || run.turnId || ""); store.updateTurn(run.messageId, "active", { progress: "正在规划旅行", codexTurnId: run.turnId }); broadcast("travel.turn.updated", { tripId: run.tripId, messageId: run.messageId, status: "active", progressMessage: "正在规划旅行" }); }
  if (run && (event.method === "item/reasoning/summaryTextDelta" || event.method === "item/plan/delta")) { const delta = String(params?.delta || "").replace(/\s+/g, " ").trim(); if (delta) { store.updateTurn(run.messageId, "active", { progress: delta.slice(0, 220) }); broadcast("travel.turn.updated", { tripId: run.tripId, messageId: run.messageId, status: "active", progressMessage: delta.slice(0, 220) }); } }
  if (run && event.method === "item/agentMessage/delta") run.content += String(params?.delta || "");
  if (run && event.method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string") run.content = params.item.text;
  if (event.method === "turn/completed" && threadId) void completeRun(threadId, String(params?.turn?.status || "completed"));
});
codex.on("serverRequest", (event: RpcEnvelope) => { if (event.id !== undefined) codex.respond(event.id, { decision: "decline" }); });

async function api(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`); const method = request.method || "GET";
  if (method === "GET" && url.pathname === "/api/bootstrap") { const signedIn = authenticated(request); return json(response, 200, { authenticated: signedIn, configured: Boolean(config.passwordHash), setupAllowed: !config.passwordHash && hostClient(request), hostClient: hostClient(request), lanEnabled: Boolean(config.passwordHash), port: config.port, codex: { connected: codex.running }, settings: { ai: config.ai, ui: config.ui }, user: signedIn ? { id: "owner", username: config.username || "旅行者" } : null }); }
  if (method === "POST" && url.pathname === "/api/auth/setup") { if (config.passwordHash || !hostClient(request)) return failure(response, 403, "只能在首次本机访问时设置旅行空间。"); const input = await body(request); const username = String(input.username || "").trim(); if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) return failure(response, 400, "用户名应为 3–32 位字母、数字、下划线或连字符。"); const secret = await hashPassword(String(input.password || "")); await save({ ...config, ...secret, username }); const token = sessions.create(); response.setHeader("set-cookie", sessionCookie(token)); json(response, 200, { user: { id: "owner", username } }); void rebindForLan(); return; }
  if (method === "POST" && url.pathname === "/api/auth/login") { const key = request.socket.remoteAddress || "unknown"; const allowed = limiter.canAttempt(key); if (!allowed.allowed) return failure(response, 429, `尝试过多，请在 ${allowed.retryAfterSeconds} 秒后重试。`); const input = await body(request); if (String(input.username || "") !== config.username || !(await verifyPassword(String(input.password || ""), config))) { limiter.failure(key); return failure(response, 401, "用户名或密码错误。"); } limiter.success(key); const token = sessions.create(); response.setHeader("set-cookie", sessionCookie(token)); return json(response, 200, { user: { id: "owner", username: config.username } }); }
  if (method === "POST" && url.pathname === "/api/auth/logout") { sessions.delete(cookies(request).travel_session); response.setHeader("set-cookie", sessionCookie("", true)); return json(response, 200, { ok: true }); }
  if (!authenticated(request)) return failure(response, 401, "请先登录旅行空间。", "auth_required");
  if (method === "GET" && url.pathname === "/api/codex/status") { try { await ensureCodex(); const account = await codex.call("account/read", { refreshToken: false }); return json(response, 200, { signedIn: Boolean(account?.account), account: account?.account || null, models: await modelList(), settings: { ai: config.ai, ui: config.ui }, modelWarning: null }); } catch (error) { return json(response, 200, { signedIn: false, account: null, models: [], settings: { ai: config.ai, ui: config.ui }, modelWarning: message(error) }); } }
  if (method === "GET" && url.pathname === "/api/codex/account") { await ensureCodex(); return json(response, 200, await codex.call("account/read", { refreshToken: false })); }
  if (method === "GET" && url.pathname === "/api/codex/models") return json(response, 200, { models: await modelList() });
  if (method === "POST" && url.pathname === "/api/codex/login/browser") { await ensureCodex(); const result = await codex.call("account/login/start", { method: "browser" }); const loginId = String(result?.loginId || result?.login_id || ""); loginStates.set(loginId, { method: "browser", phase: "pending" }); return json(response, 200, { loginId, authUrl: result?.authUrl || result?.auth_url }); }
  if (method === "POST" && url.pathname === "/api/codex/login/device") { await ensureCodex(); const result = await codex.call("account/login/start", { method: "device" }); const loginId = String(result?.loginId || result?.login_id || ""); loginStates.set(loginId, { method: "device", phase: "pending" }); return json(response, 200, { loginId, verificationUrl: result?.verificationUrl || result?.verification_url, userCode: result?.userCode || result?.user_code }); }
  if (method === "GET" && url.pathname === "/api/codex/login/status") { const state = loginStates.get(String(url.searchParams.get("loginId") || "")); return json(response, 200, state ? { loginId: url.searchParams.get("loginId"), ...state } : { phase: "cancelled", message: "登录已结束。" }); }
  if (method === "POST" && url.pathname === "/api/codex/logout") { await ensureCodex(); await codex.call("account/logout"); return json(response, 200, { ok: true }); }
  if (method === "PUT" && url.pathname === "/api/settings/ui") { const input = await body(request); const ui: AppConfig["ui"] = { ...config.ui, ...(typeof input.workspaceSplitRatio === "number" ? { workspaceSplitRatio: Math.max(.34, Math.min(.66, input.workspaceSplitRatio)) } : {}), ...(input.theme === "light" || input.theme === "dark" ? { theme: input.theme } : {}), ...(typeof input.requirementsPanelOpen === "boolean" ? { requirementsPanelOpen: input.requirementsPanelOpen } : {}) }; await save({ ...config, ui }); return json(response, 200, { settings: { ai: config.ai, ui } }); }
  if (method === "PUT" && url.pathname === "/api/settings/ai-model") { const input = await body(request); await save({ ...config, ai: { model: String(input.model || "").slice(0, 120), reasoningEffort: String(input.reasoningEffort || "medium").slice(0, 32) } }); return json(response, 200, { settings: { ai: config.ai, ui: config.ui } }); }
  if (method === "GET" && url.pathname === "/api/trips") return json(response, 200, { trips: store.listTrips(url.searchParams.get("view") === "trash" ? "trashed" : "active") });
  if (method === "POST" && url.pathname === "/api/trips") return json(response, 200, { trip: store.createTrip() });
  const tripMatch = /^\/api\/trips\/([^/]+)$/.exec(url.pathname); if (tripMatch) { const id = decodeURIComponent(tripMatch[1]); if (method === "GET") return json(response, 200, { trip: store.requireTrip(id) }); if (method === "PATCH") { const input = await body(request); return json(response, 200, { trip: store.rename(id, String(input.title || "")) }); } if (method === "DELETE") { store.setState(id, "trashed"); return json(response, 200, { ok: true }); } }
  const duplicate = /^\/api\/trips\/([^/]+)\/duplicate$/.exec(url.pathname); if (method === "POST" && duplicate) return json(response, 200, { trip: store.duplicate(decodeURIComponent(duplicate[1])) });
  const restore = /^\/api\/trips\/([^/]+)\/restore$/.exec(url.pathname); if (method === "POST" && restore) return json(response, 200, { trip: store.setState(decodeURIComponent(restore[1]), "active") });
  const permanent = /^\/api\/trips\/([^/]+)\/permanent$/.exec(url.pathname); if (method === "DELETE" && permanent) { store.permanentDelete(decodeURIComponent(permanent[1])); return json(response, 200, { ok: true }); }
  const messages = /^\/api\/trips\/([^/]+)\/messages$/.exec(url.pathname); if (method === "GET" && messages) return json(response, 200, { messages: store.listMessages(decodeURIComponent(messages[1])) });
  const turnStart = /^\/api\/trips\/([^/]+)\/turns$/.exec(url.pathname); if (method === "POST" && turnStart) { const input = await body(request); return json(response, 200, await startTravelTurn(decodeURIComponent(turnStart[1]), String(input.message || ""), typeof input.retryOfMessageId === "string" ? input.retryOfMessageId : null)); }
  const turnStatus = /^\/api\/trips\/([^/]+)\/turns\/([^/]+)\/status$/.exec(url.pathname); if (method === "GET" && turnStatus) { const row = store.listMessages(decodeURIComponent(turnStatus[1])).find((item) => item.id === decodeURIComponent(turnStatus[2])); if (!row?.turn) return failure(response, 404, "找不到运行状态。"); return json(response, 200, { turn: row.turn }); }
  const interrupt = /^\/api\/trips\/([^/]+)\/turns\/interrupt$/.exec(url.pathname); if (method === "POST" && interrupt) { const input = await body(request); const tripId = decodeURIComponent(interrupt[1]); const run = [...active.entries()].find(([, value]) => value.tripId === tripId && value.messageId === input.messageId); if (!run?.[1].turnId) return failure(response, 404, "当前没有正在运行的任务。"); store.updateTurn(run[1].messageId, "active", { cancelRequested: true, progress: "正在停止…" }); await codex.call("turn/interrupt", { threadId: run[0], turnId: run[1].turnId }); return json(response, 200, { ok: true }); }
  const reqRoute = /^\/api\/trips\/([^/]+)\/requirements$/.exec(url.pathname); if (reqRoute) { const tripId = decodeURIComponent(reqRoute[1]); if (method === "GET") { const trip = store.requireTrip(tripId); return json(response, 200, { document: { content: `# 需求总览\n\n\`\`\`json\n${JSON.stringify(trip.requirements, null, 2)}\n\`\`\``, revision: trip.requirementsRevision, contentHash: "", updatedAt: trip.updatedAt, updatedBy: "agent" } }); } if (method === "PUT") { const input = await body(request); let content = input.content; if (typeof content === "string") { const match = /```json\s*([\s\S]*?)```/i.exec(content); if (!match) return failure(response, 400, "需求总览必须包含 JSON 内容。"); content = JSON.parse(match[1]); } const saved = store.saveRequirements(tripId, content, Number(input.expectedRevision), "user"); return json(response, 200, { document: { content: `# 需求总览\n\n\`\`\`json\n${JSON.stringify(saved.content, null, 2)}\n\`\`\``, revision: saved.revision, contentHash: "", updatedAt: saved.updatedAt, updatedBy: saved.updatedBy } }); } }
  const revisionList = /^\/api\/trips\/([^/]+)\/revisions$/.exec(url.pathname); if (method === "GET" && revisionList) return json(response, 200, { revisions: store.listRevisions(decodeURIComponent(revisionList[1])) });
  const revisionGet = /^\/api\/trips\/([^/]+)\/revisions\/(\d+)$/.exec(url.pathname); if (method === "GET" && revisionGet) return json(response, 200, { revision: store.getRevision(decodeURIComponent(revisionGet[1]), Number(revisionGet[2])) });
  const revisionRestore = /^\/api\/trips\/([^/]+)\/revisions\/(\d+)\/restore$/.exec(url.pathname); if (method === "POST" && revisionRestore) return json(response, 200, store.restoreRevision(decodeURIComponent(revisionRestore[1]), Number(revisionRestore[2])));
  const map = /^\/api\/trips\/([^/]+)\/map$/.exec(url.pathname); if (method === "POST" && map) { const input = await body(request); return json(response, 200, { map: await maps.resolveDay(store.requireTrip(decodeURIComponent(map[1])), Number(input.dayNumber)) }); }
  const select = /^\/api\/trips\/([^/]+)\/map\/locations\/([^/]+)\/select$/.exec(url.pathname); if (method === "POST" && select) { const input = await body(request); const trip = store.requireTrip(decodeURIComponent(select[1])); if (!trip.activeRevision) return failure(response, 409, "当前没有行程版本。"); maps.selectCandidate(trip.id, trip.activeRevision.version, decodeURIComponent(select[2]), input.candidate); return json(response, 200, { ok: true }); }
  return failure(response, 404, "接口不存在。");
}

async function serve(request: IncomingMessage, response: ServerResponse) { const pathname = new URL(request.url || "/", "http://local").pathname; const file = pathname === "/" ? path.join(root, "dist", "web", "index.html") : path.join(root, "dist", "web", pathname); const resolved = path.resolve(file); const staticRoot = path.resolve(root, "dist", "web"); if (!resolved.startsWith(staticRoot)) return failure(response, 403, "无效路径。"); try { const info = await fs.stat(resolved); if (info.isFile()) { response.writeHead(200); createReadStream(resolved).pipe(response); return; } } catch { /* SPA fallback below */ } try { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); createReadStream(path.join(staticRoot, "index.html")).pipe(response); } catch { response.writeHead(503); response.end("请使用 npm run dev 启动开发界面。"); } }
const viteDev = process.env.TRAVEL_DEV === "1" ? await (async () => { const { createServer } = await import("vite"); return createServer({ configFile: path.join(root, "vite.config.ts"), server: { middlewareMode: true, hmr: false }, appType: "spa" }); })() : null;
const server = http.createServer((request, response) => { void (async () => { try { if ((request.url || "").startsWith("/api/")) await api(request, response); else if (viteDev) viteDev.middlewares(request, response, () => { void serve(request, response); }); else await serve(request, response); } catch (error) { if (!response.headersSent) failure(response, 400, message(error)); else response.end(); } })(); });
const ws = new WebSocketServer({ noServer: true }); server.on("upgrade", (request, socket, head) => { if (new URL(request.url || "/", "http://local").pathname !== "/ws" || !authenticated(request)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; } ws.handleUpgrade(request, socket, head, (client) => { clients.add(client); client.send(JSON.stringify({ kind: "codex.status", payload: { running: codex.running } })); client.on("close", () => clients.delete(client)); }); });
let listenHost = config.passwordHash ? "0.0.0.0" : "127.0.0.1";
function listen(host: string) { listenHost = host; server.listen(config.port, host, () => console.log(`AI Travel Planner 已启动：http://127.0.0.1:${config.port}`)); }
async function rebindForLan() { if (listenHost === "0.0.0.0") return; await new Promise<void>((resolve) => server.close(() => resolve())); listen("0.0.0.0"); }
listen(listenHost);
void codex.start().catch((error) => console.warn("[Codex]", message(error)));
process.on("SIGINT", () => { void codex.stop().finally(async () => { await viteDev?.close(); maps.close(); store.close(); server.close(() => process.exit(0)); }); });
