import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DateSchema,
  IdSchema,
  PeriodSchema,
  PlaceSchema,
  TextSchema,
  TimeSchema,
  TransportSchema,
  VerificationSchema,
  TravelPlanDocumentSchema,
  type Day,
  type PlaceResolution,
  type TravelPlanDocument,
  type TripCandidate,
} from "./contracts-v2.js";

const LegacyStopSchema = z.object({
  id: IdSchema,
  role: z.enum(["start", "visit", "end"]),
  placeId: IdSchema,
  activity: TextSchema,
  period: PeriodSchema.nullable(),
  startTime: TimeSchema.nullable(),
  endTime: TimeSchema.nullable(),
  durationMinutes: z.number().int().min(0).max(1440).nullable(),
  scheduleVerification: VerificationSchema.nullable(),
  transportFromPrevious: TransportSchema.nullable(),
  costNote: z.string().max(1000).nullable(),
  costVerification: VerificationSchema.nullable(),
  notes: z.string().max(2000).nullable(),
}).strict();

const LegacyDaySchema = z.object({
  id: IdSchema,
  dayNumber: z.number().int().min(1).max(90),
  date: DateSchema.nullable(),
  title: TextSchema.max(300),
  detailLevel: z.enum(["draft", "detailed"]),
  detailStatus: z.enum(["ready", "needs_review"]).nullable().optional(),
  stops: z.array(LegacyStopSchema).min(2).max(80),
}).strict();

const LegacyTripFactsSchema = z.object({
  title: TextSchema.max(200),
  originPlaceId: IdSchema.nullable(),
  destinationPlaceIds: z.array(IdSchema).max(30),
  dates: z.object({
    start: DateSchema.nullable(),
    end: DateSchema.nullable(),
    requestedDurationDays: z.number().int().min(1).max(90).nullable(),
  }).strict(),
  travelers: z.object({ summary: z.string().max(500), adults: z.number().int().min(0).max(30).nullable(), children: z.number().int().min(0).max(30).nullable() }).strict(),
  budget: z.object({ amount: z.number().finite().nonnegative().nullable(), currency: z.string().trim().min(1).max(12).nullable(), note: z.string().max(500).nullable() }).strict(),
  pace: z.string().trim().min(1).max(120).nullable(),
  themes: z.array(TextSchema.max(120)).max(30),
  preferences: z.array(TextSchema.max(500)).max(40),
  constraints: z.array(TextSchema.max(500)).max(40),
  assumptions: z.array(z.object({ text: TextSchema.max(500), source: z.enum(["user", "ai", "system"]), confidence: z.enum(["low", "medium", "high"]) }).strict()).max(40),
}).strict();

export const LegacyItineraryV1Schema = z.object({
  schemaVersion: z.literal(1),
  stage: z.enum(["planning", "draft", "detailed"]),
  trip: LegacyTripFactsSchema,
  places: z.array(PlaceSchema).max(1800),
  days: z.array(LegacyDaySchema).max(90),
  warnings: z.array(TextSchema.max(700)).max(100),
}).strict();
export type LegacyItineraryV1 = z.infer<typeof LegacyItineraryV1Schema>;

