import { ZodError } from "zod";
import type { AiAgentKind, AiTaskSnapshot, AiTaskStatus } from "./contracts-v2.js";
import type { TravelStoreV2 } from "./travel-store-v2.js";

const TERMINAL = new Set<AiTaskStatus>(["completed", "failed", "stopped", "cancelled_by_generation"]);
const LIMIT = 360;

export function normalizePublicAiSummary(value: unknown) {
  const text = String(value ?? "")
    .replace(/\s+/gu, " ")
    .replace(/(?:\*\*|__|`)(.*?)(?:\*\*|__|`)/gu, "$1")
    .replace(/^#{1,6}\s*/u, "")
    .replace(/(?:bearer|token|cookie|api[ _-]?key|password|secret)\s*[:=]\s*[^\s,;]+/giu, "敏感信息=[已隐藏]")
    .replace(/(?:account(?:Id)?|账户(?:名称|编号|ID))\s*[:=：]\s*[^\s,;，。]+/giu, "账户信息=[已隐藏]")
    .trim();
  return text.length <= LIMIT ? text : `${text.slice(0, LIMIT - 1).trimEnd()}…`;
}

export function aiErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "服务器请求失败。";
}

export function isRepairableAiOutputError(error: unknown) {
  if (error instanceof SyntaxError || error instanceof ZodError) return true;
  return error instanceof Error && error.constructor === Error && !("code" in error);
}

export class AiTaskMonitor {
  private readonly buffers = new Map<string, Map<string, string>>();
  constructor(private readonly store: TravelStoreV2, private readonly emit: (snapshot: AiTaskSnapshot) => void) {}
  start(input: { id: string; tripId: string; agent: AiAgentKind; label: string; summary: string; metadata?: Record<string, unknown> }) {
    const summary = normalizePublicAiSummary(input.summary);
    const snapshot = this.store.upsertAiTask({ ...input, status: "starting", summary, canStop: false, resetStartedAt: true });
    this.store.appendAiProgress(input.id, "starting", "task:started", summary); this.buffers.delete(input.id); this.emit(this.store.getAiTask(input.id)!); return snapshot;
  }
  update(id: string, status: AiTaskStatus, summary: unknown, kind = "status") {
    const value = normalizePublicAiSummary(summary); if (!value) return this.store.getAiTask(id);
    const snapshot = this.store.appendAiProgress(id, status, kind, value); if (snapshot) this.emit(snapshot); if (TERMINAL.has(status)) this.buffers.delete(id); return snapshot;
  }
  append(id: string, segment: string, delta: unknown) {
    const value = String(delta ?? ""); if (!value) return this.store.getAiTask(id);
    const segments = this.buffers.get(id) ?? new Map<string, string>(); const combined = `${segments.get(segment) ?? ""}${value}`.slice(-2400); segments.set(segment, combined); this.buffers.set(id, segments);
    return this.update(id, "running", combined, segment);
  }
  metadata(id: string, value: Record<string, unknown>) { const snapshot = this.store.setAiTaskMetadata(id, value); if (snapshot) this.emit(snapshot); return snapshot; }
  list(tripId: string) { return this.store.listAiTasks(tripId); }
}
