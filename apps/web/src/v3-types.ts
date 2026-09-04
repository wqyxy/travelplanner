import type { AiProposal, Chat, Revision, RouteState, Trip, PlaceResolution, DayRoute, PlanningAreaCoverage, WorkspaceSelection } from "./v2-types";

export type ConversationStage = "requirements" | "destinations" | "interests" | "itinerary";
export type WorkflowStepV3 = "requirements" | "backbone" | "skeleton" | "interests" | "detail";
export type RequiresWorkflowStepV3 = Exclude<WorkflowStepV3, "detail">;
// Legacy alias remains only because the old, no-longer-mounted AppV3.tsx is still
// part of the TypeScript source tree. The mounted Phase 6 app uses WorkflowStepV3.
export type PlannerStepV3 = ConversationStage | "detail";

export function conversationStageForWorkflowStepV3(step: WorkflowStepV3): ConversationStage {
  if (step === "requirements") return "requirements";
  if (step === "backbone" || step === "skeleton") return "destinations";
  if (step === "interests") return "interests";
  return "itinerary";
}

export type AiActionType =
  | "requirements.update" | "requirements.clear" | "requirements.capture"
  | "destination.generate" | "destination.add" | "destination.remove" | "destination.replace" | "destination.edit" | "destination.preference"
  | "interest.discover" | "interest.supplement" | "interest.add" | "interest.remove" | "interest.replace" | "interest.edit" | "interest.preference"
  | "itinerary.generate" | "itinerary.replan" | "itinerary.detail.generate" | "itinerary.detail.update" | "itinerary.stop.add" | "itinerary.stop.remove" | "itinerary.stop.replace" | "itinerary.stop.move" | "itinerary.day.reorder" | "itinerary.edit" | "itinerary.anchor.set" | "itinerary.day.optimize" | "itinerary.repair" | "itinerary.verify" | "itinerary.refine"
  | "map.disambiguate";
export type AiActionStatus = "pending_confirmation" | "executing" | "awaiting_apply" | "completed" | "failed" | "cancelled" | "superseded" | "applied" | "rejected";
export type AiAction = {
  id: string;
  tripId: string;
  stage: ConversationStage | "map";
  actionType: AiActionType;
  executor: "ai" | "deterministic";
  origin: "conversation" | "cta";
  sourceMessageId: string | null;
  parameters: Record<string, unknown>;
  targetIds: string[];
  scope: Record<string, unknown>;
  baseGeneration: number;
  status: AiActionStatus;
  taskId: string | null;
  proposalId: string | null;
  resultRef: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  errorSummary: string | null;
};
export type AiTaskV3 = {
  id: string;
  tripId: string;
  agent: "dialogue" | "action" | "map";
  label: string;
  status: "starting" | "running" | "waiting" | "reconnecting" | "completed" | "failed" | "stopped" | "cancelled_by_generation";
  summary: string;
  startedAt: string;
  updatedAt: string;
  canStop: boolean;
  retryCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  metadata?: Record<string, unknown>;
  events: Array<{ id: number; taskId: string; tripId: string; agent: "dialogue" | "action" | "map"; status: string; kind: string; summary: string; createdAt: string }>;
};
export type MacroRouteStateV3 = RouteState & { routeId?: string; required: boolean };
export type ItineraryUpdateStateV3 = {
  macro: { status: "ready" | "needs_update" };
  detail: { status: "ready" | "needs_update"; affectedDayIds: string[] };
};
export type PlanningAdvisoryV3 = {
  id: string;
  code: string;
  severity: "info" | "warning";
  workflowStep: WorkflowStepV3;
  message: string;
  objectRefs: Array<{ type: "trip" | "place" | "candidate" | "day" | "stop"; id: string }>;
  affectedCapabilities: Array<"map" | "route" | "schedule" | "coverage" | "planning_area" | "date_alignment">;
};
export type WorkspaceV3 = {
  trip: Trip;
  resolutions: PlaceResolution[];
  routes: DayRoute[];
  proposals: AiProposal[];
  actions: AiAction[];
  routeStates: RouteState[];
  macroRouteStates: MacroRouteStateV3[];
  itineraryUpdateState: ItineraryUpdateStateV3;
  messages: Record<ConversationStage, Chat[]>;
  tasks: AiTaskV3[];
  revisions: Revision[];
  coverage: PlanningAreaCoverage[];
  advisories: PlanningAdvisoryV3[];
};
export type WorkspaceSelectionV3 = WorkspaceSelection;