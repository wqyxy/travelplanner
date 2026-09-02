import type { CandidatePreference, PlaceResolution, TransportMode, Workspace } from "./v2-types";
import { placeNamePresentation } from "./place-name-presentation";
import { candidateRows } from "./workspace-v2";

export type WorkspaceMapView = "candidates" | "itinerary";

export type WorkspaceMapPointFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    entityType: "candidate" | "anchor" | "stop";
    candidateId: string;
    stopId: string;
    placeId: string;
    dayId: string;
    label: string;
    name: string;
    secondary: string;
    preference: CandidatePreference | "anchor";
    mark: string;
    score: number | "";
    address: string;
    excluded: boolean;
  };
};

export type WorkspaceMapRouteFeature = {
  type: "Feature";
  id: string;
  geometry: unknown;
  properties: {
    id: string;
    dayId: string;
    dayNumber: number;
    mode: TransportMode;
    status: "ready" | "attention";
    dirty: boolean;
    distanceKm: number | null;
    durationMinutes: number | null;
    warning: string;
    calculatedAt: string;
    color: string;
  };
};

export const preferenceColors: Record<CandidatePreference, string> = {
  must_go: "#e05c45",
  want_to_go: "#1b7f64",
  optional: "#55758d",
  excluded: "#9a9f9d",
};

export const preferenceMarks: Record<CandidatePreference, string> = {
  must_go: "★",
  want_to_go: "♡",
  optional: "",
  excluded: "×",
};

export const transportModeLabels: Record<TransportMode, string> = {
  walk: "步行",
  drive: "驾车",
  bike: "骑行",
  transit: "公共交通",
  rail: "铁路",
  flight: "航班",
  ferry: "轮渡",
  none: "无需跨区域交通",
};

