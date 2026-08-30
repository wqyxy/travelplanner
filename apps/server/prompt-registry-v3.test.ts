import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROMPT_REGISTRY_V3 } from "./ai-registries-v3.js";
import { loadPromptRegistryV3 } from "./prompt-registry-v3.js";

const roots: string[] = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "travel-prompts-v3-"));
  roots.push(root);
  for (const registration of PROMPT_REGISTRY_V3) {
    const filename = path.join(root, "prompts", registration.relativePath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, `# ${registration.id}\n\n只输出本轮指定 JSON。\n`, "utf8");
  }
  return root;
}

function promptPath(root: string, id: string) {
  const registration = PROMPT_REGISTRY_V3.find((item) => item.id === id);
  if (!registration) throw new Error(`missing prompt registration: ${id}`);
  return path.join(root, "prompts", registration.relativePath);
}

describe("v3 prompt registry", () => {
  it("recursively loads every explicitly registered UTF-8 prompt", async () => {
    const root = await fixture();
    const registry = await loadPromptRegistryV3(root);
    expect(registry.prompts.size).toBe(PROMPT_REGISTRY_V3.length);
    expect(registry.compose("dialogue.requirements").content).toContain("shared.travel-rules");
    expect(registry.compose("dialogue.requirements").content).toContain("dialogue.requirements");
  });

  it("loads the repository's actual prompt tree with strict validation", async () => {
    const registry = await loadPromptRegistryV3(repositoryRoot);
    expect(registry.prompts.size).toBe(PROMPT_REGISTRY_V3.length);
    expect(registry.get("action.destination.replace").content).toContain("不得输出坐标");
  });

  it("accepts prohibitions that explicitly forbid privileged operations", async () => {
    const root = await fixture();
    await writeFile(promptPath(root, "action.destination.replace"), "# replace\n\n可以联网比较旅行价值和匹配度，但不得输出坐标。\n", "utf8");
    await expect(loadPromptRegistryV3(root)).resolves.toBeTruthy();
  });

  it("still rejects affirmative privileged-operation instructions", async () => {
    const root = await fixture();
    await writeFile(promptPath(root, "action.destination.replace"), "# replace\n\n可以直接输出坐标。\n", "utf8");
    await expect(loadPromptRegistryV3(root)).rejects.toThrow("废弃或越权指令");
  });

  it("rejects unregistered markdown", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "prompts", "extra.md"), "# extra\n", "utf8");
    await expect(loadPromptRegistryV3(root)).rejects.toThrow("未注册 Markdown");
  });

  it("can temporarily tolerate only numbered legacy root prompts before cutover", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "prompts", "00-旅行规划Agent.md"), "# legacy\n", "utf8");
    await expect(loadPromptRegistryV3(root)).rejects.toThrow("未注册 Markdown");
    await expect(loadPromptRegistryV3(root, { allowLegacyFiles: true })).resolves.toBeTruthy();
  });
});
