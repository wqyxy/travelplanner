import type { MapPatchPayload, MapService } from "./map-service.js";
import type { MapAgentOutput, MapEntityPatch, MapRoutePatch, TripPlan } from "./contracts.js";
import type { TravelStore } from "./travel-store.js";

type Broadcaster = (kind: string, payload: unknown) => void;

/** Build a map-day patch from server-owned plan ids; no map-analysis model is involved. */
export function projectPlanDay(plan: TripPlan, dayNumber: number, itineraryVersion: number, baseMapVersion: number): MapAgentOutput {
  if (plan.schemaVersion !== 2 || !("places" in plan)) throw new Error("概略地图投影只接受带稳定地点定义的 V2 计划。");
  const day = plan.days.find((item) => item.dayNumber === dayNumber); if (!day) throw new Error(`找不到 Day ${dayNumber}。`);
  const places = new Map(plan.places.map((place) => [place.id, place])); const entities: MapEntityPatch[] = [];
  for (const [activityIndex, activity] of day.activities.entries()) for (const [placeIndex, placeId] of (activity.placeIds || []).entries()) {
    const place = places.get(placeId); if (!place) throw new Error(`Day ${dayNumber} 引用了未知地点：${placeId}`);
    const sourceId = `d${dayNumber}-${activity.id}-${placeIndex + 1}`.slice(0, 160); const countryCode = place.geocoding.countryCode.toLowerCase();
    entities.push({ id: sourceId, activityId: activity.id, dayNumber, order: activityIndex * 20 + placeIndex, kind: place.kind, name: place.nameZh, displayName: place.nameZh, query: [place.geocoding.name, place.geocoding.city, place.geocoding.region, place.geocoding.country].filter(Boolean).join(", "), city: place.geocoding.city, region: place.geocoding.region, country: place.geocoding.country, ...(countryCode === "xx" ? {} : { countryCode }), queryLanguage: place.localLanguage, localName: place.nameLocal, englishName: place.nameEn, localLanguage: place.localLanguage, canonicalKey: `place:${place.id}`, detail: activity.activity, importance: activityIndex === 0 ? "primary" : "secondary", startTime: activity.startTime, endTime: activity.endTime, durationMinutes: activity.durationMinutes, transportMode: activity.transportMode, costNote: activity.costNote, notes: activity.notes || "", approximateLodgingArea: place.approximate });
  }
  if (!entities.length) throw new Error(`Day ${dayNumber} 没有可投影地点。`);
  const routes: MapRoutePatch[] = entities.slice(0, -1).map((entity, index) => ({ id: `d${dayNumber}-r${index + 1}`, dayNumber, order: index + 1, fromEntityId: entity.id, toEntityId: entities[index + 1].id, mode: entities[index + 1].transportMode }));
  return { schemaVersion: 3, baseItineraryVersion: itineraryVersion, baseMapVersion, upsertEntities: entities, removeEntityIds: [], upsertRoutes: routes, removeRouteIds: [], dayPaths: [{ dayNumber, entityIds: entities.map((item) => item.id), startEntityId: entities[0].id, endEntityId: entities.at(-1)!.id, overnightEntityId: entities.at(-1)!.id }], warnings: [] };
}

export class OutlineMapProjector {
  constructor(private readonly store: TravelStore, private readonly maps: MapService, private readonly broadcast: Broadcaster) {}

  projectOutline(tripId: string, itineraryVersion: number) {
    const plan = this.store.getRevision(tripId, itineraryVersion)?.plan; if (!plan) throw new Error("找不到待投影的路线草案。");
    const manifest = this.store.prepareMapManifest(tripId, itineraryVersion, []); this.store.initializeMapDayRuns(tripId, itineraryVersion, plan.days.map((day) => day.dayNumber));
    for (const day of plan.days) this.commitDay(tripId, itineraryVersion, manifest.mapVersion, manifest.baseMapVersion, projectPlanDay(plan, day.dayNumber, itineraryVersion, manifest.baseMapVersion));
    this.store.setMapStatus(tripId, itineraryVersion, "partial", "路线骨架已显示，正在补充城市坐标");
    this.broadcast("travel.map.job.updated", { tripId, itineraryVersion, mapVersion: manifest.mapVersion, status: "partial", summary: "路线骨架已显示，正在补充城市坐标" });
    for (const day of plan.days) void this.resolveDay(tripId, itineraryVersion, manifest.mapVersion, day.dayNumber);
  }

  projectDay(tripId: string, itineraryVersion: number, dayNumber: number) {
    const plan = this.store.getRevision(tripId, itineraryVersion)?.plan; if (!plan) throw new Error("找不到待投影的日期。");
    const manifest = this.store.prepareMapManifest(tripId, itineraryVersion, []); this.commitDay(tripId, itineraryVersion, manifest.mapVersion, manifest.baseMapVersion, projectPlanDay(plan, dayNumber, itineraryVersion, manifest.baseMapVersion));
    void this.resolveDay(tripId, itineraryVersion, manifest.mapVersion, dayNumber);
  }

  private commitDay(tripId: string, itineraryVersion: number, mapVersion: number, baseMapVersion: number, patch: MapAgentOutput) {
    const applied = this.store.applyMapPatch(tripId, itineraryVersion, baseMapVersion, patch); const snapshot = this.store.getMapSnapshot(tripId, "day", patch.dayPaths[0].dayNumber); if (!snapshot) return;
    this.store.recordPlanningMetric(tripId, "map_day_projected", null, { itineraryVersion, dayNumber: patch.dayPaths[0].dayNumber, places: snapshot.places.length });
    const payload: MapPatchPayload = { tripId, itineraryVersion, mapVersion, sequence: snapshot.sequence, places: { upsert: snapshot.places, remove: applied.removedEntityIds }, visits: { upsert: snapshot.visits, remove: [] }, dayProgress: snapshot.dayProgress, entities: { upsert: snapshot.entities, remove: applied.removedEntityIds }, routes: { upsert: snapshot.routes, remove: applied.removedRouteIds }, dayPaths: snapshot.dayPaths };
    this.broadcast("travel.map.patch", payload);
  }

  private async resolveDay(tripId: string, itineraryVersion: number, mapVersion: number, dayNumber: number) {
    try { await this.maps.resolveLocationsForDay(tripId, itineraryVersion, mapVersion, dayNumber); await this.maps.resolveDayRoutes(tripId, itineraryVersion, mapVersion, dayNumber); const snapshot = this.maps.finalize(tripId, itineraryVersion, mapVersion); if (snapshot?.status === "failed") { this.store.setMapStatus(tripId, itineraryVersion, "partial", "概略路线已保留，部分坐标等待服务恢复"); this.broadcast("travel.map.job.updated", { tripId, itineraryVersion, mapVersion, status: "partial", summary: "概略路线已保留，部分坐标等待服务恢复" }); } }
    catch { const current = this.store.latestMapMeta(tripId); if (current?.itineraryVersion === itineraryVersion && current.mapVersion === mapVersion) { this.store.setMapStatus(tripId, itineraryVersion, "partial", "概略地图可用，部分坐标等待服务恢复"); this.broadcast("travel.map.job.updated", { tripId, itineraryVersion, mapVersion, status: "partial", summary: "概略地图可用，部分坐标等待服务恢复" }); } }
  }
}
