import { Crosshair, MapPinned, Maximize2, Minimize2, Route, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceV3 } from "./v3-types";
import { placeNamePresentation } from "./place-name-presentation";
import { finalRouteMapPointFeaturesV3, finalRouteMapRouteGeometryFeaturesV3, finalRouteMapStatusColorsV3 } from "./final-route-map-v3";
import { dayRouteColors } from "./workspace-map-presentation-v2";
import { finalRouteStatusLabelsV3 } from "./final-route-ui-v3";

export type FinalRouteMapFocusRequestV3 = {
  nodeId: string;
  placeId?: string | null;
  kind?: "node" | "route";
  requestId: number;
};

function routeCoordinates(geometry: unknown): Array<[number, number]> {
  const coordinates = (geometry as any)?.coordinates;
  if (!Array.isArray(coordinates)) return [];
  const result: Array<[number, number]> = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") {
      result.push([value[0], value[1]]);
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
  };
  visit(coordinates);
  return result;
}

function routeLabelCoordinate(geometry: unknown): [number, number] | null {
  const coordinates = (geometry as any)?.coordinates;
  const line = Array.isArray(coordinates?.[0]?.[0]) ? coordinates[0] : coordinates;
  const point = Array.isArray(line) && line.length ? line[Math.floor(line.length / 2)] : null;
  return Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number" ? [point[0], point[1]] : null;
}

