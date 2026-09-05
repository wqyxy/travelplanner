import type { FinalRouteNodeStatus } from "./v2-types";
import type { WorkspaceV3 } from "./v3-types";
import { placeNamePresentation } from "./place-name-presentation";
import { routeGeometryFeatures, type WorkspaceMapRouteFeature } from "./workspace-map-presentation-v2";

export type FinalRouteMapPointFeatureV3 = {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    routeNodeId: string;
    placeId: string;
    status: FinalRouteNodeStatus;
    label: string;
    name: string;
    secondary: string;
    mark: string;
    address: string;
    endsDay: boolean;
  };
};

export const finalRouteMapStatusColorsV3: Record<FinalRouteNodeStatus, string> = {
  normal: "#1b7f64",
  tentative: "#747c82",
  no_go: "#3d4348",
};

export const finalRouteMapStatusMarksV3: Record<FinalRouteNodeStatus, string> = {
  normal: "",
  tentative: "?",
  no_go: "×",
};

export function finalRouteMapPointFeaturesV3(workspace: WorkspaceV3): FinalRouteMapPointFeatureV3[] {
  const plan = workspace.trip.plan;
  const resolutions = new Map(workspace.resolutions
    .filter((item) => item.status === "resolved" && item.latitude !== null && item.longitude !== null)
    .map((item) => [item.placeId, item]));
  const places = new Map(plan.places.map((place) => [place.id, place]));

  return (plan.finalRoute?.nodes ?? []).flatMap((node, index) => {
    const resolution = resolutions.get(node.placeId);
    if (!resolution || resolution.latitude === null || resolution.longitude === null) return [];
    const place = places.get(node.placeId);
    const display = placeNamePresentation(place, workspace.trip.planLanguage, node.activity || "未命名地点");
    const statusMark = finalRouteMapStatusMarksV3[node.status];
    const stayMark = node.endsDay ? "·住" : "";
    return [{
      type: "Feature" as const,
      id: node.id,
      geometry: { type: "Point" as const, coordinates: [resolution.longitude, resolution.latitude] as [number, number] },
      properties: {
        routeNodeId: node.id,
        placeId: node.placeId,
        status: node.status,
        label: display.combined,
        name: display.primary,
        secondary: display.secondary || "",
        mark: `${statusMark}${index + 1}${stayMark}`,
        address: resolution.address || "",
        endsDay: node.endsDay,
      },
    }];
  });
}

function currentDaySegmentKeysV3(workspace: WorkspaceV3) {
  return new Map(workspace.trip.plan.days.map((day) => {
    const placeIds: string[] = [];
    const push = (placeId: string | null) => {
      if (!placeId || placeIds.at(-1) === placeId) return;
      placeIds.push(placeId);
    };
    push(day.startAnchor.placeId);
    day.stops.forEach((stop) => push(stop.placeId));
    push(day.endAnchor.placeId);
    const segments = new Set<string>();
    for (let index = 1; index < placeIds.length; index += 1) segments.add(`${placeIds[index - 1]}\u0000${placeIds[index]}`);
    return [day.id, segments] as const;
  }));
}

export function finalRouteMapRouteGeometryFeaturesV3(workspace: WorkspaceV3): WorkspaceMapRouteFeature[] {
  const currentSegments = currentDaySegmentKeysV3(workspace);
  const routeStates = workspace.routeStates.map((state) => {
    if (!state.route) return state;
    const allowed = currentSegments.get(state.dayId);
    const legs = allowed
      ? state.route.legs.filter((leg) => allowed.has(`${leg.fromPlaceId}\u0000${leg.toPlaceId}`))
      : [];
    return { ...state, route: { ...state.route, legs } };
  });
  return routeGeometryFeatures({ ...workspace, routeStates } as any, null);
}
