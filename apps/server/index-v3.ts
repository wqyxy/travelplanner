import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createSessionKey, hashPassword, LoginRateLimiter, PersistentSessionStore, verifyPassword } from "./auth.js";
import { loadConfig, mapCategoryColorDefaults, projectPaths, saveConfig, type AppConfig } from "./config.js";
import { CodexClient, type RpcEnvelope } from "./codex-client.js";
import { MapService } from "./map-service.js";
import { MapTileCache, TileFetchError } from "./map-tile-cache.js";
import { AiTaskMonitorV3, aiErrorMessageV3, normalizePublicAiSummaryV3 } from "./ai-task-monitor-v3.js";
import { DayRouteServiceV2 } from "./day-route-v2.js";
import { PlaceResolverV2 } from "./place-resolver-v2.js";
import { PlaceResolverAdapterV3 } from "./place-resolver-adapter-v3.js";
import { TravelPlannerRuntimeV3, type RuntimeEventV3 } from "./planner-runtime-v3.js";
import { loadPromptRegistryV3 } from "./prompt-registry-v3.js";
import { StagedTravelAiV3 } from "./staged-ai-v3.js";
import { StructuredAiRunnerV2 } from "./structured-ai-v2.js";
import { handleTravelApiV3, readJsonBodyV3 } from "./travel-api-v3.js";
import type { TravelStoreV2 } from "./travel-store-v2.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const root = path.resolve(process.cwd());
const paths = projectPaths(root);
await fs.mkdir(paths.privateRoot, { recursive: true });
// Strict loader: after cutover every prompts/**/*.md file must be explicitly registered.
const prompts = await loadPromptRegistryV3(root);
let config = await loadConfig(root);
// The target design intentionally keeps the filename travel-v2.sqlite3 while
// upgrading the INTERNAL database version to 3. A pre-existing v2 file fails
// closed here; normal startup never migrates, drops, deletes or overwrites it.
const store = new TravelStoreV3(paths.travelV2Db);
store.stopInterruptedAiRuns();
const codex = new CodexClient(root);
const structuredAi = new StructuredAiRunnerV2(codex);
const sessions = new PersistentSessionStore(() => config);
const limiter = new LoginRateLimiter();
const clients = new Set<WebSocket>();
const tiles = new MapTileCache(paths.cacheDb);
const maps = new MapService(paths.cacheDb);
const loginStates = new Map<string, { method: "browser" | "device"; phase: "pending" | "succeeded" | "failed" | "cancelled"; message?: string }>();

function broadcast(kind: string, payload: unknown) {
  const message = JSON.stringify({ kind, payload });
  for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(message);
}

const tasks = new AiTaskMonitorV3(store, (snapshot) => broadcast("ai-task.updated", snapshot));
const travelAi = new StagedTravelAiV3({ root, runner: structuredAi, prompts, model: () => config.ai.model || undefined });
// Resolver and route calculation remain the existing single fact chain. Their
// constructor annotations still name TravelStoreV2, so v3 is passed through a
// narrow compile-time cast; the runtime methods are the same store capabilities.
const resolverCore = new PlaceResolverV2({
  store: store as unknown as TravelStoreV2,
  maps,
  assist: (input) => travelAi.assistResolution(input),
});
const resolver = new PlaceResolverAdapterV3(resolverCore);
const routes = new DayRouteServiceV2({ store: store as unknown as TravelStoreV2, maps });
const runtime = new TravelPlannerRuntimeV3({
  store,
  ai: travelAi,
  prompts,
  tasks,
  resolver: resolver as unknown as PlaceResolverV2,
  routes,
  emit: (event: RuntimeEventV3) => broadcast(event.kind, event.payload),
});

codex.on("notification", (event: RpcEnvelope) => {
  if (event.method !== "account/login/completed") return;
  for (const state of loginStates.values()) if (state.phase === "pending") state.phase = "succeeded";
});

