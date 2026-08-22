import { z } from "zod";

export const transportModes = ["walk", "drive", "bike", "transit_advisory", "flight", "none"] as const;
export const TransportMode = z.enum(transportModes);

export const RequirementsSchema = z.object({
  destinations: z.array(z.object({ city: z.string().min(1).max(120), country: z.string().max(120).nullish(), timezone: z.string().max(80).nullish() })).max(8).default([]),
  dates: z.object({ start: z.string().max(32).nullish(), end: z.string().max(32).nullish(), durationDays: z.number().int().min(1).max(90).nullish() }).default({}),
  travelers: z.object({ summary: z.string().max(500).default("待确认"), adults: z.number().int().min(0).max(30).nullish(), children: z.number().int().min(0).max(30).nullish() }).default({ summary: "待确认" }),
  budget: z.object({ amount: z.number().nonnegative().nullish(), currency: z.string().max(12).nullish(), note: z.string().max(500).nullish() }).default({}),
  pace: z.string().max(80).default("待确认"),
  themes: z.array(z.string().min(1).max(80)).max(20).default([]),
  preferences: z.array(z.string().min(1).max(300)).max(30).default([]),
  assumptions: z.array(z.string().min(1).max(500)).max(30).default([]),
  openQuestions: z.array(z.string().min(1).max(500)).max(20).default([])
});
export type TravelRequirements = z.infer<typeof RequirementsSchema>;

export const ActivitySchema = z.object({
  id: z.string().min(1).max(120),
  startTime: z.string().max(32),
  endTime: z.string().max(32),
  placeName: z.string().min(1).max(300),
  activity: z.string().min(1).max(1200),
  durationMinutes: z.number().int().min(0).max(1440),
  transportMode: TransportMode,
  transportMinutes: z.number().int().min(0).max(1440),
  costNote: z.string().max(500),
  notes: z.string().max(1000).nullish()
});
export const TripPlanSchema = z.object({
  tripName: z.string().min(1).max(200),
  travelerSummary: z.string().min(1).max(600),
  pace: z.string().min(1).max(80),
  themes: z.array(z.string().min(1).max(80)).max(20),
  timezone: z.string().min(1).max(80),
  budgetNote: z.string().min(1).max(600),
  days: z.array(z.object({
    dayNumber: z.number().int().min(1).max(90), date: z.string().max(32).nullish(), title: z.string().min(1).max(300), activities: z.array(ActivitySchema).min(1).max(20)
  })).min(1).max(90),
  warnings: z.array(z.string().min(1).max(700)).max(30),
  generatedBy: z.literal("codex").default("codex")
});
export type TripPlan = z.infer<typeof TripPlanSchema>;

export const TravelAgentOutputSchema = z.object({
  schemaVersion: z.literal(1),
  replyType: z.enum(["clarification", "requirements_updated", "plan_updated", "answer"]),
  assistantMessage: z.string().min(1).max(12000),
  requirements: RequirementsSchema,
  plan: TripPlanSchema.nullish(),
  assumptions: z.array(z.string().min(1).max(500)).max(30).default([]),
  verificationNotes: z.array(z.string().min(1).max(700)).max(30).default([])
}).superRefine((value, context) => {
  if (value.replyType === "plan_updated" && !value.plan) context.addIssue({ code: "custom", path: ["plan"], message: "生成或修改行程时必须提供完整 plan。" });
});
export type TravelAgentOutput = z.infer<typeof TravelAgentOutputSchema>;
function requireAllObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(requireAllObjectProperties);
  if (!value || typeof value !== "object") return value;
  const record = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, requireAllObjectProperties(item)])) as Record<string, unknown>;
  const properties = record.properties;
  const type = record.type;
  if (properties && typeof properties === "object" && !Array.isArray(properties) && (type === "object" || (Array.isArray(type) && type.includes("object")))) record.required = Object.keys(properties);
  delete record.$schema;
  return record;
}
export const TravelAgentOutputJsonSchema = requireAllObjectProperties(z.toJSONSchema(TravelAgentOutputSchema)) as Record<string, unknown>;

