import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Filter, LoaderCircle, Maximize2, Minimize2 } from "lucide-react";
import type { Itinerary, ItineraryLanguage, MapEdge, MapState, MapVisit, Place, PlaceKind, ResolvedPlace, TransportMode } from "./types";
import type { MapSelection } from "./Itinerary";
import { placeNameLines } from "./Itinerary";
import { clusterHiddenLabels, layoutLabels } from "./map-label-layout";
import { approximateRouteDurationMinutes, dashedRouteModes, defaultCategoryVisibility, formatRouteDistance, formatRouteDuration, geometryDistanceKm, mapCategoryLegend, routeHoverFromFeature, routeLayerIds, visibleCategories, type MapCategory } from "./map-interactions";

const dayColors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#d97706", "#0891b2"];
const modeColors: Record<TransportMode, string> = { walk: "#2563eb", drive: "#dc2626", bike: "#16a34a", transit: "#64748b", rail: "#475569", flight: "#7c3aed", ferry: "#0891b2", none: "#94a3b8" };
const modeLabels: Record<TransportMode, string> = { walk: "步行", drive: "驾车", bike: "骑行", transit: "公共交通", rail: "铁路", flight: "航班", ferry: "轮渡", none: "无需交通" };

export function categoryForPlace(kind: PlaceKind): MapCategory {
  return kind === "airport" || kind === "station" || kind === "port" ? "stop" : kind;
}

type Marker = { id: string; place: Place; resolved: ResolvedPlace; visits: MapVisit[]; category: MapCategory; label: string; dayLabel: string };
type RouteLine = { edge: MapEdge; route: NonNullable<MapState["map"]>["routes"][number]; dayNumber: number; durationMinutes: number | null };
export type MapPresentation = { markers: Marker[]; routes: RouteLine[]; visibleVisits: MapVisit[]; unresolvedPlaceIds: string[] };

export function buildMapPresentation(itinerary: Itinerary | null, state: MapState | null, selection: MapSelection, enabledCategories: MapCategory[]): MapPresentation {
  if (!itinerary || !state?.map) return { markers: [], routes: [], visibleVisits: [], unresolvedPlaceIds: [] };
  const visibleVisits = state.map.visits.filter((visit) => selection.scope === "all" || visit.dayNumber === selection.dayNumber);
  const visitsByPlace = new Map<string, MapVisit[]>();
  for (const visit of visibleVisits) visitsByPlace.set(visit.placeId, [...(visitsByPlace.get(visit.placeId) || []), visit]);
  const places = new Map(itinerary.places.map((place) => [place.id, place]));
  const resolved = new Map(state.resolvedPlaces.map((place) => [place.placeId, place]));
  const markers: Marker[] = [];
  const unresolvedPlaceIds: string[] = [];
  for (const [placeId, visits] of visitsByPlace) {
    const place = places.get(placeId); const point = resolved.get(placeId);
    if (!place || !point || point.lat === null || point.lng === null) { unresolvedPlaceIds.push(placeId); continue; }
    const category = categoryForPlace(place.kind);
    if (!enabledCategories.includes(category)) continue;
    const dayLabel = [...new Set(visits.map((visit) => visit.dayNumber))].map((dayNumber) => `D${dayNumber}`).join("/");
    markers.push({ id: placeId, place, resolved: point, visits, category, label: place.nameZh, dayLabel });
  }
  const edges = new Map(state.map.edges.map((edge) => [edge.id, edge]));
  const visits = new Map(state.map.visits.map((visit) => [visit.id, visit]));
  const stops = new Map(itinerary.days.flatMap((day) => day.stops.map((stop) => [stop.id, stop] as const)));
  const visibleDayIds = new Set(visibleVisits.map((visit) => visit.dayId));
  const routes = state.map.routes.flatMap((route) => {
    const edge = edges.get(route.edgeId);
    if (!edge || !route.geometry || !visibleDayIds.has(edge.dayId)) return [];
    const dayNumber = visibleVisits.find((visit) => visit.dayId === edge.dayId)?.dayNumber;
    const destinationStop = stops.get(visits.get(edge.toVisitId)?.stopId ?? "");
    return dayNumber ? [{ edge, route, dayNumber, durationMinutes: destinationStop?.transportFromPrevious?.durationMinutes ?? null }] : [];
  });
  return { markers, routes, visibleVisits, unresolvedPlaceIds };
}

