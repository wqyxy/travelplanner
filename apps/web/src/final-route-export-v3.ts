import {
  finalRouteDisplayRowsV3,
  finalRouteStatusLabelsV3,
  finalRouteTransportConnectionsV4,
  transportModeLabelsV3,
} from "./final-route-ui-v3";
import { placeNamePresentation } from "./place-name-presentation";
import type { WorkspaceV3 } from "./v3-types";
import type { FinalRouteNodeStatus, Period, PlaceKind, TransportMode } from "./v2-types";

const headers = [
  "天数", "日期", "顺序", "地点名称", "英文/当地名称", "地点类型", "状态", "住宿边界",
  "活动", "时段", "开始时间", "结束时间", "活动时长(分钟)", "到达交通", "路程距离(km)",
  "路程时长(分钟)", "路线状态", "定位状态", "地址", "纬度", "经度", "费用备注", "其他备注",
];

const placeKindLabels: Record<PlaceKind, string> = {
  city: "城市",
  attraction: "景点 / 景区",
  lodging: "住宿地点",
  meal: "餐饮",
  airport: "机场",
  station: "车站",
  port: "港口",
  stop: "停靠点",
  waypoint: "途经点",
};

const periodLabels: Record<Period, string> = {
  morning: "上午",
  afternoon: "下午",
  evening: "傍晚",
  night: "夜间",
  all_day: "全天",
};

const routeStateLabels = {
  ready: "已获取",
  dirty: "待更新",
  attention: "需注意",
  pending: "待计算",
  unavailable: "不可用",
  same_place: "同地点",
} as const;

const locationStateLabels = {
  resolved: "已定位",
  resolving: "定位中",
  unresolved: "未定位",
  missing: "未定位",
} as const;

function cell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function modeLabel(mode: TransportMode | null | undefined) {
  if (!mode) return "";
  return transportModeLabelsV3[mode];
}

function statusLabel(status: FinalRouteNodeStatus) {
  return finalRouteStatusLabelsV3[status];
}

function locationLabel(status: keyof typeof locationStateLabels | undefined) {
  return locationStateLabels[status ?? "missing"];
}

function dayForNumber(workspace: WorkspaceV3, dayNumber: number) {
  return workspace.trip.plan.days.find((day) => day.dayNumber === dayNumber) ?? null;
}

function alternatePlaceName(place: WorkspaceV3["trip"]["plan"]["places"][number] | null, primary: string) {
  if (!place) return "";
  return [place.nameEn, place.nameLocal, place.nameZh].find((name) => Boolean(name && name !== primary)) ?? "";
}

export function finalRouteCsvV3(workspace: WorkspaceV3) {
  const plan = workspace.trip.plan;
  const rows = finalRouteDisplayRowsV3(plan);
  const connections = new Map(finalRouteTransportConnectionsV4(plan, workspace.routeStates).map((item) => [item.toNodeId, item]));
  const resolutions = new Map(workspace.resolutions.map((item) => [item.placeId, item]));
  const lines = [headers.map(cell).join(",")];

  for (const row of rows) {
    const day = dayForNumber(workspace, row.dayNumber);
    const connection = row.node.status === "normal" ? connections.get(row.node.id) : undefined;
    const resolution = resolutions.get(row.node.placeId);
    const display = placeNamePresentation(row.place, workspace.trip.planLanguage, "未命名地点");
    const arrivalMode = connection?.mode ?? row.node.transportFromPrevious?.mode;

    lines.push([
      row.dayNumber,
      day?.date,
      row.index + 1,
      display.primary,
      alternatePlaceName(row.place, display.primary),
      row.place ? placeKindLabels[row.place.kind] : "未知地点",
      statusLabel(row.node.status),
      row.node.endsDay ? "是" : "否",
      row.node.activity,
      row.node.period ? periodLabels[row.node.period] : null,
      row.node.startTime,
      row.node.endTime,
      row.node.durationMinutes,
      modeLabel(arrivalMode),
      connection?.distanceKm,
      connection?.durationMinutes,
      connection ? routeStateLabels[connection.state] : null,
      locationLabel(resolution?.status),
      resolution?.address,
      resolution?.latitude,
      resolution?.longitude,
      row.node.costNote,
      row.node.notes,
    ].map(cell).join(","));
  }

  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function finalRouteCsvFilenameV3(title: string) {
  const safeTitle = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return `${safeTitle || "travel-plan"}-行程.csv`;
}

export function downloadFinalRouteCsvV3(workspace: WorkspaceV3) {
  const blob = new Blob([finalRouteCsvV3(workspace)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = finalRouteCsvFilenameV3(workspace.trip.title);
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
