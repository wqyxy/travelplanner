export const mapCategoryLegend = [
  ["city", "城市"],
  ["attraction", "景点"],
  ["lodging", "住宿"],
  ["meal", "餐饮"],
  ["stop", "交通/停靠"],
  ["waypoint", "途经点"],
] as const;

export type MapCategory = (typeof mapCategoryLegend)[number][0];
export type CategoryVisibility = Record<MapCategory, boolean>;
export type RouteHover = { id: string; dayNumber: number } | null;
export const dashedRouteModes = ["flight", "ferry"] as const;
export const routeLayerIds = ["travel-routes-solid", "travel-routes-dashed"] as const;

export const routeLayerForMode = (mode: string) =>
  (dashedRouteModes as readonly string[]).includes(mode) ? "dashed" as const : "solid" as const;

export const defaultCategoryVisibility = (): CategoryVisibility =>
  Object.fromEntries(mapCategoryLegend.map(([kind]) => [kind, true])) as CategoryVisibility;

export const visibleCategories = (visibility: CategoryVisibility): MapCategory[] =>
  mapCategoryLegend
    .map(([kind]) => kind)
    .filter((kind) => visibility[kind]);

export const routeHoverFromFeature = (feature: {
  id?: string | number;
  properties?: { id?: string; dayNumber?: string | number };
}): RouteHover => {
  const id = feature.id ?? feature.properties?.id;
  const dayNumber = Number(feature.properties?.dayNumber);
  return id !== undefined && Number.isInteger(dayNumber) && dayNumber > 0
    ? { id: String(id), dayNumber }
    : null;
};
