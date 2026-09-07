import {
  TravelPlanDocumentSchema,
  type Day,
  type FinalRouteNode,
  type Transport,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { rebuildFinalRouteDaysV3 } from "./final-route-v3.js";

const clone = <T>(value: T): T => structuredClone(value);

function boundaryTransport(day: Day): Transport | null {
  if (day.endTransportFromPrevious !== undefined) return clone(day.endTransportFromPrevious);
  if (day.transferMode === "none") return null;
  return {
    mode: day.transferMode,
    durationMinutes: null,
    note: null,
    verification: { status: "unverified", checkedAt: null },
  };
}

function boundaryNode(day: Day, index: number, total: number): FinalRouteNode {
  const placeId = day.endAnchor.placeId;
  if (!placeId) throw new Error(`INITIAL_SKELETON_UNREPRESENTABLE: Day ${day.id} 缺少结束地点。`);
  if (day.stops.length) throw new Error(`INITIAL_SKELETON_UNREPRESENTABLE: Day ${day.id} 不应包含详细 Stop。`);
  return {
    id: day.id,
    placeId,
    status: "normal",
    endsDay: index < total - 1,
    transportFromPrevious: boundaryTransport(day),
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
  };
}

/**
 * First skeleton generation has no previous route to reconcile. Each generated
 * Day is represented by one independent canonical boundary node, including
 * repeated stays at the same Place. The supplied Day view is used only as
 * source metadata (stayBlockId/date/detail state) while `rebuildFinalRouteDaysV3`
 * immediately re-derives the saved Day view from finalRoute.
 */
export function applyInitialSkeletonToFinalRouteV3(
  planValue: TravelPlanDocument,
  desiredDays: Day[],
): TravelPlanDocument {
  const plan = TravelPlanDocumentSchema.parse(clone(planValue));
  if (plan.days.length || plan.finalRoute.nodes.length) {
    throw new Error("INITIAL_SKELETON_REQUIRES_EMPTY_ROUTE");
  }
  const nodes = desiredDays.map((day, index) => boundaryNode(day, index, desiredDays.length));
  const base = TravelPlanDocumentSchema.parse({
    ...plan,
    days: clone(desiredDays),
    finalRoute: { version: 1, nodes },
  });
  return rebuildFinalRouteDaysV3(base);
}
