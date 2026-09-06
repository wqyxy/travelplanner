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

  it("offers scoped recovery for unavailable routes and unresolved places", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    const app = source("./AppFinalRouteV3.tsx");
    const css = source("./phase5-final-route-polish.css");
    expect(panel).toContain("unavailableRouteMessage");
    expect(panel).toContain("起点和终点未定位，完成定位后才能获取路线");
    expect(panel).toContain("重新获取线路");
    expect(panel).toContain("onRecalculateRoute(effectiveConnection.dayId)");
    expect(panel).toContain("重新定位");
    expect(panel).toContain("选择备选");
    expect(panel).toContain("openResolutionChoices");
    expect(panel).toContain("final-route-resolution-choice-v5");
    expect(app).toContain("resolutions/${encodeURIComponent(placeId)}/candidates?expectedGeneration=");
    expect(app).toContain("resolutions/${encodeURIComponent(placeId)}/select");
    expect(app).toContain("routes/${encodeURIComponent(dayId)}/recalculate");
    expect(css).toContain(".final-route-recalculate-connection-v5:disabled");
    expect(css).toContain(".final-route-location-actions-v5");
  });

  it("syncs the map by locating unresolved places before recalculating unavailable routes", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    const app = source("./AppFinalRouteV3.tsx");
    const server = readFileSync(fileURLToPath(new URL("../../server/final-route-ai-v3.ts", import.meta.url)), "utf8");
    const css = source("./phase5-final-route-polish.css");
    expect(panel).toContain('className="final-route-panel-header-actions-v5"');
    expect(panel).toContain('className="final-route-sync-hint-v5"');
    expect(panel).toContain('onClick={() => void onSyncMap(unresolvedPlaceIds, unavailableRouteDayIds)}');
    expect(app).toContain('force: true');
    expect(app).toContain('await Promise.all(uniqueDayIds.map');
    expect(server).toContain('newNodes.map((candidate) => emptyRouteNode({ placeId: candidate.placeId, transportMode: "drive" }))');
    expect(css).toContain('.final-route-panel-header-actions-v5');
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

  it("uses compact icon status controls, a stay toggle, and copy/delete actions on the place row", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    const css = source("./phase5-final-route-polish.css");
    for (const mark of ["★", "○", "×"]) expect(panel).toContain(mark);
    expect(panel).toContain('aria-label={row.node.endsDay ? "不住" : "住"}');
    expect(panel).toContain('onClick={() => void onSetBoundary(row.node.id, !row.node.endsDay)}');
    expect(panel).not.toContain("不住</button>");
    expect(panel).not.toContain("多住晚");
    expect(panel).not.toContain("final-route-stay-menu-v4");
    expect(panel).not.toContain("final-route-status-menu-v4");
    expect(panel).toContain('className="final-route-copy-action-v5"');
    expect(panel).toContain('className="final-route-delete-action-v5"');
    expect(panel).toContain('className="final-route-delete-confirm-v5"');
    expect(css).toContain(".final-route-quick-v4{grid-column:3;grid-row:1");
    expect(css).toContain("color:#e05c45!important");
    expect(css).toContain(".final-route-quick-button-v5.status.tentative{color:#c58b2b!important}");
    expect(css).toContain(".final-route-quick-button-v5.status.no_go{color:#667085!important}");
  });

  it("links route hover to the map line and toggles focused map view back to the full route", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    const map = source("./FinalRouteMapV3.tsx");
    const css = source("./phase5-final-route-polish.css");
    expect(panel).toContain('onMouseEnter={() => onHoverNode(row.node.id)}');
    expect(panel).toContain('onMouseEnter={() => onHoverRoute(effectiveConnection.toNodeId, effectiveConnection.toPlaceId)}');
    expect(panel).toContain('onFocusNode(row.node.id)');
    expect(panel).toContain('onFocusRoute(effectiveConnection.toNodeId, effectiveConnection.toPlaceId)');
    expect(map).toContain('final-route-lines-hit');
    expect(map).toContain('final-route-line-labels');
    expect(map).toContain('const viewKind = focusRequest.kind ?? "node"');
    expect(map).toContain('focusRouteRef.current(nodeId, routePlaceId)');
    expect(map).toContain('routeCoordinates(feature.geometry)');
    expect(map).toContain('focusedViewKey.current === targetKey');
    expect(map).toContain('const routeHoverId = hoveredRouteNodeId || "__none__"');
    expect(map).toContain('const routeNodeId = hoveredRouteNodeId');
    expect(map).toContain('metrics.textContent = route.properties.summary');
    expect(css).toContain('.final-route-transport-connector-v4.hover-linked');
  });

  it("loads Phase 5 after Phase 4 so compact polish styles win without changing the core interaction CSS", () => {
    const main = source("./main.tsx");
    expect(main).toContain('import "./phase4-final-route-interaction.css"');
    expect(main).toContain('import "./phase5-final-route-polish.css"');
    expect(main.indexOf('import "./phase4-final-route-interaction.css"')).toBeLessThan(main.indexOf('import "./phase5-final-route-polish.css"'));
  });
});
