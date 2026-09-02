import { z } from "zod";
import { IdSchema, TextSchema, TransportModeSchema } from "./contracts-v2.js";

export const SkeletonStayDraftSchema = z.object({
  planningAreaCandidateId: IdSchema,
  stayDays: z.number().int().min(1).max(90),
  transferModeFromPrevious: TransportModeSchema,
}).strict();
export type SkeletonStayDraft = z.infer<typeof SkeletonStayDraftSchema>;

export const OmittedPlanningAreaSchema = z.object({
  candidateId: IdSchema,
  reason: TextSchema.max(1200),
}).strict();
export type OmittedPlanningArea = z.infer<typeof OmittedPlanningAreaSchema>;

export const SkeletonPlanDraftSchema = z.object({
  stays: z.array(SkeletonStayDraftSchema).min(1).max(90),
  omittedPlanningAreas: z.array(OmittedPlanningAreaSchema).max(1800),
}).strict().superRefine((value, context) => {
  const omittedIds = value.omittedPlanningAreas.map((item) => item.candidateId);
  if (new Set(omittedIds).size !== omittedIds.length) {
    context.addIssue({ code: "custom", path: ["omittedPlanningAreas"], message: "同一个 Planning Area 只能省略一次。" });
  }
});
export type SkeletonPlanDraft = z.infer<typeof SkeletonPlanDraftSchema>;
