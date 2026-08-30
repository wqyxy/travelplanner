import { z } from "zod";
import { buildPlanningAreaContext, fulfilledMacroCityCandidateIds } from "./planning-areas-v2.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const countryPattern = /^[A-Z]{2}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const IdSchema = z.string().trim().min(1).max(160);
export const TextSchema = z.string().trim().min(1).max(1200);
export const NullableTextSchema = z.string().trim().min(1).max(2000).nullable();
export const DateSchema = z.string().refine((value) => {
  if (!datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, "日期必须为有效的 YYYY-MM-DD。");
export const TimeSchema = z.string().regex(timePattern, "时间必须为 HH:mm。");
export const InstantSchema = z.string().regex(instantPattern, "时间戳必须为 ISO 8601。");

export const TripStageSchema = z.enum(["place_selection", "itinerary_planning", "itinerary_refinement"]);
export type TripStage = z.infer<typeof TripStageSchema>;

export const PeriodSchema = z.enum(["morning", "afternoon", "evening", "night", "all_day"]);
export type Period = z.infer<typeof PeriodSchema>;

export const VerificationStatusSchema = z.enum(["verified", "estimated", "unverified"]);
export const VerificationSchema = z.object({
  status: VerificationStatusSchema,
  checkedAt: InstantSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === "verified" && !value.checkedAt) {
    context.addIssue({ code: "custom", path: ["checkedAt"], message: "verified 必须提供 checkedAt。" });
  }
});
export type Verification = z.infer<typeof VerificationSchema>;

export const TransportModeSchema = z.enum(["walk", "drive", "bike", "transit", "rail", "flight", "ferry", "none"]);
export type TransportMode = z.infer<typeof TransportModeSchema>;
export const TransportSchema = z.object({
  mode: TransportModeSchema,
  durationMinutes: z.number().int().min(0).max(10080).nullable(),
  note: z.string().max(1000).nullable(),
  verification: VerificationSchema,
}).strict();
export type Transport = z.infer<typeof TransportSchema>;

export const PlaceKindSchema = z.enum(["city", "attraction", "lodging", "meal", "airport", "station", "port", "stop", "waypoint"]);
export type PlaceKind = z.infer<typeof PlaceKindSchema>;
export const PlaceSchema = z.object({
  id: IdSchema,
  nameZh: TextSchema.max(300),
  nameLocal: z.string().trim().min(1).max(300).nullable(),
  nameEn: z.string().trim().min(1).max(300).nullable(),
  kind: PlaceKindSchema,
  city: z.string().trim().min(1).max(160).nullable(),
  region: z.string().trim().min(1).max(160).nullable(),
  country: z.string().trim().min(1).max(160).nullable(),
  countryCode: z.string().regex(countryPattern).nullable(),
  approximate: z.boolean(),
}).strict();
export type Place = z.infer<typeof PlaceSchema>;

const TripDatesSchema = z.object({
  start: DateSchema.nullable(),
  end: DateSchema.nullable(),
  requestedDurationDays: z.number().int().min(1).max(90).nullable(),
}).strict().superRefine((value, context) => {
  if (value.start && value.end && value.start > value.end) {
    context.addIssue({ code: "custom", path: ["end"], message: "结束日期不能早于开始日期。" });
  }
  if (value.start && value.end && value.requestedDurationDays !== null) {
    context.addIssue({ code: "custom", path: ["requestedDurationDays"], message: "完整日期范围存在时不得重复保存 requestedDurationDays。" });
  }
});

const TravelersSchema = z.object({
  summary: z.string().max(500),
  adults: z.number().int().min(0).max(30).nullable(),
  children: z.number().int().min(0).max(30).nullable(),
}).strict();

const BudgetSchema = z.object({
  amount: z.number().finite().nonnegative().nullable(),
  currency: z.string().trim().min(1).max(12).nullable(),
  note: z.string().max(500).nullable(),
}).strict();

const AssumptionSchema = z.object({
  text: TextSchema.max(500),
  source: z.enum(["user", "ai", "system"]),
  confidence: z.enum(["low", "medium", "high"]),
}).strict();

export const TripFactsSchema = z.object({
  title: TextSchema.max(200),
  originPlaceId: IdSchema.nullable(),
  destinationPlaceIds: z.array(IdSchema).max(30),
  dates: TripDatesSchema,
  travelers: TravelersSchema,
  budget: BudgetSchema,
  pace: z.string().trim().min(1).max(120).nullable(),
  themes: z.array(TextSchema.max(120)).max(30),
  preferences: z.array(TextSchema.max(500)).max(40),
  constraints: z.array(TextSchema.max(500)).max(40),
  assumptions: z.array(AssumptionSchema).max(40),
}).strict();
export type TripFacts = z.infer<typeof TripFactsSchema>;

export const CandidatePreferenceSchema = z.enum(["must_go", "want_to_go", "optional", "excluded"]);
export type CandidatePreference = z.infer<typeof CandidatePreferenceSchema>;
export const TripCandidateSchema = z.object({
  id: IdSchema,
  placeId: IdSchema,
  planningAreaCandidateId: IdSchema.nullable(),
  preference: CandidatePreferenceSchema,
  source: z.enum(["ai", "user"]),
  aiReason: z.string().trim().min(1).max(1000).nullable(),
  aiScore: z.number().finite().min(0).max(100).nullable(),
  suggestedDurationMinutes: z.number().int().min(0).max(10080).nullable(),
  tags: z.array(TextSchema.max(120)).max(30),
}).strict();
export type TripCandidate = z.infer<typeof TripCandidateSchema>;

export const DayAnchorSchema = z.object({
  id: IdSchema,
  placeId: IdSchema.nullable(),
  label: z.string().trim().min(1).max(300).nullable(),
  notes: z.string().max(2000).nullable(),
}).strict();
export type DayAnchor = z.infer<typeof DayAnchorSchema>;

const DayStopObjectSchema = z.object({
  id: IdSchema,
  candidateId: IdSchema.nullable(),
  placeId: IdSchema,
  activity: TextSchema,
  period: PeriodSchema.nullable(),
  startTime: TimeSchema.nullable(),
  endTime: TimeSchema.nullable(),
  durationMinutes: z.number().int().min(0).max(1440).nullable(),
  transportFromPrevious: TransportSchema.nullable(),
  scheduleVerification: VerificationSchema.nullable(),
  costNote: z.string().max(1000).nullable(),
  costVerification: VerificationSchema.nullable(),
  notes: z.string().max(2000).nullable(),
}).strict();

function validateDayStop(value: z.infer<typeof DayStopObjectSchema>, context: z.RefinementCtx) {
  if ((value.startTime === null) !== (value.endTime === null)) {
    context.addIssue({ code: "custom", path: ["endTime"], message: "开始和结束时间必须同时提供或同时为空。" });
  }
  if (value.startTime && value.endTime && value.endTime <= value.startTime) {
    context.addIssue({ code: "custom", path: ["endTime"], message: "结束时间必须晚于开始时间。" });
  }
  if (value.startTime && value.endTime && value.durationMinutes !== null) {
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    if (minutes(value.endTime) - minutes(value.startTime) !== value.durationMinutes) {
      context.addIssue({ code: "custom", path: ["durationMinutes"], message: "停留时长必须等于开始和结束时间之差。" });
    }
  }
}

export const DayStopSchema = DayStopObjectSchema.superRefine(validateDayStop);
export type DayStop = z.infer<typeof DayStopSchema>;

const DayObjectSchema = z.object({
  id: IdSchema,
  dayNumber: z.number().int().min(1).max(90),
  date: DateSchema.nullable(),
  title: TextSchema.max(300),
  detailLevel: z.enum(["planned", "detailed"]),
  detailStatus: z.enum(["ready", "needs_review"]).nullable(),
  startAnchor: DayAnchorSchema,
  stops: z.array(DayStopSchema).max(80),
  endAnchor: DayAnchorSchema,
}).strict();

function validateDetailedDay(day: z.infer<typeof DayObjectSchema>, context: z.RefinementCtx) {
  if (day.detailLevel !== "detailed") return;
  for (const [index, stop] of day.stops.entries()) {
    if (!stop.startTime || !stop.endTime || stop.durationMinutes === null || !stop.scheduleVerification) {
      context.addIssue({ code: "custom", path: ["stops", index], message: "detailed Stop 必须提供时间、停留时长和日程核验状态。" });
    }
  }
}

export const DaySchema = DayObjectSchema.superRefine(validateDetailedDay);
export const DetailedDaySchema = DayObjectSchema.superRefine((day, context) => {
  if (day.detailLevel !== "detailed") {
    context.addIssue({ code: "custom", path: ["detailLevel"], message: "细化批次只能返回 detailed Day。" });
  }
  validateDetailedDay(day, context);
});
export type Day = z.infer<typeof DaySchema>;

function addDocumentIssues(value: {
  stage: TripStage;
  trip: TripFacts;
  places: Place[];
  candidates: TripCandidate[];
  days: Day[];
}, context: z.RefinementCtx) {
  const placeIds = new Set<string>();
  for (const [index, place] of value.places.entries()) {
    if (placeIds.has(place.id)) context.addIssue({ code: "custom", path: ["places", index, "id"], message: "Place ID 不能重复。" });
    placeIds.add(place.id);
  }

  const placesById = new Map(value.places.map((place) => [place.id, place]));
  const candidateIds = new Set<string>();
  const candidatePlaces = new Set<string>();
  const candidates = new Map<string, TripCandidate>();
  for (const [index, candidate] of value.candidates.entries()) {
    if (candidateIds.has(candidate.id)) context.addIssue({ code: "custom", path: ["candidates", index, "id"], message: "Candidate ID 不能重复。" });
    if (!placeIds.has(candidate.placeId)) context.addIssue({ code: "custom", path: ["candidates", index, "placeId"], message: `Candidate 引用未知 Place：${candidate.placeId}` });
    if (candidatePlaces.has(candidate.placeId)) context.addIssue({ code: "custom", path: ["candidates", index, "placeId"], message: "同一 Place 在一趟旅行中只能有一个 Candidate。" });
    candidateIds.add(candidate.id);
    candidatePlaces.add(candidate.placeId);
    candidates.set(candidate.id, candidate);
  }

  for (const [index, candidate] of value.candidates.entries()) {
    if (!candidate.planningAreaCandidateId) continue;
    const parent = candidates.get(candidate.planningAreaCandidateId);
    const parentPlace = parent ? placesById.get(parent.placeId) : null;
    if (!parent || parent.id === candidate.id) {
      context.addIssue({ code: "custom", path: ["candidates", index, "planningAreaCandidateId"], message: "Micro Candidate 必须引用另一条已存在的 Macro Candidate。" });
      continue;
    }
    if (parentPlace?.kind !== "city") {
      context.addIssue({ code: "custom", path: ["candidates", index, "planningAreaCandidateId"], message: "planningAreaCandidateId 必须指向 Macro 目的地 Candidate。" });
    }
    const ownPlace = placesById.get(candidate.placeId);
    if (ownPlace?.kind === "city") {
      context.addIssue({ code: "custom", path: ["candidates", index, "planningAreaCandidateId"], message: "Macro Candidate 不得再归属于其他 Macro Candidate。" });
    }
  }

  const tripRefs = [value.trip.originPlaceId, ...value.trip.destinationPlaceIds].filter((item): item is string => Boolean(item));
  for (const id of tripRefs) if (!placeIds.has(id)) context.addIssue({ code: "custom", path: ["trip"], message: `旅行引用未知 Place：${id}` });
  if (new Set(value.trip.destinationPlaceIds).size !== value.trip.destinationPlaceIds.length) {
    context.addIssue({ code: "custom", path: ["trip", "destinationPlaceIds"], message: "目的地引用不能重复。" });
  }

  const dayIds = new Set<string>();
  const nodeIds = new Set<string>();
  const scheduledCandidateIds = new Set<string>();
  for (const [dayIndex, day] of value.days.entries()) {
    if (dayIds.has(day.id)) context.addIssue({ code: "custom", path: ["days", dayIndex, "id"], message: "Day ID 不能重复。" });
    dayIds.add(day.id);
    if (day.dayNumber !== dayIndex + 1) context.addIssue({ code: "custom", path: ["days", dayIndex, "dayNumber"], message: "dayNumber 必须从 1 连续递增。" });

    for (const [anchorName, anchor] of [["startAnchor", day.startAnchor], ["endAnchor", day.endAnchor]] as const) {
      if (nodeIds.has(anchor.id)) context.addIssue({ code: "custom", path: ["days", dayIndex, anchorName, "id"], message: "Anchor/Stop ID 必须全局唯一。" });
      nodeIds.add(anchor.id);
      if (anchor.placeId && !placeIds.has(anchor.placeId)) context.addIssue({ code: "custom", path: ["days", dayIndex, anchorName, "placeId"], message: `Anchor 引用未知 Place：${anchor.placeId}` });
    }

    for (const [stopIndex, stop] of day.stops.entries()) {
      if (nodeIds.has(stop.id)) context.addIssue({ code: "custom", path: ["days", dayIndex, "stops", stopIndex, "id"], message: "Anchor/Stop ID 必须全局唯一。" });
      nodeIds.add(stop.id);
      if (!placeIds.has(stop.placeId)) context.addIssue({ code: "custom", path: ["days", dayIndex, "stops", stopIndex, "placeId"], message: `Stop 引用未知 Place：${stop.placeId}` });
      if (stop.candidateId) {
        const candidate = candidates.get(stop.candidateId);
        if (!candidate) context.addIssue({ code: "custom", path: ["days", dayIndex, "stops", stopIndex, "candidateId"], message: `Stop 引用未知 Candidate：${stop.candidateId}` });
        else {
          if (candidate.placeId !== stop.placeId) context.addIssue({ code: "custom", path: ["days", dayIndex, "stops", stopIndex, "placeId"], message: "Stop 的 Candidate 与 Place 必须一致。" });
          if (candidate.preference === "excluded") context.addIssue({ code: "custom", path: ["days", dayIndex, "stops", stopIndex, "candidateId"], message: "excluded Candidate 不得出现在行程中。" });
          scheduledCandidateIds.add(candidate.id);
        }
      }
    }
  }

  const areaContext = buildPlanningAreaContext({ places: value.places, candidates: value.candidates });
  const fulfilledMacroCities = fulfilledMacroCityCandidateIds(areaContext, scheduledCandidateIds);

  if (value.stage !== "place_selection" && !value.days.length) {
    context.addIssue({ code: "custom", path: ["days"], message: "行程规划和细化阶段必须有 Day。" });
  }
  if (value.stage !== "place_selection") {
    for (const [index, candidate] of value.candidates.entries()) {
      if (areaContext.suppressedCandidateIds.has(candidate.id) && scheduledCandidateIds.has(candidate.id)) {
        context.addIssue({ code: "custom", path: ["candidates", index], message: "所属城市已标记为不去，该 Candidate 不得排入行程。" });
      }
      if (candidate.preference === "must_go" && !scheduledCandidateIds.has(candidate.id) && !fulfilledMacroCities.has(candidate.id)) {
        context.addIssue({ code: "custom", path: ["candidates", index], message: "must_go Candidate 必须排入行程；城市级 Candidate 可以由该城市内具体地点满足。" });
      }
    }
  }

  if (value.trip.dates.start) {
    const start = Date.parse(`${value.trip.dates.start}T00:00:00Z`);
    value.days.forEach((day, index) => {
      const expected = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
      if (day.date !== expected) context.addIssue({ code: "custom", path: ["days", index, "date"], message: "Day 日期必须从开始日期连续递增。" });
    });
    if (value.trip.dates.end) {
      const total = Math.floor((Date.parse(`${value.trip.dates.end}T00:00:00Z`) - start) / 86_400_000) + 1;
      if (value.days.length && value.days.length !== total) context.addIssue({ code: "custom", path: ["days"], message: "Day 数量必须覆盖完整日期范围。" });
    }
  }
}

export const TravelPlanDocumentSchema = z.object({
  schemaVersion: z.literal(2),
  stage: TripStageSchema,
  trip: TripFactsSchema,
  places: z.array(PlaceSchema).max(1800),
  candidates: z.array(TripCandidateSchema).max(1800),
  days: z.array(DaySchema).max(90),
  warnings: z.array(TextSchema.max(700)).max(100),
}).strict().superRefine(addDocumentIssues);
export type TravelPlanDocument = z.infer<typeof TravelPlanDocumentSchema>;

export const emptyTravelPlan = (): TravelPlanDocument => TravelPlanDocumentSchema.parse({
  schemaVersion: 2,
  stage: "place_selection",
  trip: {
    title: "未命名旅行",
    originPlaceId: null,
    destinationPlaceIds: [],
    dates: { start: null, end: null, requestedDurationDays: null },
    travelers: { summary: "", adults: null, children: null },
    budget: { amount: null, currency: null, note: null },
    pace: null,
    themes: [],
    preferences: [],
    constraints: [],
    assumptions: [],
  },
  places: [],
  candidates: [],
  days: [],
  warnings: [],
});

export const PlaceResolutionMethodSchema = z.enum(["provider_match", "provider_choice", "map_pick", "manual_coordinates"]);
export const PlaceResolutionSchema = z.object({
  tripId: IdSchema,
  placeId: IdSchema,
  geoFingerprint: TextSchema.max(1000),
  status: z.enum(["resolving", "resolved", "unresolved"]),
  method: PlaceResolutionMethodSchema,
  provider: z.string().trim().min(1).max(120).nullable(),
  providerPlaceId: z.string().trim().min(1).max(240).nullable(),
  latitude: z.number().finite().min(-90).max(90).nullable(),
  longitude: z.number().finite().min(-180).max(180).nullable(),
  address: z.string().trim().min(1).max(1000).nullable(),
  confidence: z.number().finite().min(0).max(1).nullable(),
  resolvedAt: InstantSchema.nullable(),
  errorMessage: z.string().max(1000).nullable(),
}).strict().superRefine((value, context) => {
  const hasLatitude = value.latitude !== null;
  const hasLongitude = value.longitude !== null;
  if (hasLatitude !== hasLongitude) context.addIssue({ code: "custom", path: [hasLatitude ? "longitude" : "latitude"], message: "纬度和经度必须同时提供或同时为空。" });
  if (value.status === "resolved" && (!hasLatitude || !hasLongitude || !value.resolvedAt)) {
    context.addIssue({ code: "custom", path: ["status"], message: "resolved 必须提供坐标和 resolvedAt。" });
  }
  if (value.status !== "resolved" && (hasLatitude || hasLongitude)) {
    context.addIssue({ code: "custom", path: ["latitude"], message: "未解析成功时不得保存坐标。" });
  }
  if ((value.method === "provider_match" || value.method === "provider_choice") && value.status === "resolved" && (!value.provider || !value.providerPlaceId)) {
    context.addIssue({ code: "custom", path: ["providerPlaceId"], message: "Provider 解析必须保存 provider 和 providerPlaceId。" });
  }
});
export type PlaceResolution = z.infer<typeof PlaceResolutionSchema>;

export const ProviderPlaceCandidateSchema = z.object({
  provider: TextSchema.max(120),
  providerPlaceId: TextSchema.max(240),
  name: z.string().max(300).nullable(),
  displayName: TextSchema.max(1000),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  category: z.string().max(120).nullable(),
  placeType: z.string().max(120).nullable(),
  countryCode: z.string().max(2).nullable(),
  region: z.string().max(160).nullable(),
  city: z.string().max(160).nullable(),
}).strict();
export type ProviderPlaceCandidate = z.infer<typeof ProviderPlaceCandidateSchema>;

export const ProviderResolutionSelectionInputSchema = z.object({
  expectedGeneration: z.number().int().min(0),
  providerPlaceId: z.string().trim().min(1).max(240),
}).strict();
export type ProviderResolutionSelectionInput = z.infer<typeof ProviderResolutionSelectionInputSchema>;

export const DirectPlaceResolutionInputSchema = z.object({
  expectedGeneration: z.number().int().min(0),
  method: z.enum(["map_pick", "manual_coordinates"]),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  address: z.string().trim().min(1).max(1000).nullable(),
}).strict();
export type DirectPlaceResolutionInput = z.infer<typeof DirectPlaceResolutionInputSchema>;

export const PlaceResolutionRetryInputSchema = z.object({
  expectedGeneration: z.number().int().min(0),
  placeIds: z.array(IdSchema).min(1).max(200),
}).strict();
export type PlaceResolutionRetryInput = z.infer<typeof PlaceResolutionRetryInputSchema>;

export const RouteLegSchema = z.object({
  id: IdSchema,
  fromNodeId: IdSchema,
  toNodeId: IdSchema,
  fromPlaceId: IdSchema,
  toPlaceId: IdSchema,
  mode: TransportModeSchema,
  status: z.enum(["ready", "attention"]),
  distanceKm: z.number().finite().nonnegative().nullable(),
  durationMinutes: z.number().finite().nonnegative().nullable(),
  geometry: z.unknown().nullable(),
  warning: z.string().max(1000).nullable(),
}).strict();
export type RouteLeg = z.infer<typeof RouteLegSchema>;

export const DayRouteSchema = z.object({
  tripId: IdSchema,
  dayId: IdSchema,
  version: z.number().int().min(1),
  inputFingerprint: TextSchema.max(1000),
  status: z.enum(["idle", "calculating", "ready", "attention"]),
  distanceKm: z.number().finite().nonnegative().nullable(),
  durationMinutes: z.number().finite().nonnegative().nullable(),
  geometry: z.unknown().nullable(),
  legs: z.array(RouteLegSchema).max(200),
  warnings: z.array(TextSchema.max(1000)).max(100),
  calculatedAt: InstantSchema.nullable(),
}).strict();
export type DayRoute = z.infer<typeof DayRouteSchema>;

export const ProposalScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("candidate_pool"), id: z.null() }).strict(),
  z.object({ type: z.literal("candidate"), id: IdSchema }).strict(),
  z.object({ type: z.literal("place"), id: IdSchema }).strict(),
  z.object({ type: z.literal("day"), id: IdSchema }).strict(),
  z.object({ type: z.literal("trip"), id: z.null() }).strict(),
]);
export type ProposalScope = z.infer<typeof ProposalScopeSchema>;

