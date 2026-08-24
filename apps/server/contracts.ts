import { z } from "zod";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const countryPattern = /^[A-Z]{2}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const IdSchema = z.string().min(1).max(160);
const TextSchema = z.string().trim().min(1).max(1200);
const DateSchema = z.string().refine((value) => { if (!datePattern.test(value)) return false; const [y, m, d] = value.split("-").map(Number); const date = new Date(Date.UTC(y, m - 1, d)); return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d; }, "日期必须为有效的 YYYY-MM-DD。");
const TimeSchema = z.string().regex(timePattern, "时间必须为 HH:mm。");

export const PeriodSchema = z.enum(["morning", "afternoon", "evening", "night", "all_day"]);
export const VerificationStatusSchema = z.enum(["verified", "estimated", "unverified"]);
export const VerificationSchema = z.object({ status: VerificationStatusSchema, checkedAt: z.string().regex(instantPattern).nullable() }).strict().superRefine((value, context) => {
  if (value.status === "verified" && !value.checkedAt) context.addIssue({ code: "custom", path: ["checkedAt"], message: "verified 必须提供 checkedAt。" });
});
export type Verification = z.infer<typeof VerificationSchema>;

export const TransportModeSchema = z.enum(["walk", "drive", "bike", "transit", "rail", "flight", "ferry", "none"]);
export const TransportSchema = z.object({ mode: TransportModeSchema, durationMinutes: z.number().int().min(0).max(10080).nullable(), note: z.string().max(1000).nullable(), verification: VerificationSchema }).strict();
export const PlaceKindSchema = z.enum(["city", "attraction", "lodging", "meal", "airport", "station", "port", "stop", "waypoint"]);
export const PlaceSchema = z.object({ id: IdSchema, nameZh: TextSchema.max(300), nameLocal: z.string().trim().min(1).max(300).nullable(), nameEn: z.string().trim().min(1).max(300).nullable(), kind: PlaceKindSchema, city: z.string().trim().min(1).max(160).nullable(), region: z.string().trim().min(1).max(160).nullable(), country: z.string().trim().min(1).max(160).nullable(), countryCode: z.string().regex(countryPattern).nullable(), approximate: z.boolean() }).strict();
export type Place = z.infer<typeof PlaceSchema>;
const StopObjectSchema = z.object({ id: IdSchema, role: z.enum(["start", "visit", "end"]), placeId: IdSchema, activity: TextSchema, period: PeriodSchema.nullable(), startTime: TimeSchema.nullable(), endTime: TimeSchema.nullable(), durationMinutes: z.number().int().min(0).max(1440).nullable(), scheduleVerification: VerificationSchema.nullable(), transportFromPrevious: TransportSchema.nullable(), costNote: z.string().max(1000).nullable(), costVerification: VerificationSchema.nullable(), notes: z.string().max(2000).nullable() }).strict();
function addStopIssues(value: z.infer<typeof StopObjectSchema>, context: z.RefinementCtx) {
  if ((value.startTime === null) !== (value.endTime === null)) context.addIssue({ code: "custom", path: ["endTime"], message: "开始和结束时间必须同时提供或同时为空。" });
}
export const StopSchema = StopObjectSchema.superRefine(addStopIssues);
export type Stop = z.infer<typeof StopSchema>;
const DayObjectSchema = z.object({ id: IdSchema, dayNumber: z.number().int().min(1).max(90), date: DateSchema.nullable(), title: TextSchema.max(300), detailLevel: z.enum(["draft", "detailed"]), detailStatus: z.enum(["ready", "needs_review"]).nullable().optional(), stops: z.array(StopSchema).min(2).max(80) }).strict();
export const DaySchema = DayObjectSchema;
export type Day = z.infer<typeof DaySchema>;
const TripDatesSchema = z.object({ start: DateSchema.nullable(), end: DateSchema.nullable(), requestedDurationDays: z.number().int().min(1).max(90).nullable() }).strict().superRefine((value, context) => {
  if (value.start && value.end && value.start > value.end) context.addIssue({ code: "custom", path: ["end"], message: "结束日期不能早于开始日期。" });
  if (value.start && value.end && value.requestedDurationDays !== null) context.addIssue({ code: "custom", path: ["requestedDurationDays"], message: "完整日期范围存在时不得再保存 requestedDurationDays。" });
});
export const TripFactsSchema = z.object({
  title: TextSchema.max(200), originPlaceId: IdSchema.nullable(), destinationPlaceIds: z.array(IdSchema).max(30),
  dates: TripDatesSchema,
  travelers: z.object({ summary: z.string().max(500), adults: z.number().int().min(0).max(30).nullable(), children: z.number().int().min(0).max(30).nullable() }).strict(),
  budget: z.object({ amount: z.number().finite().nonnegative().nullable(), currency: z.string().trim().min(1).max(12).nullable(), note: z.string().max(500).nullable() }).strict(),
  pace: z.string().trim().min(1).max(120).nullable(), themes: z.array(TextSchema.max(120)).max(30), preferences: z.array(TextSchema.max(500)).max(40), constraints: z.array(TextSchema.max(500)).max(40),
  assumptions: z.array(z.object({ text: TextSchema.max(500), source: z.enum(["user", "ai", "system"]), confidence: z.enum(["low", "medium", "high"]) }).strict()).max(40),
}).strict();
export type TripFacts = z.infer<typeof TripFactsSchema>;

