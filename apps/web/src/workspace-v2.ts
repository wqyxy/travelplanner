import type { CandidatePreference, DayRoute, Place, PlaceResolution, RouteState, TripCandidate, Workspace } from "./v2-types";

export type CandidateFilter = "all" | CandidatePreference | "unresolved";
export type CandidateRow = { candidate: TripCandidate; place: Place; resolution: PlaceResolution | null };
export type CandidateAreaGroup = { key: string; label: string; cityRow: CandidateRow | null; rows: CandidateRow[] };

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

const normalizeArea = (value: string | null | undefined) => (value ?? "")
  .normalize("NFKC")
  .trim()
  .toLocaleLowerCase()
  .replace(/[\p{P}\p{S}\s]+/gu, "");

export function candidateAreaGroups(rows: CandidateRow[]): CandidateAreaGroup[] {
  const cityRows = rows.filter((row) => row.place.kind === "city");
  const aliases = new Map<string, CandidateRow | null>();
  for (const row of cityRows) {
    for (const value of [row.place.nameZh, row.place.nameLocal, row.place.nameEn, row.place.city]) {
      const alias = normalizeArea(value);
      if (!alias) continue;
      if (!aliases.has(alias)) aliases.set(alias, row);
      else if (aliases.get(alias)?.place.id !== row.place.id) aliases.set(alias, null);
    }
  }

  const groups = new Map<string, CandidateAreaGroup>();
  for (const row of rows) {
    let key: string;
    let label: string;
    let cityRow: CandidateRow | null = null;
    if (row.place.kind === "city") {
      key = `city:${row.place.id}`;
      label = row.place.nameZh;
      cityRow = row;
    } else {
      const cityAlias = normalizeArea(row.place.city);
      const matched = cityAlias ? aliases.get(cityAlias) ?? null : null;
      if (matched) {
        key = `city:${matched.place.id}`;
        label = matched.place.nameZh;
        cityRow = matched;
      } else if (cityAlias) {
        key = `city-name:${normalizeArea(row.place.countryCode ?? row.place.country)}:${cityAlias}`;
        label = row.place.city ?? "城市";
      } else if (row.place.region) {
        key = `region:${normalizeArea(row.place.countryCode ?? row.place.country)}:${normalizeArea(row.place.region)}`;
        label = row.place.region;
      } else if (row.place.country || row.place.countryCode) {
        key = `country:${normalizeArea(row.place.countryCode ?? row.place.country)}`;
        label = row.place.country ?? row.place.countryCode ?? "区域";
      } else {
        key = `place:${row.place.id}`;
        label = "其他地点";
      }
    }
    const group = groups.get(key) ?? { key, label, cityRow, rows: [] };
    if (!group.cityRow && cityRow) group.cityRow = cityRow;
    group.rows.push(row);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((left, right) => Number(right.place.kind === "city") - Number(left.place.kind === "city")
        || preferenceOrder[left.candidate.preference] - preferenceOrder[right.candidate.preference]
        || (right.candidate.aiScore ?? -1) - (left.candidate.aiScore ?? -1)
        || left.place.nameZh.localeCompare(right.place.nameZh, "zh-CN")),
    }))
    .sort((left, right) => {
      const leftPreference = Math.min(...left.rows.map((row) => preferenceOrder[row.candidate.preference]));
      const rightPreference = Math.min(...right.rows.map((row) => preferenceOrder[row.candidate.preference]));
      return leftPreference - rightPreference || left.label.localeCompare(right.label, "zh-CN");
    });
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