const PlaceSemanticChangesSchema = z.object({
  nameZh: TextSchema.max(300).optional(),
  nameLocal: z.string().trim().min(1).max(300).nullable().optional(),
  nameEn: z.string().trim().min(1).max(300).nullable().optional(),
  kind: PlaceKindSchema.optional(),
  city: z.string().trim().min(1).max(160).nullable().optional(),
  region: z.string().trim().min(1).max(160).nullable().optional(),
  country: z.string().trim().min(1).max(160).nullable().optional(),
  countryCode: z.string().regex(countryPattern).nullable().optional(),
  approximate: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少修改一个 Place 字段。");

const CandidateChangesSchema = z.object({
  aiReason: z.string().trim().min(1).max(1000).nullable().optional(),
  aiScore: z.number().finite().min(0).max(100).nullable().optional(),
  suggestedDurationMinutes: z.number().int().min(0).max(10080).nullable().optional(),
  tags: z.array(TextSchema.max(120)).max(30).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少修改一个 Candidate 字段。");

const DayStopChangesSchema = z.object({
  candidateId: IdSchema.nullable().optional(),
  placeId: IdSchema.optional(),
  activity: TextSchema.optional(),
  period: PeriodSchema.nullable().optional(),
  startTime: TimeSchema.nullable().optional(),
  endTime: TimeSchema.nullable().optional(),
  durationMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  transportFromPrevious: TransportSchema.nullable().optional(),
  scheduleVerification: VerificationSchema.nullable().optional(),
  costNote: z.string().max(1000).nullable().optional(),
  costVerification: VerificationSchema.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少修改一个 Stop 字段。");

const DayChangesSchema = z.object({
  title: TextSchema.max(300).optional(),
  date: DateSchema.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少修改一个 Day 字段。");

export const PlanCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_candidate_preference"), candidateId: IdSchema, preference: CandidatePreferenceSchema }).strict(),
  z.object({ type: z.literal("bulk_set_candidate_preference"), candidateIds: z.array(IdSchema).min(1).max(1800), preference: CandidatePreferenceSchema }).strict(),
  z.object({ type: z.literal("add_candidate"), place: PlaceSchema, candidate: TripCandidateSchema }).strict(),
  z.object({ type: z.literal("remove_candidate"), candidateId: IdSchema }).strict(),
  z.object({ type: z.literal("remove_candidate_tree"), candidateId: IdSchema }).strict(),
  z.object({ type: z.literal("update_candidate"), candidateId: IdSchema, changes: CandidateChangesSchema }).strict(),
  z.object({ type: z.literal("update_place"), placeId: IdSchema, changes: PlaceSemanticChangesSchema }).strict(),
  z.object({ type: z.literal("set_day_anchor"), dayId: IdSchema, anchor: z.enum(["start", "end"]), placeId: IdSchema.nullable(), label: z.string().trim().min(1).max(300).nullable(), notes: z.string().max(2000).nullable() }).strict(),
  z.object({ type: z.literal("add_day_stop"), dayId: IdSchema, index: z.number().int().min(0).max(80), stop: DayStopSchema }).strict(),
  z.object({ type: z.literal("update_day_stop"), stopId: IdSchema, changes: DayStopChangesSchema }).strict(),
  z.object({ type: z.literal("move_day_stop"), stopId: IdSchema, targetDayId: IdSchema, targetIndex: z.number().int().min(0).max(80) }).strict(),
  z.object({ type: z.literal("remove_day_stop"), stopId: IdSchema }).strict(),
  z.object({ type: z.literal("move_day"), dayId: IdSchema, targetIndex: z.number().int().min(0).max(89) }).strict(),
  z.object({ type: z.literal("update_day"), dayId: IdSchema, changes: DayChangesSchema }).strict(),
]);
export type PlanCommand = z.infer<typeof PlanCommandSchema>;

export const PlanCommandRequestSchema = z.object({
  expectedGeneration: z.number().int().min(0),
  command: PlanCommandSchema,
}).strict();
export type PlanCommandRequest = z.infer<typeof PlanCommandRequestSchema>;

export const PlanCommandBatchRequestSchema = z.object({
  expectedGeneration: z.number().int().min(0),
  commands: z.array(PlanCommandSchema).min(1).max(100),
}).strict();
export type PlanCommandBatchRequest = z.infer<typeof PlanCommandBatchRequestSchema>;

export const ProposalDiffSchema = z.object({
  summary: TextSchema.max(1000),
  commandSummaries: z.array(TextSchema.max(500)).max(100),
  affectedCandidateIds: z.array(IdSchema).max(1800),
  affectedPlaceIds: z.array(IdSchema).max(1800),
  affectedDayIds: z.array(IdSchema).max(90),
}).strict();
export type ProposalDiff = z.infer<typeof ProposalDiffSchema>;

export const AiProposalSchema = z.object({
  id: IdSchema,
  tripId: IdSchema,
  baseGeneration: z.number().int().min(0),
  scope: ProposalScopeSchema,
  status: z.enum(["pending", "applied", "rejected", "superseded", "undone"]),
  title: TextSchema.max(300),
  explanation: TextSchema.max(4000),
  commands: z.array(PlanCommandSchema).min(1).max(100),
  diff: ProposalDiffSchema,
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  appliedRevisionVersion: z.number().int().min(1).nullable(),
}).strict();
export type AiProposal = z.infer<typeof AiProposalSchema>;

export const TripFactCommandSchema = z.discriminatedUnion("field", [
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("title"), value: TextSchema.max(200) }).strict(),
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("originPlaceId"), value: IdSchema.nullable() }).strict(),
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("destinationPlaceIds"), value: z.array(IdSchema).max(30) }).strict(),
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("dates"), value: TripDatesSchema }).strict(),
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("travelers"), value: TravelersSchema }).strict(),
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("budget"), value: BudgetSchema }).strict(),
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("pace"), value: z.string().trim().min(1).max(120).nullable() }).strict(),
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("themes"), value: z.array(TextSchema.max(120)).max(30) }).strict(),
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("preferences"), value: z.array(TextSchema.max(500)).max(40) }).strict(),
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("constraints"), value: z.array(TextSchema.max(500)).max(40) }).strict(),
  z.object({ type: z.literal("set_trip_fact"), field: z.literal("assumptions"), value: z.array(AssumptionSchema).max(40) }).strict(),
]);
export type TripFactCommand = z.infer<typeof TripFactCommandSchema>;