function detailedDayIssues(day: Day, context: z.RefinementCtx, prefix: PropertyKey[] = []) {
  for (const [stopIndex, stop] of day.stops.entries()) {
    if (!stop.startTime || !stop.endTime || stop.durationMinutes === null || !stop.scheduleVerification) context.addIssue({ code: "custom", path: [...prefix, "stops", stopIndex], message: "detailed Stop 必须提供时间、停留时长和日程核验状态。" });
    if (stopIndex > 0 && (!stop.transportFromPrevious || stop.transportFromPrevious.durationMinutes === null)) context.addIssue({ code: "custom", path: [...prefix, "stops", stopIndex, "transportFromPrevious"], message: "detailed 非首 Stop 必须提供交通和时长。" });
  }
}
export const DetailedDaySchema = DaySchema.superRefine((day, context) => {
  if (day.detailLevel !== "detailed") context.addIssue({ code: "custom", path: ["detailLevel"], message: "细化批次只能返回 detailed Day。" });
  detailedDayIssues(day, context);
});
export const ItinerarySchema = z.object({ schemaVersion: z.literal(1), stage: z.enum(["planning", "draft", "detailed"]), trip: TripFactsSchema, places: z.array(PlaceSchema).max(1800), days: z.array(DaySchema).max(90), warnings: z.array(TextSchema.max(700)).max(100) }).strict().superRefine((value, context) => {
  const placeIds = new Set<string>();
  for (const [index, place] of value.places.entries()) { if (placeIds.has(place.id)) context.addIssue({ code: "custom", path: ["places", index, "id"], message: "Place ID 不能重复。" }); placeIds.add(place.id); }
  for (const id of [value.trip.originPlaceId, ...value.trip.destinationPlaceIds].filter((item): item is string => Boolean(item))) if (!placeIds.has(id)) context.addIssue({ code: "custom", path: ["trip"], message: `旅行引用未知 Place：${id}` });
  if (new Set(value.trip.destinationPlaceIds).size !== value.trip.destinationPlaceIds.length) context.addIssue({ code: "custom", path: ["trip", "destinationPlaceIds"], message: "目的地引用不能重复。" });
  const dayIds = new Set<string>(); const stopIds = new Set<string>();
  for (const [dayIndex, day] of value.days.entries()) {
    if (dayIds.has(day.id)) context.addIssue({ code: "custom", path: ["days", dayIndex, "id"], message: "Day ID 不能重复。" }); dayIds.add(day.id);
    if (day.dayNumber !== dayIndex + 1) context.addIssue({ code: "custom", path: ["days", dayIndex, "dayNumber"], message: "dayNumber 必须从 1 连续递增。" });
    for (const [stopIndex, stop] of day.stops.entries()) {
      if (stopIds.has(stop.id)) context.addIssue({ code: "custom", path: ["days", dayIndex, "stops", stopIndex, "id"], message: "Stop ID 必须全局唯一。" }); stopIds.add(stop.id);
      if (!placeIds.has(stop.placeId)) context.addIssue({ code: "custom", path: ["days", dayIndex, "stops", stopIndex, "placeId"], message: `Stop 引用未知 Place：${stop.placeId}` });
      const expectedRole = stopIndex === 0 ? "start" : stopIndex === day.stops.length - 1 ? "end" : "visit";
      if (stop.role !== expectedRole) context.addIssue({ code: "custom", path: ["days", dayIndex, "stops", stopIndex, "role"], message: `Stop 必须为 ${expectedRole}。` });
      if (stopIndex === 0 && stop.transportFromPrevious !== null) context.addIssue({ code: "custom", path: ["days", dayIndex, "stops", stopIndex, "transportFromPrevious"], message: "首 Stop 不得有交通。" });
    }
    if (day.detailLevel === "detailed") detailedDayIssues(day, context, ["days", dayIndex]);
  }
  if (value.stage !== "planning") {
    if (!value.days.length) context.addIssue({ code: "custom", path: ["days"], message: "draft 和 detailed 必须有 Days。" });
    for (const [index, day] of value.days.entries()) if (day.stops.length < 3) context.addIssue({ code: "custom", path: ["days", index, "stops"], message: "draft 每天必须有开始、访问和结束 Stop。" });
    if (value.trip.dates.start) {
      const start = Date.parse(`${value.trip.dates.start}T00:00:00Z`);
      value.days.forEach((day, index) => { const expected = new Date(start + index * 86400000).toISOString().slice(0, 10); if (day.date !== expected) context.addIssue({ code: "custom", path: ["days", index, "date"], message: "日期必须连续。" }); });
      if (value.trip.dates.end) {
        const total = Math.floor((Date.parse(`${value.trip.dates.end}T00:00:00Z`) - start) / 86400000) + 1;
        if (value.days.length !== total) context.addIssue({ code: "custom", path: ["days"], message: "Day 数量必须覆盖完整日期范围。" });
      }
    }
  }
});
export type Itinerary = z.infer<typeof ItinerarySchema>;
export const emptyItinerary = (): Itinerary => ItinerarySchema.parse({ schemaVersion: 1, stage: "planning", trip: { title: "未命名旅行", originPlaceId: null, destinationPlaceIds: [], dates: { start: null, end: null, requestedDurationDays: null }, travelers: { summary: "", adults: null, children: null }, budget: { amount: null, currency: null, note: null }, pace: null, themes: [], preferences: [], constraints: [], assumptions: [] }, places: [], days: [], warnings: [] });