export const MapEntityKindSchema = z.enum(["city", "attraction", "lodging", "meal", "stop", "waypoint"]);
export const MapEntityPatchSchema = z.object({
  id: z.string().min(1).max(160),
  activityId: z.string().min(1).max(120).nullish(),
  dayNumber: z.number().int().min(1).max(90),
  order: z.number().int().min(0).max(100),
  kind: MapEntityKindSchema,
  name: z.string().min(1).max(300),
  query: z.string().min(1).max(500),
  city: z.string().max(160),
  detail: z.string().min(1).max(1600),
  importance: z.enum(["primary", "secondary", "context"]),
  startTime: z.string().max(32),
  endTime: z.string().max(32),
  durationMinutes: z.number().int().min(0).max(1440),
  transportMode: TransportMode,
  costNote: z.string().max(500),
  notes: z.string().max(1000),
  approximateLodgingArea: z.boolean().default(false)
});
export const MapRoutePatchSchema = z.object({
  id: z.string().min(1).max(180),
  dayNumber: z.number().int().min(1).max(90),
  order: z.number().int().min(0).max(100),
  fromEntityId: z.string().min(1).max(160),
  toEntityId: z.string().min(1).max(160),
  mode: TransportMode
});
export const MapDayPathSchema = z.object({ dayNumber: z.number().int().min(1).max(90), entityIds: z.array(z.string().min(1).max(160)).min(1).max(200), startEntityId: z.string().min(1).max(160), endEntityId: z.string().min(1).max(160), overnightEntityId: z.string().min(1).max(160) });
export type MapDayPath = z.infer<typeof MapDayPathSchema>;
export const MapAgentOutputSchema = z.object({
  schemaVersion: z.literal(3),
  baseItineraryVersion: z.number().int().min(1),
  baseMapVersion: z.number().int().min(0),
  upsertEntities: z.array(MapEntityPatchSchema).max(1800),
  removeEntityIds: z.array(z.string().min(1).max(160)).max(1800),
  upsertRoutes: z.array(MapRoutePatchSchema).max(1800),
  removeRouteIds: z.array(z.string().min(1).max(180)).max(1800),
  dayPaths: z.array(MapDayPathSchema).min(1).max(90),
  warnings: z.array(z.string().min(1).max(700)).max(100)
}).superRefine((value, context) => {
  const duplicate = (values: string[]) => values.find((id, index) => values.indexOf(id) !== index);
  const entityDuplicate = duplicate(value.upsertEntities.map((item) => item.id));
  const routeDuplicate = duplicate(value.upsertRoutes.map((item) => item.id));
  if (entityDuplicate) context.addIssue({ code: "custom", path: ["upsertEntities"], message: `地点 ID 重复：${entityDuplicate}` });
  if (routeDuplicate) context.addIssue({ code: "custom", path: ["upsertRoutes"], message: `路线 ID 重复：${routeDuplicate}` });
});
export type MapAgentOutput = z.infer<typeof MapAgentOutputSchema>;
/**
 * The path endpoints duplicate information already present in entityIds.  Keep
 * the agent contract strict for everything meaningful, but canonicalize these
 * redundant fields before validation so a harmless endpoint typo cannot throw
 * away an otherwise valid map manifest.
 */
export function normalizeMapAgentOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const output = value as Record<string, unknown>;
  if (!Array.isArray(output.dayPaths)) return value;
  return {
    ...output,
    dayPaths: output.dayPaths.map((path) => {
      if (!path || typeof path !== "object" || Array.isArray(path)) return path;
      const record = path as Record<string, unknown>;
      const ids = record.entityIds;
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id)) return path;
      return { ...record, startEntityId: ids[0], endEntityId: ids.at(-1) };
    }),
  };
}
export type MapEntityPatch = z.infer<typeof MapEntityPatchSchema>;
export type MapRoutePatch = z.infer<typeof MapRoutePatchSchema>;
export const MapAgentOutputJsonSchema = requireAllObjectProperties(z.toJSONSchema(MapAgentOutputSchema)) as Record<string, unknown>;

