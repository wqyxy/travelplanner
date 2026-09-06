import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("Phase 5 final route polish contract", () => {
  it("keeps AI controls collapsed until the user opens the single AI menu", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    const css = source("./phase5-final-route-polish.css");
    expect(panel).toContain('className="final-route-ai-menu-v5"');
    expect(panel).toContain("AI 操作");
    for (const label of ["生成详细地点", "补充详细地点", "完善这一天", "优化这一天", "补充这一段", "优化这一段", "优化全程"]) expect(panel).toContain(label);
    expect(css).toContain(".final-route-ai-menu-v5>summary");
    expect(css).toContain(".final-route-ai-menu-body-v5");
  });

  it("shows every pending proposal compactly and limits only settled history", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    expect(panel).toContain("pendingAiProposals");
    expect(panel).toContain('visibleAiProposals.filter(({ proposal }) => proposal.status === "pending")');
    expect(panel).toContain('visibleAiProposals.filter(({ proposal }) => proposal.status !== "pending").slice(0, 8)');
    expect(panel).toContain('className="final-route-proposal-v5"');
    expect(panel).toContain('className="final-route-ai-history-v5"');
    expect(panel).not.toContain("phase6-proposal-card");
  });

  it("makes the add position explicit, defaults to route end, and disambiguates repeated place occurrences", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    expect(panel).toContain("ADD_AT_START");
    expect(panel).toContain("ADD_AT_END");
    expect(panel).toContain("addPosition");
    expect(panel).toContain("setAddPosition(ADD_AT_END)");
    expect(panel).toContain("插入位置");
    expect(panel).toContain("将插入到：{addPositionLabel}");
    expect(panel).toContain("在第 {row.index + 1} 个地点");
    expect(panel).toContain("插入位置始终以这里显示的选择为准");
  });

  it("uses product-native remove confirmation and keeps route-node deletion scoped to one occurrence", () => {
    const drawer = source("./FinalRouteEditorDrawerV4.tsx");
    expect(drawer).toContain("removeConfirmOpen");
    expect(drawer).toContain("final-route-remove-confirm-v5");
    expect(drawer).toContain("确认移除");
    expect(drawer).toContain("只删除当前 route node");
    expect(drawer).not.toContain("window.confirm");
  });

  it("never uses itinerary activity as the display-name fallback", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    const drawer = source("./FinalRouteEditorDrawerV4.tsx");
    expect(panel).not.toContain('row.node.activity || "未命名地点"');
    expect(drawer).not.toContain('row.node.activity || "未命名地点"');
    expect(drawer).toContain('placeNamePresentation(row.place, workspace.trip.planLanguage, "未命名地点")');
  });

  it("shows unavailable provider routes explicitly and closes transport editing when its effective connection disappears", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    const css = source("./phase5-final-route-polish.css");
    expect(panel).toContain('if (connection.state === "unavailable") return "路线暂不可用"');
    expect(panel).toContain('if (!current || current.state === "same_place") setTransportEditingNodeId(null)');
    expect(css).toContain(".final-route-transport-connector-v4.state-unavailable");
  });

  it("keeps desktop ordering handle-only but exposes up/down fallback in the narrow layout", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    const css = source("./phase5-final-route-polish.css");
    expect(panel).toContain('className="final-route-mobile-order-v5"');
    expect(panel).toContain("row.index - 1");
    expect(panel).toContain("row.index + 1");
    expect(css).toContain(".final-route-mobile-order-v5{display:none}");
    expect(css).toContain(".final-route-mobile-order-v5{display:flex");
  });

  it("loads Phase 5 after Phase 4 so compact polish styles win without changing the core interaction CSS", () => {
    const main = source("./main.tsx");
    expect(main).toContain('import "./phase4-final-route-interaction.css"');
    expect(main).toContain('import "./phase5-final-route-polish.css"');
    expect(main.indexOf('import "./phase4-final-route-interaction.css"')).toBeLessThan(main.indexOf('import "./phase5-final-route-polish.css"'));
  });
});
