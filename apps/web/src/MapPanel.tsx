import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./map-label-overrides.css";
import { AlertTriangle, ChevronDown, ChevronUp, Filter, LoaderCircle, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { api } from "./api";
import type {
  Candidate,
  MapEntity,
  MapPatch,
  MapPlace,
  MapRoute,
  MapSnapshot,
  MapVisit,
  TripPlan,
} from "./types";
import { applyMapPatch } from "./map-patch-reducer";
import {
  clusterHiddenLabels,
  labelRole,
  layoutLabels,
} from "./map-label-layout";
import {
  defaultCategoryVisibility,
  mapCategoryLegend,
  routeHoverFromFeature,
  visibleCategories,
} from "./map-interactions";
import type { MapCategory } from "./map-interactions";
import { mapStatusPresentation } from "./map-status";
import type { MapSelection } from "./Itinerary";
import { shouldApplyMapLayout, shouldRequestFullscreenLayout } from "./workspace-controls";

type JobUpdate = {
  tripId: string;
  itineraryVersion: number;
  mapVersion: number;
  status: MapSnapshot["status"];
  summary: string;
} | null;
const displayEntityName = (item: MapEntity) =>
  `${item.name}${item.status === "approximate" ? "（大致）" : ""}`;
const pointFeature = (item: MapEntity) => ({
  type: "Feature" as const,
  id: item.id,
  geometry: {
    type: "Point" as const,
    coordinates: [item.location!.longitude, item.location!.latitude],
  },
  properties: {
    id: item.id,
    name: displayEntityName(item),
    kind: item.kind,
    importance: item.importance,
    dayNumber: item.dayNumber,
    time: [item.startTime, item.endTime].filter(Boolean).join("–"),
    detail: item.detail,
    duration: item.durationMinutes,
    transportMode: item.transportMode,
    costNote: item.costNote,
    notes: item.notes,
    city: item.city,
    sourceUrl: item.location!.sourceUrl,
    sourceType: item.location!.sourceType,
    evidenceUrl: item.location!.evidenceUrl || "",
    confidence: item.location!.confidence,
    decisionNote: item.location!.decisionNote || "",
    approximateLodgingArea: item.approximateLodgingArea,
  },
});
const dayColors = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#d97706",
  "#0891b2",
];
const routeFeature = (item: MapRoute, scope?: "all" | "day" | number) => ({
  type: "Feature" as const,
  id: item.id,
  geometry: item.geometry!,
  properties: {
    id: item.id,
    mode: item.mode,
    dayNumber: item.dayNumber,
    dayColor: dayColors[(item.dayNumber - 1) % dayColors.length],
    scope: scope === "all" ? "all" : "day",
  },
});
const mapById = <T extends { id: string }>(values: T[]) =>
  new Map(values.map((item) => [item.id, item]));

/** Adapt v4's shared places/visits to the established MapLibre presentation shape. */
function normalizeSnapshot(raw: MapSnapshot): MapSnapshot {
  // A legacy v3 snapshot has renderable `entities` but no visits. Keep using
  // that presentation verbatim: reading an old map must never implicitly
  // convert it to v4 or hide its markers.
  if ((raw.contractVersion ?? 3) < 4 || !raw.places || !raw.visits) {
    return { ...raw, entities: raw.entities || [] };
  }
  const visits = raw.scope === "day" && raw.dayNumber != null
    ? raw.visits.filter((visit) => visit.dayNumber === raw.dayNumber)
    : raw.visits;
  const visitsByPlace = new Map<string, MapVisit[]>();
  for (const visit of visits) visitsByPlace.set(visit.placeId, [...(visitsByPlace.get(visit.placeId) || []), visit]);
  const entities: MapEntity[] = raw.places.filter((place) => visitsByPlace.has(place.id)).map((place: MapPlace) => {
    const placeVisits = visitsByPlace.get(place.id)!;
    const first = placeVisits[0];
    return {
      id: place.id, activityId: first.activityId || null, dayNumber: first.dayNumber, order: first.order,
      kind: place.kind, name: place.displayName, query: place.query, city: place.city,
      detail: [place.detail, ...placeVisits.map((visit) => `Day ${visit.dayNumber}${visit.startTime ? ` ${visit.startTime}` : ""}${visit.activity ? ` · ${visit.activity}` : ""}`)].filter(Boolean).join("\n"),
      importance: place.importance || "primary", startTime: first.startTime || "", endTime: first.endTime || "", durationMinutes: first.durationMinutes || 0,
      transportMode: first.transportMode || "", costNote: first.costNote || "", notes: first.notes || "", approximateLodgingArea: Boolean(place.approximateLodgingArea),
      status: place.status, location: place.location, candidates: place.candidates || [], warning: place.warning || null,
    };
  });
  const visitById = new Map(raw.visits.map((visit) => [visit.id, visit]));
  const routes: MapRoute[] = raw.routes.filter((route: any) => raw.scope !== "day" || route.dayNumber === raw.dayNumber).map((route: any) => ({
    ...route, order: route.edgeOrder ?? route.order ?? 0,
    fromEntityId: route.fromEntityId ?? visitById.get(route.fromVisitId)?.placeId ?? "",
    toEntityId: route.toEntityId ?? visitById.get(route.toVisitId)?.placeId ?? "",
  }));
  const dayPaths = raw.dayPaths.map((path: any) => {
    if (path.entityIds) return path;
    const entityIds = (path.visitIds || []).map((id: string) => visitById.get(id)?.placeId).filter(Boolean);
    return { dayNumber: path.dayNumber, entityIds, startEntityId: entityIds[0] || "", endEntityId: entityIds.at(-1) || "", overnightEntityId: entityIds.at(-1) || "" };
  });
  return { ...raw, entities, routes, dayPaths };
}