export const MapResolutionOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseItineraryVersion: z.number().int().min(1),
  baseMapVersion: z.number().int().min(1),
  selections: z.array(z.object({
    entityId: z.string().min(1).max(160),
    providerPlaceId: z.string().min(1).max(160),
    decisionNote: z.string().min(1).max(700)
  })).max(1800),
  coordinates: z.array(z.object({
    entityId: z.string().min(1).max(160),
    displayName: z.string().min(1).max(500),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    sourceType: z.enum(["ai_web", "ai_knowledge"]),
    evidenceUrl: z.string().max(2000).nullable(),
    confidence: z.enum(["high", "medium", "low"]),
    decisionNote: z.string().min(1).max(700)
  })).max(1800),
  unresolved: z.array(z.object({ entityId: z.string().min(1).max(160), reason: z.string().min(1).max(700) })).max(1800)
}).superRefine((value, context) => {
  const ids = [...value.selections, ...value.coordinates, ...value.unresolved].map((item) => item.entityId);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) context.addIssue({ code: "custom", path: ["selections"], message: `地点决策重复：${duplicate}` });
  for (const item of value.coordinates) {
    if (item.sourceType === "ai_web" && !item.evidenceUrl) context.addIssue({ code: "custom", path: ["coordinates"], message: `网页坐标必须提供证据链接：${item.entityId}` });
    if (item.evidenceUrl && !/^https?:\/\/[^\s]+$/i.test(item.evidenceUrl)) context.addIssue({ code: "custom", path: ["coordinates"], message: `坐标证据链接无效：${item.entityId}` });
  }
});
export type MapResolutionOutput = z.infer<typeof MapResolutionOutputSchema>;
export const MapResolutionOutputJsonSchema = requireAllObjectProperties(z.toJSONSchema(MapResolutionOutputSchema)) as Record<string, unknown>;

export const emptyRequirements = (): TravelRequirements => RequirementsSchema.parse({});

export type CoordinateSource = "nominatim" | "ai_web" | "ai_knowledge" | "manual";
export type CoordinateConfidence = "high" | "medium" | "low";
export type Candidate = { providerPlaceId: string; displayName: string; latitude: number; longitude: number; category: string | null; sourceUrl: string; sourceType: CoordinateSource; evidenceUrl: string | null; confidence: CoordinateConfidence; decisionNote: string | null };
/** `approximate` is a usable city/area-centre fallback; `unresolved` is terminal but deliberately has no coordinate. */
export type MapEntityView = MapEntityPatch & { status: "pending" | "resolved" | "approximate" | "ambiguous" | "unresolved" | "unlocated" | "failed"; location: Candidate | null; candidates: Candidate[]; warning: string | null };
export type MapRouteView = MapRoutePatch & { status: "pending" | "resolved" | "unresolved" | "failed"; geometry: unknown | null; warning: string | null };
export type MapJobStatus = "idle" | "queued" | "analyzing" | "resolving" | "ready" | "partial" | "failed" | "stopped";
export type MapSnapshot = { itineraryVersion: number; mapVersion: number; scope: "all" | "day"; dayNumber: number | null; status: MapJobStatus; summary: string; warnings: string[]; entities: MapEntityView[]; routes: MapRouteView[]; dayPaths: MapDayPath[] };

export type AiAgentKind = "planner" | "map";
export type AiTaskStatus = "starting" | "running" | "waiting" | "reconnecting" | "completed" | "failed" | "stopped";
export type AiProgressEvent = { id: number; taskId: string; tripId: string; agent: AiAgentKind; status: AiTaskStatus; kind: string; summary: string; createdAt: string };
export type AiTaskSnapshot = { id: string; tripId: string; agent: AiAgentKind; label: string; status: AiTaskStatus; summary: string; startedAt: string; updatedAt: string; canStop: boolean; events: AiProgressEvent[] };
