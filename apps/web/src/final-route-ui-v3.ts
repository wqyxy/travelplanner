import type {
  FinalRouteNode,
  FinalRouteNodeStatus,
  Place,
  PlaceKind,
  PlanCommand,
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
  const planningRole = draft.kind === "city" ? "planning_area" : "detail_interest";
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
        planningRole,
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
