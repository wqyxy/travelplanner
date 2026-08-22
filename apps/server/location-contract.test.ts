import { describe, expect, it } from "vitest";
import { TravelAgentOutputJsonSchema, TripPlanSchema, TripPlanV2Schema } from "./contracts.js";

const activity = { id: "a1", startTime: "09:00", endTime: "10:00", placeName: "悉尼歌剧院", activity: "参观", durationMinutes: 60, transportMode: "walk" as const, transportMinutes: 10, costNote: "" };
const base = { tripName: "悉尼", travelerSummary: "两位成人", pace: "舒缓", themes: ["建筑"], timezone: "Australia/Sydney", budgetNote: "待确认", days: [{ dayNumber: 1, date: "2026-10-01", title: "悉尼", activities: [activity] }], warnings: [], generatedBy: "codex" as const };

describe("TripPlan location contract", () => {
  it("keeps legacy plans readable without rewriting them", () => {
    expect(TripPlanSchema.parse(base)).not.toHaveProperty("schemaVersion");
  });

  it("requires every V2 activity to reference a structured local-language place", () => {
    const place = { id: "sydney-opera-house", kind: "attraction" as const, nameZh: "悉尼歌剧院", nameEn: "Sydney Opera House", nameLocal: "Sydney Opera House", localLanguage: "en-AU", approximate: false, geocoding: { name: "Sydney Opera House", city: "Sydney", region: "New South Wales", country: "Australia", countryCode: "au" } };
    expect(TripPlanV2Schema.parse({ ...base, schemaVersion: 2, places: [place], days: [{ ...base.days[0], activities: [{ ...activity, placeIds: [place.id] }] }] }).places[0].geocoding.countryCode).toBe("au");
    expect(() => TripPlanV2Schema.parse({ ...base, schemaVersion: 2, places: [place] })).toThrow(/placeId/);
  });

  it("publishes only the V2 planner output schema", () => {
    expect(JSON.stringify(TravelAgentOutputJsonSchema)).toContain('"const":2');
  });
});
