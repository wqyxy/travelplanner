import { z } from "zod";
import {
  CandidatePreferenceSchema,
  DaySchema,
  DetailedDaySchema,
  IdSchema,
  MapResolutionAssistOutputSchema,
  PlaceSchema,
  TextSchema,
  TimeSchema,
  TransportSchema,
  VerificationSchema,
  type Day,
} from "./contracts-v2.js";
import { AiLedMicroCandidateDiscoveryOutputSchema } from "./ai-led-micro-contract-v2.js";
import { StageDialogueOutputSchema, WebDialogueOutputSchema } from "./ai-stage-contracts-v3.js";

const CandidateDraftSchema = z.object({
  temporaryId: IdSchema,
  placeTemporaryId: IdSchema,
  planningAreaCandidateId: IdSchema.nullable(),
  aiReason: TextSchema.max(1000),
  aiScore: z.number().int().min(0).max(100),
  suggestedDurationMinutes: z.number().int().min(0).max(10080).nullable(),
  tags: z.array(TextSchema.max(120)).max(30),
  defaultPreference: CandidatePreferenceSchema,
}).strict();

function validateCandidateDrafts(
  value: { places: z.infer<typeof PlaceSchema>[]; candidates: z.infer<typeof CandidateDraftSchema>[] },
  context: z.RefinementCtx,
) {
  const placeIds = new Set(value.places.map((place) => place.id));
  if (placeIds.size !== value.places.length) context.addIssue({ code: "custom", path: ["places"], message: "临时 Place ID 不能重复。" });
  const candidateIds = new Set<string>();
  const usedPlaceIds = new Set<string>();
  for (const [index, candidate] of value.candidates.entries()) {
    if (candidateIds.has(candidate.temporaryId)) context.addIssue({ code: "custom", path: ["candidates", index, "temporaryId"], message: "临时 Candidate ID 不能重复。" });
    if (!placeIds.has(candidate.placeTemporaryId)) context.addIssue({ code: "custom", path: ["candidates", index, "placeTemporaryId"], message: "Candidate 必须引用本轮 Place。" });
    if (usedPlaceIds.has(candidate.placeTemporaryId)) context.addIssue({ code: "custom", path: ["candidates", index, "placeTemporaryId"], message: "同一 Place 只能对应一个 Candidate。" });
    candidateIds.add(candidate.temporaryId);
    usedPlaceIds.add(candidate.placeTemporaryId);
  }
}

const DestinationDiscoveryBaseSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  assistantMessage: TextSchema.max(12000),
  places: z.array(PlaceSchema).min(1).max(30),
  candidates: z.array(CandidateDraftSchema).min(1).max(30),
}).strict();

export const DestinationGenerateOutputSchema = DestinationDiscoveryBaseSchema.superRefine((value, context) => {
  validateCandidateDrafts(value, context);
  for (const [index, place] of value.places.entries()) {
    if (place.kind !== "city") context.addIssue({ code: "custom", path: ["places", index, "kind"], message: "目的地 Macro 必须使用现有 kind=city。" });
  }
  for (const [index, candidate] of value.candidates.entries()) {
    if (candidate.planningAreaCandidateId !== null) context.addIssue({ code: "custom", path: ["candidates", index, "planningAreaCandidateId"], message: "Macro Candidate 不得归属另一个 Macro。" });
  }
});
export type DestinationGenerateOutput = z.infer<typeof DestinationGenerateOutputSchema>;

const SingleCandidateProposalBaseSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  assistantMessage: TextSchema.max(12000),
  title: TextSchema.max(300),
  explanation: TextSchema.max(4000),
  places: z.array(PlaceSchema).length(1),
  candidates: z.array(CandidateDraftSchema).length(1),
}).strict();

export const DestinationAddOutputSchema = SingleCandidateProposalBaseSchema.superRefine((value, context) => {
  validateCandidateDrafts(value, context);
  if (value.places[0]?.kind !== "city") context.addIssue({ code: "custom", path: ["places", 0, "kind"], message: "新增目的地必须保持 Macro kind=city。" });
  if (value.candidates[0]?.planningAreaCandidateId !== null) context.addIssue({ code: "custom", path: ["candidates", 0, "planningAreaCandidateId"], message: "Macro Candidate 不得存在父 Macro。" });
});
export type DestinationAddOutput = z.infer<typeof DestinationAddOutputSchema>;

