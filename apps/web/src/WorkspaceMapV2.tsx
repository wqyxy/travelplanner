import { Crosshair, MapPinned, Maximize2, Minimize2, Route } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CandidatePreference, PlaceResolution, Workspace } from "./v2-types";
import { candidateRows } from "./workspace-v2";

const preferenceColors: Record<CandidatePreference, string> = {
  must_go: "#e05c45",
  want_to_go: "#1b7f64",
  optional: "#55758d",
  excluded: "#9a9f9d",
};
const preferenceMarks: Record<CandidatePreference, string> = { must_go: "★", want_to_go: "✓", optional: "○", excluded: "×" };

function routeGeometryFeatures(workspace: Workspace, selectedDayId: string | null) {
  const dayNumbers = new Map(workspace.trip.plan.days.map((day) => [day.id, day.dayNumber]));
  return workspace.routeStates.flatMap((state) => {
    if (selectedDayId && state.dayId !== selectedDayId) return [];
    return state.route?.legs.flatMap((leg, index) => leg.geometry ? [{
      type: "Feature",
      id: `${state.dayId}:${index}`,
      geometry: leg.geometry,
      properties: {
        dayId: state.dayId,
        dayNumber: dayNumbers.get(state.dayId) ?? 0,
        mode: leg.mode,
        status: leg.status,
        dirty: state.dirty,
      },
    }] : []) ?? [];
  });
}

function resolvedByPlace(workspace: Workspace) {
  return new Map(workspace.resolutions
    .filter((resolution) => resolution.status === "resolved" && resolution.latitude !== null && resolution.longitude !== null)
    .map((resolution) => [resolution.placeId, resolution]));
}

function coordinate(resolution: PlaceResolution | undefined) {
  return resolution?.latitude === null || resolution?.longitude === null || resolution?.latitude === undefined || resolution?.longitude === undefined
    ? null
    : [resolution.longitude, resolution.latitude];
}

function candidatePointFeatures(workspace: Workspace) {
  return candidateRows(workspace).flatMap((row) => {
    const location = coordinate(row.resolution ?? undefined);
    if (!location) return [];
    return [{
      type: "Feature",
      id: row.candidate.id,
      geometry: { type: "Point", coordinates: location },
      properties: {
        entityType: "candidate",
        candidateId: row.candidate.id,
        stopId: "",
        placeId: row.place.id,
        dayId: "",
        name: row.place.nameZh,
        secondary: row.place.nameLocal || row.place.nameEn || "",
        preference: row.candidate.preference,
        mark: preferenceMarks[row.candidate.preference],
        score: row.candidate.aiScore ?? "",
        address: row.resolution?.address || "",
        excluded: row.candidate.preference === "excluded",
      },
    }];
  });
}

function dayPointFeatures(workspace: Workspace, selectedDayId: string) {
  const day = workspace.trip.plan.days.find((item) => item.id === selectedDayId);
  if (!day) return [];
  const resolutions = resolvedByPlace(workspace);
  const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place]));
  const candidates = new Map(workspace.trip.plan.candidates.map((candidate) => [candidate.id, candidate]));
  const candidateByPlace = new Map(workspace.trip.plan.candidates.map((candidate) => [candidate.placeId, candidate]));
  const features: any[] = [];
  const add = (input: {
    id: string;
    entityType: "anchor" | "stop";
    placeId: string | null;
    stopId?: string;
    candidateId?: string | null;
    mark: string;
    nameFallback: string;
  }) => {
    if (!input.placeId) return;
    const resolution = resolutions.get(input.placeId);
    const location = coordinate(resolution);
    if (!location) return;
    const place = places.get(input.placeId);
    const candidate = input.candidateId ? candidates.get(input.candidateId) : candidateByPlace.get(input.placeId);
    features.push({
      type: "Feature",
      id: input.id,
      geometry: { type: "Point", coordinates: location },
      properties: {
        entityType: input.entityType,
        candidateId: candidate?.id || "",
        stopId: input.stopId || "",
        placeId: input.placeId,
        dayId: day.id,
        name: place?.nameZh || input.nameFallback,
        secondary: place?.nameLocal || place?.nameEn || "",
        preference: candidate?.preference || "anchor",
        mark: input.mark,
        score: candidate?.aiScore ?? "",
        address: resolution?.address || "",
        excluded: false,
      },
    });
  };
  add({ id: day.startAnchor.id, entityType: "anchor", placeId: day.startAnchor.placeId, mark: "起", nameFallback: day.startAnchor.label || "出发 Anchor" });
  day.stops.forEach((stop, index) => add({
    id: stop.id,
    entityType: "stop",
    placeId: stop.placeId,
    stopId: stop.id,
    candidateId: stop.candidateId,
    mark: String(index + 1),
    nameFallback: stop.activity,
  }));
  add({ id: day.endAnchor.id, entityType: "anchor", placeId: day.endAnchor.placeId, mark: "终", nameFallback: day.endAnchor.label || "结束 Anchor" });
  return features;
}

