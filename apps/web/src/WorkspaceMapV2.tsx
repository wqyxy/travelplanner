import { Crosshair, MapPinned, Maximize2, Minimize2, Route } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CandidatePreference, Workspace } from "./v2-types";
import { candidateRows } from "./workspace-v2";

const preferenceColors: Record<CandidatePreference, string> = { must_go: "#e05c45", want_to_go: "#1b7f64", optional: "#55758d", excluded: "#9a9f9d" };
const preferenceMarks: Record<CandidatePreference, string> = { must_go: "★", want_to_go: "✓", optional: "○", excluded: "×" };

function geometryFeatures(workspace: Workspace, selectedDayId: string | null) {
  const dayNumbers = new Map(workspace.trip.plan.days.map((day) => [day.id, day.dayNumber]));
  return workspace.routeStates.flatMap((state) => {
    if (selectedDayId && state.dayId !== selectedDayId) return [];
    return state.route?.legs.flatMap((leg, index) => leg.geometry ? [{ type: "Feature", id: `${state.dayId}:${index}`, geometry: leg.geometry, properties: { dayId: state.dayId, dayNumber: dayNumbers.get(state.dayId) ?? 0, mode: leg.mode, status: leg.status } }] : []) ?? [];
  });
}

export function WorkspaceMapV2({ workspace, selectedCandidateId, selectedDayId, mapPickPlaceId, fullscreen, onSelectCandidate, onMapPick, onToggleFullscreen }: {
  workspace: Workspace;
  selectedCandidateId: string | null;
  selectedDayId: string | null;
  mapPickPlaceId: string | null;
  fullscreen: boolean;
  onSelectCandidate: (candidateId: string) => void;
  onMapPick: (placeId: string, latitude: number, longitude: number) => void;
  onToggleFullscreen: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const popupRef = useRef<any>(null);
  const pickRef = useRef(mapPickPlaceId);
  const selectRef = useRef(onSelectCandidate);
  const onMapPickRef = useRef(onMapPick);
  const fitted = useRef("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  pickRef.current = mapPickPlaceId; selectRef.current = onSelectCandidate; onMapPickRef.current = onMapPick;

  const rows = useMemo(() => candidateRows(workspace), [workspace]);
  const candidateByPlace = useMemo(() => new Map(rows.map((row) => [row.place.id, row.candidate])), [rows]);
  const points = useMemo(() => rows.flatMap((row) => {
    const resolution = row.resolution;
    if (resolution?.status !== "resolved" || resolution.latitude === null || resolution.longitude === null) return [];
    return [{ type: "Feature", id: row.candidate.id, geometry: { type: "Point", coordinates: [resolution.longitude, resolution.latitude] }, properties: { candidateId: row.candidate.id, placeId: row.place.id, name: row.place.nameZh, secondary: row.place.nameLocal || row.place.nameEn || "", preference: row.candidate.preference, mark: preferenceMarks[row.candidate.preference], score: row.candidate.aiScore ?? "", address: resolution.address || "", excluded: row.candidate.preference === "excluded" } }];
  }), [rows]);
  const routes = useMemo(() => geometryFeatures(workspace, selectedDayId), [workspace, selectedDayId]);

  useEffect(() => {
    let cancelled = false; let map: any; let observer: ResizeObserver | null = null;
    void import("maplibre-gl").then((lib) => {
      if (cancelled || !element.current) return;
      map = new lib.Map({ container: element.current, style: { version: 8, sources: { base: { type: "raster", tiles: ["/api/map/tiles/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } }, layers: [{ id: "base", type: "raster", source: "base" }] }, center: [105, 35], zoom: 2.5 });
      map.addControl(new lib.NavigationControl({ showCompass: false }), "bottom-right");
      map.on("load", () => {
        map.addSource("v3-routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "v3-route-halo", type: "line", source: "v3-routes", paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": .82 } });
        map.addLayer({ id: "v3-routes", type: "line", source: "v3-routes", paint: { "line-color": ["match", ["get", "dayNumber"], 1, "#316bc5", 2, "#dc654d", 3, "#3d9b69", 4, "#9a65bf", 5, "#d1962f", "#277f91"], "line-width": 4, "line-opacity": .9 } });
        map.addSource("v3-candidates", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "v3-candidate-halo", type: "circle", source: "v3-candidates", paint: { "circle-radius": ["case", ["==", ["get", "candidateId"], ""], 0, 13], "circle-color": "#ffffff", "circle-opacity": .9 } });
        map.addLayer({ id: "v3-candidates", type: "circle", source: "v3-candidates", paint: { "circle-radius": ["case", ["==", ["get", "preference"], "must_go"], 9, 8], "circle-color": ["match", ["get", "preference"], "must_go", preferenceColors.must_go, "want_to_go", preferenceColors.want_to_go, "optional", preferenceColors.optional, preferenceColors.excluded], "circle-stroke-width": 2, "circle-stroke-color": "#ffffff", "circle-opacity": ["case", ["get", "excluded"], .45, .95] } });
        map.addLayer({ id: "v3-candidate-labels", type: "symbol", source: "v3-candidates", minzoom: 8, layout: { "text-field": ["concat", ["get", "mark"], " ", ["get", "name"]], "text-size": 12, "text-offset": [0, 1.4], "text-anchor": "top", "text-allow-overlap": false }, paint: { "text-color": "#24342e", "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });
        map.on("mouseenter", "v3-candidates", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "v3-candidates", () => { map.getCanvas().style.cursor = pickRef.current ? "crosshair" : ""; });
        map.on("click", "v3-candidates", (event: any) => {
          if (pickRef.current) return;
          const feature = event.features?.[0]; const id = String(feature?.properties?.candidateId || "");
          if (!id) return;
          selectRef.current(id);
          const properties = feature.properties || {};
          const content = document.createElement("div"); content.className = "v3-map-popup";
          const title = document.createElement("strong"); title.textContent = `${properties.mark || ""} ${properties.name || "地点"}`.trim(); content.append(title);
          if (properties.secondary) { const secondary = document.createElement("small"); secondary.textContent = properties.secondary; content.append(secondary); }
          if (properties.address) { const address = document.createElement("p"); address.textContent = properties.address; content.append(address); }
          popupRef.current?.remove(); popupRef.current = new lib.Popup({ offset: 15 }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
        });
        map.on("click", (event: any) => {
          const placeId = pickRef.current;
          if (!placeId) return;
          onMapPickRef.current(placeId, event.lngLat.lat, event.lngLat.lng);
        });
        setReady(true);
      });
      observer = new ResizeObserver(() => map.resize()); observer.observe(element.current); mapRef.current = map;
    }).catch(() => setError("地图渲染组件加载失败。"));
    return () => { cancelled = true; observer?.disconnect(); popupRef.current?.remove(); map?.remove(); mapRef.current = null; setReady(false); };
  }, []);

  useEffect(() => {
    const map = mapRef.current; if (!ready || !map) return;
    map.getSource("v3-candidates")?.setData({ type: "FeatureCollection", features: points });
    map.getSource("v3-routes")?.setData({ type: "FeatureCollection", features: routes });
    map.setPaintProperty("v3-candidate-halo", "circle-radius", ["case", ["==", ["get", "candidateId"], selectedCandidateId || "__none__"], 15, 11]);
    map.setPaintProperty("v3-candidate-halo", "circle-color", ["case", ["==", ["get", "candidateId"], selectedCandidateId || "__none__"], "#f3b646", "#ffffff"]);
    const key = `${workspace.trip.id}:${workspace.trip.contentGeneration}:${points.map((point: any) => point.id).join(",")}`;
    if (points.length && fitted.current !== key) void import("maplibre-gl").then((lib) => {
      if (mapRef.current !== map) return;
      const bounds = new lib.LngLatBounds(); points.forEach((point: any) => bounds.extend(point.geometry.coordinates));
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 64, maxZoom: 13, duration: 450 });
      fitted.current = key;
    });
  }, [ready, points, routes, selectedCandidateId, workspace.trip.id, workspace.trip.contentGeneration]);

  useEffect(() => {
    const map = mapRef.current; if (!ready || !map || !selectedCandidateId) return;
    const point: any = points.find((feature: any) => feature.id === selectedCandidateId);
    if (point) map.flyTo({ center: point.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), duration: 400 });
  }, [ready, points, selectedCandidateId]);
  useEffect(() => { if (mapRef.current) mapRef.current.getCanvas().style.cursor = mapPickPlaceId ? "crosshair" : ""; }, [mapPickPlaceId]);
  useEffect(() => { const frame = requestAnimationFrame(() => mapRef.current?.resize()); return () => cancelAnimationFrame(frame); }, [fullscreen]);
  useEffect(() => { const resize = () => mapRef.current?.resize(); window.addEventListener("travel-workspace-resize", resize); return () => window.removeEventListener("travel-workspace-resize", resize); }, []);

  const resolvedCount = points.length;
  const selectedPlace = mapPickPlaceId ? workspace.trip.plan.places.find((place) => place.id === mapPickPlaceId) : null;
  return <section className="workspace-map-v2">
    <header><div><p className="eyebrow">MAP WORKSPACE</p><h2>{selectedDayId ? `Day ${workspace.trip.plan.days.find((day) => day.id === selectedDayId)?.dayNumber || ""} 地图` : "旅行地图"}</h2><small><MapPinned size={13}/>已定位 {resolvedCount}/{rows.length}<Route size={13}/>路线 {routes.length}</small></div><button className="icon-button panel-fullscreen" type="button" aria-label={fullscreen ? "退出地图全屏" : "地图全屏"} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></header>
    <div className="workspace-map-canvas"><div className="workspace-map-element" ref={element}/>{mapPickPlaceId && <div className="map-pick-banner"><Crosshair size={18}/><span>在地图上点击 <strong>{selectedPlace?.nameZh || "目标地点"}</strong> 的正确位置</span></div>}{!rows.length && <div className="map-empty-overlay"><MapPinned size={34}/><strong>地点会在这里出现</strong><span>先让 AI 生成 Candidate Pool</span></div>}{error && <div className="map-error-overlay">{error}</div>}</div>
    <footer><span><i style={{ background: preferenceColors.must_go }}/>必去</span><span><i style={{ background: preferenceColors.want_to_go }}/>想去</span><span><i style={{ background: preferenceColors.optional }}/>可选</span><span className="muted"><i style={{ background: preferenceColors.excluded }}/>不去</span></footer>
  </section>;
}
