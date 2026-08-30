import { z, type ZodType } from "zod";
import {
  CodexClient,
  structuredTurn,
  type ReasoningEffort,
  type ReasoningSummary,
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
  reasoningSummary?: ReasoningSummary;
  timeoutMs?: number;
  validateResult?: (value: T) => T;
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
  validateResult?: (value: T) => T;
  outputSchema: Record<string, unknown>;
  model?: string;
  effort?: ReasoningEffort;
  reasoningSummary: ReasoningSummary;
  repairAttempts: number;
  settle: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (progress: StructuredAiProgress) => void;
};

const safeError = (value: unknown) => value instanceof Error ? value : new Error(String(value ?? "AI 请求失败。"));
const PATCH_KEY = "__patch";
const MAX_STRUCTURED_REPAIRS = 2;
const FORBIDDEN_SCHEMA_KEYS = new Set(["allOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isObjectSchema(record: Record<string, unknown>) {
  return record.type === "object" || (Array.isArray(record.type) && record.type.includes("object"));
}

function transportSchema(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item, index) => transportSchema(item, [...path, String(index)]));
  if (!isRecord(value)) return value;

  const record = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transportSchema(item, [...path, key])])) as Record<string, unknown>;
  delete record.$schema;

  if (Array.isArray(record.oneOf)) {
    if (record.anyOf !== undefined) throw new Error(`AI output schema 同时包含 oneOf/anyOf：${path.join(".") || "root"}`);
    record.anyOf = record.oneOf;
    delete record.oneOf;
  }

  for (const key of FORBIDDEN_SCHEMA_KEYS) {
    if (record[key] !== undefined) throw new Error(`AI output schema 不支持 ${key}：${path.join(".") || "root"}`);
  }

  if (isObjectSchema(record) && isRecord(record.properties)) {
    const properties = record.properties;
    const keys = Object.keys(properties);
    if (keys.includes(PATCH_KEY)) throw new Error(`业务 Schema 不得使用保留字段 ${PATCH_KEY}：${path.join(".") || "root"}`);
    const required = new Set(Array.isArray(record.required) ? record.required.filter((item): item is string => typeof item === "string") : []);
    const optionalKeys = keys.filter((key) => !required.has(key));

    if (optionalKeys.length) {
      if (required.size) throw new Error(`AI output object 不能混用 required/optional 字段：${path.join(".") || "root"}`);
      if (!keys.length) throw new Error(`AI output optional object 没有可修改字段：${path.join(".") || "root"}`);
      return {
        type: "object",
        properties: {
          [PATCH_KEY]: {
            type: "array",
            minItems: 1,
            maxItems: keys.length,
            items: {
              anyOf: keys.map((key) => ({
                type: "object",
                properties: {
                  field: { type: "string", const: key },
                  value: properties[key],
                },
                required: ["field", "value"],
                additionalProperties: false,
              })),
            },
          },
        },
        required: [PATCH_KEY],
        additionalProperties: false,
      };
    }

    if (required.size !== keys.length) throw new Error(`AI output object required 与 properties 不一致：${path.join(".") || "root"}`);
    record.required = keys;
    record.additionalProperties = false;
  }

  return record;
}

export function buildOpenAiStructuredOutputSchema(schema: ZodType<unknown>): Record<string, unknown> {
  const converted = transportSchema(z.toJSONSchema(schema));
  if (!isRecord(converted) || !isObjectSchema(converted)) throw new Error("AI output schema 根节点必须是 object。");
  return converted;
}

export function normalizeStructuredOutputTransport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStructuredOutputTransport);
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === PATCH_KEY) {
    const entries = value[PATCH_KEY];
    if (!Array.isArray(entries) || !entries.length) throw new Error("AI patch 至少需要一个字段修改。");
    const result: Record<string, unknown> = {};
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.field !== "string" || !("value" in entry)) throw new Error("AI patch 项格式无效。");
      if (entry.field in result) throw new Error(`AI patch 字段重复：${entry.field}`);
      result[entry.field] = normalizeStructuredOutputTransport(entry.value);
    }
    return result;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeStructuredOutputTransport(item)]));
}

function repairMessage(error: Error, attempt: number) {
  const detail = error.message.replace(/\s+/g, " ").slice(0, 4000);
  return [
    `上一轮 AI 输出未通过服务端校验，正在进行第 ${attempt}/${MAX_STRUCTURED_REPAIRS} 次修正。`,
    `校验错误：${detail}`,
    "请根据当前线程中的原始任务和状态修正输出。",
    "只返回符合本轮同一 JSON Schema 的完整 JSON；不要解释，不要使用 Markdown。",
  ].join("\n");
}

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
        const parsed = normalizeStructuredOutputTransport(JSON.parse(run.content));
        const value = run.schema.parse(parsed);
        this.finish(threadId, null, run.validateResult ? run.validateResult(value) : value);
      } catch (error) {
        const normalized = safeError(error);
        if (run.repairAttempts < MAX_STRUCTURED_REPAIRS) {
          void this.repair(threadId, normalized);
          return;
        }
        this.finish(threadId, normalized);
      }
    }
  }

  private async repair(threadId: string, error: Error) {
    const run = this.active.get(threadId);
    if (!run) return;
    run.repairAttempts += 1;
    run.content = "";
    run.onProgress?.({ kind: "turn:repair", text: `AI 结果校验失败，正在自动修正（${run.repairAttempts}/${MAX_STRUCTURED_REPAIRS}）` });
    try {
      const turn = await this.client.call("turn/start", structuredTurn({
        threadId,
        input: [{ type: "text", text: repairMessage(error, run.repairAttempts), text_elements: [] }],
        outputSchema: run.outputSchema,
        ...(run.model ? { model: run.model } : {}),
        ...(run.effort ? { effort: run.effort } : {}),
      }, run.reasoningSummary), 120_000);
      run.turnId = String(turn?.turn?.id ?? run.turnId ?? "") || null;
    } catch (repairError) {
      this.finish(threadId, safeError(repairError));
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
    const outputSchema = buildOpenAiStructuredOutputSchema(options.schema as ZodType<unknown>);
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
    const run: ActiveRun<T> = {
      threadId,
      turnId: null,
      content: "",
      schema: options.schema,
      validateResult: options.validateResult,
      outputSchema,
      model: options.model,
      effort: options.effort,
      reasoningSummary: options.reasoningSummary ?? "detailed",
      repairAttempts: 0,
      settle,
      reject,
      timer,
      onProgress: options.onProgress,
    };
    this.active.set(threadId, run as ActiveRun);
    try {
      const state = typeof options.state === "string" ? options.state : JSON.stringify(options.state, null, 2);
      const turn = await this.client.call("turn/start", structuredTurn({
        threadId,
        input: [{ type: "text", text: `${options.prompt}\n\n本轮受控状态：\n${state}`, text_elements: [] }],
        outputSchema,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      }, run.reasoningSummary), 120_000);
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
