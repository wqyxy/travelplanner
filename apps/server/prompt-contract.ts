import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
export const TRAVEL_PROMPT_ID = "travel-planner-agent";
export const TRAVEL_PROMPT_VERSION = 2;
export const MAP_PROMPT_ID = "travel-map-agent";
export const MAP_PROMPT_VERSION = 5;
type PromptSpec = { relativePath: string; id: string; version: number; label: string };
async function loadPrompt(root: string, spec: PromptSpec) {
  const content = (await fs.readFile(path.join(root, spec.relativePath), "utf8")).replace(/^\uFEFF/, "");
  const ids = [...content.matchAll(/<!--\s*prompt-id:\s*([^\s]+)\s*-->/g)];
  const versions = [...content.matchAll(/<!--\s*prompt-version:\s*([^\s]+)\s*-->/g)];
  if (ids.length !== 1 || ids[0][1] !== spec.id || versions.length !== 1 || Number(versions[0][1]) !== spec.version) throw new Error(`${spec.label} Prompt 合同校验失败。`);
  if (!content.replace(/<!--[^>]+-->/g, "").trim()) throw new Error(`${spec.label} Prompt 不能为空。`);
  return { relativePath: spec.relativePath, content: content.trim(), sha256: createHash("sha256").update(content, "utf8").digest("hex") };
}
export async function loadTravelPrompt(root: string) { return loadPrompt(root, { relativePath: "prompts/00-旅行规划Agent.md", id: TRAVEL_PROMPT_ID, version: TRAVEL_PROMPT_VERSION, label: "旅行 Agent" }); }
export async function loadMapPrompt(root: string) { return loadPrompt(root, { relativePath: "prompts/01-地图标注Agent.md", id: MAP_PROMPT_ID, version: MAP_PROMPT_VERSION, label: "地图 Agent" }); }
export async function loadAgentPrompts(root: string) {
  const [travel, mapPrompt] = await Promise.all([loadTravelPrompt(root), loadMapPrompt(root)]);
  if (travel.sha256 === mapPrompt.sha256) throw new Error("Agent Prompt 内容不能重复。");
  return { travel, map: mapPrompt };
}