function pointFeature(marker: Marker, itinerary: Itinerary, language: ItineraryLanguage) {
  const stops = new Map(itinerary.days.flatMap((day) => day.stops.map((stop) => [stop.id, stop] as const)));
  const details = marker.visits.map((visit) => {
    const stop = stops.get(visit.stopId);
    return `Day ${visit.dayNumber}${stop?.startTime ? ` ${stop.startTime}` : ""}${stop?.activity ? ` · ${stop.activity}` : ""}`;
  });
  const displayName = placeNameLines(marker.place, marker.place.nameZh, language).join(" · ");
  return { type: "Feature" as const, id: marker.id, geometry: { type: "Point" as const, coordinates: [marker.resolved.lng!, marker.resolved.lat!] }, properties: { id: marker.id, name: `${displayName}${marker.resolved.resolution === "approximate" ? "（大致位置）" : ""}`, kind: marker.category, dayNumber: marker.visits[0]?.dayNumber || 0, detail: details.join("\n"), city: marker.place.city || "", region: marker.place.region || "", resolution: marker.resolved.resolution } };
}

function routeFeature(line: RouteLine) {
  const distanceKm = geometryDistanceKm(line.route.geometry);
  const durationMinutes = approximateRouteDurationMinutes(line.edge.mode, distanceKm, line.durationMinutes);
  return { type: "Feature" as const, id: line.edge.id, geometry: line.route.geometry, properties: { id: line.edge.id, mode: line.edge.mode, dayNumber: line.dayNumber, distanceKm, durationMinutes, status: line.route.status, warning: line.route.warning || "" } };
}

