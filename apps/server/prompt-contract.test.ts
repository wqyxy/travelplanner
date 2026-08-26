import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COORDINATE_RESEARCH_PROMPT_VERSION, DETAIL_PROMPT_VERSION, loadAgentPrompts, PLANNER_PROMPT_VERSION } from "./prompt-contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("Prompt contracts", () => {
  it("loads the planner, detailer, candidate and coordinate-research prompts", async () => {
    const prompts = await loadAgentPrompts(root);
    expect(Object.keys(prompts).sort()).toEqual(["candidate", "coordinateResearch", "detailer", "planner"]);
    expect(prompts.planner.relativePath).toBe("prompts/00-旅行规划Agent.md");
    expect(prompts.detailer.relativePath).toBe("prompts/01-行程细化Agent.md");
    expect(prompts.candidate.relativePath).toBe("prompts/02-地图候选消歧Agent.md");
    expect(prompts.coordinateResearch.relativePath).toBe("prompts/03-地图坐标搜索Agent.md");
    expect(PLANNER_PROMPT_VERSION).toBe(11);
    expect(DETAIL_PROMPT_VERSION).toBe(5);
    expect(COORDINATE_RESEARCH_PROMPT_VERSION).toBe(1);
    expect(prompts.planner.content).toContain("Place 的 `kind` 表示地点实体本身");
    expect(prompts.planner.content).toContain("初稿不编造公里数或驾驶时长");
    expect(prompts.planner.content).toContain("相邻 Stop 引用不同 Place 时交通不得缺失");
    expect(prompts.planner.content).toContain("途经地点必须落实为实际 Stop");
    expect(prompts.planner.content).toContain("前一日末 Stop 与后一日首 Stop 必须引用同一 Place");
    expect(prompts.planner.content).toContain("首 Stop 的 `transportFromPrevious` 始终为 `null`");
    expect(prompts.planner.content).toContain("输出前逐一自检所有受影响日期边界");
    expect(prompts.planner.content).toContain('`nextAction!="none"` 时 `suggestion` 必须为 `null`');
    expect(prompts.detailer.content).toContain("完整城市游览日必须把笼统的城市活动展开");
    expect(prompts.detailer.content).toContain("不是固定数量");
    expect(prompts.detailer.content).toContain("它占用的是前一 Stop 结束到当前 Stop 开始之间的时间");
    expect(prompts.detailer.content).toContain("current.startTime >= previous.endTime + transportFromPrevious.durationMinutes");
    expect(prompts.detailer.content).toContain("交通空档低于估时 75% 的复核提示");
    expect(prompts.candidate.content).toContain("不得搜索网页");
    expect(prompts.coordinateResearch.content).toContain("可以使用网页搜索");
    expect(new Set(Object.values(prompts).map((prompt) => prompt.sha256)).size).toBe(4);
  });
});
