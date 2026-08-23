import { describe, expect, it } from "vitest";
import { MapAgentOutputSchema, TripPlanV2Schema } from "./contracts.js";
import { projectPlanDay } from "./outline-map-projector.js";

describe("outline map projector", () => {
  it("creates a valid patch for one day without model-generated map ids", () => {
    const plan = TripPlanV2Schema.parse({ schemaVersion: 2, tripName: "澳洲路线", travelerSummary: "两位成人", pace: "适中", themes: ["海岸"], timezone: "Australia/Sydney", budgetNote: "待确认", warnings: [], generatedBy: "codex", places: [
      { id: "sydney", kind: "city", nameZh: "悉尼", nameEn: "Sydney", nameLocal: "Sydney", localLanguage: "en", approximate: true, geocoding: { name: "Sydney", city: "Sydney", region: "NSW", country: "Australia", countryCode: "au" } },
      { id: "gong", kind: "city", nameZh: "卧龙岗", nameEn: "Wollongong", nameLocal: "Wollongong", localLanguage: "en", approximate: true, geocoding: { name: "Wollongong", city: "Wollongong", region: "NSW", country: "Australia", countryCode: "au" } },
    ], days: [
      { dayNumber: 1, title: "悉尼", activities: [{ id: "d1", startTime: "10:00", endTime: "18:00", placeName: "悉尼", placeIds: ["sydney"], activity: "城市草案", durationMinutes: 480, transportMode: "walk", transportMinutes: 0, costNote: "待细化" }] },
      { dayNumber: 2, title: "沿海", activities: [{ id: "d2", startTime: "09:00", endTime: "18:00", placeName: "悉尼至卧龙岗", placeIds: ["sydney", "gong"], activity: "沿海移动", durationMinutes: 540, transportMode: "drive", transportMinutes: 120, costNote: "待细化" }] },
    ] });
    const patch = MapAgentOutputSchema.parse(projectPlanDay(plan, 2, 7, 3));
    expect(patch.dayPaths).toEqual([expect.objectContaining({ dayNumber: 2 })]);
    expect(patch.upsertEntities.map((item) => item.canonicalKey)).toEqual(["place:sydney", "place:gong"]);
    expect(patch.upsertRoutes).toHaveLength(1);
    expect(patch.upsertEntities.some((item) => item.dayNumber === 1)).toBe(false);
  });
});
