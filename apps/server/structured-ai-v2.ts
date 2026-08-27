import type { ZodType } from "zod";
import {
  CodexClient,
  structuredTurn,
  type ReasoningEffort,
  type RpcEnvelope,
} from "./codex-client.js";

export type StructuredAiProgress = { kind: string; text: string };
export type StructuredAiRunOptions<T> = {
  cwd: string;
  prompt: string;
  state: unknown;
  schema: ZodType<T>;
  outputSchema: Record<string, unknown>;
  developerInstructions: string;
  threadSource: string;
  existingThreadId?: string | null;
  ephemeral?: boolean;
  webSearch?: "live" | "disabled";
  model?: string;
  effort?: ReasoningEffort;
  timeoutMs?: number;
  onProgress?: (progress: StructuredAiProgress) => void;
};

export type StructuredAiRun<T> = {
  threadId: string;
  result: Promise<T>;
  interrupt: () => Promise<void>;
  turnId: () => string | null;
};

type ActiveRun<T = unknown> = {
  threadId: string;
  turnId: string | null;
  content: string;
  schema: ZodType<T>;
  settle: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (progress: StructuredAiProgress) => void;
};

const safeError = (value: unknown) => value instanceof Error ? value : new Error(String(value ?? "AI 请求失败。"));

export class StructuredAiRunnerV2 {
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly client: CodexClient) {
    client.on("notification", (event: RpcEnvelope) => this.notification(event));
    client.on("serverRequest", (event: RpcEnvelope) => {
      if (event.id !== undefined) client.respond(event.id, { decision: "decline" });
    });
  }

  async ensureStarted() {
    if (!this.client.running) await this.client.start();
  }

  private notification(event: RpcEnvelope) {
    const params = event.params as Record<string, any> | undefined;
    const threadId = String(params?.threadId ?? "");
    const run = this.active.get(threadId);
    if (!run) return;
    if (event.method === "turn/started") {
      run.turnId = String(params?.turn?.id ?? params?.turnId ?? run.turnId ?? "") || null;
      run.onProgress?.({ kind: "turn:started", text: "AI 已开始处理" });
      return;
    }
    if (event.method === "item/reasoning/summaryTextDelta" || event.method === "item/plan/delta") {
      const text = String(params?.delta ?? "");
      if (text) run.onProgress?.({ kind: event.method, text });
      return;
    }
    if (event.method === "item/agentMessage/delta") {
      run.content += String(params?.delta ?? "");
      return;
    }
    if (event.method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string") {
      run.content = params.item.text;
      return;
    }
    if (event.method === "error" || event.method === "turn/error") {
      const message = String(params?.error?.message ?? params?.message ?? "AI turn 失败。");
      this.finish(threadId, new Error(message));
      return;
    }
    if (event.method === "turn/completed") {
      const status = String(params?.turn?.status ?? "completed");
      if (status !== "completed") {
        this.finish(threadId, new Error(String(params?.turn?.error?.message ?? params?.error?.message ?? `AI turn 状态：${status}`)));
        return;
      }
      try {
        const parsed = JSON.parse(run.content);
        this.finish(threadId, null, run.schema.parse(parsed));
      } catch (error) {
        this.finish(threadId, safeError(error));
      }
    }
  }

  private finish<T>(threadId: string, error: Error | null, value?: T) {
    const run = this.active.get(threadId) as ActiveRun<T> | undefined;
    if (!run) return;
    this.active.delete(threadId);
    clearTimeout(run.timer);
    if (error) run.reject(error);
    else run.settle(value as T);
  }

  async start<T>(options: StructuredAiRunOptions<T>): Promise<StructuredAiRun<T>> {
    await this.ensureStarted();
    const common = {
      cwd: options.cwd,
      developerInstructions: options.developerInstructions,
      config: {
        web_search: options.webSearch ?? "live",
        features: { apps: false, goals: false, multi_agent: false, shell_tool: false, plugins: false, remote_plugin: false },
      },
      sandbox: "read-only" as const,
      approvalPolicy: "never" as const,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
    };
    let threadId = options.existingThreadId?.trim() || "";
    if (threadId) {
      try {
        await this.client.call("thread/resume", { ...common, threadId }, 60_000);
      } catch {
        threadId = "";
      }
    }
    if (!threadId) {
      const started = await this.client.call("thread/start", {
        ...common,
        threadSource: options.threadSource,
        ephemeral: options.ephemeral ?? false,
        environments: [],
      }, 60_000);
      threadId = String(started?.thread?.id ?? "");
      if (!threadId) throw new Error("Codex 没有返回线程 ID。");
    }

    let settle!: (value: T) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<T>((resolve, rejectValue) => { settle = resolve; reject = rejectValue; });
    const timer = setTimeout(() => {
      const run = this.active.get(threadId);
      if (run?.turnId) void this.client.call("turn/interrupt", { threadId, turnId: run.turnId }).catch(() => undefined);
      this.finish(threadId, new Error("AI 结构化请求超时。"));
    }, options.timeoutMs ?? 180_000);
    timer.unref();
    const run: ActiveRun<T> = { threadId, turnId: null, content: "", schema: options.schema, settle, reject, timer, onProgress: options.onProgress };
    this.active.set(threadId, run as ActiveRun);
    try {
      const state = typeof options.state === "string" ? options.state : JSON.stringify(options.state, null, 2);
      const turn = await this.client.call("turn/start", structuredTurn({
        threadId,
        input: [{ type: "text", text: `${options.prompt}\n\n本轮受控状态：\n${state}`, text_elements: [] }],
        outputSchema: options.outputSchema,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      }), 120_000);
      run.turnId = String(turn?.turn?.id ?? run.turnId ?? "") || null;
    } catch (error) {
      this.finish(threadId, safeError(error));
    }
    return {
      threadId,
      result,
      turnId: () => run.turnId,
      interrupt: async () => {
        if (run.turnId) await this.client.call("turn/interrupt", { threadId, turnId: run.turnId });
        this.finish(threadId, new Error("AI 任务已停止。"));
      },
    };
  }
}
