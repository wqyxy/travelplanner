import { z } from "zod";

export const transportModes = ["walk", "drive", "bike", "transit_advisory", "none"] as const;
export const TransportMode = z.enum(transportModes);

export const RequirementsSchema = z.object({
  destinations: z.array(z.object({ city: z.string().min(1).max(120), country: z.string().max(120).optional(), timezone: z.string().max(80).optional() })).max(8).default([]),
  dates: z.object({ start: z.string().max(32).optional(), end: z.string().max(32).optional(), durationDays: z.number().int().min(1).max(90).optional() }).default({}),
  travelers: z.object({ summary: z.string().max(500).default("待确认"), adults: z.number().int().min(0).max(30).optional(), children: z.number().int().min(0).max(30).optional() }).default({ summary: "待确认" }),
  budget: z.object({ amount: z.number().nonnegative().optional(), currency: z.string().max(12).optional(), note: z.string().max(500).optional() }).default({}),
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
  notes: z.string().max(1000).optional()
});
export const TripPlanSchema = z.object({
  tripName: z.string().min(1).max(200),
  travelerSummary: z.string().min(1).max(600),
  pace: z.string().min(1).max(80),
  themes: z.array(z.string().min(1).max(80)).max(20),
  timezone: z.string().min(1).max(80),
  budgetNote: z.string().min(1).max(600),
  days: z.array(z.object({
    dayNumber: z.number().int().min(1).max(90), date: z.string().max(32).optional(), title: z.string().min(1).max(300), activities: z.array(ActivitySchema).min(1).max(20)
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
  plan: TripPlanSchema.optional(),
  assumptions: z.array(z.string().min(1).max(500)).max(30).default([]),
  verificationNotes: z.array(z.string().min(1).max(700)).max(30).default([])
}).superRefine((value, context) => {
  if (value.replyType === "plan_updated" && !value.plan) context.addIssue({ code: "custom", path: ["plan"], message: "生成或修改行程时必须提供完整 plan。" });
});
export type TravelAgentOutput = z.infer<typeof TravelAgentOutputSchema>;
export const TravelAgentOutputJsonSchema = z.toJSONSchema(TravelAgentOutputSchema);

export const emptyRequirements = (): TravelRequirements => RequirementsSchema.parse({});

export type Candidate = { providerPlaceId: string; displayName: string; latitude: number; longitude: number; category: string | null; sourceUrl: string };
export type MapView = { dayNumber: number; dayTitle: string; markers: Array<{ activityId: string; order: number; placeName: string; activity: string; durationMinutes: number; transportMode: string; status: "resolved" | "ambiguous" | "unresolved"; location: Candidate | null; candidates: Candidate[] }>; routes: Array<{ fromActivityId: string; toActivityId: string; mode: string; geometry: unknown | null; status: "resolved" | "unresolved"; warning: string | null }> };
