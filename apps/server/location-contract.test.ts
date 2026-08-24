import { describe, expect, it } from "vitest";
import {
  DetailBatchOutputSchema,
  ItinerarySchema,
  PlannerMutationSchema,
  PlannerOutputJsonSchema,
  PlannerOutputSchema,
  emptyItinerary,
  type Day,
  type Itinerary,
  type Stop,
} from "./contracts.js";

const place = { id: "city", nameZh: "京都", nameLocal: "京都", nameEn: "Kyoto", kind: "city" as const, city: "京都", region: null, country: "日本", countryCode: "JP", approximate: false };
const estimated = { status: "estimated" as const, checkedAt: null };
const draftStop = (id: string, role: Stop["role"], activity: string): Stop => ({ id, role, placeId: place.id, activity, period: "morning", startTime: null, endTime: null, durationMinutes: null, scheduleVerification: null, transportFromPrevious: null, costNote: null, costVerification: null, notes: null });
const detailedStop = (id: string, role: Stop["role"], activity: string, first = false): Stop => ({ id, role, placeId: place.id, activity, period: "morning", startTime: "09:00", endTime: "10:00", durationMinutes: 60, scheduleVerification: estimated, transportFromPrevious: first ? null : { mode: "walk", durationMinutes: 10, note: null, verification: estimated }, costNote: null, costVerification: null, notes: null });
const day = (id = "day-1", detailLevel: Day["detailLevel"] = "draft"): Day => ({ id, dayNumber: 1, date: null, title: "京都", detailLevel, stops: detailLevel === "detailed" ? [detailedStop(`${id}-start`, "start", "出发", true), detailedStop(`${id}-visit`, "visit", "游览"), detailedStop(`${id}-end`, "end", "住宿")] : [draftStop(`${id}-start`, "start", "出发"), draftStop(`${id}-visit`, "visit", "游览"), draftStop(`${id}-end`, "end", "住宿")] });
const draft = (): Itinerary => ({ ...emptyItinerary(), stage: "draft", places: [place], days: [day()] });

function expectClosedRequiredObjects(value: unknown) {
  if (Array.isArray(value)) { value.forEach(expectClosedRequiredObjects); return; }
  if (!value || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    expect(schema.additionalProperties).toBe(false);
    expect(new Set(schema.required as string[])).toEqual(new Set(Object.keys(schema.properties)));
  }
  Object.values(schema).forEach(expectClosedRequiredObjects);
}

