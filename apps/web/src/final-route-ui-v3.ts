import type {
  FinalRouteNode,
  FinalRouteNodeStatus,
  Place,
  PlaceKind,
  PlanCommand,
  RouteState,
  Transport,
  TransportMode,
  TravelPlanDocument,
  TripCandidate,
} from "./v2-types";

export type FinalRouteDisplayRowV3 = {
  index: number;
  node: FinalRouteNode;
  place: Place | null;
  candidate: TripCandidate | null;
  dayNumber: number;
  active: boolean;
};

export type FinalRouteTransportConnectionV4 = {
  fromNodeId: string;
  toNodeId: string;
  fromPlaceId: string;
  toPlaceId: string;
  dayId: string | null;
  dayNumber: number;
  mode: TransportMode | null;
  distanceKm: number | null;
  durationMinutes: number | null;
  state: "ready" | "dirty" | "attention" | "pending" | "same_place";
  warning: string | null;
  skippedInactiveCount: number;
};

export type FinalRouteDayViewV4 = {
  dayId: string;
  dayNumber: number;
  date: string | null;
  title: string;
  startPlaceId: string | null;
  endPlaceId: string | null;
  distanceKm: number | null;
  durationMinutes: number | null;
  routeState: "ready" | "dirty" | "attention" | "calculating" | "idle";
  emptyDetail: boolean;
};

export type NewFinalRoutePlaceDraftV3 = {
  index: number;
  temporaryPlaceId: string;
  temporaryCandidateId: string;
  temporaryNodeId: string;
  nameZh: string;
  kind: PlaceKind;
};

export const finalRouteStatusLabelsV3: Record<FinalRouteNodeStatus, string> = {
  normal: "正常",
  tentative: "待定",
  no_go: "不去",
};

export const transportModeLabelsV3: Record<TransportMode, string> = {
  walk: "步行",
  drive: "自驾",
  bike: "骑行",
  transit: "公共交通",
  rail: "铁路",
  flight: "航班",
  ferry: "轮渡",
  none: "无需交通",
};

export function finalRouteDisplayRowsV3(plan: TravelPlanDocument): FinalRouteDisplayRowV3[] {
  const places = new Map(plan.places.map((place) => [place.id, place]));
  const candidates = new Map(plan.candidates.map((candidate) => [candidate.placeId, candidate]));
  let dayNumber = 1;
  return (plan.finalRoute?.nodes ?? []).map((node, index) => {
    const row = {
      index,
      node,
      place: places.get(node.placeId) ?? null,
      candidate: candidates.get(node.placeId) ?? null,
      dayNumber,
      active: node.status === "normal",
    };
    if (node.status === "normal" && node.endsDay) dayNumber += 1;
    return row;
  });
}

export function finalRouteDayCountV3(plan: TravelPlanDocument) {
  const active = (plan.finalRoute?.nodes ?? []).filter((node) => node.status === "normal");
  if (!active.length) return 0;
  const boundaries = active.filter((node) => node.endsDay).length;
  return boundaries + (active.at(-1)?.endsDay ? 0 : 1);
}