function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ data }));
}
function failure(response: ServerResponse, status: number, value: string, code?: string) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: { message: value, ...(code ? { code } : {}) } }));
}
function errorStatus(error: unknown) {
  const value = aiErrorMessageV3(error);
  if (value === "CONTENT_GENERATION_SUPERSEDED" || value === "PROPOSAL_UNDO_SUPERSEDED" || value === "STAGE_TURN_BUSY") return 409;
  if (/找不到|未知/u.test(value)) return 404;
  return 400;
}
function publicFailure(error: unknown) { return normalizePublicAiSummaryV3(aiErrorMessageV3(error)) || "服务请求失败。"; }
function cookies(request: IncomingMessage) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map((item) => item.trim().split(/=(.*)/s, 2)).filter(([key]) => key).map(([key, value]) => [key, decodeURIComponent(value || "")]));
}
function authenticated(request: IncomingMessage) { return sessions.has(cookies(request).travel_session); }
function hostClient(request: IncomingMessage) {
  const address = request.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address.endsWith("::ffff:127.0.0.1");
}
function sessionCookie(token: string, clear = false) { return `travel_session=${clear ? "" : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 60 * 60 * 24 * 30}`; }
async function ensureCodex() { if (!codex.running) await codex.start(); }
let configMutation = Promise.resolve();
function mutateConfig(mutator: (current: AppConfig) => AppConfig | Promise<AppConfig>) {
  const write = configMutation.then(async () => { const next = await mutator(config); await saveConfig(root, next); config = next; return next; });
  configMutation = write.then(() => undefined, () => undefined);
  return write;
}
async function modelList() {
  await ensureCodex();
  const result = await codex.call("model/list", {}, 30_000);
  const source = Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : [];
  const seen = new Set<string>();
  return source.flatMap((item: any) => {
    const model = String(item?.model || "").trim().slice(0, 120);
    if (!model || item?.hidden === true || seen.has(model)) return [];
    seen.add(model);
    const supportedReasoningEfforts = Array.isArray(item?.supportedReasoningEfforts)
      ? [...new Set<string>(item.supportedReasoningEfforts.map((entry: any) => typeof entry === "string" ? entry : entry?.reasoningEffort).filter((entry: unknown): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry: string) => entry.trim().slice(0, 32)))]
      : [];
    return [{ model, displayName: String(item?.displayName || model).trim().slice(0, 120), supportedReasoningEfforts }];
  });
}

