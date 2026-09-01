import { z } from "zod";
import {
  CandidatePreferenceSchema,
  DaySchema,
  IdSchema,
  MapResolutionAssistOutputSchema,
  PeriodSchema,
  PlaceSchema,
  TextSchema,
  TimeSchema,
  TransportModeSchema,
  TransportSchema,
  VerificationSchema,
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

const ItineraryGenerateRequiresStageSchema = z.object({
  type: z.literal("requires_stage"),
  requiresStage: z.enum(["requirements", "interests"]),
  assistantMessage: TextSchema.max(12000),
  reason: TextSchema.max(2000),
}).strict();

export const ItineraryMacroVisitSchema = z.object({
  destinationCandidateId: IdSchema,
  stayDays: z.number().int().min(1).max(90),
  transferMode: TransportModeSchema,
}).strict();
export type ItineraryMacroVisit = z.infer<typeof ItineraryMacroVisitSchema>;

const ItineraryGenerationSuccessSchema = z.object({
  type: z.literal("success"),
  assistantMessage: TextSchema.max(12000),
  destinations: z.array(ItineraryMacroVisitSchema).min(1).max(30),
}).strict().superRefine((value, context) => {
  const ids = value.destinations.map((item) => item.destinationCandidateId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["destinations"], message: "Macro 行程中同一目的地只能出现一次。" });
});

export const ItineraryGenerateOutputSchema = z.object({ schemaVersion: z.literal(2), baseGeneration: z.number().int().min(0), result: z.discriminatedUnion("type", [ItineraryGenerationSuccessSchema, ItineraryGenerateRequiresStageSchema]) }).strict();
export type ItineraryGenerateOutput = z.infer<typeof ItineraryGenerateOutputSchema>;

const ItineraryReplacementSuccessSchema = z.object({
  type: z.literal("success"),
  assistantMessage: TextSchema.max(12000),
  title: TextSchema.max(300),
  explanation: TextSchema.max(4000),
  destinations: z.array(ItineraryMacroVisitSchema).min(1).max(30),
}).strict().superRefine((value, context) => {
  const ids = value.destinations.map((item) => item.destinationCandidateId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["destinations"], message: "Macro 行程中同一目的地只能出现一次。" });
});

export const ItineraryReplanOutputSchema = z.object({ schemaVersion: z.literal(1), baseGeneration: z.number().int().min(0), result: z.discriminatedUnion("type", [ItineraryReplacementSuccessSchema, RequiresInterestsSchema]) }).strict();
export type ItineraryReplanOutput = z.infer<typeof ItineraryReplanOutputSchema>;

const DetailedStopDraftSchema = z.object({
  candidateId: IdSchema,
  activity: TextSchema,
  period: PeriodSchema.nullable(),
  startTime: TimeSchema,
  endTime: TimeSchema,
  durationMinutes: z.number().int().min(0).max(1440),
  transportFromPrevious: TransportSchema.nullable(),
  scheduleVerification: VerificationSchema,
  costNote: z.string().max(1000).nullable(),
  costVerification: VerificationSchema.nullable(),
  notes: z.string().max(2000).nullable(),
}).strict().superRefine((value, context) => {
  if (value.endTime <= value.startTime) context.addIssue({ code: "custom", path: ["endTime"], message: "结束时间必须晚于开始时间。" });
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  if (minutes(value.endTime) - minutes(value.startTime) !== value.durationMinutes) context.addIssue({ code: "custom", path: ["durationMinutes"], message: "停留时长必须等于开始和结束时间之差。" });
});

export const DetailedDayUpdateSchema = z.object({
  dayId: IdSchema,
  stops: z.array(DetailedStopDraftSchema).max(80),
}).strict().superRefine((value, context) => {
  const candidateIds = value.stops.map((stop) => stop.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) context.addIssue({ code: "custom", path: ["stops"], message: "同一天不得重复安排同一个 Candidate。" });
});
export type DetailedDayUpdate = z.infer<typeof DetailedDayUpdateSchema>;

