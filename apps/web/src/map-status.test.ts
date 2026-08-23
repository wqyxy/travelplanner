import { describe, expect, it } from "vitest";
import { mapStatusPresentation } from "./map-status";

describe("map status presentation", () => {
  it("shows the completed map state in green", () => {
    expect(mapStatusPresentation("ready")).toEqual({ label: "已同步地图", tone: "ready" });
  });

  it("groups active map work into the syncing state", () => {
    for (const status of ["queued", "analyzing", "resolving"] as const) {
      expect(mapStatusPresentation(status)).toEqual({ label: "正在同步，请稍后", tone: "syncing" });
    }
  });

  it("separates attention and idle states", () => {
    expect(mapStatusPresentation("partial")).toEqual({ label: "地图部分完成", tone: "attention" });
    for (const status of ["failed", "stopped"] as const) {
      expect(mapStatusPresentation(status)).toEqual({ label: "地图待处理", tone: "attention" });
    }
    expect(mapStatusPresentation("idle")).toEqual({ label: "等待同步", tone: "idle" });
    expect(mapStatusPresentation(null)).toEqual({ label: "等待同步", tone: "idle" });
  });
});
