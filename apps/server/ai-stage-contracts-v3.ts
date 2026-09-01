import { z } from "zod";

export const ConversationStageSchema = z.enum([
  "requirements",
  "destinations",
  "interests",
  "itinerary",
]);
export type ConversationStage = z.infer<typeof ConversationStageSchema>;
export const AiActionStageSchema = z.union([ConversationStageSchema, z.literal("map")]);
export type AiActionStage = z.infer<typeof AiActionStageSchema>;

export const AiActionTypeSchema = z.enum([
  "requirements.update",
  "requirements.clear",
  "requirements.capture",
  "destination.generate",
  "destination.add",
  "destination.remove",
  "destination.replace",
  "destination.edit",
  "destination.preference",
  "interest.discover",
  "interest.supplement",
  "interest.add",
  "interest.remove",
  "interest.replace",
  "interest.edit",
  "interest.preference",
  "itinerary.generate",
  "itinerary.replan",
  "itinerary.detail.generate",
  "itinerary.detail.update",
  "itinerary.stop.add",
  "itinerary.stop.remove",
  "itinerary.stop.replace",
  "itinerary.stop.move",
  "itinerary.day.reorder",
  "itinerary.edit",
  "itinerary.anchor.set",
  "itinerary.day.optimize",
  "itinerary.repair",
  "itinerary.verify",
  "itinerary.refine",
  "map.disambiguate",
]);
export type AiActionType = z.infer<typeof AiActionTypeSchema>;

export const AiActionExecutorSchema = z.enum(["ai", "deterministic"]);
export type AiActionExecutor = z.infer<typeof AiActionExecutorSchema>;

export const AiActionStatusSchema = z.enum([
  "pending_confirmation",
  "executing",
  "awaiting_apply",
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "applied",
  "rejected",
]);
export type AiActionStatus = z.infer<typeof AiActionStatusSchema>;

export const AiActionOriginSchema = z.enum(["conversation", "cta"]);
export type AiActionOrigin = z.infer<typeof AiActionOriginSchema>;

export const AiTaskAgentV3Schema = z.enum(["dialogue", "action", "map"]);
export type AiTaskAgentV3 = z.infer<typeof AiTaskAgentV3Schema>;

export const WorkspaceSelectionV3Schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trip"), id: z.null() }).strict(),
  z.object({ type: z.literal("candidate_pool"), id: z.null() }).strict(),
  z.object({ type: z.literal("candidate"), id: z.string().trim().min(1).max(160) }).strict(),
  z.object({ type: z.literal("place"), id: z.string().trim().min(1).max(160) }).strict(),
  z.object({ type: z.literal("day"), id: z.string().trim().min(1).max(160) }).strict(),
  z.object({ type: z.literal("stop"), id: z.string().trim().min(1).max(160) }).strict(),
]);
export type WorkspaceSelectionV3 = z.infer<typeof WorkspaceSelectionV3Schema>;

const RequirementFieldSchema = z.enum([
  "title",
  "brief",
  "dates",
  "travelers",
  "budget",
  "pace",
  "themes",
  "preferences",
  "constraints",
  "assumptions",
]);

const AssumptionInputSchema = z.object({
  text: z.string().trim().min(1).max(500),
  source: z.enum(["user", "ai", "system"]),
  confidence: z.enum(["low", "medium", "high"]),
}).strict();

const DialogueChangesSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  brief: z.object({
    destination: z.string().trim().max(500).optional(),
    origin: z.string().trim().max(500).optional(),
    departureTime: z.string().trim().max(500).optional(),
    duration: z.string().trim().max(500).optional(),
    travelers: z.string().trim().max(500).optional(),
    transport: z.string().trim().max(500).optional(),
    additionalRequirements: z.string().trim().max(4000).optional(),
  }).strict().optional(),
  date: z.string().trim().min(1).max(40).nullable().optional(),
  activity: z.string().trim().min(1).max(2000).optional(),
  period: z.enum(["morning", "afternoon", "evening", "night", "all_day"]).nullable().optional(),
  startTime: z.string().trim().min(1).max(20).nullable().optional(),
  endTime: z.string().trim().min(1).max(20).nullable().optional(),
  durationMinutes: z.number().int().min(0).max(10080).nullable().optional(),
  costNote: z.string().max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  pace: z.string().trim().min(1).max(120).nullable().optional(),
  themes: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  preferences: z.array(z.string().trim().min(1).max(500)).max(40).optional(),
  constraints: z.array(z.string().trim().min(1).max(500)).max(40).optional(),
  assumptions: z.array(AssumptionInputSchema).max(40).optional(),
  dates: z.object({
    start: z.string().trim().min(1).max(40).nullable(),
    end: z.string().trim().min(1).max(40).nullable(),
    requestedDurationDays: z.number().int().min(1).max(365).nullable(),
  }).strict().optional(),
  travelers: z.object({
    summary: z.string().max(1000),
    adults: z.number().int().min(0).max(100).nullable(),
    children: z.number().int().min(0).max(100).nullable(),
  }).strict().optional(),
  budget: z.object({
    amount: z.number().finite().nonnegative().nullable(),
    currency: z.string().trim().min(1).max(20).nullable(),
    note: z.string().max(1000).nullable(),
  }).strict().optional(),
  scheduleVerification: z.object({
    status: z.enum(["verified", "estimated", "unverified"]),
    checkedAt: z.string().datetime({ offset: true }).nullable(),
  }).strict().nullable().optional(),
  costVerification: z.object({
    status: z.enum(["verified", "estimated", "unverified"]),
    checkedAt: z.string().datetime({ offset: true }).nullable(),
  }).strict().nullable().optional(),
}).strict();