export function MapPanel({
  tripId,
  plan,
  revision,
  patches,
  job,
  categoryColors: suppliedColors,
  selection,
  fullscreen,
  onToggleFullscreen,
  onSnapshotChange,
}: {
  tripId: string | null;
  plan: TripPlan | null;
  revision: number | null;
  patches: MapPatch[];
  job: JobUpdate;
  categoryColors?: Record<string, string>;
  selection: MapSelection;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onSnapshotChange?: (snapshot: MapSnapshot | null) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const popupRef = useRef<any>(null);
  const routePopupRef = useRef<any>(null);
  const hoveredRouteRef = useRef<string | null>(null);
  const pinnedRef = useRef(false);
  const previousPoints = useRef(new Map<string, string>());
  const previousRoutes = useRef(new Map<string, string>());
  const fitKey = useRef("");
  const snapshotRef = useRef<MapSnapshot | null>(null);
  const handledPatchCount = useRef(0);
  const handledJobEvent = useRef<JobUpdate>(null);
  const loadGeneration = useRef(0);
  const requestedView = useRef("");
  const viewRef = useRef({ tripId, revision, scope: "all" as "all" | "day", day: 1 });
  const operationGeneration = useRef(0);
  const layoutGeneration = useRef(0);
  const previousFullscreen = useRef<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<MapSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [previewColors, setPreviewColors] = useState<Record<
    string,
    string
  > | null>(null);
  const [spiderCluster, setSpiderCluster] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [categoryVisibility, setCategoryVisibility] = useState(
    defaultCategoryVisibility,
  );
  useEffect(() => {
    onSnapshotChange?.(snapshot);
    window.dispatchEvent(new CustomEvent("travel.map.snapshot", { detail: snapshot }));
  }, [snapshot, onSnapshotChange]);
  const days = plan?.days || [];
  const scope = selection.scope;
  const day = selection.scope === "day" ? selection.dayNumber : (days[0]?.dayNumber || 1);
  const currentViewKey = (selectedScope = scope, selectedDay = day) =>
    `${tripId || ""}:${revision || ""}:${selectedScope}:${selectedScope === "day" ? selectedDay : "all"}`;
  snapshotRef.current = snapshot;
  requestedView.current = currentViewKey();
  viewRef.current = { tripId, revision, scope, day };
  const clearRenderedMap = useCallback(() => {
    const empty = { type: "FeatureCollection", features: [] };
    const map = mapRef.current;
    for (const sourceId of ["travel-places", "travel-routes"]) {
      const source = map?.getSource?.(sourceId);
      if (source?.setData) source.setData(empty);
    }
    previousPoints.current.clear();
    previousRoutes.current.clear();
    labelsRef.current?.replaceChildren();
    popupRef.current?.remove();
    popupRef.current = null;
    routePopupRef.current?.remove();
    routePopupRef.current = null;
    hoveredRouteRef.current = null;
    pinnedRef.current = false;
    fitKey.current = "";
    setSpiderCluster(null);
  }, []);
  const cancelMapLoads = useCallback(() => { loadGeneration.current += 1; }, []);
  const categoryColors = previewColors ||
    suppliedColors || {
      city: "#1b4f78",
      attraction: "#e11d48",
      lodging: "#7c3aed",
      meal: "#d97706",
      stop: "#0891b2",
      waypoint: "#64748b",
    };
  const enabledCategories = useMemo(
    () => visibleCategories(categoryVisibility),
    [categoryVisibility],
  );
  useEffect(() => {
    operationGeneration.current += 1;
    const update = (event: Event) =>
      setPreviewColors((event as CustomEvent<Record<string, string>>).detail);
    window.addEventListener("map-category-colors-preview", update);
    return () =>
      window.removeEventListener("map-category-colors-preview", update);
  }, []);
  const load = async (selectedScope = scope, selectedDay = day) => {
    if (!tripId || !revision) {
      setSnapshot(null);
      return;
    }
    const target = `${tripId}:${revision}:${selectedScope}:${selectedScope === "day" ? selectedDay : "all"}`;
    requestedView.current = target;
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const query =
        selectedScope === "day"
          ? `scope=day&dayNumber=${selectedDay}`
          : "scope=all";
      const data = await api<{ map: MapSnapshot | null }>(
        `/api/trips/${tripId}/map?${query}`,
      );
      if (generation !== loadGeneration.current || requestedView.current !== target || (data.map && data.map.itineraryVersion !== revision)) return;
      const current = snapshotRef.current;
      if (data.map && current && data.map.mapVersion === current.mapVersion && (data.map.sequence ?? 0) < (current.sequence ?? 0)) return;
      setSnapshot(data.map ? normalizeSnapshot(data.map) : null);
      setNotice("");
    } catch (cause) {
      if (generation !== loadGeneration.current || requestedView.current !== target) return;
      setNotice(cause instanceof Error ? cause.message : "地图加载失败。");
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  };
  useEffect(() => {
    operationGeneration.current += 1;
    handledPatchCount.current = 0;
    handledJobEvent.current = null;
    requestedView.current = `${tripId || ""}:${revision || ""}:all:all`;
    cancelMapLoads();
    clearRenderedMap();
    setSnapshot(null);
    setLegendOpen(false);
    setCategoryVisibility(defaultCategoryVisibility());
    void load("all", days[0]?.dayNumber || 1);
  }, [tripId, revision, clearRenderedMap, cancelMapLoads]);
  useEffect(() => {
    operationGeneration.current += 1;
    cancelMapLoads();
    clearRenderedMap();
    setSnapshot(null);
    void load(scope, day);
  }, [selection, scope, day]);
  useEffect(() => {
    const refresh = () => void load(scope, day);
    window.addEventListener("travel-map-refresh", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.removeEventListener("travel-map-refresh", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [tripId, revision, scope, day]);
  useEffect(() => {
    if (!snapshot || !["queued", "analyzing", "resolving"].includes(snapshot.status)) return;
    const timer = window.setInterval(() => void load(scope, day), 5000);
    return () => window.clearInterval(timer);
  }, [snapshot?.status, snapshot?.mapVersion, tripId, revision, scope, day]);
  useEffect(() => {
    const shouldLayout = shouldRequestFullscreenLayout(previousFullscreen.current, fullscreen);
    previousFullscreen.current = fullscreen;
    if (!shouldLayout) return;
    const generation = ++layoutGeneration.current;
    const frame = requestAnimationFrame(() => {
      const map = mapRef.current;
      map?.resize?.();
      fitKey.current = "";
      const points = snapshotRef.current?.entities.filter((item) => item.location) || [];
      if (!shouldApplyMapLayout(layoutGeneration.current, generation, Boolean(map), points.length)) return;
      void import("maplibre-gl").then((lib) => {
        if (!shouldApplyMapLayout(layoutGeneration.current, generation, mapRef.current === map, points.length)) return;
        const bounds = new lib.LngLatBounds();
        for (const point of points) bounds.extend([point.location!.longitude, point.location!.latitude]);
        if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 54, maxZoom: 13, duration: 0 });
      });
    });
    return () => { cancelAnimationFrame(frame); layoutGeneration.current += 1; };
  }, [fullscreen]);
  useEffect(() => {
    const resize = () => mapRef.current?.resize?.();
    window.addEventListener("travel-workspace-resize", resize);
    return () => window.removeEventListener("travel-workspace-resize", resize);
  }, []);
  useEffect(() => {
    const pending = patches.slice(handledPatchCount.current);
    if (!pending.length) return;
    handledPatchCount.current = patches.length;
    for (const patch of pending) {
      if (patch.tripId !== tripId || patch.itineraryVersion !== revision) continue;
      cancelMapLoads();
      const next = applyMapPatch(snapshotRef.current, patch);
      if (!next) { cancelMapLoads(); void load(); return; }
      const normalized = normalizeSnapshot(next);
      snapshotRef.current = normalized;
      setSnapshot(normalized);
    }
  }, [patches, tripId, revision, cancelMapLoads]);
  useEffect(() => {
    if (!job || job.tripId !== tripId || job.itineraryVersion !== revision)
      return;
    if (handledJobEvent.current === job) return;
    handledJobEvent.current = job;
    const currentSnapshot = snapshotRef.current;
    if (job.status === "failed" || job.status === "stopped") {
      setLoading(false);
      setNotice(job.status === "stopped" ? "地图生成已停止，已保留当前结果。" : "地图生成部分失败，已保留当前结果。");
      setSnapshot((current) => current ? { ...current, status: job.status, summary: job.summary } : current);
      return;
    }
    if (!currentSnapshot || currentSnapshot.mapVersion !== job.mapVersion) {
      cancelMapLoads();
      clearRenderedMap();
      setSnapshot(null);
      void load();
      return;
    }
    setSnapshot((current) => !current || (current.status === job.status && current.summary === job.summary) ? current : { ...current, status: job.status, summary: job.summary });
  }, [job, tripId, revision, clearRenderedMap, cancelMapLoads]);
  useEffect(() => {
    let map: any;
    let resizeObserver: ResizeObserver | null = null;
    let cancelled = false;
    void import("maplibre-gl")
      .then((lib) => {
        if (!element.current || cancelled) return;
        map = new lib.Map({
          container: element.current,
          style: {
            version: 8,
            sources: {
              osm: {
                type: "raster",
                tiles: ["/api/map/tiles/{z}/{x}/{y}.png"],
                tileSize: 256,
                attribution: "© OpenStreetMap contributors",
              },
            },
            layers: [{ id: "osm", type: "raster", source: "osm" }],
          },
          center: [0, 20],
          zoom: 1.1,
        });
        map.addControl(
          new lib.NavigationControl({ showCompass: false }),
          "top-right",
        );
        map.on("load", () => {
          map.addSource("travel-routes", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "travel-routes",
            type: "line",
            source: "travel-routes",
            paint: {
              "line-color": [
                "match",
                ["get", "mode"],
                "drive",
                "#dc2626",
                "walk",
                "#2563eb",
                "bike",
                "#16a34a",
                "#64748b",
              ],
              "line-width": [
                "case",
                ["boolean", ["feature-state", "hover"], false],
                ["match", ["get", "mode"], "drive", 7, 5],
                ["match", ["get", "mode"], "drive", 5, 3],
              ],
              "line-opacity": [
                "case",
                ["boolean", ["feature-state", "hover"], false],
                1,
                0.82,
              ],
            },
          });
          map.addSource("travel-places", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "travel-places",
            type: "circle",
            source: "travel-places",
            paint: {
              "circle-radius": [
                "match",
                ["get", "importance"],
                "primary",
                8,
                "secondary",
                6,
                5,
              ],
              "circle-color": [
                "match",
                ["get", "kind"],
                "city",
                "#1b4f78",
                "lodging",
                "#7c3aed",
                "meal",
                "#d97706",
                "#e11d48",
              ],
              "circle-stroke-width": 2,
              "circle-stroke-color": "#ffffff",
            },
          });
          const clearRouteHover = () => {
            const id = hoveredRouteRef.current;
            if (id) map.setFeatureState({ source: "travel-routes", id }, { hover: false });
            hoveredRouteRef.current = null;
            routePopupRef.current?.remove();
            routePopupRef.current = null;
          };
          const showRouteHover = (event: any) => {
            if (viewRef.current.scope !== "all") return clearRouteHover();
            const hover = routeHoverFromFeature(event.features?.[0] || {});
            if (!hover) return clearRouteHover();
            if (hoveredRouteRef.current !== hover.id) {
              clearRouteHover();
              map.setFeatureState({ source: "travel-routes", id: hover.id }, { hover: true });
              hoveredRouteRef.current = hover.id;
            }
            routePopupRef.current?.remove();
            const content = document.createElement("div");
            content.className = "map-route-tooltip";
            content.textContent = `Day ${hover.dayNumber}`;
            routePopupRef.current = new lib.Popup({
              offset: 10,
              closeButton: false,
              closeOnClick: false,
              className: "map-route-popup",
            })
              .setLngLat(event.lngLat)
              .setDOMContent(content)
              .addTo(map);
          };
          const showPopup = (event: any, pinned: boolean) => {
            const feature = event.features?.[0];
            if (!feature) return;
            const properties = feature.properties || {};
            const content = document.createElement("div");
            content.className = "map-popup-content";
            const title = document.createElement("strong");
            title.textContent = properties.name || "地点";
            const meta = document.createElement("small");
            meta.textContent = [
              `Day ${properties.dayNumber}`,
              properties.time,
              properties.city,
            ]
              .filter(Boolean)
              .join(" · ");
            const detail = document.createElement("p");
            detail.textContent = properties.detail || "";
            const extra = document.createElement("small");
            extra.textContent = [
              `停留 ${properties.duration || 0} 分钟`,
              properties.transportMode,
              properties.costNote,
              properties.notes,
            ]
              .filter(Boolean)
              .join(" · ");
            const source = document.createElement("small");
            const sourceNames: Record<string, string> = {
              nominatim: "OpenStreetMap Nominatim",
              ai_web: "AI 网页核验",
              ai_knowledge: "AI 知识估算",
              manual: "用户手工确认",
            };
            source.textContent = [
              `坐标来源：${sourceNames[properties.sourceType] || "未知"}`,
              properties.confidence ? `置信度：${properties.confidence}` : "",
              properties.approximateLodgingArea
                ? "未指定酒店，仅代表计划住宿区域"
                : "",
              properties.decisionNote,
            ]
              .filter(Boolean)
              .join(" · ");
            const link = document.createElement("a");
            link.textContent = "在 OpenStreetMap 查看";
            link.href = properties.sourceUrl || "https://www.openstreetmap.org";
            link.target = "_blank";
            link.rel = "noreferrer";
            content.append(title, meta, detail, extra, source, link);
            if (properties.evidenceUrl) {
              const evidence = document.createElement("a");
              evidence.textContent = "查看坐标依据";
              evidence.href = properties.evidenceUrl;
              evidence.target = "_blank";
              evidence.rel = "noreferrer";
              content.append(evidence);
            }
            popupRef.current?.remove();
            popupRef.current = new lib.Popup({
              offset: 14,
              closeButton: pinned,
              closeOnClick: false,
            })
              .setLngLat(event.lngLat)
              .setDOMContent(content)
              .addTo(map);
            pinnedRef.current = pinned;
          };
          map.on("mouseenter", "travel-places", (event: any) => {
            map.getCanvas().style.cursor = "pointer";
            if (!pinnedRef.current) showPopup(event, false);
          });
          map.on("mouseleave", "travel-places", () => {
            map.getCanvas().style.cursor = "";
            if (!pinnedRef.current) popupRef.current?.remove();
          });
          map.on("click", "travel-places", (event: any) =>
            showPopup(event, true),
          );
          map.on("mouseenter", "travel-routes", (event: any) => {
            if (viewRef.current.scope === "all") map.getCanvas().style.cursor = "pointer";
            showRouteHover(event);
          });
          map.on("mousemove", "travel-routes", showRouteHover);
          map.on("mouseleave", "travel-routes", () => {
            if (viewRef.current.scope === "all") map.getCanvas().style.cursor = "";
            clearRouteHover();
          });
          map.on("click", (event: any) => {
            if (
              !map.queryRenderedFeatures(event.point, {
                layers: ["travel-places"],
              }).length
            ) {
              pinnedRef.current = false;
              popupRef.current?.remove();
            }
          });
          setReady(true);
        });
        resizeObserver = new ResizeObserver(() => map.resize());
        resizeObserver.observe(element.current);
        mapRef.current = map;
      })
      .catch(() => setNotice("地图渲染组件加载失败。"));
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      popupRef.current?.remove();
      routePopupRef.current?.remove();
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !snapshot) return;
    const pointSource = map.getSource("travel-places");
    const routeSource = map.getSource("travel-routes");
    if (!pointSource || !routeSource) return;
    const pointFeatures = snapshot.entities
      .filter((item) => item.location)
      .map(pointFeature);
    const routeFeatures = snapshot.routes
      .filter((item) => item.status === "resolved" && item.geometry)
      .map(routeFeature);
    const sync = (
      source: any,
      previous: React.MutableRefObject<Map<string, string>>,
      features: any[],
    ) => {
      const next = new Map(
        features.map((feature) => [
          String(feature.id),
          JSON.stringify(feature),
        ]),
      );
      const remove = [...previous.current.keys()].filter((id) => !next.has(id));
      const add = features.filter(
        (feature) => !previous.current.has(String(feature.id)),
      );
      const update = features
        .filter(
          (feature) =>
            previous.current.has(String(feature.id)) &&
            previous.current.get(String(feature.id)) !==
              next.get(String(feature.id)),
        )
        .map((feature) => ({
          id: feature.id,
          newGeometry: feature.geometry,
          removeAllProperties: true,
          addOrUpdateProperties: feature.properties,
        }));
      if (remove.length || add.length || update.length)
        void source.updateData({ remove, add, update });
      previous.current = next;
    };
    sync(pointSource, previousPoints, pointFeatures);
    sync(routeSource, previousRoutes, routeFeatures);
    const drawLabels = () => {
      const overlay = labelsRef.current;
      if (!overlay) return;
      overlay.replaceChildren();
      if (!snapshot) return;
      const boxes = snapshot.entities
        .filter(
          (entity) =>
            entity.location &&
            enabledCategories.includes(entity.kind as MapCategory),
        )
        .map((entity) => {
          const p = map.project([
            entity.location!.longitude,
            entity.location!.latitude,
          ]);
          const role =
            labelRole(entity.id, snapshot.dayPaths) ||
            `D${entity.dayNumber} · ${entity.order}`;
          const text = `${displayEntityName(entity)} · ${role}`;
          return {
            id: entity.id,
            x: p.x,
            y: p.y,
            width: Math.min(176, 38 + text.length * 12),
            height: 26,
            priority:
              entity.importance === "primary"
                ? 3
                : entity.importance === "secondary"
                  ? 2
                  : 1,
            text,
            entity,
          };
        });
      const placements = layoutLabels(
        boxes,
        { width: overlay.clientWidth, height: overlay.clientHeight },
        boxes.map((item) => ({
          ...item,
          id: `pin:${item.id}`,
          x: item.x - 9,
          y: item.y - 9,
          width: 18,
          height: 18,
        })),
      );
      const visible = placements.filter((item) => !item.hidden);
      for (const item of visible) {
        const node = document.createElement("button");
        node.className = "map-label";
        node.style.transform = `translate(${item.x}px,${item.y}px)`;
        node.style.setProperty(
          "--label-color",
          categoryColors[item.entity.kind] || "#1b4f78",
        );
        node.textContent = item.text;
        node.setAttribute("aria-label", item.text);
        node.onclick = () =>
          map.flyTo({
            center: [
              item.entity.location!.longitude,
              item.entity.location!.latitude,
            ],
            zoom: Math.max(14, map.getZoom()),
          });
        overlay.append(node);
      }
      const groups = clusterHiddenLabels(
        placements.filter((item) => item.hidden),
      );
      const clusters = layoutLabels(
        groups,
        { width: overlay.clientWidth, height: overlay.clientHeight },
        visible,
      );
      for (const group of clusters.filter((item) => !item.hidden)) {
        const cluster = document.createElement("button");
        cluster.className = "map-label map-cluster";
        cluster.textContent = `+${group.members.length} 个地点`;
        cluster.style.transform = `translate(${group.x}px,${group.y}px)`;
        cluster.onclick = () => {
          const members = group.members
            .map((member) => member.entity.location!)
            .map((location) => [location.longitude, location.latitude]);
          if (map.getZoom() >= 17) setSpiderCluster(group.id);
          else if (members.length) {
            const [firstLongitude, firstLatitude] = members[0] as [number, number];
            const bounds = members.slice(1).reduce(
              ([minLongitude, minLatitude, maxLongitude, maxLatitude]: [number, number, number, number], [longitude, latitude]: any) => [
                Math.min(minLongitude, longitude), Math.min(minLatitude, latitude),
                Math.max(maxLongitude, longitude), Math.max(maxLatitude, latitude),
              ] as [number, number, number, number],
              [firstLongitude, firstLatitude, firstLongitude, firstLatitude] as [number, number, number, number],
            );
            map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 70, maxZoom: 17 });
          }
        };
        overlay.append(cluster);
        if (spiderCluster === group.id)
          group.members.forEach((member, index) => {
            const angle = (Math.PI * 2 * index) / group.members.length;
            const node = document.createElement("button");
            node.className = "map-label map-spider";
            node.style.setProperty(
              "--label-color",
              categoryColors[member.entity.kind] || "#1b4f78",
            );
            node.textContent = displayEntityName(member.entity);
            node.style.transform = `translate(${group.x + Math.cos(angle) * 72}px,${group.y + Math.sin(angle) * 72}px)`;
            node.onclick = () =>
              map.flyTo({
                center: [
                  member.entity.location!.longitude,
                  member.entity.location!.latitude,
                ],
                zoom: map.getZoom(),
              });
            overlay.append(node);
          });
      }
    };
    let raf = 0;
    const queue = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(drawLabels);
    };
    map.on("move", queue);
    map.on("zoom", queue);
    queue();
    const observer = new ResizeObserver(queue);
    if (labelsRef.current) observer.observe(labelsRef.current);
    return () => {
      map.off("move", queue);
      map.off("zoom", queue);
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
    const key = `${tripId}:${revision}:${scope}:${scope === "day" ? day : "all"}`;
    if (pointFeatures.length && fitKey.current !== key) {
      void import("maplibre-gl").then((lib) => {
        const bounds = new lib.LngLatBounds();
        for (const feature of pointFeatures)
          bounds.extend(feature.geometry.coordinates as [number, number]);
        if (!bounds.isEmpty())
          map.fitBounds(bounds, { padding: 54, maxZoom: 13, duration: 500 });
        fitKey.current = key;
      });
    }
  }, [
    ready,
    snapshot,
    tripId,
    revision,
    scope,
    day,
    categoryColors,
    enabledCategories,
    spiderCluster,
  ]);
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map?.getLayer("travel-places"))
      map.setPaintProperty("travel-places", "circle-color", [
        "match",
        ["get", "kind"],
        ...Object.entries(categoryColors).flatMap(([kind, color]) => [
          kind,
          color,
        ]),
        "#1b4f78",
      ]);
  }, [ready, categoryColors]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map?.getLayer("travel-places")) return;
    map.setFilter("travel-places", [
      "in",
      ["get", "kind"],
      ["literal", enabledCategories],
    ]);
  }, [ready, enabledCategories]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map?.getLayer("travel-routes")) return;
    map.setPaintProperty(
      "travel-routes",
      "line-color",
      scope === "all"
        ? [
            "match",
            ["get", "dayNumber"],
            1,
            "#2563eb",
            2,
            "#dc2626",
            3,
            "#16a34a",
            4,
            "#9333ea",
            5,
            "#d97706",
            "#0891b2",
          ]
        : [
            "match",
            ["get", "mode"],
            "drive",
            "#dc2626",
            "walk",
            "#2563eb",
            "bike",
            "#16a34a",
            "flight",
            "#7c3aed",
            "#64748b",
          ],
    );
    map.setPaintProperty("travel-routes", "line-dasharray", [
      "match",
      ["get", "mode"],
      "flight",
      [2, 2],
      [1, 0],
    ]);
  }, [ready, scope, snapshot]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !snapshot) return;
    const points = snapshot.entities.filter((item) => item.location);
    const key = `${tripId}:${revision}:${scope}:${scope === "day" ? day : "all"}`;
    if (!points.length || fitKey.current === key) return;
    void import("maplibre-gl").then((lib) => {
      const bounds = new lib.LngLatBounds();
      for (const point of points)
        bounds.extend([point.location!.longitude, point.location!.latitude]);
      if (!bounds.isEmpty())
        map.fitBounds(bounds, { padding: 54, maxZoom: 13, duration: 500 });
      fitKey.current = key;
    });
  }, [ready, snapshot, tripId, revision, scope, day]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map?.getLayer("travel-routes") || scope !== "all") return;
    const values = [
      ...new Set(snapshot?.routes.map((route) => route.dayNumber) || []),
    ]
      .sort((a, b) => a - b)
      .flatMap((dayNumber) => [
        dayNumber,
        dayColors[(dayNumber - 1) % dayColors.length],
      ]);
    map.setPaintProperty("travel-routes", "line-color", [
      "match",
      ["get", "dayNumber"],
      ...values,
      "#64748b",
    ]);
  }, [ready, scope, snapshot]);
  const unresolved = useMemo(
    () =>
      snapshot?.entities.filter((item) => item.status === "ambiguous") || [],
    [snapshot],
  );
  const matchingJob = job?.tripId === tripId && job.itineraryVersion === revision
    ? job
    : null;
  const mapStatus = matchingJob?.status || snapshot?.status || "idle";
  const statusPresentation = mapStatusPresentation(mapStatus);
  const running = ["queued", "analyzing", "resolving"].includes(mapStatus);
  const progress = useMemo(() => {
    const places = snapshot?.places || snapshot?.entities || [];
    const located = places.filter((item) => Boolean(item.location)).length;
    const routed = snapshot?.routes.filter((item) => item.status === "resolved").length || 0;
    return { located, places: places.length, routed, routes: snapshot?.routes.length || 0 };
  }, [snapshot]);
  const select = async (entityId: string, candidate: Candidate) => {
    if (!tripId) return;
    const operation = ++operationGeneration.current;
    const view = { ...viewRef.current };
    try {
      await api(
        `/api/trips/${tripId}/map/locations/${encodeURIComponent(entityId)}/select`,
        { method: "POST", body: JSON.stringify({ candidate }) },
      );
      if (operation !== operationGeneration.current || requestedView.current !== `${view.tripId || ""}:${view.revision || ""}:${view.scope}:${view.scope === "day" ? view.day : "all"}`) return;
      await load(view.scope, view.day);
    } catch (cause) {
      if (operation !== operationGeneration.current || requestedView.current !== `${view.tripId || ""}:${view.revision || ""}:${view.scope}:${view.scope === "day" ? view.day : "all"}`) return;
      setNotice(cause instanceof Error ? cause.message : "地点选择失败。");
    }
  };
  const retry = async () => {
    if (!tripId) return;
    const operation = ++operationGeneration.current;
    const view = { ...viewRef.current };
    setLoading(true);
    try {
      await api(`/api/trips/${tripId}/map/retry`, {
        method: "POST",
        body: "{}",
      });
      if (operation !== operationGeneration.current || requestedView.current !== `${view.tripId || ""}:${view.revision || ""}:${view.scope}:${view.scope === "day" ? view.day : "all"}`) return;
      await load(view.scope, view.day);
    } catch (cause) {
      if (operation !== operationGeneration.current || requestedView.current !== `${view.tripId || ""}:${view.revision || ""}:${view.scope}:${view.scope === "day" ? view.day : "all"}`) return;
      setNotice(cause instanceof Error ? cause.message : "地图重试失败。");
    } finally {
      if (operation === operationGeneration.current && requestedView.current === `${view.tripId || ""}:${view.revision || ""}:${view.scope}:${view.scope === "day" ? view.day : "all"}`) setLoading(false);
    }
  };
  return (
    <section className="map-panel">
      <div className="map-heading">
        <h2 className={`map-status ${statusPresentation.tone}`} aria-live="polite">{statusPresentation.label}</h2>
        {(progress.places || progress.routes) > 0 && <small className="map-progress">已定位 {progress.located}/{progress.places} · 路线 {progress.routed}/{progress.routes}</small>}
        <fieldset className="map-category-filter" aria-label="地点筛选">
          <legend><Filter size={13} /> 地点筛选</legend>
          <div className="map-category-options">
            {mapCategoryLegend.map(([kind, label]) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={categoryVisibility[kind]}
                  onChange={() => setCategoryVisibility((current) => ({
                    ...current,
                    [kind]: !current[kind],
                  }))}
                />
                <i style={{ background: categoryColors[kind] }} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {plan && (
          <div className="map-actions">
            <button className="icon-button panel-fullscreen" type="button" title={fullscreen ? "退出地图全屏" : "地图全屏"} aria-label={fullscreen ? "退出地图全屏" : "地图全屏"} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button>
            {(snapshot && ["partial", "failed"].includes(snapshot.status) || job?.tripId === tripId && job?.itineraryVersion === revision && job.status === "failed") && (
              <button disabled={loading} onClick={() => void retry()}>
                <RotateCcw size={12} />
                {loading ? "重试中" : "重试未完成项"}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="map-canvas-wrap">
        <div ref={element} className="map-canvas" />
        <div ref={labelsRef} className="map-label-overlay" />
        <div className={`map-legend ${legendOpen ? "open" : ""}`} aria-label="地图图例">
          <button
            className="map-legend-toggle"
            type="button"
            aria-expanded={legendOpen}
            aria-controls="map-legend-details"
            onClick={() => setLegendOpen((open) => !open)}
          >
            图例 {legendOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {legendOpen && <div id="map-legend-details">
            <strong>{scope === "all" ? "路线（按天）" : "路线（按交通）"}</strong>
            <div className="map-legend-items">
              {scope === "all" ? (
                days.map((item) => (
                  <span key={item.dayNumber}>
                    <i style={{ background: dayColors[(item.dayNumber - 1) % dayColors.length] }} />
                    Day {item.dayNumber}
                  </span>
                ))
              ) : (
                <>
                  <span><i style={{ background: "#2563eb" }} />步行</span>
                  <span><i style={{ background: "#dc2626" }} />自驾</span>
                  <span><i style={{ background: "#16a34a" }} />骑行</span>
                  <span><i className="legend-flight" />飞机</span>
                </>
              )}
            </div>
            <strong>地点</strong>
            <div className="map-legend-items">
              {mapCategoryLegend.map(([kind, label]) => (
                <span key={kind}><i style={{ background: categoryColors[kind] }} />{label}</span>
              ))}
            </div>
          </div>}
        </div>
      </div>
      {unresolved.length > 0 && (
        <div className="map-candidates">
          {unresolved.map((item) => (
            <div key={item.id}>
              <b>{item.name}：请选择地点</b>
              {item.candidates.map((candidate) => (
                <button
                  key={candidate.providerPlaceId}
                  onClick={() => void select(item.id, candidate)}
                >
                  {candidate.displayName}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <p className={`map-notice ${snapshot?.status || "idle"}`}>
        {running ? (
          <LoaderCircle className="spin" size={13} />
        ) : snapshot?.status === "partial" || snapshot?.status === "failed" ? (
          <AlertTriangle size={13} />
        ) : null}
        <span>
          {notice ||
            matchingJob?.summary ||
            snapshot?.summary ||
            (plan
              ? "地图 Agent 将在后台自动标注全程地点和路线。"
              : "生成行程后会自动建立地图。")}
        </span>
      </p>
    </section>
  );
}