export const DestinationReplaceOutputSchema = SingleCandidateProposalBaseSchema.extend({ replaceCandidateId: IdSchema }).strict().superRefine((value, context) => {
  validateCandidateDrafts(value, context);
  if (value.places[0]?.kind !== "city") context.addIssue({ code: "custom", path: ["places", 0, "kind"], message: "替换目的地必须保持 Macro kind=city。" });
  if (value.candidates[0]?.planningAreaCandidateId !== null) context.addIssue({ code: "custom", path: ["candidates", 0, "planningAreaCandidateId"], message: "Macro Candidate 不得存在父 Macro。" });
});
export type DestinationReplaceOutput = z.infer<typeof DestinationReplaceOutputSchema>;

export const InterestDiscoverOutputSchema = AiLedMicroCandidateDiscoveryOutputSchema;
export const InterestSupplementOutputSchema = AiLedMicroCandidateDiscoveryOutputSchema;

export const InterestAddOutputSchema = SingleCandidateProposalBaseSchema.superRefine((value, context) => {
  validateCandidateDrafts(value, context);
  if (value.places[0]?.kind === "city") context.addIssue({ code: "custom", path: ["places", 0, "kind"], message: "兴趣点不得使用 kind=city。" });
  if (!value.candidates[0]?.planningAreaCandidateId) context.addIssue({ code: "custom", path: ["candidates", 0, "planningAreaCandidateId"], message: "兴趣点必须绑定现有 Macro Candidate。" });
});
export type InterestAddOutput = z.infer<typeof InterestAddOutputSchema>;

export const InterestReplaceOutputSchema = SingleCandidateProposalBaseSchema.extend({ replaceCandidateId: IdSchema }).strict().superRefine((value, context) => {
  validateCandidateDrafts(value, context);
  if (value.places[0]?.kind === "city") context.addIssue({ code: "custom", path: ["places", 0, "kind"], message: "兴趣点不得使用 kind=city。" });
  if (!value.candidates[0]?.planningAreaCandidateId) context.addIssue({ code: "custom", path: ["candidates", 0, "planningAreaCandidateId"], message: "兴趣点必须绑定现有 Macro Candidate。" });
});
export type InterestReplaceOutput = z.infer<typeof InterestReplaceOutputSchema>;

const RequiresInterestsSchema = z.object({
  type: z.literal("requires_stage"),
  requiresStage: z.literal("interests"),
  assistantMessage: TextSchema.max(12000),
  reason: TextSchema.max(2000),
}).strict();

const ItineraryGenerationSuccessSchema = z.object({
  type: z.literal("success"),
  assistantMessage: TextSchema.max(12000),
  days: z.array(DaySchema).min(1).max(90),
  unscheduledCandidates: z.array(z.object({ candidateId: IdSchema, reason: TextSchema.max(1000) }).strict()).max(1800),
}).strict();

export const ItineraryGenerateOutputSchema = z.object({ schemaVersion: z.literal(1), baseGeneration: z.number().int().min(0), result: z.discriminatedUnion("type", [ItineraryGenerationSuccessSchema, RequiresInterestsSchema]) }).strict();
export type ItineraryGenerateOutput = z.infer<typeof ItineraryGenerateOutputSchema>;

const ItineraryReplacementSuccessSchema = z.object({
  type: z.literal("success"),
  assistantMessage: TextSchema.max(12000),
  title: TextSchema.max(300),
  explanation: TextSchema.max(4000),
  days: z.array(DaySchema).min(1).max(90),
}).strict();

export const ItineraryReplanOutputSchema = z.object({ schemaVersion: z.literal(1), baseGeneration: z.number().int().min(0), result: z.discriminatedUnion("type", [ItineraryReplacementSuccessSchema, RequiresInterestsSchema]) }).strict();
export type ItineraryReplanOutput = z.infer<typeof ItineraryReplanOutputSchema>;

export const ItineraryDayOptimizeOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  result: z.discriminatedUnion("type", [
    z.object({ type: z.literal("success"), assistantMessage: TextSchema.max(12000), title: TextSchema.max(300), explanation: TextSchema.max(4000), dayId: IdSchema, orderedStopIds: z.array(IdSchema).max(80) }).strict(),
    RequiresInterestsSchema,
  ]),
}).strict();
export type ItineraryDayOptimizeOutput = z.infer<typeof ItineraryDayOptimizeOutputSchema>;

export const ItineraryRepairOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  result: z.discriminatedUnion("type", [
    z.object({ type: z.literal("success"), assistantMessage: TextSchema.max(12000), title: TextSchema.max(300), explanation: TextSchema.max(4000), days: z.array(DaySchema).min(1).max(90) }).strict(),
    RequiresInterestsSchema,
  ]),
}).strict();
export type ItineraryRepairOutput = z.infer<typeof ItineraryRepairOutputSchema>;

const ItineraryVerificationChangesSchema = z.object({
  startTime: TimeSchema.nullable().optional(),
  endTime: TimeSchema.nullable().optional(),
  durationMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  transportFromPrevious: TransportSchema.nullable().optional(),
  scheduleVerification: VerificationSchema.nullable().optional(),
  costNote: z.string().max(1000).nullable().optional(),
  costVerification: VerificationSchema.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "动态核验至少需要更新一个可核验字段。");

const ItineraryVerificationCommandSchema = z.object({
  type: z.literal("update_day_stop"),
  stopId: IdSchema,
  changes: ItineraryVerificationChangesSchema,
}).strict();

export const ItineraryVerifyOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  assistantMessage: TextSchema.max(12000),
  title: TextSchema.max(300),
  explanation: TextSchema.max(4000),
  checkedAt: z.string().datetime({ offset: true }),
  commands: z.array(ItineraryVerificationCommandSchema).max(100),
}).strict();
export type ItineraryVerifyOutput = z.infer<typeof ItineraryVerifyOutputSchema>;

export const ItineraryRefineOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  result: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("success"),
      assistantMessage: TextSchema.max(12000),
      title: TextSchema.max(300),
      explanation: TextSchema.max(4000),
      dayIds: z.array(IdSchema).min(1).max(2),
      days: z.array(DetailedDaySchema).min(1).max(2),
    }).strict().superRefine((value, context) => {
      const requested = new Set(value.dayIds);
      const returned = new Set(value.days.map((day: Day) => day.id));
      if (requested.size !== value.dayIds.length || returned.size !== value.days.length || requested.size !== returned.size || [...requested].some((id) => !returned.has(id))) context.addIssue({ code: "custom", path: ["days"], message: "细化动作必须恰好返回指定 Day。" });
    }),
    RequiresInterestsSchema,
  ]),
}).strict();
export type ItineraryRefineOutput = z.infer<typeof ItineraryRefineOutputSchema>;

export const MapDisambiguateOutputSchema = MapResolutionAssistOutputSchema;

export const OUTPUT_CONTRACT_SCHEMAS_V3 = {
  "stage.dialogue.output": StageDialogueOutputSchema,
  "stage.web-dialogue.output": WebDialogueOutputSchema,
  "destination.generate.output": DestinationGenerateOutputSchema,
  "destination.add.output": DestinationAddOutputSchema,
  "destination.replace.output": DestinationReplaceOutputSchema,
  "interest.discover.output": InterestDiscoverOutputSchema,
  "interest.supplement.output": InterestSupplementOutputSchema,
  "interest.add.output": InterestAddOutputSchema,
  "interest.replace.output": InterestReplaceOutputSchema,
  "itinerary.generate.output": ItineraryGenerateOutputSchema,
  "itinerary.replan.output": ItineraryReplanOutputSchema,
  "itinerary.day.optimize.output": ItineraryDayOptimizeOutputSchema,
  "itinerary.repair.output": ItineraryRepairOutputSchema,
  "itinerary.verify.output": ItineraryVerifyOutputSchema,
  "itinerary.refine.output": ItineraryRefineOutputSchema,
  "map.disambiguate.output": MapDisambiguateOutputSchema,
} as const;