const DialoguePlaceChangesSchema = z.object({
  nameZh: z.string().trim().min(1).max(300).optional(),
  nameLocal: z.string().trim().min(1).max(300).nullable().optional(),
  nameEn: z.string().trim().min(1).max(300).nullable().optional(),
  kind: z.enum(["city", "attraction", "lodging", "meal", "airport", "station", "port", "stop", "waypoint"]).optional(),
  city: z.string().trim().min(1).max(160).nullable().optional(),
  region: z.string().trim().min(1).max(160).nullable().optional(),
  country: z.string().trim().min(1).max(160).nullable().optional(),
  countryCode: z.string().trim().min(2).max(2).nullable().optional(),
  approximate: z.boolean().optional(),
}).strict();

const DialogueCandidateChangesSchema = z.object({
  aiReason: z.string().trim().min(1).max(1000).nullable().optional(),
  aiScore: z.number().finite().min(0).max(100).nullable().optional(),
  suggestedDurationMinutes: z.number().int().min(0).max(10080).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
}).strict();

export const DialogueActionParametersSchema = z.object({
  request: z.string().trim().min(1).max(4000).nullable(),
  candidateId: z.string().trim().min(1).max(160).nullable(),
  candidateIds: z.array(z.string().trim().min(1).max(160)).max(200),
  preference: z.enum(["must_go", "want_to_go", "optional", "excluded"]).nullable(),
  dayId: z.string().trim().min(1).max(160).nullable(),
  dayIds: z.array(z.string().trim().min(1).max(160)).max(90),
  stopId: z.string().trim().min(1).max(160).nullable(),
  targetDayId: z.string().trim().min(1).max(160).nullable(),
  targetIndex: z.number().int().min(0).max(100).nullable(),
  index: z.number().int().min(0).max(100).nullable(),
  anchor: z.enum(["start", "end"]).nullable(),
  placeId: z.string().trim().min(1).max(160).nullable(),
  label: z.string().trim().min(1).max(300).nullable(),
  notes: z.string().max(2000).nullable(),
  activity: z.string().trim().min(1).max(2000).nullable(),
  fields: z.array(RequirementFieldSchema).max(10),
  changes: DialogueChangesSchema.nullable(),
  placeChanges: DialoguePlaceChangesSchema.nullable(),
  candidateChanges: DialogueCandidateChangesSchema.nullable(),
  allowWeb: z.boolean().nullable(),
}).strict();
export type DialogueActionParameters = z.infer<typeof DialogueActionParametersSchema>;

const ActionDialogueResultSchema = z.object({
  type: z.literal("action"),
  assistantMessage: z.string().trim().min(1).max(12000),
  actionType: AiActionTypeSchema,
  parameters: DialogueActionParametersSchema,
  targetIds: z.array(z.string().trim().min(1).max(160)).max(200),
  impactSummary: z.string().trim().min(1).max(2000),
}).strict();

export const StageDialogueOutputSchema = z.object({
  schemaVersion: z.literal(1),
  requirementsCapture: z.object({
    additionalRequirements: z.string().trim().min(1).max(4000),
  }).strict().nullable(),
  result: z.discriminatedUnion("type", [
    z.object({ type: z.literal("reply"), assistantMessage: z.string().trim().min(1).max(12000) }).strict(),
    z.object({ type: z.literal("clarification"), assistantMessage: z.string().trim().min(1).max(12000) }).strict(),
    z.object({ type: z.literal("web_required"), queryIntent: z.string().trim().min(1).max(2000), reason: z.string().trim().min(1).max(2000) }).strict(),
    ActionDialogueResultSchema,
  ]),
}).strict();
export type StageDialogueOutput = z.infer<typeof StageDialogueOutputSchema>;

