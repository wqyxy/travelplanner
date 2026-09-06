import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("Phase 4 final route interaction contract", () => {
  it("separates hover, map selection, and editing state", () => {
    const app = source("./AppFinalRouteV3.tsx");
    expect(app).toContain("hoveredNodeId");
    expect(app).toContain("editingNodeId");
    expect(app).toContain("mapFocusRequest");
    expect(app).toContain("mapPickReturnNodeId");
    expect(app).toContain("onHoverNode={setHoveredNodeId}");
    expect(app).toContain("onEditNode={setEditingNodeId}");
  });

  it("does not fly the map merely because selection or hover changed", () => {
    const map = source("./FinalRouteMapV3.tsx");
    expect(map).toContain("hoveredNodeId");
    expect(map).toContain("focusRequest");
    expect(map).toContain("map.flyTo");
    expect(map).not.toContain("!selectedNodeId) return");
    expect(map).not.toContain("[points, ready, selectedNodeId]");
  });

  it("renders every route node as the same place card and keeps Day out of place names", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    expect(panel).toContain('placeNamePresentation(row.place, workspace.trip.planLanguage, "未命名地点")');
    expect(panel).not.toContain('row.node.activity || "未命名地点"');
    expect(panel).not.toContain("final-route-day-divider-v3");
    expect(panel).not.toContain("final-route-day-title-v4");
    expect(panel).toContain("final-route-night-divider-v4");
    expect(panel).toContain("第 {row.dayNumber} 晚");
  });

  it("keeps place editing out of the inline route list", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    const drawer = source("./FinalRouteEditorDrawerV4.tsx");
    expect(panel).toContain("final-route-transport-connector-v4");
    expect(panel).toContain("FinalRouteEditorDrawerV4");
    expect(panel).toContain("onMouseEnter={() => onHoverNode(row.node.id)}");
    expect(panel).toContain("onFocusNode(row.node.id)");
    expect(panel).not.toContain("final-route-editor-v3");
    expect(drawer).toContain("final-route-editor-drawer-v4");
    expect(drawer).toContain("地图选点");
  });

  it("starts drag only from the handle while the whole place card follows as the drag image", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    const css = source("./phase4-final-route-interaction.css");
    expect(panel).toContain('className="final-route-drag-v3"');
    expect(panel).toContain("draggable={!busy && !aiBusy}");
    expect(panel).toContain('event.currentTarget.closest(".final-route-row-v3")');
    expect(panel).toContain("event.dataTransfer.setDragImage(card, 22, 22)");
    expect(panel).toContain("finalRouteMoveTargetIndexV4");
    expect(panel).toContain('`drop-${currentDrop}`');
    expect(css).toContain(".final-route-row-v3.dragging");
    expect(css).toContain(".final-route-row-v3.drop-before:before");
    expect(css).toContain(".final-route-row-v3.drop-after:after");
  });

  it("does not offer transport editing for the synthetic same-place hop created by another night", () => {
    const panel = source("./FinalRoutePanelV3.tsx");
    expect(panel).toContain('if (connection.state === "same_place") return "同地停留"');
    expect(panel).toContain('connection.state === "same_place" ? "连续住宿" : connectionText(connection)');
    expect(panel).toContain('transportEditingNodeId === row.node.id && connection.state !== "same_place"');
  });

  it("loads the dedicated phase4 interaction styles", () => {
    const main = source("./main.tsx");
    const css = source("./phase4-final-route-interaction.css");
    expect(main).toContain('import "./phase4-final-route-interaction.css"');
    expect(css).toContain(".final-route-transport-connector-v4");
    expect(css).toContain(".final-route-night-divider-v4");
    expect(css).toContain(".final-route-editor-drawer-v4");
  });
});