const stableId = (prefix: string, source: string) => `${prefix}-${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;

function uniqueId(preferred: string, used: Set<string>) {
  let value = preferred.slice(0, 160);
  let suffix = 1;
  while (used.has(value)) {
    const ending = `-${suffix++}`;
    value = `${preferred.slice(0, 160 - ending.length)}${ending}`;
  }
  used.add(value);
  return value;
}

export type V1ConversionResult = {
  document: TravelPlanDocument;
  warnings: string[];
  candidateByPlaceId: Record<string, string>;
};

export function convertItineraryV1ToPlanV2(input: unknown): V1ConversionResult {
  const legacy = LegacyItineraryV1Schema.parse(input);
  const usedIds = new Set<string>(legacy.places.map((place) => place.id));
  for (const day of legacy.days) {
    usedIds.add(day.id);
    for (const stop of day.stops) usedIds.add(stop.id);
  }

  const candidateByPlaceId = new Map<string, string>();
  const candidates: TripCandidate[] = [];
  for (const day of legacy.days) {
    for (const stop of day.stops.slice(1, -1)) {
      if (candidateByPlaceId.has(stop.placeId)) continue;
      const id = uniqueId(stableId("migration-candidate", stop.placeId), usedIds);
      candidateByPlaceId.set(stop.placeId, id);
      candidates.push({
        id,
        placeId: stop.placeId,
        preference: "want_to_go",
        source: "migration",
        aiReason: null,
        aiScore: null,
        suggestedDurationMinutes: stop.durationMinutes,
        tags: [],
      });
    }
  }

  const days: Day[] = legacy.days.map((day) => {
    const first = day.stops[0];
    const last = day.stops.at(-1)!;
    return {
      id: day.id,
      dayNumber: day.dayNumber,
      date: day.date,
      title: day.title,
      detailLevel: day.detailLevel === "detailed" ? "detailed" : "planned",
      detailStatus: day.detailStatus ?? null,
      startAnchor: {
        id: uniqueId(stableId("migration-start", day.id), usedIds),
        placeId: first.placeId,
        label: first.activity || null,
        notes: first.notes,
      },
      stops: day.stops.slice(1, -1).map((stop) => ({
        id: stop.id,
        candidateId: candidateByPlaceId.get(stop.placeId) ?? null,
        placeId: stop.placeId,
        activity: stop.activity,
        period: stop.period,
        startTime: stop.startTime,
        endTime: stop.endTime,
        durationMinutes: stop.durationMinutes,
        transportFromPrevious: stop.transportFromPrevious,
        scheduleVerification: stop.scheduleVerification,
        costNote: stop.costNote,
        costVerification: stop.costVerification,
        notes: stop.notes,
      })),
      endAnchor: {
        id: uniqueId(stableId("migration-end", day.id), usedIds),
        placeId: last.placeId,
        label: last.activity || null,
        notes: last.notes,
      },
    };
  });

  const conversionWarnings: string[] = [];
  let stage: TravelPlanDocument["stage"] = legacy.stage === "planning" ? "place_selection" : legacy.stage === "draft" ? "itinerary_planning" : "itinerary_refinement";
  if (stage === "place_selection" && days.length) {
    stage = "itinerary_planning";
    conversionWarnings.push("旧 planning 行程包含 Day；为保留已有结构，迁移为 itinerary_planning。");
  }

  const document = TravelPlanDocumentSchema.parse({
    schemaVersion: 2,
    stage,
    trip: legacy.trip,
    places: legacy.places,
    candidates,
    days,
    warnings: legacy.warnings,
  });

  return { document, warnings: conversionWarnings, candidateByPlaceId: Object.fromEntries(candidateByPlaceId) };
}

export type LegacyResolvedPlace = {
  placeId: string;
  geoFingerprint: string;
  provider: string;
  providerPlaceId: string | null;
  lat: number | null;
  lng: number | null;
  resolution: "exact" | "approximate" | "researched" | "ignored" | "unresolved";
  confidence: number | null;
  resolvedAt: string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  decisionReason?: string | null;
};

export function convertResolvedPlaceV1(tripId: string, value: LegacyResolvedPlace): PlaceResolution {
  const providerTrusted = value.provider !== "ai-web" && !value.provider.includes("ai-web");
  const coordinatesValid = value.lat !== null && value.lng !== null && Number.isFinite(value.lat) && Number.isFinite(value.lng);
  const trusted = providerTrusted && coordinatesValid && (value.resolution === "exact" || value.resolution === "approximate");
  if (!trusted) {
    return {
      tripId,
      placeId: value.placeId,
      geoFingerprint: value.geoFingerprint,
      status: "unresolved",
      method: "provider_match",
      provider: null,
      providerPlaceId: null,
      latitude: null,
      longitude: null,
      address: null,
      confidence: null,
      resolvedAt: null,
      errorMessage: value.resolution === "researched" || !providerTrusted ? "旧 AI 联网坐标不再受信任，需要重新解析。" : "旧地点未可靠定位，需要重新解析。",
    };
  }
  return {
    tripId,
    placeId: value.placeId,
    geoFingerprint: value.geoFingerprint,
    status: "resolved",
    method: "provider_match",
    provider: value.provider,
    providerPlaceId: value.providerPlaceId,
    latitude: value.lat,
    longitude: value.lng,
    address: null,
    confidence: value.confidence,
    resolvedAt: value.resolvedAt ?? new Date(0).toISOString(),
    errorMessage: null,
  };
}
