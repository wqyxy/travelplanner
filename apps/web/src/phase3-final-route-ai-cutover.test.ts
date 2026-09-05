import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const serverSource = (name: string) => readFileSync(fileURLToPath(new URL(`../../server/${name}`, import.meta.url)), "utf8");

describe("Phase 3 final route AI cutover", () => {
  it("keeps every AI planning entry in the right-side final-route panel", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    for (const label of ["生成主要地点", "生成详细地点", "补充详细地点", "完善这一天", "优化这一天", "优化这一段", "优化全程"]) expect(panel).toContain(label);
    expect(panel).toContain('"destination.generate"');
    expect(panel).toContain('"interest.discover"');
    expect(panel).toContain('"itinerary.refine"');
    expect(panel).toContain('"itinerary.day.optimize"');
    expect(panel).toContain('"itinerary.repair"');
    expect(panel).not.toContain('"itinerary.generate"');
    expect(panel).not.toContain('"itinerary.detail.generate"');
  });

  it("keeps detailed time and notes editable inside the final-route panel instead of restoring Step 5", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    for (const label of ["详细安排", "活动说明", "时段", "开始时间", "结束时间", "停留分钟", "备注", "保存详细安排"]) expect(panel).toContain(label);
    expect(panel).toContain('actionType: "itinerary.edit"');
    expect(panel).toContain("selectedStopOwner");
  });

  it("does not reintroduce route business buttons into the map", () => {
    const map = source("./FinalRouteMapV3.tsx");
    for (const label of ["生成主要地点", "生成详细地点", "完善这一天", "优化这一天", "优化这一段", "优化全程", "多一晚", "从线路移除"]) expect(map).not.toContain(label);
  });

  it("installs the final-route AI persistence cutover before the server runtime is constructed", () => {
    const entry = serverSource("index-cutover-v3.ts");
    const cutover = serverSource("final-route-ai-cutover-v3.ts");
    expect(entry).toContain('import "./final-route-ai-cutover-v3.js"');
    expect(cutover).toContain('source === "action:destination.generate"');
    expect(cutover).toContain('source === "action:interest.discover"');
    expect(cutover).toContain("finalRouteMoveCommandsForOrderedSubsetV3");
    expect(cutover).toContain('const scope: ProposalScope = { type: "trip", id: null }');
  });

  it("fails closed on requested Day scope, protects refine facts, and refreshes routes after optimization apply or undo", () => {
    const cutover = serverSource("final-route-ai-cutover-v3.ts");
    expect(cutover).toContain("requestedDayId");
    expect(cutover).toContain("result.dayId !== requestedDayId");
    expect(cutover).toContain("persistFinalRouteDayDetails");
    expect(cutover).toContain("stop.transportFromPrevious = structuredClone(current.transportFromPrevious)");
    expect(cutover).toContain("stop.scheduleVerification = structuredClone(current.scheduleVerification)");
    expect(cutover).toContain("originalApplyProposal");
    expect(cutover).toContain("originalUndoProposal");
    expect(cutover).toContain("runtime.startRouteBatch");
  });

  it("uses final-route language instead of the removed five-step product language in rewritten AI prompts", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const readPrompt = (path: string) => readFileSync(`${root}/prompts/${path}`, "utf8");
    const main = readPrompt("actions/destinations/生成目的地建议.md");
    const details = readPrompt("actions/interests/发现兴趣点.md");
    const refine = readPrompt("actions/itinerary/细化每日行程.md");
    const optimize = readPrompt("actions/itinerary/优化单日游览顺序.md");
    expect(main).toContain("最终线路");
    expect(details).toContain("已有最终线路节点的相对顺序必须保持不变");
    expect(refine).toContain("补充详细安排");
    expect(refine).toContain("不得改变当前 Stop 顺序");
    expect(optimize).toContain("只有用户明确启动本动作");
    for (const prompt of [main, details, refine, optimize]) {
      expect(prompt).not.toContain("Step 2");
      expect(prompt).not.toContain("Step 3");
      expect(prompt).not.toContain("Step 4");
      expect(prompt).not.toContain("Step 5");
    }
  });
});
