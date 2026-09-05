import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("Phase 2 final route app cutover", () => {
  it("mounts the two-workspace app instead of the old five-step app", () => {
    const main = source("./main.tsx");
    expect(main).toContain('import AppFinalRouteV3 from "./AppFinalRouteV3"');
    expect(main).toContain("<AppFinalRouteV3/>");
    expect(main).not.toContain("<AppWorkflowV3/>");
  });

  it("exposes only the planning and final-route workspace navigation in the mounted app", () => {
    const app = source("./AppFinalRouteV3.tsx");
    expect(app).toContain("规划 · 旅行需求");
    expect(app).toContain("行程 · 最终线路");
    expect(app).not.toContain("想去哪些地方</b>");
    expect(app).not.toContain("路线和天数</b>");
    expect(app).not.toContain("补充景点</b>");
    expect(app).not.toContain("每日行程</b>");
  });

  it("keeps route business controls out of the map component", () => {
    const map = source("./FinalRouteMapV3.tsx");
    for (const forbidden of ["从线路移除", "多一晚", "不住", "set_final_route_status", "remove_final_route_node"]) expect(map).not.toContain(forbidden);
    expect(map).toContain("onSelectNode");
    expect(map).toContain("mapPickPlaceId");
  });
});
