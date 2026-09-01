import type { CandidatePreference, PlaceResolution, TransportMode, Workspace } from "./v2-types";
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
  want_to_go: "✓",
  optional: "○",
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
  none: "交通待定",
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
        name: row.place.nameZh,
        secondary: row.place.nameLocal || row.place.nameEn || "",
        preference: row.candidate.preference,
        mark: preferenceMarks[row.candidate.preference],
        score: row.candidate.aiScore ?? "",
        address: row.resolution?.address || "",
        excluded: row.candidate.preference === "excluded",
      },
    }];
  });
}

export function itineraryPointFeatures(workspace: Workspace, selectedDayId: string | null): WorkspaceMapPointFeature[] {
  const resolutions = resolvedByPlace(workspace);
  const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place]));
  const candidates = new Map(workspace.trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const candidateByPlace = new Map(workspace.trip.plan.candidates.map((candidate) => [candidate.placeId, candidate]));
  const days = selectedDayId ? workspace.trip.plan.days.filter((day) => day.id === selectedDayId) : workspace.trip.plan.days;
  const allDays = selectedDayId === null;
  const features: WorkspaceMapPointFeature[] = [];

  for (const day of days) {
    const add = (input: {
      id: string;
      entityType: "anchor" | "stop";
      placeId: string | null;
      stopId?: string;
      candidateId?: string | null;
      mark: string;
      nameFallback: string;
    }) => {
      const placeId = input.placeId;
      if (!placeId) return;
      const resolution = resolutions.get(placeId);
      const location = coordinate(resolution);
      if (!location) return;
      const place = places.get(placeId);
      const candidate = input.candidateId ? candidates.get(input.candidateId) : candidateByPlace.get(placeId);
      features.push({
        type: "Feature",
        id: `${day.id}:${input.id}`,
        geometry: { type: "Point", coordinates: location },
        properties: {
          entityType: input.entityType,
          candidateId: candidate?.id || "",
          stopId: input.stopId || "",
          placeId,
          dayId: day.id,
          name: place?.nameZh || input.nameFallback,
          secondary: place?.nameLocal || place?.nameEn || "",
          preference: candidate?.preference || "anchor",
          mark: allDays ? `D${day.dayNumber}·${input.mark}` : input.mark,
          score: candidate?.aiScore ?? "",
          address: resolution?.address || "",
          excluded: false,
        },
      });
    };
    add({ id: day.startAnchor.id, entityType: "anchor", placeId: day.startAnchor.placeId, mark: "起", nameFallback: day.startAnchor.label || "出发 Anchor" });
    day.stops.forEach((stop, index) => add({
      id: stop.id,
      entityType: "stop",
      placeId: stop.placeId,
      stopId: stop.id,
      candidateId: stop.candidateId,
      mark: String(index + 1),
      nameFallback: stop.activity,
    }));
    add({ id: day.endAnchor.id, entityType: "anchor", placeId: day.endAnchor.placeId, mark: "终", nameFallback: day.endAnchor.label || "结束 Anchor" });
  }
  return features;
}

export function routeGeometryFeatures(workspace: Workspace, selectedDayId: string | null): WorkspaceMapRouteFeature[] {
  const dayNumbers = new Map(workspace.trip.plan.days.map((day) => [day.id, day.dayNumber]));
  const colors = dayRouteColors(workspace.trip.plan.days);
  return workspace.routeStates.flatMap((state) => {
    if (selectedDayId && state.dayId !== selectedDayId) return [];
    const dayNumber = dayNumbers.get(state.dayId) ?? 0;
    if (dayNumber < 1) return [];
    return state.route?.legs.flatMap((leg) => {
      if (!leg.geometry) return [];
      const id = `route-leg:${state.dayId}:${leg.id}`;
      return [{
        type: "Feature" as const,
        id,
        geometry: leg.geometry,
        properties: {
          id,
          dayId: state.dayId,
          dayNumber,
          mode: leg.mode,
          status: leg.status,
          dirty: state.dirty,
          distanceKm: leg.distanceKm,
          durationMinutes: leg.durationMinutes,
          warning: leg.warning || "",
          calculatedAt: state.route?.calculatedAt || "",
          color: colors.get(dayNumber) || "#64748b",
        },
      }];
    }) ?? [];
  });
}

export function formatProviderDistance(distanceKm: number | null) {
  if (distanceKm === null || !Number.isFinite(distanceKm) || distanceKm < 0) return "距离待计算";
  const value = distanceKm < 1 ? Number(distanceKm.toFixed(2)) : distanceKm < 10 ? Number(distanceKm.toFixed(1)) : Math.round(distanceKm);
  return `${value} km`;
}

export function formatProviderDuration(durationMinutes: number | null) {
  if (durationMinutes === null || !Number.isFinite(durationMinutes) || durationMinutes < 0) return "时间待计算";
  const minutes = Math.round(durationMinutes);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}
