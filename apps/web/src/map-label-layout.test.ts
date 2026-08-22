import { describe, expect, it } from "vitest";
import { clusterHiddenLabels, labelRole, layoutLabels } from "./map-label-layout";

describe("layoutLabels", () => {
  it("keeps visible Chinese labels from overlapping and clusters impossible collisions", () => {
    const result = layoutLabels(Array.from({ length: 12 }, (_, index) => ({ id: String(index), x: 100, y: 100, width: 100, height: 26, priority: 12 - index })), { width: 300, height: 220 });
    const visible = result.filter((item) => !item.hidden);
    for (const a of visible) for (const b of visible) if (a.id !== b.id) expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
    expect(result.some((item) => item.hidden)).toBe(true);
  });
  it("derives a shared lodging's cross-day role from DayPaths", () => {
    expect(labelRole("hotel", [{ dayNumber: 1, startEntityId: "first", endEntityId: "hotel" }, { dayNumber: 2, startEntityId: "hotel", endEntityId: "second" }])).toBe("D1终 / D2起");
  });
  it("anchors a collision cluster at its members' geographic screen center", () => {
    const groups = clusterHiddenLabels([{ id: "a", x: 100, y: 80, width: 20, height: 20, priority: 1 }, { id: "b", x: 118, y: 98, width: 20, height: 20, priority: 1 }, { id: "c", x: 300, y: 300, width: 20, height: 20, priority: 1 }]);
    expect(groups.find((group) => group.members.length === 2)).toMatchObject({ x: 109, y: 89 });
  });
});