export const ConversationOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  assistantMessage: TextSchema.max(12000),
  tripChanges: z.array(TripFactCommandSchema).max(20),
  suggestedAction: z.enum(["none", "generate_candidates"]),
}).strict();
export type ConversationOutput = z.infer<typeof ConversationOutputSchema>;

export const CandidateProminenceSchema = z.enum(["iconic", "major", "supporting"]);
export type CandidateProminence = z.infer<typeof CandidateProminenceSchema>;

export const CandidateExperienceTypeSchema = z.enum([
  "landmark",
  "photo",
  "viewpoint",
  "museum_culture",
  "nature",
  "heritage_architecture",
  "family",
  "outdoor",
]);
export type CandidateExperienceType = z.infer<typeof CandidateExperienceTypeSchema>;

export const CandidateVisitPointTypeSchema = z.enum([
  "venue",
  "landmark",
  "photo_spot",
  "viewpoint",
  "trailhead",
  "attraction_entrance",
  "experience_meeting_point",
]);
export type CandidateVisitPointType = z.infer<typeof CandidateVisitPointTypeSchema>;

export const CandidateResearchBasisSchema = z.enum([
  "multi_guide_consensus",
  "official_status_verified",
  "user_theme_match",
]);
export type CandidateResearchBasis = z.infer<typeof CandidateResearchBasisSchema>;

