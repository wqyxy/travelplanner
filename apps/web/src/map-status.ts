import type { MapSnapshot } from "./types";

type MapStatus = MapSnapshot["status"];

export type MapStatusPresentation = {
  label: string;
  tone: "idle" | "syncing" | "ready" | "attention";
};

export function mapStatusPresentation(status: MapStatus | null | undefined): MapStatusPresentation {
  if (status === "ready") return { label: "已同步地图", tone: "ready" };
  if (status === "queued" || status === "analyzing" || status === "resolving") {
    return { label: "正在同步，请稍后", tone: "syncing" };
  }
  if (status === "partial") return { label: "地图部分完成", tone: "attention" };
  if (status === "failed" || status === "stopped") return { label: "地图待处理", tone: "attention" };
  return { label: "等待同步", tone: "idle" };
}
