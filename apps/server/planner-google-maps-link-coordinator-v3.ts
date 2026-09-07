import {
  GoogleMapsLinkCommitInputSchema,
  GoogleMapsLinkPreviewInputSchema,
  type Place,
  type PlaceResolution,
} from "./contracts-v2.js";
import { GoogleMapsLinkService } from "./google-maps-link.js";
import { applyPlanCommands } from "./plan-commands-v2.js";
import { markImpact } from "./planner-itinerary-impact-v3.js";
import { placeGeoFingerprint } from "./place-resolver-v2.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const now = () => new Date().toISOString();

/**
 * Owns Google Maps link preview/commit persistence.
 *
 * Coordinates/address continue to come only from GoogleMapsLinkService. The
 * coordinator never synthesizes provider identifiers, geometry or verification.
 */
export class PlannerGoogleMapsLinkCoordinatorV3 {
  constructor(private readonly options: {
    store: TravelStoreV3;
    service?: GoogleMapsLinkService;
    emitDocumentChanged: (tripId: string, generation: number, changedDayIds: string[]) => void;
    emitResolutionChanged: (tripId: string, placeId: string) => void;
  }) {}

  private service() {
    if (!this.options.service) throw new Error("Google Maps 链接解析服务未配置。");
    return this.options.service;
  }

  async preview(tripId: string, placeId: string, input: unknown) {
    const parsed = GoogleMapsLinkPreviewInputSchema.parse(input);
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== parsed.expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    if (!trip.plan.places.some((place) => place.id === placeId)) throw new Error("找不到目标 Place。");
    return this.service().preview(parsed.url);
  }

  async apply(tripId: string, placeId: string, input: unknown) {
    const parsed = GoogleMapsLinkCommitInputSchema.parse(input);
    const trip = this.options.store.requireTrip(tripId);
    if (trip.contentGeneration !== parsed.expectedGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
    const currentPlace = trip.plan.places.find((place) => place.id === placeId);
    if (!currentPlace) throw new Error("找不到目标 Place。");

    const preview = await this.service().preview(parsed.url);
    const applied = applyPlanCommands(trip.plan, [{
      type: "update_place",
      placeId,
      changes: { ...parsed.changes, nameZh: currentPlace.nameZh },
    }]);
    const plan = markImpact(trip.plan, applied.plan);
    const place = plan.places.find((item) => item.id === placeId) as Place | undefined;
    if (!place) throw new Error("找不到更新后的 Place。");

    const resolution: PlaceResolution = {
      tripId,
      placeId,
      geoFingerprint: placeGeoFingerprint(place),
      status: "resolved",
      method: "google_maps_link",
      provider: null,
      providerPlaceId: null,
      latitude: preview.latitude,
      longitude: preview.longitude,
      address: preview.address,
      confidence: null,
      resolvedAt: now(),
      errorMessage: null,
    };
    const written = this.options.store.writePlanAndPlaceResolution(
      tripId,
      plan,
      resolution,
      parsed.expectedGeneration,
      { source: "google_maps_link", summary: "通过 Google Maps 链接更新地点和坐标" },
    );
    this.options.emitDocumentChanged(tripId, written.generation, applied.effects.changedDayIds);
    this.options.emitResolutionChanged(tripId, placeId);
    return {
      trip: written.trip,
      resolution: written.resolution,
      generation: written.generation,
      version: written.version,
    };
  }
}