const DetailGenerateSuccessSchema = z.object({
  type: z.literal("success"),
  assistantMessage: TextSchema.max(12000),
  dayUpdates: z.array(DetailedDayUpdateSchema).min(1).max(90),
  unscheduledCandidates: z.array(z.object({ candidateId: IdSchema, reason: TextSchema.max(1000) }).strict()).max(1800),
}).strict();

export const ItineraryDetailGenerateOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  result: z.discriminatedUnion("type", [DetailGenerateSuccessSchema, RequiresInterestsSchema]),
}).strict();
export type ItineraryDetailGenerateOutput = z.infer<typeof ItineraryDetailGenerateOutputSchema>;

const DetailUpdateSuccessSchema = z.object({
  type: z.literal("success"),
  assistantMessage: TextSchema.max(12000),
  title: TextSchema.max(300),
  explanation: TextSchema.max(4000),
  affectedDayIds: z.array(IdSchema).min(1).max(90),
  dayUpdates: z.array(DetailedDayUpdateSchema).min(1).max(90),
}).strict().superRefine((value, context) => {
  const requested = new Set(value.affectedDayIds);
  const returned = new Set(value.dayUpdates.map((day) => day.dayId));
  if (requested.size !== value.affectedDayIds.length || returned.size !== value.dayUpdates.length || requested.size !== returned.size || [...requested].some((id) => !returned.has(id))) {
    context.addIssue({ code: "custom", path: ["dayUpdates"], message: "增量详细行程必须恰好返回 affectedDayIds。" });
  }
});

export const ItineraryDetailUpdateOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  result: z.discriminatedUnion("type", [DetailUpdateSuccessSchema, RequiresInterestsSchema]),
}).strict();
export type ItineraryDetailUpdateOutput = z.infer<typeof ItineraryDetailUpdateOutputSchema>;

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

const ItineraryRefineStopSchema = z.object({
  stopId: IdSchema,
  activity: TextSchema,
  period: PeriodSchema.nullable(),
  startTime: TimeSchema,
  endTime: TimeSchema,
  durationMinutes: z.number().int().min(0).max(1440),
  transportFromPrevious: TransportSchema.nullable(),
  scheduleVerification: VerificationSchema,
  costNote: z.string().max(1000).nullable(),
  costVerification: VerificationSchema.nullable(),
  notes: z.string().max(2000).nullable(),
}).strict().superRefine((value, context) => {
  if (value.endTime <= value.startTime) context.addIssue({ code: "custom", path: ["endTime"], message: "结束时间必须晚于开始时间。" });
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  if (minutes(value.endTime) - minutes(value.startTime) !== value.durationMinutes) context.addIssue({ code: "custom", path: ["durationMinutes"], message: "停留时长必须等于开始和结束时间之差。" });
});

const ItineraryRefineDayUpdateSchema = z.object({
  dayId: IdSchema,
  stops: z.array(ItineraryRefineStopSchema).max(80),
}).strict().superRefine((value, context) => {
  const ids = value.stops.map((stop) => stop.stopId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["stops"], message: "同一个 Stop 只能细化一次。" });
});

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
      dayUpdates: z.array(ItineraryRefineDayUpdateSchema).min(1).max(2),
    }).strict().superRefine((value, context) => {
      const requested = new Set(value.dayIds);
      const returned = new Set(value.dayUpdates.map((day) => day.dayId));
      if (requested.size !== value.dayIds.length || returned.size !== value.dayUpdates.length || requested.size !== returned.size || [...requested].some((id) => !returned.has(id))) context.addIssue({ code: "custom", path: ["dayUpdates"], message: "细化动作必须恰好返回指定 Day。" });
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
  "itinerary.detail.generate.output": ItineraryDetailGenerateOutputSchema,
  "itinerary.detail.update.output": ItineraryDetailUpdateOutputSchema,
  "itinerary.day.optimize.output": ItineraryDayOptimizeOutputSchema,
  "itinerary.repair.output": ItineraryRepairOutputSchema,
  "itinerary.verify.output": ItineraryVerifyOutputSchema,
  "itinerary.refine.output": ItineraryRefineOutputSchema,
  "map.disambiguate.output": MapDisambiguateOutputSchema,
} as const;