export function FinalRouteMapV3({
  workspace,
  selectedNodeId,
  hoveredNodeId,
  hoveredRouteNodeId,
  hoveredRoutePlaceId,
  focusRequest,
  mapPickPlaceId,
  fullscreen,
  onSelectNode,
  onHoverNode,
  onHoverRoute,
  onFocusNode,
  onFocusRoute,
  onMapPick,
  onCancelMapPick,
  onFocusHandled,
  onToggleFullscreen,
}: {
  workspace: WorkspaceV3;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  hoveredRouteNodeId: string | null;
  hoveredRoutePlaceId: string | null;
  focusRequest: FinalRouteMapFocusRequestV3 | null;
  mapPickPlaceId: string | null;
  fullscreen: boolean;
  onSelectNode: (nodeId: string) => void;
  onHoverNode: (nodeId: string | null) => void;
  onHoverRoute: (nodeId: string | null, placeId?: string | null) => void;
  onFocusNode: (nodeId: string) => void;
  onFocusRoute: (nodeId: string, placeId?: string | null) => void;
  onMapPick: (placeId: string, latitude: number, longitude: number) => void;
  onCancelMapPick: () => void;
  onFocusHandled: (requestId: number) => void;
  onToggleFullscreen: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const popupRef = useRef<any>(null);
  const routePopupRef = useRef<any>(null);
  const pickRef = useRef(mapPickPlaceId);
  const selectNodeRef = useRef(onSelectNode);
  const hoverNodeRef = useRef(onHoverNode);
  const hoverRouteRef = useRef(onHoverRoute);
  const focusNodeRef = useRef(onFocusNode);
  const focusRouteRef = useRef(onFocusRoute);
  const mapPickRef = useRef(onMapPick);
  const fitted = useRef("");
  const focusedViewKey = useRef<string | null>(null);
  const hoveredMapRouteNodeId = useRef<string | null>(null);
  const handledFocusRequestId = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  pickRef.current = mapPickPlaceId;
  selectNodeRef.current = onSelectNode;
  hoverNodeRef.current = onHoverNode;
  hoverRouteRef.current = onHoverRoute;
  focusNodeRef.current = onFocusNode;
  focusRouteRef.current = onFocusRoute;
  mapPickRef.current = onMapPick;

  const points = useMemo(() => finalRouteMapPointFeaturesV3(workspace), [workspace]);
  const allRoutes = useMemo(() => finalRouteMapRouteGeometryFeaturesV3(workspace), [workspace]);
  const currentRoutes = useMemo(() => allRoutes.filter((feature) => !feature.properties.dirty), [allRoutes]);
  const dirtyRoutes = useMemo(() => allRoutes.filter((feature) => feature.properties.dirty), [allRoutes]);
  const routeColors = useMemo(() => dayRouteColors(workspace.trip.plan.days), [workspace.trip.plan.days]);

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
        map.addSource("final-route-lines", { type: "geojson", data: empty });
        map.addLayer({ id: "final-route-lines-halo", type: "line", source: "final-route-lines", paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": .82 } });
        map.addLayer({ id: "final-route-lines", type: "line", source: "final-route-lines", paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": .9 } });
        map.addSource("final-route-lines-hover", { type: "geojson", data: empty });
        map.addLayer({ id: "final-route-lines-hover-halo", type: "line", source: "final-route-lines-hover", paint: { "line-color": "#ffffff", "line-width": 13, "line-opacity": .96 } });
        map.addLayer({ id: "final-route-lines-hover", type: "line", source: "final-route-lines-hover", paint: { "line-color": "#f3b646", "line-width": 8, "line-opacity": 1 } });
        map.addLayer({ id: "final-route-line-labels", type: "symbol", source: "final-route-lines", layout: { "symbol-placement": "line", "text-field": ["get", "summary"], "text-size": 11, "text-padding": 8, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#24342e", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
        map.addLayer({ id: "final-route-lines-hit", type: "line", source: "final-route-lines", paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0 } });
        map.addSource("final-route-lines-dirty", { type: "geojson", data: empty });
        map.addLayer({ id: "final-route-lines-dirty", type: "line", source: "final-route-lines-dirty", paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": .28, "line-dasharray": [2, 2] } });
        map.addLayer({ id: "final-route-line-labels-dirty", type: "symbol", source: "final-route-lines-dirty", layout: { "symbol-placement": "line", "text-field": ["get", "summary"], "text-size": 11, "text-padding": 8, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#6d6b5c", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
        map.addLayer({ id: "final-route-lines-dirty-hit", type: "line", source: "final-route-lines-dirty", paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0, "line-dasharray": [2, 2] } });
        map.addSource("final-route-points", { type: "geojson", data: empty });
        map.addLayer({ id: "final-route-point-halo", type: "circle", source: "final-route-points", paint: { "circle-radius": 13, "circle-color": "#ffffff", "circle-opacity": .9 } });
        map.addLayer({
          id: "final-route-points",
          type: "circle",
          source: "final-route-points",
          paint: {
            "circle-radius": 9,
            "circle-color": ["match", ["get", "status"], "normal", finalRouteMapStatusColorsV3.normal, "tentative", finalRouteMapStatusColorsV3.tentative, "no_go", finalRouteMapStatusColorsV3.no_go, finalRouteMapStatusColorsV3.normal],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
            "circle-opacity": ["match", ["get", "status"], "normal", .96, "tentative", .72, "no_go", .48, .96],
          },
        });
        map.addLayer({
          id: "final-route-labels",
          type: "symbol",
          source: "final-route-points",
          layout: { "text-field": ["concat", ["get", "mark"], " ", ["get", "label"]], "text-size": 12, "text-offset": [0, 1.45], "text-anchor": "top", "text-allow-overlap": false },
          paint: { "text-color": "#24342e", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
        });
        map.on("mouseenter", "final-route-points", (event: any) => { map.getCanvas().style.cursor = "pointer"; hoverRouteRef.current(null, null); hoveredMapRouteNodeId.current = null; routePopupRef.current?.remove(); routePopupRef.current = null; const nodeId = String(event.features?.[0]?.properties?.routeNodeId || ""); if (nodeId) hoverNodeRef.current(nodeId); });
        map.on("mouseleave", "final-route-points", () => { hoverNodeRef.current(null); map.getCanvas().style.cursor = pickRef.current ? "crosshair" : ""; });
        map.on("click", "final-route-points", (event: any) => {
          if (pickRef.current) return;
          const properties = event.features?.[0]?.properties ?? {};
          const nodeId = String(properties.routeNodeId || "");
          if (nodeId) { selectNodeRef.current(nodeId); focusNodeRef.current(nodeId); }
          const content = document.createElement("div");
          content.className = "v3-map-popup";
          const title = document.createElement("strong");
          title.textContent = `${properties.mark || ""} ${properties.name || "地点"}`.trim();
          content.append(title);
          const status = document.createElement("small");
          const statusKey = String(properties.status || "normal") as keyof typeof finalRouteStatusLabelsV3;
          status.textContent = `线路状态：${finalRouteStatusLabelsV3[statusKey] ?? "正常"}`;
          content.append(status);
          if (properties.secondary) { const secondary = document.createElement("small"); secondary.textContent = properties.secondary; content.append(secondary); }
          if (properties.address) { const address = document.createElement("p"); address.textContent = properties.address; content.append(address); }
          popupRef.current?.remove();
          popupRef.current = new lib.Popup({ offset: 15 }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
        });
        map.on("mousemove", (event: any) => {
          const feature = map.queryRenderedFeatures(event.point, { layers: ["final-route-lines-hit", "final-route-lines-dirty-hit"] })[0];
          const nodeId = String(feature?.properties?.toNodeId || "");
          if (nodeId) {
            hoverNodeRef.current(null);
            hoverRouteRef.current(nodeId, String(feature?.properties?.toPlaceId || "") || null);
            map.getCanvas().style.cursor = "pointer";
            const summary = String(feature?.properties?.summary || "");
            if (summary && hoveredMapRouteNodeId.current !== nodeId) {
              const content = document.createElement("div");
              content.className = "v3-map-popup v3-route-popup";
              const metrics = document.createElement("strong");
              metrics.textContent = summary;
              content.append(metrics);
              routePopupRef.current?.remove();
              routePopupRef.current = new lib.Popup({ offset: 10, closeButton: false, closeOnClick: false }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
              hoveredMapRouteNodeId.current = nodeId;
            } else {
              routePopupRef.current?.setLngLat(event.lngLat);
            }
          } else {
            hoverNodeRef.current(null);
            hoverRouteRef.current(null, null);
            hoveredMapRouteNodeId.current = null;
            routePopupRef.current?.remove();
            routePopupRef.current = null;
            map.getCanvas().style.cursor = pickRef.current ? "crosshair" : "";
          }
        });
        map.on("mouseout", () => { hoverNodeRef.current(null); hoverRouteRef.current(null, null); hoveredMapRouteNodeId.current = null; routePopupRef.current?.remove(); routePopupRef.current = null; map.getCanvas().style.cursor = pickRef.current ? "crosshair" : ""; });
        map.on("click", (event: any) => {
          const placeId = pickRef.current;
          if (placeId) {
            mapPickRef.current(placeId, event.lngLat.lat, event.lngLat.lng);
            return;
          }
          if (map.queryRenderedFeatures(event.point, { layers: ["final-route-points"] })[0]) return;
          const feature = map.queryRenderedFeatures(event.point, { layers: ["final-route-lines-hit", "final-route-lines-dirty-hit"] })[0];
          const nodeId = String(feature?.properties?.toNodeId || "");
          const routePlaceId = String(feature?.properties?.toPlaceId || "") || null;
          if (nodeId) { selectNodeRef.current(nodeId); focusRouteRef.current(nodeId, routePlaceId); }
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
    map.getSource("final-route-points")?.setData({ type: "FeatureCollection", features: points });
    map.getSource("final-route-lines")?.setData({ type: "FeatureCollection", features: currentRoutes });
    map.getSource("final-route-lines-dirty")?.setData({ type: "FeatureCollection", features: dirtyRoutes });
    const hoverId = hoveredNodeId || "__none__";
    const routeHoverId = hoveredRouteNodeId || "__none__";
    const routeHoverPlaceId = hoveredRoutePlaceId || points.find((point) => point.properties.routeNodeId === hoveredRouteNodeId)?.properties.placeId || "__none__";
    const routeHighlight = ["any", ["==", ["get", "toNodeId"], routeHoverId], ["==", ["get", "toPlaceId"], routeHoverPlaceId]];
    map.getSource("final-route-lines-hover")?.setData({ type: "FeatureCollection", features: [...currentRoutes, ...dirtyRoutes].filter((feature) => feature.properties.toNodeId === routeHoverId || feature.properties.toPlaceId === routeHoverPlaceId) });
    const selectedId = selectedNodeId || "__none__";
    map.setPaintProperty("final-route-point-halo", "circle-radius", ["case", ["==", ["get", "routeNodeId"], hoverId], 18, ["==", ["get", "routeNodeId"], selectedId], 16, 12]);
    map.setPaintProperty("final-route-point-halo", "circle-color", ["case", ["==", ["get", "routeNodeId"], hoverId], "#f3b646", ["==", ["get", "routeNodeId"], selectedId], "#a9cde6", "#ffffff"]);
    map.setPaintProperty("final-route-lines-halo", "line-width", ["case", routeHighlight, 14, 8]);
    map.setPaintProperty("final-route-lines", "line-width", ["case", routeHighlight, 7, 4]);
    map.setPaintProperty("final-route-lines-dirty", "line-width", ["case", routeHighlight, 7, 3]);
    map.setFilter("final-route-line-labels", ["any", ["==", ["get", "toNodeId"], routeHoverId], ["==", ["get", "toPlaceId"], routeHoverPlaceId]]);
    map.setFilter("final-route-line-labels-dirty", ["any", ["==", ["get", "toNodeId"], routeHoverId], ["==", ["get", "toPlaceId"], routeHoverPlaceId]]);
    const key = `${workspace.trip.id}:${workspace.trip.contentGeneration}:final-route`;
    if (points.length && fitted.current !== key) {
      void import("maplibre-gl").then((lib) => {
        if (mapRef.current !== map) return;
        const bounds = new lib.LngLatBounds();
        points.forEach((point) => bounds.extend(point.geometry.coordinates));
        if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 450 });
        focusedViewKey.current = null;
        fitted.current = key;
      });
    }
  }, [currentRoutes, dirtyRoutes, hoveredNodeId, hoveredRouteNodeId, points, ready, selectedNodeId, workspace.trip.contentGeneration, workspace.trip.id]);

  useEffect(() => {
    const map = mapRef.current;
    const routeNodeId = hoveredRouteNodeId;
    const routePlaceId = hoveredRoutePlaceId || points.find((point) => point.properties.routeNodeId === routeNodeId)?.properties.placeId;
    const route = [...currentRoutes, ...dirtyRoutes].find((feature) => feature.properties.toNodeId === routeNodeId || feature.properties.toPlaceId === routePlaceId);
    const coordinate = route ? routeLabelCoordinate(route.geometry) : null;
    if (!ready || !map || !coordinate || !route?.properties.summary) {
      routePopupRef.current?.remove();
      routePopupRef.current = null;
      return;
    }
    void import("maplibre-gl").then((lib) => {
      if (mapRef.current !== map) return;
      const content = document.createElement("div");
      content.className = "v3-map-popup v3-route-popup";
      const metrics = document.createElement("strong");
      metrics.textContent = route.properties.summary;
      content.append(metrics);
      routePopupRef.current?.remove();
      routePopupRef.current = new lib.Popup({ offset: 10, closeButton: false, closeOnClick: false }).setLngLat(coordinate).setDOMContent(content).addTo(map);
    });
  }, [currentRoutes, dirtyRoutes, hoveredRouteNodeId, hoveredRoutePlaceId, points, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focusRequest) return;
    if (handledFocusRequestId.current === focusRequest.requestId) return;
    handledFocusRequestId.current = focusRequest.requestId;
    const point = points.find((item) => item.properties.routeNodeId === focusRequest.nodeId);
    const viewKind = focusRequest.kind ?? "node";
    const placeId = focusRequest.placeId || points.find((item) => item.properties.routeNodeId === focusRequest.nodeId)?.properties.placeId || null;
    const targetKey = `${viewKind}:${focusRequest.nodeId}:${placeId || ""}`;
    const fitAll = () => {
      void import("maplibre-gl").then((lib) => {
        if (mapRef.current !== map) return;
        const bounds = new lib.LngLatBounds();
        points.forEach((item) => bounds.extend(item.geometry.coordinates));
        if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 450 });
      });
    };
    if (focusedViewKey.current === targetKey) {
      fitAll();
      focusedViewKey.current = null;
    } else if (viewKind === "route") {
      const routeFeatures = [...currentRoutes, ...dirtyRoutes].filter((feature) => feature.properties.toNodeId === focusRequest.nodeId || feature.properties.toPlaceId === placeId);
      const coordinates = routeFeatures.flatMap((feature) => routeCoordinates(feature.geometry));
      if (coordinates.length) {
        void import("maplibre-gl").then((lib) => {
          if (mapRef.current !== map) return;
          const bounds = new lib.LngLatBounds();
          coordinates.forEach((coordinate) => bounds.extend(coordinate));
          if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 72, maxZoom: 14, duration: 450 });
        });
        focusedViewKey.current = targetKey;
      }
    } else if (point) {
      map.flyTo({ center: point.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), duration: 400 });
      focusedViewKey.current = targetKey;
    }
    onFocusHandled(focusRequest.requestId);
  }, [currentRoutes, dirtyRoutes, focusRequest, onFocusHandled, points, ready]);

  useEffect(() => { if (mapRef.current) mapRef.current.getCanvas().style.cursor = mapPickPlaceId ? "crosshair" : ""; }, [mapPickPlaceId]);
  useEffect(() => { const frame = requestAnimationFrame(() => mapRef.current?.resize()); return () => cancelAnimationFrame(frame); }, [fullscreen]);
  useEffect(() => { const resize = () => mapRef.current?.resize(); window.addEventListener("travel-workspace-resize", resize); return () => window.removeEventListener("travel-workspace-resize", resize); }, []);

  const selectedPlace = mapPickPlaceId ? workspace.trip.plan.places.find((place) => place.id === mapPickPlaceId) : null;
  const selectedPlaceName = placeNamePresentation(selectedPlace, workspace.trip.planLanguage, "目标地点").combined;
  return <section className="workspace-map-v2 final-route-map-v3">
    <header><div><p className="eyebrow">MAP</p><h2>最终线路地图</h2><small><MapPinned size={13}/>已定位 {points.length}/{workspace.trip.plan.finalRoute?.nodes.length ?? 0}<Route size={13}/>路线 {currentRoutes.length}{dirtyRoutes.length ? ` · 待更新 ${dirtyRoutes.length}` : ""}</small></div><button className="icon-button panel-fullscreen" type="button" aria-label={fullscreen ? "退出地图全屏" : "地图全屏"} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></header>
    <div className="workspace-map-canvas"><div className="workspace-map-element" ref={element}/>{mapPickPlaceId && <div className="map-pick-banner"><Crosshair size={18}/><span>在地图上点击 <strong>{selectedPlaceName}</strong> 的正确位置</span><button className="icon-button compact" type="button" aria-label="取消地图选点" onClick={onCancelMapPick}><X size={15}/></button></div>}{!points.length && <div className="map-empty-overlay"><MapPinned size={34}/><strong>线路地点还没有可靠坐标</strong><span>地点仍会保留在线路中；请在右侧选择地点后修复定位</span></div>}{error && <div className="map-error-overlay">{error}</div>}</div>
    <footer><span><i style={{ background: finalRouteMapStatusColorsV3.normal }}/>正常</span><span><i style={{ background: finalRouteMapStatusColorsV3.tentative }}/>待定</span><span><i style={{ background: finalRouteMapStatusColorsV3.no_go }}/>不去</span>{workspace.trip.plan.days.map((day) => <span key={day.id}><i style={{ background: routeColors.get(day.dayNumber) }}/>Day {day.dayNumber}</span>)}{dirtyRoutes.length > 0 && <span className="muted">虚线为待更新路线</span>}</footer>
  </section>;
}
