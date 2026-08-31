import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PROMPT_REGISTRY_V3, promptRegistration, validateRegistryDefinitionsV3 } from "./ai-registries-v3.js";
import type { PromptIdV3 } from "./ai-stage-contracts-v3.js";

export type LoadedPromptV3 = {
  id: PromptIdV3;
  relativePath: string;
  content: string;
  hash: string;
  version: string;
};

export type LoadedPromptRegistryV3 = {
  prompts: ReadonlyMap<PromptIdV3, LoadedPromptV3>;
  get: (id: PromptIdV3) => LoadedPromptV3;
  compose: (id: Exclude<PromptIdV3, "shared.travel-rules">) => LoadedPromptV3;
};

const LEGACY_PROMPT_PATTERN = /^\d{2}-.*Agent\.md$/u;
const LEGACY_FORBIDDEN_PROMPT_PATTERN = /03-地图坐标搜索Agent|CoordinateResearch/iu;
const FORBIDDEN_OPERATION_PATTERN = /(?:直接生成(?:可信)?坐标|输出(?:经纬度|坐标)|执行\s*(?:Shell|命令)|调用\s*MCP|创建(?:子)?\s*Agent)/iu;
const FORBIDDEN_DIRECTIVE_CANDIDATE_PATTERN = /(?:请|必须|允许|可以).{0,48}(?:直接生成(?:可信)?坐标|输出(?:经纬度|坐标)|执行\s*(?:Shell|命令)|调用\s*MCP|创建(?:子)?\s*Agent)/giu;
const NEGATED_FORBIDDEN_OPERATION_PATTERN = /(?:不得|不能|不可|禁止|不要|不应|不允许|严禁|勿)\s*(?:直接|自行|主动|私自)?\s*(?:直接生成(?:可信)?坐标|输出(?:经纬度|坐标)|执行\s*(?:Shell|命令)|调用\s*MCP|创建(?:子)?\s*Agent)/iu;

function normalizeRelative(value: string) {
  return value.split(path.sep).join("/");
}

async function listMarkdown(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...await listMarkdown(root, child));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(normalizeRelative(child));
  }
  return result.sort();
}

function containsForbiddenDirective(value: string) {
  if (LEGACY_FORBIDDEN_PROMPT_PATTERN.test(value)) return true;
  for (const match of value.matchAll(FORBIDDEN_DIRECTIVE_CANDIDATE_PATTERN)) {
    const candidate = match[0];
    if (!FORBIDDEN_OPERATION_PATTERN.test(candidate)) continue;
    if (NEGATED_FORBIDDEN_OPERATION_PATTERN.test(candidate)) continue;
    return true;
  }
  return false;
}

function validatePromptContent(relativePath: string, content: string) {
  const value = content.trim();
  if (!value) throw new Error(`Prompt 不能为空：${relativePath}`);
  if (containsForbiddenDirective(value)) throw new Error(`Prompt 包含废弃或越权指令：${relativePath}`);
  return value;
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function loadPromptRegistryV3(root: string, options: { allowLegacyFiles?: boolean } = {}): Promise<LoadedPromptRegistryV3> {
  validateRegistryDefinitionsV3();
  const promptRoot = path.join(root, "prompts");
  const actual = await listMarkdown(promptRoot);
  const expected = new Set(PROMPT_REGISTRY_V3.map((item) => normalizeRelative(item.relativePath)));
  const extras = actual.filter((item) => !expected.has(item) && !(options.allowLegacyFiles && !item.includes("/") && LEGACY_PROMPT_PATTERN.test(item)));
  if (extras.length) throw new Error(`prompts/ 存在未注册 Markdown：${extras.join(", ")}`);
  const missing = [...expected].filter((item) => !actual.includes(item));
  if (missing.length) throw new Error(`缺少已注册 Prompt：${missing.join(", ")}`);

  const loaded = new Map<PromptIdV3, LoadedPromptV3>();
  for (const registration of PROMPT_REGISTRY_V3) {
    const relativePath = normalizeRelative(registration.relativePath);
    const content = validatePromptContent(relativePath, await fs.readFile(path.join(promptRoot, relativePath), "utf8"));
    const digest = hash(content);
    loaded.set(registration.id, { id: registration.id, relativePath, content, hash: digest, version: `v1:${digest.slice(0, 16)}` });
  }

  const get = (id: PromptIdV3) => {
    const value = loaded.get(id);
    if (!value) throw new Error(`Prompt 未加载：${id}`);
    return value;
  };
  const compose = (id: Exclude<PromptIdV3, "shared.travel-rules">) => {
    const registration = promptRegistration(id);
    if (registration.kind === "shared") throw new Error("shared Prompt 不能作为具体 Agent Prompt 运行。");
    const shared = get("shared.travel-rules");
    const specific = get(id);
    const content = `${shared.content}\n\n${specific.content}`;
    const digest = hash(content);
    return { ...specific, content, hash: digest, version: `v1:${digest.slice(0, 16)}` };
  };
  return { prompts: loaded, get, compose };
}
