import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const PLANNER_PROMPT_ID = "travel-planner-agent";
export const PLANNER_PROMPT_VERSION = 11;
export const DETAIL_PROMPT_ID = "travel-itinerary-detail-agent";
export const DETAIL_PROMPT_VERSION = 5;
export const CANDIDATE_PROMPT_ID = "travel-map-candidate-agent";
export const CANDIDATE_PROMPT_VERSION = 1;
export const COORDINATE_RESEARCH_PROMPT_ID = "travel-map-coordinate-research-agent";
export const COORDINATE_RESEARCH_PROMPT_VERSION = 1;

type PromptSpec = { relativePath: string; id: string; version: number; label: string };
export type LoadedPrompt = { relativePath: string; content: string; sha256: string };

async function loadPrompt(root: string, spec: PromptSpec): Promise<LoadedPrompt> {
  const content = (await fs.readFile(path.join(root, spec.relativePath), "utf8")).replace(/^\uFEFF/, "");
  const ids = [...content.matchAll(/<!--\s*prompt-id:\s*([^\s]+)\s*-->/g)];
  const versions = [...content.matchAll(/<!--\s*prompt-version:\s*([^\s]+)\s*-->/g)];
  if (ids.length !== 1 || ids[0][1] !== spec.id || versions.length !== 1 || Number(versions[0][1]) !== spec.version) throw new Error(`${spec.label} Prompt 合同校验失败。`);
  if (!content.replace(/<!--[^>]+-->/g, "").trim()) throw new Error(`${spec.label} Prompt 不能为空。`);
  return { relativePath: spec.relativePath, content: content.trim(), sha256: createHash("sha256").update(content, "utf8").digest("hex") };
}

export async function loadPlannerPrompt(root: string) { return loadPrompt(root, { relativePath: "prompts/00-旅行规划Agent.md", id: PLANNER_PROMPT_ID, version: PLANNER_PROMPT_VERSION, label: "旅行规划 Agent" }); }
export async function loadDetailPrompt(root: string) { return loadPrompt(root, { relativePath: "prompts/01-行程细化Agent.md", id: DETAIL_PROMPT_ID, version: DETAIL_PROMPT_VERSION, label: "行程细化 Agent" }); }
export async function loadCandidatePrompt(root: string) { return loadPrompt(root, { relativePath: "prompts/02-地图候选消歧Agent.md", id: CANDIDATE_PROMPT_ID, version: CANDIDATE_PROMPT_VERSION, label: "地图候选消歧 Agent" }); }
export async function loadCoordinateResearchPrompt(root: string) { return loadPrompt(root, { relativePath: "prompts/03-地图坐标搜索Agent.md", id: COORDINATE_RESEARCH_PROMPT_ID, version: COORDINATE_RESEARCH_PROMPT_VERSION, label: "地图坐标搜索 Agent" }); }

export async function loadAgentPrompts(root: string) {
  const [planner, detailer, candidate, coordinateResearch] = await Promise.all([loadPlannerPrompt(root), loadDetailPrompt(root), loadCandidatePrompt(root), loadCoordinateResearchPrompt(root)]);
  const loaded = [planner, detailer, candidate, coordinateResearch];
  if (new Set(loaded.map((prompt) => prompt.sha256)).size !== loaded.length) throw new Error("Agent Prompt 内容不能重复或混用。");
  return { planner, detailer, candidate, coordinateResearch };
}