const CandidateDiscoveryFieldsSchema = z.object({
  temporaryId: IdSchema,
  placeTemporaryId: IdSchema,
  planningAreaCandidateId: IdSchema.nullable(),
  aiReason: TextSchema.max(1000),
  aiScore: z.number().int().min(0).max(100),
  suggestedDurationMinutes: z.number().int().min(0).max(10080).nullable(),
  tags: z.array(TextSchema.max(120)).max(30),
  defaultPreference: z.literal("optional"),
}).strict();

const MacroCandidateDiscoveryItemSchema = CandidateDiscoveryFieldsSchema;
const MicroCandidateDiscoveryItemSchema = CandidateDiscoveryFieldsSchema.extend({
  prominence: CandidateProminenceSchema,
  experienceTypes: z.array(CandidateExperienceTypeSchema).min(1).max(8),
  visitPointType: CandidateVisitPointTypeSchema,
  researchBasis: z.array(CandidateResearchBasisSchema).min(1).max(3),
}).strict();

function validateDiscoveryReferences(
  value: { places: z.infer<typeof PlaceSchema>[]; candidates: Array<{ temporaryId: string; placeTemporaryId: string }> },
  context: z.RefinementCtx,
) {
  const placeIds = new Set(value.places.map((place) => place.id));
  if (placeIds.size !== value.places.length) context.addIssue({ code: "custom", path: ["places"], message: "临时 Place ID 不能重复。" });
  const candidateIds = new Set<string>();
  const placeRefs = new Set<string>();
  for (const [index, candidate] of value.candidates.entries()) {
    if (candidateIds.has(candidate.temporaryId)) context.addIssue({ code: "custom", path: ["candidates", index, "temporaryId"], message: "临时 Candidate ID 不能重复。" });
    if (!placeIds.has(candidate.placeTemporaryId)) context.addIssue({ code: "custom", path: ["candidates", index, "placeTemporaryId"], message: "Candidate 必须引用本轮 Place。" });
    if (placeRefs.has(candidate.placeTemporaryId)) context.addIssue({ code: "custom", path: ["candidates", index, "placeTemporaryId"], message: "同一 Place 只能生成一个 Candidate。" });
    candidateIds.add(candidate.temporaryId);
    placeRefs.add(candidate.placeTemporaryId);
  }
}

export const MacroCandidateDiscoveryOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  assistantMessage: TextSchema.max(12000),
  places: z.array(PlaceSchema).min(1).max(200),
  candidates: z.array(MacroCandidateDiscoveryItemSchema).min(1).max(200),
}).strict().superRefine(validateDiscoveryReferences);
export type MacroCandidateDiscoveryOutput = z.infer<typeof MacroCandidateDiscoveryOutputSchema>;

export const MicroCandidateDiscoveryOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  assistantMessage: TextSchema.max(12000),
  areaTargets: z.array(z.object({
    planningAreaCandidateId: IdSchema,
    targetCount: z.number().int().min(1).max(9),
    reason: TextSchema.max(1000),
  }).strict()).length(1),
  places: z.array(PlaceSchema).min(1).max(9),
  candidates: z.array(MicroCandidateDiscoveryItemSchema).min(1).max(9),
}).strict().superRefine(validateDiscoveryReferences);
export type MicroCandidateDiscoveryOutput = z.infer<typeof MicroCandidateDiscoveryOutputSchema>;

export const CandidateDiscoveryOutputSchema = z.union([MacroCandidateDiscoveryOutputSchema, MicroCandidateDiscoveryOutputSchema]);
export type CandidateDiscoveryOutput = z.infer<typeof CandidateDiscoveryOutputSchema>;

