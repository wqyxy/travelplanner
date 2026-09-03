import { Crosshair, MapPinned, Maximize2, Minimize2, Route } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "./v2-types";
import { placeNamePresentation } from "./place-name-presentation";
import {
  candidatePointFeatures,
  dayRouteColors,
  formatProviderDistance,
  formatProviderDuration,
  itineraryPointFeatures,
  preferenceColors,
  routeGeometryFeatures,
  transportModeLabels,
  type WorkspaceMapRouteFeature,
  type WorkspaceMapView,
} from "./workspace-map-presentation-v2";

export type WorkspaceMapFocusRequest = { target: "candidate" | "day"; id: string; requestId: number };

export function WorkspaceMapV2({
  workspace,
  view,
  selectedCandidateId,
  selectedDayId,
  selectedStopId,
  focusRequest,
  routePreviewDayId,
  routeFocusDayId,
  mapPickPlaceId,
  fullscreen,
  onSelectCandidate,
  onSelectStop,
  onMapPick,
  onFocusHandled,
  onToggleFullscreen,
}: {
  workspace: Workspace;
  view: WorkspaceMapView;
  selectedCandidateId: string | null;
  selectedDayId: string | null;
  selectedStopId: string | null;
  focusRequest?: WorkspaceMapFocusRequest | null;
  routePreviewDayId?: string | null;
  routeFocusDayId?: string | null;
  mapPickPlaceId: string | null;
  fullscreen: boolean;
  onSelectCandidate: (candidateId: string, focusMap?: boolean) => void;
  onSelectStop: (stopId: string) => void;
  onMapPick: (placeId: string, latitude: number, longitude: number) => void;
  onFocusHandled?: (requestId: number) => void;
  onToggleFullscreen: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const popupRef = useRef<any>(null);
  const routePopupRef = useRef<any>(null);
  const hoveredRouteRef = useRef<string | null>(null);
  const routeFeaturesRef = useRef(new Map<string, WorkspaceMapRouteFeature>());
  const pickRef = useRef(mapPickPlaceId);
  const selectCandidateRef = useRef(onSelectCandidate);
  const selectStopRef = useRef(onSelectStop);
  const onMapPickRef = useRef(onMapPick);
  const fitted = useRef("");
  const routeFocusCamera = useRef<{ center: [number, number]; zoom: number; bearing: number; pitch: number } | null>(null);
  const previousRouteFocusDayId = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  pickRef.current = mapPickPlaceId;
  selectCandidateRef.current = onSelectCandidate;
  selectStopRef.current = onSelectStop;
  onMapPickRef.current = onMapPick;

  const allCandidatePoints = useMemo(() => candidatePointFeatures(workspace), [workspace]);
  const itineraryPoints = useMemo(() => itineraryPointFeatures(workspace, selectedDayId), [workspace, selectedDayId]);
  const points = view === "itinerary" ? itineraryPoints : allCandidatePoints;
  const allRoutes = useMemo(() => routeGeometryFeatures(workspace, null), [workspace]);
  const routeFilterDayId = routeFocusDayId ?? selectedDayId;
  const visibleRoutes = useMemo(() => view === "itinerary" ? allRoutes.filter((feature) => !routeFilterDayId || feature.properties.dayId === routeFilterDayId) : [], [allRoutes, routeFilterDayId, view]);
  const previewRoutes = useMemo(() => view === "itinerary" && routePreviewDayId && !routeFocusDayId ? allRoutes.filter((feature) => feature.properties.dayId === routePreviewDayId) : [], [allRoutes, routeFocusDayId, routePreviewDayId, view]);
  const currentRoutes = useMemo(() => visibleRoutes.filter((feature) => !feature.properties.dirty), [visibleRoutes]);
  const dirtyRoutes = useMemo(() => visibleRoutes.filter((feature) => feature.properties.dirty), [visibleRoutes]);
  const routeColors = useMemo(() => dayRouteColors(workspace.trip.plan.days), [workspace.trip.plan.days]);
  const selectedEntityId = selectedStopId || selectedCandidateId || "__none__";

  useEffect(() => {
    let cancelled = false;
    let map: any;
    let observer: ResizeObserver | null = null;
    void import("maplibre-gl").then((lib) => {
      if (cancelled || !element.current) return;
      map = new lib.Map({
        container: element.current,
        style: {
          version: 8,
          sources: { base: { type: "raster", tiles: ["/api/map/tiles/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
          layers: [{ id: "base", type: "raster", source: "base" }],
        },
        center: [105, 35],
        zoom: 2.5,
      });
      map.addControl(new lib.NavigationControl({ showCompass: false }), "bottom-right");
      map.on("load", () => {
        const empty = { type: "FeatureCollection", features: [] };
        map.addSource("v3-routes-current", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "v3-route-halo", type: "line", source: "v3-routes-current", paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": .82 } });
        map.addLayer({ id: "v3-routes-current", type: "line", source: "v3-routes-current", paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": .9 } });
        map.addLayer({ id: "v3-routes-current-hit", type: "line", source: "v3-routes-current", paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0 } });
        map.addSource("v3-routes-dirty", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "v3-routes-dirty", type: "line", source: "v3-routes-dirty", paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": .32, "line-dasharray": [2, 2] } });
        map.addLayer({ id: "v3-routes-dirty-hit", type: "line", source: "v3-routes-dirty", paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0, "line-dasharray": [2, 2] } });
        map.addSource("v3-route-preview", { type: "geojson", data: empty });
        map.addLayer({ id: "v3-route-preview-halo", type: "line", source: "v3-route-preview", paint: { "line-color": "#ffffff", "line-width": 12, "line-opacity": .96 } });
        map.addLayer({ id: "v3-route-preview", type: "line", source: "v3-route-preview", paint: { "line-color": ["get", "color"], "line-width": 7, "line-opacity": 1 } });
        map.addSource("v3-route-hover", { type: "geojson", data: empty });
        map.addLayer({ id: "v3-route-hover-halo", type: "line", source: "v3-route-hover", paint: { "line-color": "#ffffff", "line-width": 12, "line-opacity": .95 } });
        map.addLayer({ id: "v3-route-hover", type: "line", source: "v3-route-hover", paint: { "line-color": ["get", "color"], "line-width": 7, "line-opacity": 1 } });
        map.addSource("v3-workspace-points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "v3-point-halo", type: "circle", source: "v3-workspace-points", paint: { "circle-radius": 13, "circle-color": "#ffffff", "circle-opacity": .9 } });
        map.addLayer({
          id: "v3-workspace-points",
          type: "circle",
          source: "v3-workspace-points",
          paint: {
            "circle-radius": ["case", ["==", ["get", "entityType"], "anchor"], 8, ["==", ["get", "preference"], "must_go"], 9, 8],
            "circle-color": ["match", ["get", "preference"], "must_go", preferenceColors.must_go, "want_to_go", preferenceColors.want_to_go, "optional", preferenceColors.optional, "excluded", preferenceColors.excluded, "#3f6687"],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
            "circle-opacity": ["case", ["get", "excluded"], .45, .95],
          },
        });
        map.addLayer({
          id: "v3-point-labels",
          type: "symbol",
          source: "v3-workspace-points",
          layout: {
            "text-field": ["concat", ["get", "mark"], " ", ["get", "label"]],
            "text-size": 12,
            "text-offset": [0, 1.4],
            "text-anchor": "top",
            "text-allow-overlap": false,
          },
          paint: { "text-color": "#24342e", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
        });
        map.on("mouseenter", "v3-workspace-points", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "v3-workspace-points", () => { map.getCanvas().style.cursor = pickRef.current ? "crosshair" : ""; });
        map.on("click", "v3-workspace-points", (event: any) => {
          if (pickRef.current) return;
          const feature = event.features?.[0];
          const properties = feature?.properties || {};
          const stopId = String(properties.stopId || "");
          const candidateId = String(properties.candidateId || "");
          if (stopId) selectStopRef.current(stopId);
          else if (candidateId) selectCandidateRef.current(candidateId, true);
          const content = document.createElement("div");
          content.className = "v3-map-popup";
          const title = document.createElement("strong");
          title.textContent = `${properties.mark || ""} ${properties.name || "地点"}`.trim();
          content.append(title);
          if (properties.secondary) { const secondary = document.createElement("small"); secondary.textContent = properties.secondary; content.append(secondary); }
          if (properties.address) { const address = document.createElement("p"); address.textContent = properties.address; content.append(address); }
          popupRef.current?.remove();
          popupRef.current = new lib.Popup({ offset: 15 }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
        });
        const clearRouteHover = () => {
          if (!hoveredRouteRef.current) return;
          map.getSource("v3-route-hover")?.setData(empty);
          hoveredRouteRef.current = null;
          routePopupRef.current?.remove();
          routePopupRef.current = null;
        };
        map.on("mousemove", (event: any) => {
          const rendered = map.queryRenderedFeatures(event.point, { layers: ["v3-routes-current-hit", "v3-routes-dirty-hit"] })[0];
          const routeId = String(rendered?.properties?.id || rendered?.id || "");
          const route = routeId ? routeFeaturesRef.current.get(routeId) : null;
          if (!route) {
            clearRouteHover();
            map.getCanvas().style.cursor = pickRef.current ? "crosshair" : map.queryRenderedFeatures(event.point, { layers: ["v3-workspace-points"] }).length ? "pointer" : "";
            return;
          }
          map.getCanvas().style.cursor = "pointer";
          if (hoveredRouteRef.current !== routeId) {
            map.getSource("v3-route-hover")?.setData({ type: "FeatureCollection", features: [route] });
            hoveredRouteRef.current = routeId;
          }
          const content = document.createElement("div");
          content.className = "v3-map-popup v3-route-popup";
          const title = document.createElement("strong");
          title.textContent = `Day ${route.properties.dayNumber} · ${transportModeLabels[route.properties.mode]}`;
          const metrics = document.createElement("p");
          metrics.textContent = `${formatProviderDistance(route.properties.distanceKm)} · ${formatProviderDuration(route.properties.durationMinutes)}`;
          content.append(title, metrics);
          if (route.properties.dirty) {
            const stale = document.createElement("small");
            stale.textContent = "旧路线，需更新";
            content.append(stale);
          }
          if (route.properties.warning) {
            const warning = document.createElement("small");
            warning.textContent = route.properties.warning;
            content.append(warning);
          }
          routePopupRef.current?.remove();
          routePopupRef.current = new lib.Popup({ offset: 10, closeButton: false, closeOnClick: false }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
        });
        map.on("mouseout", () => {
          map.getCanvas().style.cursor = pickRef.current ? "crosshair" : "";
          clearRouteHover();
        });
        map.on("click", (event: any) => {
          const placeId = pickRef.current;
          if (!placeId) return;
          onMapPickRef.current(placeId, event.lngLat.lat, event.lngLat.lng);
        });
        setReady(true);
      });
      observer = new ResizeObserver(() => map.resize());
      observer.observe(element.current);
      mapRef.current = map;
    }).catch(() => setError("地图渲染组件加载失败。"));
    return () => {
      cancelled = true;
      observer?.disconnect();
      popupRef.current?.remove();
      routePopupRef.current?.remove();
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.getSource("v3-workspace-points")?.setData({ type: "FeatureCollection", features: points });
    map.getSource("v3-routes-current")?.setData({ type: "FeatureCollection", features: currentRoutes });
    map.getSource("v3-routes-dirty")?.setData({ type: "FeatureCollection", features: dirtyRoutes });
    map.getSource("v3-route-preview")?.setData({ type: "FeatureCollection", features: previewRoutes });
    map.getSource("v3-route-hover")?.setData({ type: "FeatureCollection", features: [] });
    hoveredRouteRef.current = null;
    routePopupRef.current?.remove();
    routePopupRef.current = null;
    routeFeaturesRef.current = new Map(visibleRoutes.map((feature) => [feature.properties.id, feature]));
    const highlightedDayId = routeFocusDayId || routePreviewDayId;
    const selectedPoint = ["any", ["==", ["get", "stopId"], selectedEntityId], ["==", ["get", "candidateId"], selectedEntityId], ...(highlightedDayId ? [["==", ["get", "dayId"], highlightedDayId]] : [])];
    map.setPaintProperty("v3-point-halo", "circle-radius", [
      "case",
      selectedPoint,
      15,
      11,
    ]);
    map.setPaintProperty("v3-point-halo", "circle-color", [
      "case",
      selectedPoint,
      "#f3b646",
      "#ffffff",
    ]);
    const key = `${workspace.trip.id}:${workspace.trip.contentGeneration}:${view}`;
    if (points.length && fitted.current !== key) {
      void import("maplibre-gl").then((lib) => {
        if (mapRef.current !== map) return;
        const bounds = new lib.LngLatBounds();
        points.forEach((point: any) => bounds.extend(point.geometry.coordinates));
        if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 450 });
        fitted.current = key;
      });
    }
  }, [ready, points, currentRoutes, dirtyRoutes, previewRoutes, routeFocusDayId, routePreviewDayId, visibleRoutes, selectedEntityId, selectedDayId, view, workspace.trip.id, workspace.trip.contentGeneration]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !selectedStopId) return;
    const point: any = points.find((feature: any) => feature.properties.stopId === selectedStopId);
    if (point) map.flyTo({ center: point.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), duration: 400 });
  }, [ready, points, selectedStopId]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (routeFocusDayId && routeFocusDayId !== previousRouteFocusDayId.current) {
      routeFocusCamera.current = { center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
      const point: any = itineraryPoints.find((feature: any) => feature.properties.dayId === routeFocusDayId && feature.properties.mark === "终")
        ?? itineraryPoints.find((feature: any) => feature.properties.dayId === routeFocusDayId);
      if (point) map.flyTo({ center: point.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), duration: 400 });
    } else if (!routeFocusDayId && previousRouteFocusDayId.current && routeFocusCamera.current) {
      map.easeTo({ ...routeFocusCamera.current, duration: 400 });
      routeFocusCamera.current = null;
    }
    previousRouteFocusDayId.current = routeFocusDayId || null;
  }, [itineraryPoints, ready, routeFocusDayId]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focusRequest) return;
    const point: any = focusRequest.target === "candidate"
      ? points.find((feature: any) => feature.properties.candidateId === focusRequest.id)
      : points.find((feature: any) => feature.properties.dayId === focusRequest.id && feature.properties.mark === "终")
        ?? points.find((feature: any) => feature.properties.dayId === focusRequest.id);
    if (point) map.flyTo({ center: point.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), duration: 400 });
    onFocusHandled?.(focusRequest.requestId);
  }, [focusRequest, onFocusHandled, points, ready]);
  useEffect(() => { if (mapRef.current) mapRef.current.getCanvas().style.cursor = mapPickPlaceId ? "crosshair" : ""; }, [mapPickPlaceId]);
  useEffect(() => { const frame = requestAnimationFrame(() => mapRef.current?.resize()); return () => cancelAnimationFrame(frame); }, [fullscreen]);
  useEffect(() => { const resize = () => mapRef.current?.resize(); window.addEventListener("travel-workspace-resize", resize); return () => window.removeEventListener("travel-workspace-resize", resize); }, []);

  const selectedDay = (routeFocusDayId || selectedDayId) ? workspace.trip.plan.days.find((day) => day.id === (routeFocusDayId || selectedDayId)) : null;
  const selectedPlace = mapPickPlaceId ? workspace.trip.plan.places.find((place) => place.id === mapPickPlaceId) : null;
  const selectedPlaceName = placeNamePresentation(selectedPlace, workspace.trip.planLanguage, "目标地点").combined;
  const legendDays = selectedDay ? [selectedDay] : workspace.trip.plan.days;
  const mapTitle = view === "candidates" ? "旅行地图" : selectedDay ? `Day ${selectedDay.dayNumber} 地图` : "行程全览地图";
  const pointSummary = view === "candidates" ? `已定位地点 ${points.length}` : routeFocusDayId ? `全程已定位节点 ${points.length}` : selectedDay ? `当天已定位节点 ${points.length}` : `全程已定位节点 ${points.length}`;
  return <section className="workspace-map-v2">
    <header><div><p className="eyebrow">MAP WORKSPACE</p><h2>{mapTitle}</h2><small><MapPinned size={13}/>{pointSummary}<Route size={13}/>当前路线 {currentRoutes.length}{dirtyRoutes.length ? ` · 旧路线 ${dirtyRoutes.length}` : ""}</small></div><button className="icon-button panel-fullscreen" type="button" aria-label={fullscreen ? "退出地图全屏" : "地图全屏"} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></header>
    <div className="workspace-map-canvas"><div className="workspace-map-element" ref={element}/>{mapPickPlaceId && <div className="map-pick-banner"><Crosshair size={18}/><span>在地图上点击 <strong>{selectedPlaceName}</strong> 的正确位置</span></div>}{!points.length && <div className="map-empty-overlay"><MapPinned size={34}/><strong>{view === "itinerary" ? "行程节点尚未可靠定位" : "地点会在这里出现"}</strong><span>{view === "itinerary" ? "返回右侧处理尚未定位的地点，或确认当天起点和终点" : "先让 AI 推荐一些地点，或手动添加地点"}</span></div>}{error && <div className="map-error-overlay">{error}</div>}</div>
    <footer>{view === "itinerary" ? <>{legendDays.map((day) => <span key={day.id}><i style={{ background: routeColors.get(day.dayNumber) }}/>Day {day.dayNumber}</span>)}{dirtyRoutes.length > 0 && <span className="muted">虚线为旧路线，仅供参考</span>}</> : <><span><i style={{ background: preferenceColors.must_go }}/>必去</span><span><i style={{ background: preferenceColors.want_to_go }}/>想去</span></>}</footer>
  </section>;
}