export function finalRouteTransportConnectionsV4(plan: TravelPlanDocument, routeStates: RouteState[]): FinalRouteTransportConnectionV4[] {
  const rows = finalRouteDisplayRowsV3(plan);
  const activeRows = rows.filter((row) => row.node.status === "normal");
  const states = new Map(routeStates.map((state) => [state.dayId, state]));
  const result: FinalRouteTransportConnectionV4[] = [];

  for (let index = 1; index < activeRows.length; index += 1) {
    const previous = activeRows[index - 1];
    const current = activeRows[index];
    const day = plan.days[current.dayNumber - 1];
    const state = day ? states.get(day.id) ?? null : null;
    const route = state?.route ?? null;
    const dirty = Boolean(state?.dirty);
    const samePlace = previous.node.placeId === current.node.placeId;
    const leg = !dirty && route
      ? route.legs.find((item) => item.fromPlaceId === previous.node.placeId && item.toPlaceId === current.node.placeId) ?? null
      : null;
    const skippedInactiveCount = rows
      .slice(previous.index + 1, current.index)
      .filter((row) => row.node.status !== "normal")
      .length;

    let connectionState: FinalRouteTransportConnectionV4["state"] = "pending";
    if (samePlace) connectionState = "same_place";
    else if (dirty) connectionState = "dirty";
    else if (route?.status === "attention" || leg?.status === "attention") connectionState = "attention";
    else if (leg) connectionState = "ready";

    result.push({
      fromNodeId: previous.node.id,
      toNodeId: current.node.id,
      fromPlaceId: previous.node.placeId,
      toPlaceId: current.node.placeId,
      dayId: day?.id ?? null,
      dayNumber: current.dayNumber,
      mode: current.node.transportFromPrevious?.mode ?? null,
      distanceKm: connectionState === "ready" || connectionState === "attention" ? leg?.distanceKm ?? null : null,
      durationMinutes: connectionState === "ready" || connectionState === "attention" ? leg?.durationMinutes ?? null : null,
      state: connectionState,
      warning: connectionState === "attention" ? leg?.warning ?? route?.warnings[0] ?? null : null,
      skippedInactiveCount,
    });
  }

  return result;
}

export function finalRouteDayViewsV4(plan: TravelPlanDocument, routeStates: RouteState[]): FinalRouteDayViewV4[] {
  const states = new Map(routeStates.map((state) => [state.dayId, state]));
  return plan.days.map((day) => {
    const state = states.get(day.id) ?? null;
    const route = state?.route ?? null;
    const dirty = Boolean(state?.dirty);
    const routeState: FinalRouteDayViewV4["routeState"] = dirty
      ? "dirty"
      : route?.status === "ready"
        ? "ready"
        : route?.status === "attention"
          ? "attention"
          : route?.status === "calculating"
            ? "calculating"
            : "idle";
    return {
      dayId: day.id,
      dayNumber: day.dayNumber,
      date: day.date,
      title: day.title,
      startPlaceId: day.startAnchor.placeId,
      endPlaceId: day.endAnchor.placeId,
      distanceKm: routeState === "ready" || routeState === "attention" ? route?.distanceKm ?? null : null,
      durationMinutes: routeState === "ready" || routeState === "attention" ? route?.durationMinutes ?? null : null,
      routeState,
      emptyDetail: day.stops.length === 0 && day.startAnchor.placeId === day.endAnchor.placeId,
    };
  });
}

export function transportFromModeV3(mode: TransportMode | ""): Transport | null {
  if (!mode || mode === "none") return null;
  return {
    mode,
    durationMinutes: null,
    note: null,
    verification: { status: "unverified", checkedAt: null },
  };
}

export function newFinalRoutePlaceCommandsV3(draft: NewFinalRoutePlaceDraftV3): PlanCommand[] {
  const nameZh = draft.nameZh.trim();
  if (!nameZh) throw new Error("地点名称不能为空。");
  return [
    {
      type: "add_candidate",
      place: {
        id: draft.temporaryPlaceId,
        nameZh,
        nameLocal: null,
        nameEn: null,
        kind: draft.kind,
        city: null,
        region: null,
        country: null,
        countryCode: null,
        approximate: false,
      },
      candidate: {
        id: draft.temporaryCandidateId,
        placeId: draft.temporaryPlaceId,
        planningAreaCandidateId: null,
        planningRole: "planning_area",
        preference: "optional",
        source: "user",
        aiReason: null,
        aiScore: null,
        suggestedDurationMinutes: null,
        tags: [],
      },
    },
    {
      type: "add_final_route_node",
      index: draft.index,
      node: {
        id: draft.temporaryNodeId,
        placeId: draft.temporaryPlaceId,
        status: "normal",
        endsDay: false,
        transportFromPrevious: null,
        activity: null,
        period: null,
        scheduleText: null,
        startTime: null,
        endTime: null,
        durationMinutes: null,
        scheduleVerification: null,
        costNote: null,
        costVerification: null,
        notes: null,
      },
    },
  ];
}
