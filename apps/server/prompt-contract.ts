import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
export const TRAVEL_PROMPT_ID = "travel-planner-agent";
export const TRAVEL_PROMPT_VERSION = 1;
export async function loadTravelPrompt(root: string) { const relativePath = "prompts/00-旅行规划Agent.md"; const content = (await fs.readFile(path.join(root, relativePath), "utf8")).replace(/^\uFEFF/, ""); const id = [...content.matchAll(/<!--\s*prompt-id:\s*([^\s]+)\s*-->/g)]; const version = [...content.matchAll(/<!--\s*prompt-version:\s*([^\s]+)\s*-->/g)]; if (id.length !== 1 || id[0][1] !== TRAVEL_PROMPT_ID || version.length !== 1 || Number(version[0][1]) !== TRAVEL_PROMPT_VERSION) throw new Error("旅行 Agent Prompt 合同校验失败。"); if (!content.replace(/<!--[^>]+-->/g, "").trim()) throw new Error("旅行 Agent Prompt 不能为空。"); return { relativePath, content: content.trim(), sha256: createHash("sha256").update(content, "utf8").digest("hex") }; }