const TripChangesSchema = z.union([
  z.object({ title: z.string().trim().min(1).max(200) }).strict(), z.object({ originPlaceId: IdSchema.nullable() }).strict(), z.object({ destinationPlaceIds: z.array(IdSchema).max(30) }).strict(), z.object({ dates: TripDatesSchema }).strict(), z.object({ travelers: TripFactsSchema.shape.travelers }).strict(), z.object({ budget: TripFactsSchema.shape.budget }).strict(), z.object({ pace: z.string().trim().min(1).max(120).nullable() }).strict(), z.object({ themes: z.array(TextSchema.max(120)).max(30) }).strict(), z.object({ preferences: z.array(TextSchema.max(500)).max(40) }).strict(), z.object({ constraints: z.array(TextSchema.max(500)).max(40) }).strict(), z.object({ assumptions: TripFactsSchema.shape.assumptions }).strict(),
]);
const PlaceChangesSchema = z.union([
  z.object({ nameZh: TextSchema.max(300) }).strict(), z.object({ nameLocal: z.string().trim().min(1).max(300).nullable() }).strict(), z.object({ nameEn: z.string().trim().min(1).max(300).nullable() }).strict(), z.object({ kind: PlaceKindSchema }).strict(), z.object({ city: z.string().trim().min(1).max(160).nullable() }).strict(), z.object({ region: z.string().trim().min(1).max(160).nullable() }).strict(), z.object({ country: z.string().trim().min(1).max(160).nullable() }).strict(), z.object({ countryCode: z.string().regex(countryPattern).nullable() }).strict(), z.object({ approximate: z.boolean() }).strict(),
]);
const DayChangesSchema = z.union([
  z.object({ date: DateSchema.nullable() }).strict(), z.object({ title: TextSchema.max(300) }).strict(), z.object({ detailLevel: z.enum(["draft", "detailed"]) }).strict(),
]);
const StopChangesSchema = z.union([
  z.object({ activity: TextSchema }).strict(), z.object({ period: PeriodSchema.nullable() }).strict(), z.object({ startTime: TimeSchema.nullable() }).strict(), z.object({ endTime: TimeSchema.nullable() }).strict(), z.object({ durationMinutes: z.number().int().min(0).max(1440).nullable() }).strict(), z.object({ scheduleVerification: VerificationSchema.nullable() }).strict(), z.object({ transportFromPrevious: TransportSchema.nullable() }).strict(), z.object({ costNote: z.string().max(1000).nullable() }).strict(), z.object({ costVerification: VerificationSchema.nullable() }).strict(), z.object({ notes: z.string().max(2000).nullable() }).strict(),
]);
const NewPlaceSchema = PlaceSchema;
const NewDaySchema = z.object({ id: IdSchema, date: DateSchema.nullable(), title: TextSchema.max(300), detailLevel: z.enum(["draft", "detailed"]), stops: z.array(StopSchema).min(2).max(80) }).strict();
const NewStopSchema = StopObjectSchema.superRefine(addStopIssues);
export const PlannerMutationSchema = z.union([
  z.object({ type: z.literal("update_fields"), entity: z.literal("trip"), id: z.null(), changes: TripChangesSchema }).strict(), z.object({ type: z.literal("update_fields"), entity: z.literal("place"), id: IdSchema, changes: PlaceChangesSchema }).strict(), z.object({ type: z.literal("update_fields"), entity: z.literal("day"), id: IdSchema, changes: DayChangesSchema }).strict(), z.object({ type: z.literal("update_fields"), entity: z.literal("stop"), id: IdSchema, changes: StopChangesSchema }).strict(),
  z.object({ type: z.literal("add_entity"), entity: z.literal("place"), parentId: z.null(), value: NewPlaceSchema }).strict(), z.object({ type: z.literal("add_entity"), entity: z.literal("day"), parentId: z.null(), value: NewDaySchema }).strict(), z.object({ type: z.literal("add_entity"), entity: z.literal("stop"), parentId: IdSchema, value: NewStopSchema }).strict(),
  z.object({ type: z.literal("remove_entity"), entity: z.enum(["place", "day", "stop"]), id: IdSchema }).strict(), z.object({ type: z.literal("move_entity"), entity: z.literal("day"), id: IdSchema, targetParentId: z.null(), position: z.number().int().min(0).max(90).nullable() }).strict(), z.object({ type: z.literal("move_entity"), entity: z.literal("stop"), id: IdSchema, targetParentId: IdSchema, position: z.number().int().min(0).max(80).nullable() }).strict(),
  z.object({ type: z.literal("replace_reference"), entity: z.enum(["place", "stop"]), id: IdSchema, newReferenceId: IdSchema }).strict(), z.object({ type: z.literal("invalidate_dependencies"), entity: z.enum(["place", "day", "stop", "edge"]), id: IdSchema, reason: TextSchema.max(500) }).strict(),
]);
export type PlannerMutation = z.infer<typeof PlannerMutationSchema>;
export const PlannerOutputSchema = z.object({ schemaVersion: z.literal(1), operation: z.enum(["reply", "mutate_itinerary", "create_draft", "start_detailing"]), assistantMessage: TextSchema.max(12000), baseGeneration: z.number().int().min(0), mutations: z.array(PlannerMutationSchema).max(100).nullable(), draftItinerary: ItinerarySchema.nullable(), nextAction: z.enum(["none", "start_draft", "start_detail"]), suggestion: z.object({ id: IdSchema, text: TextSchema.max(700) }).strict().nullable() }).strict().superRefine((value, context) => {
  if (value.operation === "reply" && (value.mutations !== null || value.draftItinerary !== null)) context.addIssue({ code: "custom", message: "reply 不得写 itinerary。" });
  if (value.operation === "mutate_itinerary" && (!value.mutations?.length || value.draftItinerary !== null)) context.addIssue({ code: "custom", message: "mutation 必须只携带非空 mutations。" });
  if (value.operation === "create_draft" && (!value.draftItinerary || value.mutations !== null || value.draftItinerary.stage !== "draft" || value.draftItinerary.days.some((day) => day.detailLevel !== "draft"))) context.addIssue({ code: "custom", message: "create_draft 必须携带完整初始 draft。" });
  if (value.operation === "start_detailing" && (value.mutations !== null || value.draftItinerary !== null)) context.addIssue({ code: "custom", message: "start_detailing 不携带写入。" });
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
export const DetailBatchOutputSchema = z.object({ schemaVersion: z.literal(1), baseGeneration: z.number().int().min(0), batchId: IdSchema, dayIds: z.array(IdSchema).min(1).max(2), placeUpserts: z.array(PlaceSchema).max(100), days: z.array(DetailedDaySchema).min(1).max(2), assistantMessage: TextSchema.max(12000) }).strict().superRefine((value, context) => {
  const requested = new Set(value.dayIds); const returned = new Set(value.days.map((day) => day.id));
  if (requested.size !== value.dayIds.length || returned.size !== value.days.length || requested.size !== returned.size || [...requested].some((id) => !returned.has(id))) context.addIssue({ code: "custom", path: ["days"], message: "细化批次必须恰好替换指定 detailed Days。" });
});
export type DetailBatchOutput = z.infer<typeof DetailBatchOutputSchema>;
export const DetailCanonicalFeedbackSchema = z.object({ appliedDayIds: z.array(IdSchema).min(1).max(2), idMappings: z.record(IdSchema, IdSchema), canonicalDays: z.array(DetailedDaySchema).min(1).max(2), canonicalPlaceChanges: z.array(PlaceSchema).max(100), invalidatedFacts: z.array(TextSchema.max(700)).max(100), currentGeneration: z.number().int().min(0) }).strict().superRefine((value, context) => {
  const applied = new Set(value.appliedDayIds); const canonical = new Set(value.canonicalDays.map((day) => day.id));
  if (applied.size !== value.appliedDayIds.length || canonical.size !== value.canonicalDays.length || applied.size !== canonical.size || [...applied].some((id) => !canonical.has(id))) context.addIssue({ code: "custom", path: ["canonicalDays"], message: "canonical feedback 必须回灌全部已应用 Day。" });
});
export type DetailCanonicalFeedback = z.infer<typeof DetailCanonicalFeedbackSchema>;
export const ResolvedPlaceSchema = z.object({ placeId: IdSchema, geoFingerprint: TextSchema.max(1000), provider: TextSchema.max(120), providerPlaceId: z.string().max(200).nullable(), lat: z.number().finite().min(-90).max(90).nullable(), lng: z.number().finite().min(-180).max(180).nullable(), timezone: z.string().max(120).nullable(), resolution: z.enum(["exact", "approximate", "unresolved"]), confidence: z.number().finite().min(0).max(1).nullable(), resolvedAt: z.string().regex(instantPattern).nullable() }).strict();
export type ResolvedPlace = z.infer<typeof ResolvedPlaceSchema>;
export const MapVisitSchema = z.object({ id: IdSchema, dayId: IdSchema, dayNumber: z.number().int().min(1), stopId: IdSchema, placeId: IdSchema, order: z.number().int().min(0) }).strict(); export type MapVisit = z.infer<typeof MapVisitSchema>;
export const MapEdgeSchema = z.object({ id: IdSchema, dayId: IdSchema, fromVisitId: IdSchema, toVisitId: IdSchema, mode: TransportModeSchema, order: z.number().int().min(0) }).strict(); export type MapEdge = z.infer<typeof MapEdgeSchema>;
export const DerivedMapRouteSchema = z.object({ edgeId: IdSchema, routeKey: z.string().min(1).max(1000), geometry: z.unknown().nullable(), status: z.enum(["ready", "attention"]), warning: z.string().max(700).nullable() }).strict(); export type DerivedMapRoute = z.infer<typeof DerivedMapRouteSchema>;
export const DerivedMapSnapshotSchema = z.object({ visits: z.array(MapVisitSchema).max(7200), edges: z.array(MapEdgeSchema).max(7200), routes: z.array(DerivedMapRouteSchema).max(7200) }).strict(); export type DerivedMapSnapshot = z.infer<typeof DerivedMapSnapshotSchema>;
export const CandidateDecisionOutputSchema = z.object({ schemaVersion: z.literal(1), providerPlaceId: z.string().max(200).nullable(), reason: TextSchema.max(700) }).strict(); export type CandidateDecisionOutput = z.infer<typeof CandidateDecisionOutputSchema>;
export const MapChangedEventSchema = z.object({ tripId: IdSchema, generation: z.number().int().min(0), changedDayIds: z.array(IdSchema).max(90), status: z.enum(["syncing", "ready", "attention"]), summary: TextSchema.max(700) }).strict(); export type MapChangedEvent = z.infer<typeof MapChangedEventSchema>;
export type MapState = { generation: number; resolvedPlaces: ResolvedPlace[]; map: unknown; status: "idle" | "syncing" | "ready" | "attention"; warnings: string[]; updatedAt: string };
export type AiAgentKind = "planner" | "detailer" | "map"; export type AiTaskStatus = "starting" | "running" | "waiting" | "reconnecting" | "completed" | "failed" | "stopped" | "cancelled_by_generation";
export type AiProgressEvent = { id: number; taskId: string; tripId: string; agent: AiAgentKind; status: AiTaskStatus; kind: string; summary: string; createdAt: string };
export type AiTaskSnapshot = { id: string; tripId: string; agent: AiAgentKind; label: string; status: AiTaskStatus; summary: string; startedAt: string; updatedAt: string; canStop: boolean; retryCount: number; nextAttemptAt: string | null; lastError: string | null; metadata: Record<string, unknown>; events: AiProgressEvent[] };
function strictJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(strictJson); if (!value || typeof value !== "object") return value; const record = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, strictJson(item)])) as Record<string, unknown>; if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties) && (record.type === "object" || (Array.isArray(record.type) && record.type.includes("object")))) record.required = Object.keys(record.properties as Record<string, unknown>); delete record.$schema; return record; }
export const ItineraryJsonSchema = strictJson(z.toJSONSchema(ItinerarySchema)) as Record<string, unknown>;
export const PlannerOutputJsonSchema = strictJson(z.toJSONSchema(PlannerOutputSchema)) as Record<string, unknown>;
export const DetailBatchOutputJsonSchema = strictJson(z.toJSONSchema(DetailBatchOutputSchema)) as Record<string, unknown>;
export const CandidateDecisionOutputJsonSchema = strictJson(z.toJSONSchema(CandidateDecisionOutputSchema)) as Record<string, unknown>;