export const PlanGenerationOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  assistantMessage: TextSchema.max(12000),
  newPlaces: z.array(PlaceSchema).max(100),
  days: z.array(DaySchema).min(1).max(90),
  unscheduledCandidates: z.array(z.object({ candidateId: IdSchema, reason: TextSchema.max(1000) }).strict()).max(1800),
}).strict();
export type PlanGenerationOutput = z.infer<typeof PlanGenerationOutputSchema>;

export const AdjustmentProposalOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  scope: ProposalScopeSchema,
  assistantMessage: TextSchema.max(12000),
  title: TextSchema.max(300),
  explanation: TextSchema.max(4000),
  commands: z.array(PlanCommandSchema).min(1).max(100),
}).strict();
export type AdjustmentProposalOutput = z.infer<typeof AdjustmentProposalOutputSchema>;

export const DetailBatchOutputV2Schema = z.object({
  schemaVersion: z.literal(2),
  baseGeneration: z.number().int().min(0),
  batchId: IdSchema,
  dayIds: z.array(IdSchema).min(1).max(2),
  newPlaces: z.array(PlaceSchema).max(100),
  newCandidates: z.array(TripCandidateSchema).max(100),
  days: z.array(DetailedDaySchema).min(1).max(2),
  assistantMessage: TextSchema.max(12000),
}).strict().superRefine((value, context) => {
  const requested = new Set(value.dayIds);
  const returned = new Set(value.days.map((day) => day.id));
  if (requested.size !== value.dayIds.length || returned.size !== value.days.length || requested.size !== returned.size || [...requested].some((id) => !returned.has(id))) {
    context.addIssue({ code: "custom", path: ["days"], message: "细化批次必须恰好返回指定 Day。" });
  }
});
export type DetailBatchOutputV2 = z.infer<typeof DetailBatchOutputV2Schema>;

export const MapResolutionAssistOutputSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.enum(["choose_candidate", "retry_with_hints", "unresolved"]),
  providerPlaceId: z.string().trim().min(1).max(240).nullable(),
  searchHints: z.array(TextSchema.max(300)).max(8),
  reason: TextSchema.max(1000),
}).strict().superRefine((value, context) => {
  if (value.action === "choose_candidate" && !value.providerPlaceId) {
    context.addIssue({ code: "custom", path: ["providerPlaceId"], message: "choose_candidate 必须提供 providerPlaceId。" });
  }
  if (value.action !== "choose_candidate" && value.providerPlaceId !== null) {
    context.addIssue({ code: "custom", path: ["providerPlaceId"], message: "只有 choose_candidate 可以提供 providerPlaceId。" });
  }
  if (value.action === "retry_with_hints" && !value.searchHints.length) {
    context.addIssue({ code: "custom", path: ["searchHints"], message: "retry_with_hints 必须提供搜索提示。" });
  }
});
export type MapResolutionAssistOutput = z.infer<typeof MapResolutionAssistOutputSchema>;

export type AiAgentKind = "planner" | "detailer" | "map";
export type AiTaskStatus = "starting" | "running" | "waiting" | "reconnecting" | "completed" | "failed" | "stopped" | "cancelled_by_generation";
export type AiProgressEvent = { id: number; taskId: string; tripId: string; agent: AiAgentKind; status: AiTaskStatus; kind: string; summary: string; createdAt: string };
export type AiTaskSnapshot = { id: string; tripId: string; agent: AiAgentKind; label: string; status: AiTaskStatus; summary: string; startedAt: string; updatedAt: string; canStop: boolean; retryCount: number; nextAttemptAt: string | null; lastError: string | null; metadata: Record<string, unknown>; events: AiProgressEvent[] };

function strictJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictJson);
  if (!value || typeof value !== "object") return value;
  const record = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, strictJson(item)])) as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties) && (record.type === "object" || (Array.isArray(record.type) && record.type.includes("object")))) {
    record.required = Object.keys(record.properties as Record<string, unknown>);
  }
  delete record.$schema;
  return record;
}

export const TravelPlanDocumentJsonSchema = strictJson(z.toJSONSchema(TravelPlanDocumentSchema)) as Record<string, unknown>;
export const ConversationOutputJsonSchema = strictJson(z.toJSONSchema(ConversationOutputSchema)) as Record<string, unknown>;
export const MacroCandidateDiscoveryOutputJsonSchema = strictJson(z.toJSONSchema(MacroCandidateDiscoveryOutputSchema)) as Record<string, unknown>;
export const MicroCandidateDiscoveryOutputJsonSchema = strictJson(z.toJSONSchema(MicroCandidateDiscoveryOutputSchema)) as Record<string, unknown>;
export const PlanGenerationOutputJsonSchema = strictJson(z.toJSONSchema(PlanGenerationOutputSchema)) as Record<string, unknown>;
export const AdjustmentProposalOutputJsonSchema = strictJson(z.toJSONSchema(AdjustmentProposalOutputSchema)) as Record<string, unknown>;
export const DetailBatchOutputV2JsonSchema = strictJson(z.toJSONSchema(DetailBatchOutputV2Schema)) as Record<string, unknown>;
export const MapResolutionAssistOutputJsonSchema = strictJson(z.toJSONSchema(MapResolutionAssistOutputSchema)) as Record<string, unknown>;
