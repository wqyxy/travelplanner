import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DETAIL_PROMPT_VERSION, loadAgentPrompts, PLANNER_PROMPT_VERSION } from "./prompt-contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("Prompt contracts", () => {
  it("loads exactly the planner, detailer and candidate prompts", async () => {
    const prompts = await loadAgentPrompts(root);
    expect(Object.keys(prompts).sort()).toEqual(["candidate", "detailer", "planner"]);
    expect(prompts.planner.relativePath).toBe("prompts/00-旅行规划Agent.md");
    expect(prompts.detailer.relativePath).toBe("prompts/01-行程细化Agent.md");
    expect(prompts.candidate.relativePath).toBe("prompts/02-地图候选消歧Agent.md");
    expect(PLANNER_PROMPT_VERSION).toBe(9);
    expect(DETAIL_PROMPT_VERSION).toBe(3);
    expect(prompts.planner.content).toContain("Place 的 `kind` 表示地点实体本身");
    expect(prompts.planner.content).toContain("初稿不编造公里数或驾驶时长");
    expect(prompts.planner.content).toContain("相邻 Stop 引用不同 Place 时交通不得缺失");
    expect(prompts.planner.content).toContain("途经地点必须落实为实际 Stop");
    expect(prompts.planner.content).toContain('`nextAction!="none"` 时 `suggestion` 必须为 `null`');
    expect(prompts.detailer.content).toContain("完整城市游览日必须把笼统的城市活动展开");
    expect(prompts.detailer.content).toContain("不是固定数量");
    expect(prompts.detailer.content).toContain("相邻活动之间的空档必须容纳交通时长");
    expect(new Set(Object.values(prompts).map((prompt) => prompt.sha256)).size).toBe(3);
  });
});
