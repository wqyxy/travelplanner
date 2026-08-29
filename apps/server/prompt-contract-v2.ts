import { promises as fs } from "node:fs";
import path from "node:path";

export const V2_PROMPT_FILES = {
  planner: "00-旅行规划Agent.md",
  detailer: "01-行程细化Agent.md",
  mapResolver: "02-地图候选消歧Agent.md",
  interestDiscovery: "03-兴趣点发现Agent.md",
} as const;

export type PromptDocumentV2 = { filename: string; content: string };
export type AgentPromptsV2 = {
  planner: PromptDocumentV2;
  detailer: PromptDocumentV2;
  mapResolver: PromptDocumentV2;
  interestDiscovery: PromptDocumentV2;
};

function validatePrompt(filename: string, content: string) {
  const value = content.trim();
  if (!value) throw new Error(`${filename} 不能为空。`);
  if (/03-地图坐标搜索Agent|CoordinateResearch|直接生成(?:可信)?坐标|输出(?:经纬度|坐标)/iu.test(value)) {
    throw new Error(`${filename} 包含已废弃的坐标 Agent 或坐标输出指令。`);
  }
  return { filename, content: value };
}

export async function loadAgentPromptsV2(root: string): Promise<AgentPromptsV2> {
  const promptRoot = path.join(root, "prompts");
  const files = await fs.readdir(promptRoot);
  const agentFiles = files.filter((filename) => /^\d{2}-.*Agent\.md$/u.test(filename)).sort();
  const expected = Object.values(V2_PROMPT_FILES).sort();
  if (agentFiles.length !== expected.length || agentFiles.some((filename, index) => filename !== expected[index])) {
    throw new Error(`v3 只允许 00/01/02/03 四份 Agent Prompt；当前为：${agentFiles.join(", ") || "无"}`);
  }
  const read = async (filename: string) => validatePrompt(filename, await fs.readFile(path.join(promptRoot, filename), "utf8"));
  return {
    planner: await read(V2_PROMPT_FILES.planner),
    detailer: await read(V2_PROMPT_FILES.detailer),
    mapResolver: await read(V2_PROMPT_FILES.mapResolver),
    interestDiscovery: await read(V2_PROMPT_FILES.interestDiscovery),
  };
}