async function api(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const method = request.method || "GET";
  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const signedIn = authenticated(request);
    return json(response, 200, {
      authenticated: signedIn,
      configured: Boolean(config.passwordHash),
      setupAllowed: !config.passwordHash && hostClient(request),
      hostClient: hostClient(request),
      lanEnabled: Boolean(config.passwordHash),
      port: config.port,
      codex: { connected: codex.running },
      settings: { ai: { ...config.ai, reasoningEffort: "auto" }, ui: config.ui },
      user: signedIn ? { id: "owner", username: config.username || "旅行者" } : null,
      runtime: { schemaVersion: 3, database: "travel-v2.sqlite3", migration: "none" },
    });
  }
  if (method === "POST" && url.pathname === "/api/auth/setup") {
    if (config.passwordHash || !hostClient(request)) return failure(response, 403, "只能在首次本机访问时设置旅行空间。");
    const input = await readJsonBodyV3(request);
    const username = String(input.username || "").trim();
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) return failure(response, 400, "用户名应为 3–32 位字母、数字、下划线或连字符。");
    const password = await hashPassword(String(input.password || ""));
    await mutateConfig((current) => ({ ...current, ...password, sessionKey: createSessionKey(), username }));
    const token = sessions.create();
    response.setHeader("set-cookie", sessionCookie(token));
    json(response, 200, { user: { id: "owner", username } });
    void rebindForLan();
    return;
  }
  if (method === "POST" && url.pathname === "/api/auth/login") {
    const key = request.socket.remoteAddress || "unknown";
    const allowed = limiter.canAttempt(key);
    if (!allowed.allowed) return failure(response, 429, `尝试过多，请在 ${allowed.retryAfterSeconds} 秒后重试。`);
    const input = await readJsonBodyV3(request);
    if (String(input.username || "") !== config.username || !(await verifyPassword(String(input.password || ""), config))) {
      limiter.failure(key); return failure(response, 401, "用户名或密码错误。");
    }
    limiter.success(key);
    const token = sessions.create(); response.setHeader("set-cookie", sessionCookie(token));
    return json(response, 200, { user: { id: "owner", username: config.username } });
  }
  if (method === "POST" && url.pathname === "/api/auth/logout") {
    sessions.delete(cookies(request).travel_session); response.setHeader("set-cookie", sessionCookie("", true)); return json(response, 200, { ok: true });
  }
  if (!authenticated(request)) return failure(response, 401, "请先登录旅行空间。", "auth_required");

  const tile = /^\/api\/map\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
  if (method === "GET" && tile) {
    try {
      const result = await tiles.getTile(Number(tile[1]), Number(tile[2]), Number(tile[3]), request.headers.referer);
      response.writeHead(200, { "content-type": result.contentType, "content-length": String(result.content.length), "cache-control": "private, max-age=0, must-revalidate", "x-map-tile-cache": result.cacheStatus });
      response.end(result.content);
    } catch (error) { failure(response, error instanceof TileFetchError ? error.status : 500, publicFailure(error)); }
    return;
  }
  if (method === "PUT" && url.pathname === "/api/auth/password") {
    const input = await readJsonBodyV3(request);
    if (typeof input.newPassword !== "string") return failure(response, 400, "新密码必须是字符串。");
    const password = await hashPassword(input.newPassword);
    await mutateConfig((current) => ({ ...current, ...password, ...(current.sessionKey ? {} : { sessionKey: current.passwordHash }) }));
    return json(response, 200, { ok: true });
  }
  if (method === "GET" && url.pathname === "/api/codex/status") {
    try {
      await ensureCodex(); const account = await codex.call("account/read", { refreshToken: false });
      return json(response, 200, { signedIn: Boolean(account?.account), account: account?.account || null, models: await modelList() });
    } catch (error) { return json(response, 200, { signedIn: false, account: null, models: [], error: publicFailure(error) }); }
  }
  if (method === "POST" && url.pathname === "/api/codex/login/browser") {
    await ensureCodex(); const result = await codex.call("account/login/start", { method: "browser" });
    const loginId = String(result?.loginId || result?.login_id || ""); if (loginId) loginStates.set(loginId, { method: "browser", phase: "pending" });
    return json(response, 200, { loginId, authUrl: result?.authUrl || result?.auth_url });
  }
  if (method === "POST" && url.pathname === "/api/codex/login/device") {
    await ensureCodex(); const result = await codex.call("account/login/start", { method: "device" });
    const loginId = String(result?.loginId || result?.login_id || ""); if (loginId) loginStates.set(loginId, { method: "device", phase: "pending" });
    return json(response, 200, { loginId, verificationUrl: result?.verificationUrl || result?.verification_url, userCode: result?.userCode || result?.user_code });
  }
  if (method === "GET" && url.pathname === "/api/codex/login/status") {
    const state = loginStates.get(String(url.searchParams.get("loginId") || ""));
    return json(response, 200, state ? { loginId: url.searchParams.get("loginId"), ...state } : { phase: "cancelled", message: "登录已结束。" });
  }
  if (method === "POST" && url.pathname === "/api/codex/logout") { await ensureCodex(); await codex.call("account/logout"); return json(response, 200, { ok: true }); }
  if (method === "PUT" && url.pathname === "/api/settings/ui") {
    const input = await readJsonBodyV3(request); const colors = input.mapCategoryColors;
    if (colors !== undefined && (!colors || typeof colors !== "object" || Array.isArray(colors) || Object.entries(colors).some(([key, value]) => !(key in mapCategoryColorDefaults) || typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)))) return failure(response, 400, "地图分类颜色必须是已知类别的 #RRGGBB 值。");
    const next = await mutateConfig((current) => ({ ...current, ui: { ...current.ui, ...(typeof input.workspaceSplitRatio === "number" ? { workspaceSplitRatio: Math.max(.34, Math.min(.66, input.workspaceSplitRatio)) } : {}), ...(input.theme === "light" || input.theme === "dark" ? { theme: input.theme } : {}), ...(typeof input.sidebarOpen === "boolean" ? { sidebarOpen: input.sidebarOpen } : {}), ...(colors ? { mapCategoryColors: { ...current.ui.mapCategoryColors, ...colors as Record<string, string> } } : {}) } }));
    return json(response, 200, { settings: { ai: { ...next.ai, reasoningEffort: "auto" }, ui: next.ui } });
  }
  if (method === "PUT" && url.pathname === "/api/settings/ai-model") {
    const input = await readJsonBodyV3(request);
    const next = await mutateConfig((current) => ({ ...current, ai: { model: String(input.model || "").slice(0, 120), reasoningEffort: "auto" } }));
    return json(response, 200, { settings: { ai: next.ai, ui: next.ui } });
  }

  if (await handleTravelApiV3(request, response, { store, runtime })) return;
  return failure(response, 404, "接口不存在。");
}

