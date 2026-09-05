import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const serverSource = (name: string) => readFileSync(fileURLToPath(new URL(`../../server/${name}`, import.meta.url)), "utf8");

describe("Phase 3 final route AI cutover", () => {
  it("keeps every AI planning entry in the right-side final-route panel", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    for (const label of ["生成主要地点", "生成详细地点", "补充详细地点", "优化这一天", "优化这一段", "优化全程"]) expect(panel).toContain(label);
    expect(panel).toContain('"destination.generate"');
    expect(panel).toContain('"interest.discover"');
    expect(panel).toContain('"itinerary.day.optimize"');
    expect(panel).toContain('"itinerary.repair"');
    expect(panel).not.toContain('"itinerary.generate"');
    expect(panel).not.toContain('"itinerary.detail.generate"');
  });

  it("does not reintroduce route business buttons into the map", () => {
    const map = source("./FinalRouteMapV3.tsx");
    for (const label of ["生成主要地点", "生成详细地点", "优化这一天", "优化这一段", "优化全程", "多一晚", "从线路移除"]) expect(map).not.toContain(label);
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

  it("uses final-route language instead of the removed five-step product language in rewritten AI prompts", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const readPrompt = (path: string) => readFileSync(`${root}/prompts/${path}`, "utf8");
    const main = readPrompt("actions/destinations/生成目的地建议.md");
    const details = readPrompt("actions/interests/发现兴趣点.md");
    const optimize = readPrompt("actions/itinerary/优化单日游览顺序.md");
    expect(main).toContain("最终线路");
    expect(details).toContain("已有最终线路节点的相对顺序必须保持不变");
    expect(optimize).toContain("只有用户明确启动本动作");
    for (const prompt of [main, details, optimize]) {
      expect(prompt).not.toContain("Step 2");
      expect(prompt).not.toContain("Step 3");
      expect(prompt).not.toContain("Step 4");
      expect(prompt).not.toContain("Step 5");
    }
  });
});