export function WorkspaceMapV2({
  workspace,
  selectedCandidateId,
  selectedDayId,
  selectedStopId,
  mapPickPlaceId,
  fullscreen,
  onSelectCandidate,
  onSelectStop,
  onMapPick,
  onToggleFullscreen,
}: {
  workspace: Workspace;
  selectedCandidateId: string | null;
  selectedDayId: string | null;
  selectedStopId: string | null;
  mapPickPlaceId: string | null;
  fullscreen: boolean;
  onSelectCandidate: (candidateId: string) => void;
  onSelectStop: (stopId: string) => void;
  onMapPick: (placeId: string, latitude: number, longitude: number) => void;
  onToggleFullscreen: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const popupRef = useRef<any>(null);
  const pickRef = useRef(mapPickPlaceId);
  const selectCandidateRef = useRef(onSelectCandidate);
  const selectStopRef = useRef(onSelectStop);
  const onMapPickRef = useRef(onMapPick);
  const fitted = useRef("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  pickRef.current = mapPickPlaceId;
  selectCandidateRef.current = onSelectCandidate;
  selectStopRef.current = onSelectStop;
  onMapPickRef.current = onMapPick;

  const allCandidatePoints = useMemo(() => candidatePointFeatures(workspace), [workspace]);
  const dayPoints = useMemo(() => selectedDayId ? dayPointFeatures(workspace, selectedDayId) : [], [workspace, selectedDayId]);
  const points = selectedDayId ? dayPoints : allCandidatePoints;
  const allRoutes = useMemo(() => routeGeometryFeatures(workspace, selectedDayId), [workspace, selectedDayId]);
  const currentRoutes = useMemo(() => allRoutes.filter((feature: any) => !feature.properties.dirty), [allRoutes]);
  const dirtyRoutes = useMemo(() => allRoutes.filter((feature: any) => feature.properties.dirty), [allRoutes]);
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
        map.addSource("v3-routes-current", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "v3-route-halo", type: "line", source: "v3-routes-current", paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": .82 } });
        map.addLayer({ id: "v3-routes-current", type: "line", source: "v3-routes-current", paint: { "line-color": ["match", ["get", "dayNumber"], 1, "#316bc5", 2, "#dc654d", 3, "#3d9b69", 4, "#9a65bf", 5, "#d1962f", "#277f91"], "line-width": 4, "line-opacity": .9 } });
        map.addSource("v3-routes-dirty", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "v3-routes-dirty", type: "line", source: "v3-routes-dirty", paint: { "line-color": "#6f7780", "line-width": 3, "line-opacity": .3, "line-dasharray": [2, 2] } });
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
            "text-field": ["concat", ["get", "mark"], " ", ["get", "name"]],
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
          else if (candidateId) selectCandidateRef.current(candidateId);
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
    map.setPaintProperty("v3-point-halo", "circle-radius", [
      "case",
      ["any", ["==", ["get", "stopId"], selectedEntityId], ["==", ["get", "candidateId"], selectedEntityId]],
      15,
      11,
    ]);
    map.setPaintProperty("v3-point-halo", "circle-color", [
      "case",
      ["any", ["==", ["get", "stopId"], selectedEntityId], ["==", ["get", "candidateId"], selectedEntityId]],
      "#f3b646",
      "#ffffff",
    ]);
    const key = `${workspace.trip.id}:${workspace.trip.contentGeneration}:${selectedDayId || "all"}:${points.map((point: any) => `${point.id}:${point.geometry.coordinates.join(",")}`).join("|")}`;
    if (points.length && fitted.current !== key) {
      void import("maplibre-gl").then((lib) => {
        if (mapRef.current !== map) return;
        const bounds = new lib.LngLatBounds();
        points.forEach((point: any) => bounds.extend(point.geometry.coordinates));
        if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 450 });
        fitted.current = key;
      });
    }
  }, [ready, points, currentRoutes, dirtyRoutes, selectedEntityId, selectedDayId, workspace.trip.id, workspace.trip.contentGeneration]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || selectedEntityId === "__none__") return;
    const point: any = points.find((feature: any) => feature.properties.stopId === selectedEntityId || feature.properties.candidateId === selectedEntityId);
    if (point) map.flyTo({ center: point.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), duration: 400 });
  }, [ready, points, selectedEntityId]);
  useEffect(() => { if (mapRef.current) mapRef.current.getCanvas().style.cursor = mapPickPlaceId ? "crosshair" : ""; }, [mapPickPlaceId]);
  useEffect(() => { const frame = requestAnimationFrame(() => mapRef.current?.resize()); return () => cancelAnimationFrame(frame); }, [fullscreen]);
  useEffect(() => { const resize = () => mapRef.current?.resize(); window.addEventListener("travel-workspace-resize", resize); return () => window.removeEventListener("travel-workspace-resize", resize); }, []);

  const selectedDay = selectedDayId ? workspace.trip.plan.days.find((day) => day.id === selectedDayId) : null;
  const selectedPlace = mapPickPlaceId ? workspace.trip.plan.places.find((place) => place.id === mapPickPlaceId) : null;
  return <section className="workspace-map-v2">
    <header><div><p className="eyebrow">MAP WORKSPACE</p><h2>{selectedDay ? `Day ${selectedDay.dayNumber} 地图` : "旅行地图"}</h2><small><MapPinned size={13}/>{selectedDay ? `当天已定位节点 ${points.length}` : `已定位地点 ${allCandidatePoints.length}`}<Route size={13}/>当前路线 {currentRoutes.length}{dirtyRoutes.length ? ` · 旧路线 ${dirtyRoutes.length}` : ""}</small></div><button className="icon-button panel-fullscreen" type="button" aria-label={fullscreen ? "退出地图全屏" : "地图全屏"} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></header>
    <div className="workspace-map-canvas"><div className="workspace-map-element" ref={element}/>{mapPickPlaceId && <div className="map-pick-banner"><Crosshair size={18}/><span>在地图上点击 <strong>{selectedPlace?.nameZh || "目标地点"}</strong> 的正确位置</span></div>}{!points.length && <div className="map-empty-overlay"><MapPinned size={34}/><strong>{selectedDay ? "当天节点尚未全部定位" : "地点会在这里出现"}</strong><span>{selectedDay ? "返回地点页处理未定位地点或设置 Anchor" : "先让 AI 生成 Candidate Pool，或手动添加地点"}</span></div>}{error && <div className="map-error-overlay">{error}</div>}</div>
    <footer><span><i style={{ background: preferenceColors.must_go }}/>必去</span><span><i style={{ background: preferenceColors.want_to_go }}/>想去</span><span><i style={{ background: preferenceColors.optional }}/>可选</span><span className="muted"><i style={{ background: preferenceColors.excluded }}/>不去</span>{dirtyRoutes.length > 0 && <span className="muted">虚线为旧路线，仅供参考</span>}</footer>
  </section>;
}