function contentType(filename: string) {
  if (filename.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  if (filename.endsWith(".svg")) return "image/svg+xml";
  if (filename.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/html; charset=utf-8";
}
async function serve(request: IncomingMessage, response: ServerResponse) {
  const pathname = new URL(request.url || "/", "http://local").pathname;
  const target = pathname === "/" ? path.join(root, "dist", "web", "index.html") : path.join(root, "dist", "web", pathname);
  const resolved = path.resolve(target); const staticRoot = path.resolve(root, "dist", "web");
  if (!resolved.startsWith(staticRoot)) return failure(response, 403, "无效路径。");
  try {
    const info = await fs.stat(resolved);
    if (info.isFile()) { response.writeHead(200, { "content-type": contentType(resolved) }); createReadStream(resolved).pipe(response); return; }
  } catch { /* SPA fallback. */ }
  try { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); createReadStream(path.join(staticRoot, "index.html")).pipe(response); }
  catch { response.writeHead(503); response.end("请使用 npm run dev 启动开发界面。"); }
}

const viteDev = process.env.TRAVEL_DEV === "1" ? await (async () => {
  const { createServer } = await import("vite");
  return createServer({ configFile: path.join(root, "vite.config.ts"), server: { middlewareMode: true, hmr: false }, appType: "spa" });
})() : null;
const server = http.createServer((request, response) => {
  void (async () => {
    try {
      if ((request.url || "").startsWith("/api/")) await api(request, response);
      else if (viteDev) viteDev.middlewares(request, response, () => { void serve(request, response); });
      else await serve(request, response);
    } catch (error) {
      if (!response.headersSent) failure(response, errorStatus(error), publicFailure(error), aiErrorMessageV3(error));
      else response.end();
    }
  })();
});
const ws = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url || "/", "http://local").pathname !== "/ws" || !authenticated(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return;
  }
  ws.handleUpgrade(request, socket, head, (client) => { clients.add(client); client.on("close", () => clients.delete(client)); });
});
let listenHost = config.passwordHash ? "0.0.0.0" : "127.0.0.1";
function listen(host: string) {
  listenHost = host;
  server.listen(config.port, host, () => console.log(`AI Travel Planner staged v3 已启动：http://127.0.0.1:${config.port}`));
}
async function rebindForLan() {
  if (listenHost === "0.0.0.0") return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  listen("0.0.0.0");
}
listen(listenHost);
void codex.start().catch((error) => console.warn("[Codex]", publicFailure(error)));
process.on("SIGINT", () => {
  void codex.stop().finally(async () => {
    await viteDev?.close(); tiles.close(); maps.close(); store.close(); server.close(() => process.exit(0));
  });
});
