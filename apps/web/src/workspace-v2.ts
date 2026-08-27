import type { CandidatePreference, DayRoute, Place, PlaceResolution, RouteState, TripCandidate, Workspace } from "./v2-types";

export type CandidateFilter = "all" | CandidatePreference | "unresolved";
export type CandidateRow = { candidate: TripCandidate; place: Place; resolution: PlaceResolution | null };

export const preferenceOrder: Record<CandidatePreference, number> = { must_go: 0, want_to_go: 1, optional: 2, excluded: 3 };

export function candidateRows(workspace: Workspace): CandidateRow[] {
  const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place]));
  const resolutions = new Map(workspace.resolutions.map((resolution) => [resolution.placeId, resolution]));
  return workspace.trip.plan.candidates.flatMap((candidate) => {
    const place = places.get(candidate.placeId);
    return place ? [{ candidate, place, resolution: resolutions.get(candidate.placeId) ?? null }] : [];
  }).sort((left, right) => preferenceOrder[left.candidate.preference] - preferenceOrder[right.candidate.preference]
    || (right.candidate.aiScore ?? -1) - (left.candidate.aiScore ?? -1)
    || left.place.nameZh.localeCompare(right.place.nameZh, "zh-CN"));
}

export function resolutionStatus(row: CandidateRow) {
  return row.resolution?.status ?? "unresolved";
}

export function filterCandidateRows(rows: CandidateRow[], filter: CandidateFilter, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filter === "unresolved" && resolutionStatus(row) !== "unresolved") return false;
    if (filter !== "all" && filter !== "unresolved" && row.candidate.preference !== filter) return false;
    if (!needle) return true;
    return [row.place.nameZh, row.place.nameLocal, row.place.nameEn, row.place.city, row.place.region, row.place.country, row.candidate.aiReason, ...row.candidate.tags]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(needle));
  });
}

export function candidateCounts(rows: CandidateRow[]) {
  const result = { all: rows.length, must_go: 0, want_to_go: 0, optional: 0, excluded: 0, unresolved: 0, selected: 0 };
  for (const row of rows) {
    result[row.candidate.preference] += 1;
    if (row.candidate.preference !== "excluded") result.selected += 1;
    if (resolutionStatus(row) === "unresolved") result.unresolved += 1;
  }
  return result;
}

export function selectedUnresolvedRows(rows: CandidateRow[]) {
  return rows.filter((row) => row.candidate.preference !== "excluded" && resolutionStatus(row) !== "resolved");
}

export function formatDuration(minutes: number | null) {
  if (minutes === null) return null;
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天`;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  }
  return `${minutes} 分钟`;
}

export function formatDistance(value: number | null) {
  if (value === null) return "距离待计算";
  return value < 1 ? `${Math.round(value * 1000)} 米` : `${value.toFixed(value < 10 ? 1 : 0)} 公里`;
}

export function formatRouteDuration(value: number | null) {
  if (value === null) return "时间待计算";
  if (value < 60) return `${Math.round(value)} 分钟`;
  const hours = Math.floor(value / 60);
  const minutes = Math.round(value % 60);
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

export function routeStateForDay(routeStates: RouteState[], dayId: string): RouteState {
  return routeStates.find((state) => state.dayId === dayId) ?? { dayId, dirty: true, route: null };
}

export function currentRoute(routes: DayRoute[], dayId: string) {
  return routes.find((route) => route.dayId === dayId) ?? null;
}