export const WebDialogueOutputSchema = z.object({
  schemaVersion: z.literal(1),
  assistantMessage: z.string().trim().min(1).max(12000),
  verification: z.object({
    status: z.enum(["verified", "partially_verified", "unverified"]),
    checkedAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();
export type WebDialogueOutput = z.infer<typeof WebDialogueOutputSchema>;

export const StageConversationTurnInputSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  selection: WorkspaceSelectionV3Schema,
}).strict();
export type StageConversationTurnInput = z.infer<typeof StageConversationTurnInputSchema>;

export const ActionConfirmationInputSchema = z.object({ expectedGeneration: z.number().int().min(0) }).strict();
export type ActionConfirmationInput = z.infer<typeof ActionConfirmationInputSchema>;
export const ActionCancellationInputSchema = z.object({ expectedGeneration: z.number().int().min(0).optional() }).strict();
export type ActionCancellationInput = z.infer<typeof ActionCancellationInputSchema>;

export const AiTaskTimingSchema = z.object({
  startupMs: z.number().int().min(0).optional(),
  webMs: z.number().int().min(0).optional(),
  generationMs: z.number().int().min(0).optional(),
  validationMs: z.number().int().min(0).optional(),
  persistenceMs: z.number().int().min(0).optional(),
  totalMs: z.number().int().min(0),
  failedPhase: z.enum(["startup", "web", "generation", "validation", "persistence"]).optional(),
}).strict();
export type AiTaskTiming = z.infer<typeof AiTaskTimingSchema>;

export const StageThreadRecordSchema = z.object({
  tripId: z.string().trim().min(1).max(160),
  stage: ConversationStageSchema,
  threadId: z.string().trim().min(1).max(240),
  promptHash: z.string().trim().min(1).max(160),
  promptVersion: z.string().trim().min(1).max(80),
  contextGeneration: z.number().int().min(0),
  turnCount: z.number().int().min(0),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type StageThreadRecord = z.infer<typeof StageThreadRecordSchema>;

export const AiActionRecordSchema = z.object({
  id: z.string().trim().min(1).max(160),
  tripId: z.string().trim().min(1).max(160),
  stage: AiActionStageSchema,
  actionType: AiActionTypeSchema,
  executor: AiActionExecutorSchema,
  origin: AiActionOriginSchema,
  sourceMessageId: z.string().trim().min(1).max(160).nullable(),
  parameters: z.record(z.string(), z.unknown()),
  targetIds: z.array(z.string().trim().min(1).max(160)).max(200),
  scope: z.record(z.string(), z.unknown()),
  baseGeneration: z.number().int().min(0),
  status: AiActionStatusSchema,
  taskId: z.string().trim().min(1).max(160).nullable(),
  proposalId: z.string().trim().min(1).max(160).nullable(),
  resultRef: z.string().trim().min(1).max(1000).nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  errorSummary: z.string().max(2000).nullable(),
}).strict().superRefine((value, context) => {
  if (value.origin === "conversation" && !value.sourceMessageId) context.addIssue({ code: "custom", path: ["sourceMessageId"], message: "conversation Action 必须关联 sourceMessageId。" });
  if (value.origin === "cta" && value.sourceMessageId !== null) context.addIssue({ code: "custom", path: ["sourceMessageId"], message: "CTA Action 不得关联聊天消息。" });
  if (value.stage === "map" && value.origin === "conversation") context.addIssue({ code: "custom", path: ["origin"], message: "地图内部 Action 不来自阶段对话。" });
});
export type AiActionRecord = z.infer<typeof AiActionRecordSchema>;

export type PromptKindV3 = "shared" | "dialogue" | "action";
export type PromptWebPolicyV3 = "disabled" | "allowed" | "required";
export type ActionResultPolicyV3 = "save_result" | "proposal_required" | "deterministic_apply";

export type PromptIdV3 =
  | "shared.travel-rules"
  | "dialogue.requirements"
  | "dialogue.destinations"
  | "dialogue.interests"
  | "dialogue.itinerary"
  | "action.destination.generate"
  | "action.destination.add"
  | "action.destination.replace"
  | "action.interest.discover"
  | "action.interest.supplement"
  | "action.interest.add"
  | "action.interest.replace"
  | "action.itinerary.generate"
  | "action.itinerary.replan"
  | "action.itinerary.detail.generate"
  | "action.itinerary.detail.update"
  | "action.itinerary.day.optimize"
  | "action.itinerary.repair"
  | "action.itinerary.verify"
  | "action.itinerary.refine"
  | "action.map.disambiguate";

export type InputContractIdV3 =
  | "requirements.mutation.input"
  | "requirements.capture.input"
  | "destination.action.input"
  | "interest.action.input"
  | "itinerary.action.input"
  | "map.disambiguate.input";

export type OutputContractIdV3 =
  | "stage.dialogue.output"
  | "stage.web-dialogue.output"
  | "deterministic.result"
  | "destination.generate.output"
  | "destination.add.output"
  | "destination.replace.output"
  | "interest.discover.output"
  | "interest.supplement.output"
  | "interest.add.output"
  | "interest.replace.output"
  | "itinerary.generate.output"
  | "itinerary.replan.output"
  | "itinerary.detail.generate.output"
  | "itinerary.detail.update.output"
  | "itinerary.day.optimize.output"
  | "itinerary.repair.output"
  | "itinerary.verify.output"
  | "itinerary.refine.output"
  | "map.disambiguate.output";

export type ScopePolicyIdV3 =
  | "trip-facts"
  | "macro-candidate"
  | "micro-candidate"
  | "itinerary"
  | "day"
  | "map-candidate";