describe("itinerary:v1 contracts", () => {
  it("allows an empty planning itinerary", () => expect(ItinerarySchema.parse(emptyItinerary()).stage).toBe("planning"));

  it("rejects invalid draft routes and references", () => {
    const value = draft();
    expect(ItinerarySchema.safeParse({ ...value, days: [{ ...value.days[0], stops: [value.days[0].stops[0], value.days[0].stops[2]] }] }).success).toBe(false);
    expect(ItinerarySchema.safeParse({ ...value, days: [{ ...value.days[0], stops: value.days[0].stops.map((stop) => ({ ...stop, placeId: "missing" })) }] }).success).toBe(false);
    expect(ItinerarySchema.safeParse({ ...value, days: [{ ...value.days[0], stops: value.days[0].stops.map((stop, index) => index === 0 ? { ...stop, role: "visit" } : stop) }] }).success).toBe(false);
  });

  it("validates dates continuously from an exact start and removes redundant duration", () => {
    const value = draft();
    const exactStart = { ...value, trip: { ...value.trip, dates: { start: "2026-10-01", end: null, requestedDurationDays: 1 } } };
    expect(ItinerarySchema.safeParse(exactStart).success).toBe(false);
    expect(ItinerarySchema.safeParse({ ...exactStart, days: [{ ...value.days[0], date: "2026-10-01" }] }).success).toBe(true);
    expect(ItinerarySchema.safeParse({ ...exactStart, trip: { ...exactStart.trip, dates: { start: "2026-10-01", end: "2026-10-01", requestedDurationDays: 1 } }, days: [{ ...value.days[0], date: "2026-10-01" }] }).success).toBe(false);
  });

  it("validates time, country and verification formats", () => {
    const value = draft();
    expect(ItinerarySchema.safeParse({ ...value, places: [{ ...place, countryCode: "JPN" }] }).success).toBe(false);
    expect(ItinerarySchema.safeParse({ ...value, days: [{ ...value.days[0], stops: value.days[0].stops.map((stop, index) => index === 1 ? { ...stop, startTime: "9:00", endTime: "10:00" } : stop) }] }).success).toBe(false);
    expect(ItinerarySchema.safeParse({ ...value, days: [{ ...value.days[0], stops: value.days[0].stops.map((stop, index) => index === 1 ? { ...stop, scheduleVerification: { status: "verified", checkedAt: null } } : stop) }] }).success).toBe(false);
    expect(ItinerarySchema.safeParse({ ...value, days: [{ ...value.days[0], stops: value.days[0].stops.map((stop, index) => index === 1 ? { ...stop, scheduleVerification: { status: "estimated", checkedAt: "2026-10-01T09:00:00+09:00" } } : stop) }] }).success).toBe(true);
  });

  it("applies detailed validation independently of itinerary stage", () => {
    const value = draft();
    expect(ItinerarySchema.safeParse({ ...value, days: [{ ...value.days[0], detailLevel: "detailed" }] }).success).toBe(false);
    expect(ItinerarySchema.safeParse({ ...value, days: [day("day-1", "detailed")] }).success).toBe(true);
  });

  it("keeps the detailed lifecycle when every Day later needs re-detailing", () => {
    const value = draft();
    expect(ItinerarySchema.safeParse({ ...value, stage: "detailed", days: value.days.map((item) => ({ ...item, detailLevel: "draft", detailStatus: "needs_review" as const })) }).success).toBe(true);
  });

  it("requires a detail batch to return the exact requested detailed day set", () => {
    const detailed = day("day-1", "detailed");
    const output = { schemaVersion: 1, baseGeneration: 3, batchId: "batch-1", dayIds: ["day-1"], placeUpserts: [], days: [detailed], assistantMessage: "已细化" };
    expect(DetailBatchOutputSchema.safeParse(output).success).toBe(true);
    expect(DetailBatchOutputSchema.safeParse({ ...output, dayIds: ["day-1", "day-2"] }).success).toBe(false);
    expect(DetailBatchOutputSchema.safeParse({ ...output, days: [{ ...detailed, stops: detailed.stops.map((stop, index) => index === 1 ? { ...stop, transportFromPrevious: null } : stop) }] }).success).toBe(false);
  });

  it("keeps update_fields minimal and rejects IDs or multiple field rewrites", () => {
    expect(PlannerMutationSchema.safeParse({ type: "update_fields", entity: "trip", id: null, changes: { title: "京都周末" } }).success).toBe(true);
    expect(PlannerMutationSchema.safeParse({ type: "update_fields", entity: "trip", id: null, changes: { title: "京都周末", pace: "慢节奏" } }).success).toBe(false);
    expect(PlannerMutationSchema.safeParse({ type: "update_fields", entity: "stop", id: "stop-1", changes: { id: "changed" } }).success).toBe(false);
    expect(PlannerMutationSchema.safeParse({ type: "move_entity", entity: "stop", id: "stop-1", targetParentId: "day-2", position: 1 }).success).toBe(true);
  });

  it("keeps stage actions and optional suggestions mutually exclusive", () => {
    const output = { schemaVersion: 1, operation: "reply", assistantMessage: "下一步", baseGeneration: 0, mutations: null, draftItinerary: null, nextAction: "none", suggestion: null };
    expect(PlannerOutputSchema.safeParse({ ...output, nextAction: "start_detail" }).success).toBe(true);
    expect(PlannerOutputSchema.safeParse({ ...output, suggestion: { id: "s1", text: "在京都多住一晚" } }).success).toBe(true);
    expect(PlannerOutputSchema.safeParse({ ...output, nextAction: "start_detail", suggestion: { id: "duplicate", text: "下一步开始细化" } }).success).toBe(false);
  });

  it("exports a closed Structured Output schema without optional object properties", () => {
    expect(PlannerOutputSchema.safeParse({ schemaVersion: 1, operation: "reply", assistantMessage: "您好", baseGeneration: 0, mutations: null, draftItinerary: null, nextAction: "none", suggestion: null }).success).toBe(true);
    expect(PlannerOutputJsonSchema).not.toHaveProperty("$schema");
    expectClosedRequiredObjects(PlannerOutputJsonSchema);
  });
});
