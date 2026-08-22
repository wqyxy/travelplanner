import type { MapPatch, MapSnapshot } from "./types";

const byId = <T extends { id: string }>(items: T[] = []) => new Map(items.map((item) => [item.id, item]));
const merge = <T extends { id: string }>(current: T[] | undefined, patch?: { upsert: T[]; remove: string[] }) => {
  const next = byId(current);
  for (const id of patch?.remove || []) next.delete(id);
  for (const item of patch?.upsert || []) next.set(item.id, item);
  return [...next.values()];
};
const mergeDays = <T extends { dayNumber: number }>(current: T[], patch?: T[]) => {
  if (!patch) return current;
  const next = new Map(current.map((item) => [item.dayNumber, item]));
  for (const item of patch) next.set(item.dayNumber, item);
  return [...next.values()].sort((a, b) => a.dayNumber - b.dayNumber);
};

/** Returns null when a sequence gap requires fetching an authoritative snapshot. */
export function applyMapPatch(current: MapSnapshot | null, patch: MapPatch): MapSnapshot | null {
  if (!current || patch.replaceAll || current.mapVersion !== patch.mapVersion) return null;
  if (patch.sequence != null && current.sequence != null && patch.sequence !== current.sequence + 1) return null;
  return {
    ...current,
    sequence: patch.sequence ?? current.sequence,
    entities: merge(current.entities, patch.entities),
    places: merge(current.places, patch.places),
    visits: merge(current.visits, patch.visits),
    routes: merge(current.routes, patch.routes as { upsert: typeof current.routes; remove: string[] }),
    dayPaths: mergeDays(current.dayPaths, patch.dayPaths as typeof current.dayPaths | undefined),
    dayProgress: mergeDays(current.dayProgress || [], patch.dayProgress),
  };
}
