import { EventEmitter } from "node:events";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { StructuredAiRunnerV2 } from "./structured-ai-v2.js";

class FakeClient extends EventEmitter {
  running = true;
  calls: Array<{ method: string; params: any }> = [];
  private turn = 0;
  async start() { this.running = true; }
  respond(_id?: unknown, _value?: unknown) {}
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "thread/resume") return {};
    if (method === "turn/start") return { turn: { id: `turn-${++this.turn}` } };
    return {};
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("StructuredAiRunnerV2", () => {
  it("collects and validates structured output", async () => {
    const client = new FakeClient();
    const runner = new StructuredAiRunnerV2(client as any);
    const run = await runner.start({ cwd: "/tmp", prompt: "prompt", state: { a: 1 }, schema: z.object({ ok: z.boolean() }), outputSchema: {}, developerInstructions: "rules", threadSource: "test" });
    client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: '{"ok":true}' } });
    client.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await expect(run.result).resolves.toEqual({ ok: true });
  });

  it("retries a locally invalid result on the same thread", async () => {
    const client = new FakeClient();
    const runner = new StructuredAiRunnerV2(client as any);
    const progress: string[] = [];
    const run = await runner.start({
      cwd: "/tmp",
      prompt: "prompt",
      state: { a: 1 },
      schema: z.object({ ok: z.literal(true) }).strict(),
      outputSchema: {},
      developerInstructions: "rules",
      threadSource: "test",
      onProgress: (item) => progress.push(item.kind),
    });

    client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: '{"ok":false}' } });
    client.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await tick();

    expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
    expect(progress).toContain("turn:repair");

    client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: '{"ok":true}' } });
    client.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } } });
    await expect(run.result).resolves.toEqual({ ok: true });
  });

  it("declines server requests", async () => {
    const client = new FakeClient();
    let response: unknown;
    client.respond = (_id: unknown, value: unknown) => { response = value; };
    new StructuredAiRunnerV2(client as any);
    client.emit("serverRequest", { id: 1, method: "approval" });
    expect(response).toEqual({ decision: "decline" });
  });
});
