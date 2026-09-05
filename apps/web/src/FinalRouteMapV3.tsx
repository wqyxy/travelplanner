import { Crosshair, MapPinned, Maximize2, Minimize2, Route } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceV3 } from "./v3-types";
import { placeNamePresentation } from "./place-name-presentation";
import { finalRouteMapPointFeaturesV3, finalRouteMapStatusColorsV3 } from "./final-route-map-v3";
import { dayRouteColors, routeGeometryFeatures } from "./workspace-map-presentation-v2";
import { finalRouteStatusLabelsV3 } from "./final-route-ui-v3";

export type FinalRouteMapFocusRequestV3 = { nodeId: string; requestId: number };

export function FinalRouteMapV3({
  workspace,
  selectedNodeId,
  focusRequest,
  mapPickPlaceId,
  fullscreen,
  onSelectNode,
  onMapPick,
  onFocusHandled,
  onToggleFullscreen,
}: {
  workspace: WorkspaceV3;
  selectedNodeId: string | null;
  focusRequest: FinalRouteMapFocusRequestV3 | null;
  mapPickPlaceId: string | null;
  fullscreen: boolean;
  onSelectNode: (nodeId: string) => void;
  onMapPick: (placeId: string, latitude: number, longitude: number) => void;
  onFocusHandled: (requestId: number) => void;
  onToggleFullscreen: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const popupRef = useRef<any>(null);
  const pickRef = useRef(mapPickPlaceId);
  const selectNodeRef = useRef(onSelectNode);
  const mapPickRef = useRef(onMapPick);
  const fitted = useRef("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  pickRef.current = mapPickPlaceId;
  selectNodeRef.current = onSelectNode;
  mapPickRef.current = onMapPick;

  const points = useMemo(() => finalRouteMapPointFeaturesV3(workspace), [workspace]);
  const allRoutes = useMemo(() => routeGeometryFeatures(workspace as any, null), [workspace]);
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
        map.addSource("final-route-lines-dirty", { type: "geojson", data: empty });
        map.addLayer({ id: "final-route-lines-dirty", type: "line", source: "final-route-lines-dirty", paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": .28, "line-dasharray": [2, 2] } });
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
        map.on("mouseenter", "final-route-points", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "final-route-points", () => { map.getCanvas().style.cursor = pickRef.current ? "crosshair" : ""; });
        map.on("click", "final-route-points", (event: any) => {
          if (pickRef.current) return;
          const properties = event.features?.[0]?.properties ?? {};
          const nodeId = String(properties.routeNodeId || "");
          if (nodeId) selectNodeRef.current(nodeId);
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
        map.on("click", (event: any) => {
          const placeId = pickRef.current;
          if (!placeId) return;
          mapPickRef.current(placeId, event.lngLat.lat, event.lngLat.lng);
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
    map.setPaintProperty("final-route-point-halo", "circle-radius", ["case", ["==", ["get", "routeNodeId"], selectedNodeId || "__none__"], 16, 12]);
    map.setPaintProperty("final-route-point-halo", "circle-color", ["case", ["==", ["get", "routeNodeId"], selectedNodeId || "__none__"], "#f3b646", "#ffffff"]);
    const key = `${workspace.trip.id}:${workspace.trip.contentGeneration}:final-route`;
    if (points.length && fitted.current !== key) {
      void import("maplibre-gl").then((lib) => {
        if (mapRef.current !== map) return;
        const bounds = new lib.LngLatBounds();
        points.forEach((point) => bounds.extend(point.geometry.coordinates));
        if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 450 });
        fitted.current = key;
      });
    }
  }, [currentRoutes, dirtyRoutes, points, ready, selectedNodeId, workspace.trip.contentGeneration, workspace.trip.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !selectedNodeId) return;
    const point = points.find((item) => item.properties.routeNodeId === selectedNodeId);
    if (point) map.flyTo({ center: point.geometry.coordinates, zoom: Math.max(map.getZoom(), 13), duration: 350 });
  }, [points, ready, selectedNodeId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focusRequest) return;
    const point = points.find((item) => item.properties.routeNodeId === focusRequest.nodeId);
    if (point) map.flyTo({ center: point.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), duration: 400 });
    onFocusHandled(focusRequest.requestId);
  }, [focusRequest, onFocusHandled, points, ready]);

  useEffect(() => { if (mapRef.current) mapRef.current.getCanvas().style.cursor = mapPickPlaceId ? "crosshair" : ""; }, [mapPickPlaceId]);
  useEffect(() => { const frame = requestAnimationFrame(() => mapRef.current?.resize()); return () => cancelAnimationFrame(frame); }, [fullscreen]);
  useEffect(() => { const resize = () => mapRef.current?.resize(); window.addEventListener("travel-workspace-resize", resize); return () => window.removeEventListener("travel-workspace-resize", resize); }, []);

  const selectedPlace = mapPickPlaceId ? workspace.trip.plan.places.find((place) => place.id === mapPickPlaceId) : null;
  const selectedPlaceName = placeNamePresentation(selectedPlace, workspace.trip.planLanguage, "目标地点").combined;
  return <section className="workspace-map-v2 final-route-map-v3">
    <header><div><p className="eyebrow">MAP</p><h2>最终线路地图</h2><small><MapPinned size={13}/>已定位 {points.length}/{workspace.trip.plan.finalRoute?.nodes.length ?? 0}<Route size={13}/>路线 {currentRoutes.length}{dirtyRoutes.length ? ` · 待更新 ${dirtyRoutes.length}` : ""}</small></div><button className="icon-button panel-fullscreen" type="button" aria-label={fullscreen ? "退出地图全屏" : "地图全屏"} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></header>
    <div className="workspace-map-canvas"><div className="workspace-map-element" ref={element}/>{mapPickPlaceId && <div className="map-pick-banner"><Crosshair size={18}/><span>在地图上点击 <strong>{selectedPlaceName}</strong> 的正确位置</span></div>}{!points.length && <div className="map-empty-overlay"><MapPinned size={34}/><strong>线路地点还没有可靠坐标</strong><span>地点仍会保留在线路中；请在右侧选择地点后修复定位</span></div>}{error && <div className="map-error-overlay">{error}</div>}</div>
    <footer><span><i style={{ background: finalRouteMapStatusColorsV3.normal }}/>正常</span><span><i style={{ background: finalRouteMapStatusColorsV3.tentative }}/>待定</span><span><i style={{ background: finalRouteMapStatusColorsV3.no_go }}/>不去</span>{workspace.trip.plan.days.map((day) => <span key={day.id}><i style={{ background: routeColors.get(day.dayNumber) }}/>Day {day.dayNumber}</span>)}{dirtyRoutes.length > 0 && <span className="muted">虚线为待更新路线</span>}</footer>
  </section>;
}
