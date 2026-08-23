import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
export const TRAVEL_PROMPT_ID = "travel-planner-agent";
export const TRAVEL_PROMPT_VERSION = 3;
export const MAP_PROMPT_ID = "travel-map-agent";
export const MAP_PROMPT_VERSION = 5;
export const DAILY_DETAIL_PROMPT_ID = "travel-daily-detail-agent";
export const DAILY_DETAIL_PROMPT_VERSION = 1;
export const DAILY_REPAIR_PROMPT_ID = "travel-daily-repair-agent";
export const DAILY_REPAIR_PROMPT_VERSION = 1;
export const TRANSPORT_VERIFY_PROMPT_ID = "travel-transport-verification-agent";
export const TRANSPORT_VERIFY_PROMPT_VERSION = 1;
export const ROUTE_REPAIR_PROMPT_ID = "travel-route-repair-agent";
export const ROUTE_REPAIR_PROMPT_VERSION = 1;
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
export async function loadDailyDetailPrompt(root: string) { return loadPrompt(root, { relativePath: "prompts/02-每日细化Agent.md", id: DAILY_DETAIL_PROMPT_ID, version: DAILY_DETAIL_PROMPT_VERSION, label: "每日细化 Agent" }); }
export async function loadDailyRepairPrompt(root: string) { return loadPrompt(root, { relativePath: "prompts/03-每日修复Agent.md", id: DAILY_REPAIR_PROMPT_ID, version: DAILY_REPAIR_PROMPT_VERSION, label: "每日修复 Agent" }); }
export async function loadTransportVerifyPrompt(root: string) { return loadPrompt(root, { relativePath: "prompts/04-关键交通核验Agent.md", id: TRANSPORT_VERIFY_PROMPT_ID, version: TRANSPORT_VERIFY_PROMPT_VERSION, label: "关键交通核验 Agent" }); }
export async function loadRouteRepairPrompt(root: string) { return loadPrompt(root, { relativePath: "prompts/05-路线修复Agent.md", id: ROUTE_REPAIR_PROMPT_ID, version: ROUTE_REPAIR_PROMPT_VERSION, label: "路线修复 Agent" }); }
export async function loadAgentPrompts(root: string) {
  const [travel, mapPrompt, dailyDetail, dailyRepair, transportVerify, routeRepair] = await Promise.all([loadTravelPrompt(root), loadMapPrompt(root), loadDailyDetailPrompt(root), loadDailyRepairPrompt(root), loadTransportVerifyPrompt(root), loadRouteRepairPrompt(root)]);
  const loaded = [travel, mapPrompt, dailyDetail, dailyRepair, transportVerify, routeRepair]; if (new Set(loaded.map((prompt) => prompt.sha256)).size !== loaded.length) throw new Error("Agent Prompt 内容不能重复或混用。");
  return { travel, map: mapPrompt, dailyDetail, dailyRepair, transportVerify, routeRepair };
}