function hslToHex(hue: number, saturation: number, lightness: number) {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = ((hue % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs(section % 2 - 1));
  const [red, green, blue] = section < 1 ? [chroma, x, 0]
    : section < 2 ? [x, chroma, 0]
      : section < 3 ? [0, chroma, x]
        : section < 4 ? [0, x, chroma]
          : section < 5 ? [x, 0, chroma]
            : [chroma, 0, x];
  const offset = l - chroma / 2;
  return `#${[red, green, blue].map((value) => Math.round((value + offset) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function dayRouteColors(days: Workspace["trip"]["plan"]["days"]) {
  const ordered = [...days].sort((left, right) => left.dayNumber - right.dayNumber);
  const count = Math.max(1, ordered.length);
  return new Map(ordered.map((day, index) => [day.dayNumber, hslToHex(212 + index * 360 / count, 64, index % 2 ? 43 : 48)]));
}

function resolvedByPlace(workspace: Workspace) {
  return new Map(workspace.resolutions
    .filter((resolution) => resolution.status === "resolved" && resolution.latitude !== null && resolution.longitude !== null)
    .map((resolution) => [resolution.placeId, resolution]));
}

function coordinate(resolution: PlaceResolution | undefined): [number, number] | null {
  return resolution?.latitude === null || resolution?.longitude === null || resolution?.latitude === undefined || resolution?.longitude === undefined
    ? null
    : [resolution.longitude, resolution.latitude];
}

export function candidatePointFeatures(workspace: Workspace): WorkspaceMapPointFeature[] {
  return candidateRows(workspace).flatMap((row) => {
    const location = coordinate(row.resolution ?? undefined);
    if (!location) return [];
    const displayName = placeNamePresentation(row.place, workspace.trip.planLanguage);
    return [{
      type: "Feature" as const,
      id: row.candidate.id,
      geometry: { type: "Point" as const, coordinates: location },
      properties: {
        entityType: "candidate" as const,
        candidateId: row.candidate.id,
        stopId: "",
        placeId: row.place.id,
        dayId: "",
        label: displayName.combined,
        name: displayName.primary,
        secondary: displayName.secondary ?? "",
        preference: row.candidate.preference,
        mark: preferenceMarks[row.candidate.preference],
        score: row.candidate.aiScore ?? "",
        address: row.resolution?.address || row.place.region || row.place.country || "",
        excluded: row.candidate.preference === "excluded",
      },
    }];
  });
}

export function itineraryPointFeatures(workspace: Workspace, selectedDayId: string | null): WorkspaceMapPointFeature[] {
  const resolutions = resolvedByPlace(workspace);
  const days = selectedDayId ? workspace.trip.plan.days.filter((day) => day.id === selectedDayId) : workspace.trip.plan.days;
  const manyDays = selectedDayId === null;
  const features: WorkspaceMapPointFeature[] = [];
  for (const day of days) {
    const nodes = [
      { id: day.startAnchor.id, type: "anchor" as const, placeId: day.startAnchor.placeId, candidateId: "", stopId: "", label: day.startAnchor.label || "出发", mark: manyDays ? `D${day.dayNumber}·起` : "起" },
      ...day.stops.map((stop, index) => ({ id: stop.id, type: "stop" as const, placeId: stop.placeId, candidateId: stop.candidateId || "", stopId: stop.id, label: stop.activity, mark: manyDays ? `D${day.dayNumber}·${index + 1}` : String(index + 1) })),
      { id: day.endAnchor.id, type: "anchor" as const, placeId: day.endAnchor.placeId, candidateId: "", stopId: "", label: day.endAnchor.label || "结束", mark: manyDays ? `D${day.dayNumber}·终` : "终" },
    ];
    for (const node of nodes) {
      if (!node.placeId) continue;
      const resolution = resolutions.get(node.placeId);
      const location = coordinate(resolution);
      if (!location) continue;
      const place = workspace.trip.plan.places.find((item) => item.id === node.placeId);
      const displayName = placeNamePresentation(place, workspace.trip.planLanguage, node.label);
      features.push({
        type: "Feature", id: `${day.id}:${node.id}`, geometry: { type: "Point", coordinates: location },
        properties: { entityType: node.type, candidateId: node.candidateId, stopId: node.stopId, placeId: node.placeId, dayId: day.id, label: displayName.combined, name: displayName.primary, secondary: displayName.secondary ?? "", preference: "anchor", mark: node.mark, score: "", address: resolution?.address || place?.region || place?.country || "", excluded: false },
      });
    }
  }
  return features;
}

export function routeGeometryFeatures(workspace: Workspace, selectedDayId: string | null): WorkspaceMapRouteFeature[] {
  const colors = dayRouteColors(workspace.trip.plan.days);
  const states = new Map(workspace.routeStates.map((state) => [state.dayId, state]));
  return workspace.routes.flatMap((route) => {
    if (selectedDayId && route.dayId !== selectedDayId) return [];
    const day = workspace.trip.plan.days.find((item) => item.id === route.dayId);
    if (!day) return [];
    const dirty = states.get(route.dayId)?.dirty ?? false;
    return route.legs.flatMap((leg) => leg.geometry ? [{
      type: "Feature" as const,
      id: `route-leg:${route.dayId}:${leg.id}`,
      geometry: leg.geometry,
      properties: { id: leg.id, dayId: route.dayId, dayNumber: day.dayNumber, mode: leg.mode, status: leg.status, dirty, distanceKm: leg.distanceKm, durationMinutes: leg.durationMinutes, warning: leg.warning || "", calculatedAt: route.calculatedAt || "", color: colors.get(day.dayNumber) || "#3b82f6" },
    }] : []);
  });
}

export function formatProviderDistance(value: number | null) {
  if (value === null) return "距离待计算";
  return value < 1 ? `${Math.round(value * 1000)} 米` : `${value.toFixed(value < 10 ? 1 : 0)} 公里`;
}

export function formatProviderDuration(value: number | null) {
  if (value === null) return "时间待计算";
  if (value < 60) return `${Math.round(value)} 分钟`;
  const hours = Math.floor(value / 60);
  const minutes = Math.round(value % 60);
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}
