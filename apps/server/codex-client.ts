import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import path from "node:path";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexFailureKind = "protocol" | "authentication" | "model" | "transient" | "unknown";
export type CodexTextInput = { type: "text"; text: string; text_elements: unknown[] };
export type ThreadStartParams = { model?: string; effort?: ReasoningEffort; cwd: string; developerInstructions: string; threadSource: string; ephemeral: boolean; config: Record<string, unknown>; sandbox: "read-only" | "workspace-write" | "danger-full-access"; approvalPolicy: "untrusted" | "on-request" | "never"; environments?: unknown[] };
export type ThreadResumeParams = Omit<ThreadStartParams, "threadSource" | "ephemeral" | "environments"> & { threadId: string };
export type TurnStartParams = { threadId: string; input: CodexTextInput[]; outputSchema?: Record<string, unknown>; model?: string; effort?: ReasoningEffort; summary?: ReasoningSummary };
type RpcParams = {
  initialize: { clientInfo: { name: string; title: string; version: string }; capabilities: { experimentalApi: boolean; requestAttestation: boolean } };
  "model/list": Record<string, never>;
  "thread/start": ThreadStartParams;
  "thread/resume": ThreadResumeParams;
  "turn/start": TurnStartParams;
  "turn/interrupt": { threadId: string; turnId: string };
  "account/read": { refreshToken: boolean };
  "account/login/start": { method: "browser" | "device" };
  "account/logout": undefined;
};
type RpcResults = {
  initialize: unknown;
  "model/list": { data?: unknown[]; models?: unknown[] };
  "thread/start": { thread?: { id?: string } };
  "thread/resume": unknown;
  "turn/start": { turn?: { id?: string } };
  "turn/interrupt": unknown;
  "account/read": { account?: unknown };
  "account/login/start": { loginId?: string; login_id?: string; authUrl?: string; auth_url?: string; verificationUrl?: string; verification_url?: string; userCode?: string; user_code?: string };
  "account/logout": unknown;
};
export interface RpcEnvelope { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number | string; message?: string; data?: unknown }; }
export class CodexRpcError extends Error { constructor(message: string, readonly code?: number | string, readonly data?: unknown) { super(message); this.name = "CodexRpcError"; } }
export function classifyCodexFailure(error: unknown): CodexFailureKind {
  const value = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (/invalid request|invalid params|unknown variant|expected one of|unsupported (?:field|parameter)|schema.+invalid/.test(value)) return "protocol";
  if (/unauthorized|forbidden|not logged in|authentication|sign[ -]?in|login required|登录/.test(value)) return "authentication";
  if (/unknown model|model.+(?:not found|unavailable|unsupported|not allowed)/.test(value)) return "model";
  if (/timeout|超时|network|stream disconnected|transport error|connection|broken pipe|econn|app-server.+退出|尚未运行|temporar/.test(value)) return "transient";
  return "unknown";
}
export const MAX_CODEX_RETRIES = 3;
export function nextCodexRetry(retryCount: number) { const attempt = Math.max(0, Math.trunc(retryCount)) + 1; return attempt > MAX_CODEX_RETRIES ? null : { attempt, delayMs: 15_000 * 2 ** (attempt - 1) }; }
export function structuredTurn(input: Omit<TurnStartParams, "summary">): TurnStartParams { return { ...input, summary: "detailed" }; }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export class CodexClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null; private nextId = 1; private pending = new Map<number, Pending>(); private starting: Promise<void> | null = null;
  constructor(private readonly root: string, private readonly entryOverride = process.env.TRAVEL_PLANNER_CODEX_ENTRY) { super(); }
  get running() { return Boolean(this.child && !this.child.killed); }
  async start() { if (this.starting) return this.starting; this.starting = this.startInternal().catch((error) => { this.starting = null; throw error; }); return this.starting; }
  private async startInternal() { const entry = this.entryOverride || path.join(this.root, "node_modules", "@openai", "codex", "bin", "codex.js"); await fs.access(entry); const env = { ...process.env }; delete env.OPENAI_API_KEY; delete env.OPENAI_ORG_ID; delete env.OPENAI_PROJECT_ID; const child = spawn(process.execPath, [entry, "app-server"], { cwd: this.root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); this.child = child; child.on("exit", (code) => { const error = new Error(`Codex app-server 已退出（${code ?? "unknown"}）。`); for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); if (this.child === child) { this.child = null; this.starting = null; } this.emit("status", { running: false, error: error.message }); }); child.stderr.on("data", (chunk: Buffer) => { const message = chunk.toString("utf8").trim(); if (message) this.emit("diagnostic", { message }); }); createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line)); await this.call("initialize", { clientInfo: { name: "ai-travel-planner", title: "AI Travel Planner", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }); this.notify("initialized"); this.emit("status", { running: true }); }
  private handleLine(line: string) { let message: RpcEnvelope; try { message = JSON.parse(line); } catch { this.emit("diagnostic", { message: "Codex 返回了无法解析的消息。" }); return; } if (message.id !== undefined && (message.result !== undefined || message.error)) { const item = this.pending.get(Number(message.id)); if (!item) return; clearTimeout(item.timer); this.pending.delete(Number(message.id)); message.error ? item.reject(new CodexRpcError(message.error.message || "Codex 请求失败。", message.error.code, message.error.data)) : item.resolve(message.result); return; } if (message.id !== undefined && message.method) { this.emit("serverRequest", message); return; } if (message.method) this.emit("notification", message); }
  private send(message: RpcEnvelope) { if (!this.child?.stdin.writable) throw new Error("Codex app-server 尚未运行。"); this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  async call<M extends keyof RpcParams>(method: M, ...args: RpcParams[M] extends undefined ? [params?: undefined, timeoutMs?: number] : [params: RpcParams[M], timeoutMs?: number]): Promise<RpcResults[M]> { const params = args[0] as RpcParams[M]; const timeoutMs = args[1] ?? 60000; if (!this.child && method !== "initialize") await this.start(); const id = this.nextId++; const value = new Promise<unknown>((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new CodexRpcError(`${method} 请求超时。`)); }, timeoutMs); this.pending.set(id, { resolve, reject, timer }); }); this.send({ id, method, ...(params === undefined ? {} : { params }) }); return value as Promise<RpcResults[M]>; }
  notify(method: string, params?: unknown) { this.send({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id: number | string, result: unknown) { this.send({ id, result }); }
  async stop() { const child = this.child; if (!child) return; this.child = null; this.starting = null; await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 2000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill(); }); }
}
