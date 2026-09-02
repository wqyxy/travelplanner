import { z } from "zod";

export const WorkflowStepV3Schema = z.enum([
  "requirements",
  "backbone",
  "skeleton",
  "interests",
  "detail",
]);
export type WorkflowStepV3 = z.infer<typeof WorkflowStepV3Schema>;

export const RequiresWorkflowStepV3Schema = z.enum([
  "requirements",
  "backbone",
  "skeleton",
  "interests",
]);
export type RequiresWorkflowStepV3 = z.infer<typeof RequiresWorkflowStepV3Schema>;

export const RequiresWorkflowStepResultSchema = z.object({
  type: z.literal("requires_workflow_step"),
  requiresWorkflowStep: RequiresWorkflowStepV3Schema,
  reason: z.string().trim().min(1).max(2000),
  assistantMessage: z.string().trim().min(1).max(12000),
}).strict();
export type RequiresWorkflowStepResult = z.infer<typeof RequiresWorkflowStepResultSchema>;

export function conversationStageForWorkflowStepV3(step: WorkflowStepV3): "requirements" | "destinations" | "interests" | "itinerary" {
  if (step === "requirements") return "requirements";
  if (step === "backbone" || step === "skeleton") return "destinations";
  if (step === "interests") return "interests";
  return "itinerary";
}
