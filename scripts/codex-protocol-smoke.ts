import { CodexClient, structuredTurn, type RpcEnvelope } from "../apps/server/codex-client.js";

const client = new CodexClient(process.cwd());
try {
  await client.start();
  const account = await client.call("account/read", { refreshToken: false });
  if (!account.account) throw new Error("Codex 尚未登录，无法执行真实协议冒烟。");
  const started = await client.call("thread/start", {
    cwd: process.cwd(),
    developerInstructions: "只返回符合输出 Schema 的 JSON，不执行工具。",
    threadSource: "ai-travel-protocol-smoke",
    ephemeral: true,
    config: { web_search: "disabled", features: { shell_tool: false, multi_agent: false } },
    sandbox: "read-only",
    approvalPolicy: "never",
    environments: [],
  });
  const threadId = String(started.thread?.id || "");
  if (!threadId) throw new Error("真实协议冒烟没有获得 threadId。");
  let answer = "";
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("真实协议冒烟等待完成超时。")), 120_000);
    client.on("notification", (event: RpcEnvelope) => {
      const params = event.params as Record<string, any> | undefined;
      if (String(params?.threadId || "") !== threadId) return;
      if (event.method === "item/completed" && params?.item?.type === "agentMessage") answer = String(params.item.text || "");
      if (event.method === "turn/completed") { clearTimeout(timer); String(params?.turn?.status || "") === "completed" ? resolve() : reject(new Error(String(params?.turn?.error?.message || "真实协议冒烟失败。"))); }
    });
  });
  await client.call("turn/start", structuredTurn({
    threadId,
    input: [{ type: "text", text: "返回一个 answer 字段，值为 ok。", text_elements: [] }],
    outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  }), 120_000);
  await completed;
  const parsed = JSON.parse(answer) as { answer?: string };
  if (parsed.answer !== "ok") throw new Error(`真实协议冒烟返回异常：${answer}`);
  console.log(JSON.stringify({ ok: true, summary: "detailed", answer: parsed.answer }));
} finally {
  await client.stop();
}
