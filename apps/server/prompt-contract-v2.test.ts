import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentPromptsV2, V2_PROMPT_FILES } from "./prompt-contract-v2.js";

async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "travel-prompts-v2-"));
  await mkdir(path.join(root, "prompts"));
  for (const filename of Object.values(V2_PROMPT_FILES)) await writeFile(path.join(root, "prompts", filename), `# ${filename}\n受控结构化输出。\n`);
  for (const [filename, content] of Object.entries(extra)) await writeFile(path.join(root, "prompts", filename), content);
  return root;
}

describe("prompt contract v2", () => {
  it("loads exactly 00, 01 and 02", async () => {
    const prompts = await loadAgentPromptsV2(await fixture());
    expect(prompts.planner.filename).toBe(V2_PROMPT_FILES.planner);
    expect(prompts.detailer.filename).toBe(V2_PROMPT_FILES.detailer);
    expect(prompts.mapResolver.filename).toBe(V2_PROMPT_FILES.mapResolver);
  });

  it("rejects a fourth coordinate agent", async () => {
    await expect(loadAgentPromptsV2(await fixture({ "03-地图坐标搜索Agent.md": "旧坐标 Agent" }))).rejects.toThrow("只允许 00/01/02");
  });
});