export function MapPanel({ itinerary, state, language, categoryColors, selection, fullscreen, onToggleFullscreen }: {
  itinerary: Itinerary | null;
  state: MapState | null;
  language: ItineraryLanguage;
  categoryColors: Record<string, string>;
  selection: MapSelection;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const popupRef = useRef<any>(null);
  const routePopupRef = useRef<any>(null);
  const hoveredRoute = useRef<string | null>(null);
  const fitKey = useRef("");
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [legendOpen, setLegendOpen] = useState(false);
  const [categoryVisibility, setCategoryVisibility] = useState(defaultCategoryVisibility);
  const enabledCategories = useMemo(() => visibleCategories(categoryVisibility), [categoryVisibility]);
  const presentation = useMemo(() => buildMapPresentation(itinerary, state, selection, enabledCategories), [itinerary, state, selection, enabledCategories]);
  const pointFeatures = useMemo(() => itinerary ? presentation.markers.map((marker) => pointFeature(marker, itinerary, language)) : [], [itinerary, presentation.markers, language]);
  const routeFeatures = useMemo(() => presentation.routes.map(routeFeature), [presentation.routes]);

  useEffect(() => {
    let map: any; let observer: ResizeObserver | null = null; let cancelled = false;
    void import("maplibre-gl").then((lib) => {
      if (!element.current || cancelled) return;
      map = new lib.Map({ container: element.current, style: { version: 8, sources: { osm: { type: "raster", tiles: ["/api/map/tiles/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } }, layers: [{ id: "osm", type: "raster", source: "osm" }] }, center: [0, 20], zoom: 1.1 });
      map.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        map.addSource("travel-routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        const routePaint = { "line-color": "#64748b", "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 6, 4], "line-opacity": ["case", ["==", ["get", "status"], "attention"], .55, .84] };
        const dashedFilter = ["in", ["get", "mode"], ["literal", dashedRouteModes]];
        map.addLayer({ id: "travel-routes-solid", type: "line", source: "travel-routes", filter: ["!", dashedFilter], paint: routePaint });
        map.addLayer({ id: "travel-routes-dashed", type: "line", source: "travel-routes", filter: dashedFilter, paint: { ...routePaint, "line-dasharray": [2, 2] } });
        map.addSource("travel-places", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "travel-places", type: "circle", source: "travel-places", paint: { "circle-radius": 7, "circle-color": "#1b4f78", "circle-stroke-width": 2, "circle-stroke-color": "#fff" } });
        const clearRouteHover = () => { if (hoveredRoute.current) map.setFeatureState({ source: "travel-routes", id: hoveredRoute.current }, { hover: false }); hoveredRoute.current = null; routePopupRef.current?.remove(); routePopupRef.current = null; };
        const showRouteHover = (event: any) => {
          const hover = routeHoverFromFeature(event.features?.[0] || {}); if (!hover) return clearRouteHover();
          if (hoveredRoute.current !== hover.id) { clearRouteHover(); map.setFeatureState({ source: "travel-routes", id: hover.id }, { hover: true }); hoveredRoute.current = hover.id; }
          const feature = event.features?.[0]; const properties = feature?.properties || {}; const content = document.createElement("div"); content.className = "map-route-tooltip";
          const title = document.createElement("strong"); title.textContent = `Day ${hover.dayNumber} · ${modeLabels[properties.mode as TransportMode] || properties.mode || "路线"}`;
          const distanceValue = properties.distanceKm === null || properties.distanceKm === undefined ? Number.NaN : Number(properties.distanceKm);
          const durationValue = properties.durationMinutes === null || properties.durationMinutes === undefined ? Number.NaN : Number(properties.durationMinutes);
          const distance = formatRouteDistance(Number.isFinite(distanceValue) ? distanceValue : null);
          const duration = formatRouteDuration(Number.isFinite(durationValue) ? durationValue : null);
          const metrics = document.createElement("span"); metrics.textContent = [distance, duration ? `约 ${duration}` : "时间待估"].filter(Boolean).join(" · ");
          content.append(title, metrics);
          if (properties.warning) { const warning = document.createElement("small"); warning.textContent = properties.warning; content.append(warning); }
          routePopupRef.current?.remove(); routePopupRef.current = new lib.Popup({ offset: 10, closeButton: false, closeOnClick: false, className: "map-route-popup" }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
        };
        const showPlace = (event: any) => {
          const feature = event.features?.[0]; if (!feature) return;
          const properties = feature.properties || {}; const content = document.createElement("div"); content.className = "map-popup-content";
          const title = document.createElement("strong"); title.textContent = properties.name || "地点";
          const meta = document.createElement("small"); meta.textContent = [properties.city, properties.region, properties.resolution === "approximate" ? "大致定位" : "已定位"].filter(Boolean).join(" · ");
          const detail = document.createElement("p"); detail.textContent = properties.detail || "";
          const link = document.createElement("a"); link.textContent = "在 OpenStreetMap 查看"; link.href = `https://www.openstreetmap.org/?mlat=${event.lngLat.lat}&mlon=${event.lngLat.lng}#map=16/${event.lngLat.lat}/${event.lngLat.lng}`; link.target = "_blank"; link.rel = "noreferrer";
          content.append(title, meta, detail, link); popupRef.current?.remove(); popupRef.current = new lib.Popup({ offset: 14 }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
        };
        map.on("mouseenter", "travel-places", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "travel-places", () => { map.getCanvas().style.cursor = ""; });
        map.on("click", "travel-places", showPlace);
        for (const layerId of routeLayerIds) {
          map.on("mouseenter", layerId, (event: any) => { map.getCanvas().style.cursor = "pointer"; showRouteHover(event); });
          map.on("mousemove", layerId, showRouteHover);
          map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; clearRouteHover(); });
        }
        setReady(true);
      });
      observer = new ResizeObserver(() => map.resize()); observer.observe(element.current); mapRef.current = map;
    }).catch(() => setNotice("地图渲染组件加载失败。"));
    return () => { cancelled = true; observer?.disconnect(); popupRef.current?.remove(); routePopupRef.current?.remove(); map?.remove(); mapRef.current = null; setReady(false); };
  }, []);

  useEffect(() => {
    const map = mapRef.current; if (!ready || !map) return;
    map.getSource("travel-places")?.setData({ type: "FeatureCollection", features: pointFeatures });
    map.getSource("travel-routes")?.setData({ type: "FeatureCollection", features: routeFeatures });
    map.setPaintProperty("travel-places", "circle-color", ["match", ["get", "kind"], ...Object.entries(categoryColors).flatMap(([kind, color]) => [kind, color]), "#1b4f78"]);
    const routeColors = selection.scope === "all" ? [...new Map(presentation.routes.map((line) => [line.dayNumber, dayColors[(line.dayNumber - 1) % dayColors.length]])).entries()].flatMap(([dayNumber, color]) => [dayNumber, color]) : Object.entries(modeColors).flatMap(([mode, color]) => [mode, color]);
    for (const layerId of routeLayerIds) map.setPaintProperty(layerId, "line-color", ["match", ["get", selection.scope === "all" ? "dayNumber" : "mode"], ...routeColors, "#64748b"]);
    const key = `${state?.generation ?? -1}:${selection.scope}:${selection.scope === "day" ? selection.dayNumber : "all"}:${pointFeatures.map((feature) => feature.id).join(",")}`;
    if (pointFeatures.length && fitKey.current !== key) void import("maplibre-gl").then((lib) => { if (mapRef.current !== map) return; const bounds = new lib.LngLatBounds(); for (const feature of pointFeatures) bounds.extend(feature.geometry.coordinates as [number, number]); if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 54, maxZoom: 13, duration: 500 }); fitKey.current = key; });
  }, [ready, pointFeatures, routeFeatures, categoryColors, selection, presentation.routes, state?.generation]);

  useEffect(() => {
    const map = mapRef.current; const overlay = labels.current; if (!ready || !map || !overlay) return;
    const draw = () => {
      overlay.replaceChildren();
      const boxes = presentation.markers.map((marker) => { const point = map.project([marker.resolved.lng, marker.resolved.lat]); const text = `${placeNameLines(marker.place, marker.place.nameZh, language)[0]} · ${marker.dayLabel}`; return { ...marker, x: point.x, y: point.y, width: Math.min(176, 38 + text.length * 11), height: 26, priority: marker.place.kind === "city" || marker.place.kind === "lodging" ? 3 : 2, text }; });
      const placements = layoutLabels(boxes, { width: overlay.clientWidth, height: overlay.clientHeight }, boxes.map((item) => ({ ...item, id: `pin:${item.id}`, x: item.x - 9, y: item.y - 9, width: 18, height: 18 })));
      for (const item of placements.filter((entry) => !entry.hidden)) { const node = document.createElement("button"); node.className = "map-label"; node.style.transform = `translate(${item.x}px,${item.y}px)`; node.style.setProperty("--label-color", categoryColors[item.category] || "#1b4f78"); node.textContent = item.text; node.onclick = () => map.flyTo({ center: [item.resolved.lng, item.resolved.lat], zoom: Math.max(14, map.getZoom()) }); overlay.append(node); }
      const clusters = layoutLabels(clusterHiddenLabels(placements.filter((item) => item.hidden)), { width: overlay.clientWidth, height: overlay.clientHeight });
      for (const cluster of clusters.filter((item) => !item.hidden)) { const node = document.createElement("button"); node.className = "map-label map-cluster"; node.style.transform = `translate(${cluster.x}px,${cluster.y}px)`; node.textContent = `+${cluster.members.length} 个地点`; node.onclick = () => { const first = cluster.members[0]; if (first) map.flyTo({ center: [first.resolved.lng, first.resolved.lat], zoom: Math.min(17, map.getZoom() + 2) }); }; overlay.append(node); }
    };
    let frame = 0; const queue = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); }; map.on("move", queue); map.on("zoom", queue); queue(); const observer = new ResizeObserver(queue); observer.observe(overlay);
    return () => { map.off("move", queue); map.off("zoom", queue); observer.disconnect(); cancelAnimationFrame(frame); };
  }, [ready, presentation.markers, categoryColors, language]);

  useEffect(() => { const frame = requestAnimationFrame(() => mapRef.current?.resize?.()); fitKey.current = ""; return () => cancelAnimationFrame(frame); }, [fullscreen]);
  useEffect(() => { const resize = () => mapRef.current?.resize?.(); window.addEventListener("travel-workspace-resize", resize); return () => window.removeEventListener("travel-workspace-resize", resize); }, []);

  const status = state?.status || "idle";
  const statusLabel = status === "ready" ? "已同步地图" : status === "attention" ? "地图需要注意" : status === "syncing" ? "正在同步地图" : itinerary?.days.length ? "等待地图同步" : "等待行程";
  const uniqueVisiblePlaces = new Set(presentation.visibleVisits.map((visit) => visit.placeId)).size;
  return <section className="map-panel">
    <div className="map-heading"><h2 className={`map-status ${status}`} aria-live="polite">{statusLabel}</h2>{uniqueVisiblePlaces > 0 && <small className="map-progress">已定位 {presentation.markers.length}/{uniqueVisiblePlaces} · 路线 {presentation.routes.length}</small>}
      <fieldset className="map-category-filter"><legend><Filter size={13}/>地点筛选</legend><div className="map-category-options">{mapCategoryLegend.map(([kind, label]) => <label key={kind}><input type="checkbox" checked={categoryVisibility[kind]} onChange={() => setCategoryVisibility((current) => ({ ...current, [kind]: !current[kind] }))}/><i style={{ background: categoryColors[kind] }}/>{label}</label>)}</div></fieldset>
      <div className="map-actions"><button className="icon-button panel-fullscreen" type="button" aria-label={fullscreen ? "退出地图全屏" : "地图全屏"} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></div>
    </div>
    <div className="map-canvas-wrap"><div ref={element} className="map-canvas"/><div ref={labels} className="map-label-overlay"/><div className={`map-legend ${legendOpen ? "open" : ""}`}><button className="map-legend-toggle" type="button" aria-expanded={legendOpen} onClick={() => setLegendOpen((open) => !open)}>图例 {legendOpen ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}</button>{legendOpen && <div><strong>{selection.scope === "all" ? "路线（按天）" : "路线（按交通）"}</strong><div className="map-legend-items">{selection.scope === "all" ? itinerary?.days.map((day) => <span key={day.id}><i style={{ background: dayColors[(day.dayNumber - 1) % dayColors.length] }}/>Day {day.dayNumber}</span>) : Object.entries(modeLabels).filter(([mode]) => mode !== "none").map(([mode, label]) => <span key={mode}><i style={{ background: modeColors[mode as TransportMode] }}/>{label}</span>)}</div><strong>地点</strong><div className="map-legend-items">{mapCategoryLegend.map(([kind, label]) => <span key={kind}><i style={{ background: categoryColors[kind] }}/>{label}</span>)}</div></div>}</div></div>
    <p className={`map-notice ${status}`}>{status === "syncing" ? <LoaderCircle className="spin" size={13}/> : status === "attention" || notice ? <AlertTriangle size={13}/> : null}<span>{notice || (presentation.unresolvedPlaceIds.length ? `${presentation.unresolvedPlaceIds.length} 个地点尚未可靠定位；行程仍可继续编辑。` : status === "ready" ? "地图已从当前 canonical itinerary 自动派生。" : "生成初稿后会自动建立地图。")}</span></p>
    {state?.warnings.length ? <div className="map-warning-list">{state.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
  </section>;
}
