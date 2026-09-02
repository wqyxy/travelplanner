import { describe, expect, it } from "vitest";
import { actionBelongsToWorkflowStepV3, defaultWorkflowStepV3, latestRequiredWorkflowStepV3, requiredWorkflowStepFromResultRefV3, stageForWorkflowStepV3, workflowStepForActionTypeV3, WORKFLOW_STEPS_V3 } from "./workflow-ui-v3";
import type { WorkspaceV3 } from "./v3-types";

function workspace(): WorkspaceV3 {
  return {
    trip: { id: "trip", title: "测试", state: "active", updatedAt: "2026-09-02T00:00:00Z", planLanguage: "zh", contentGeneration: 1, plan: { schemaVersion: 2, stage: "place_selection", trip: {} as any, places: [], candidates: [], days: [], warnings: [] } },
    resolutions: [], routes: [], proposals: [], actions: [], routeStates: [], macroRouteStates: [], itineraryUpdateState: { macro: { status: "ready" }, detail: { status: "ready", affectedDayIds: [] } }, messages: { requirements: [], destinations: [], interests: [], itinerary: [] }, tasks: [], revisions: [], coverage: [],
  } as WorkspaceV3;
}

describe("Phase 6 workflow UI helpers", () => {
  it("uses the final five user-facing steps", () => {
    expect(WORKFLOW_STEPS_V3.map((item) => [item.number, item.label, item.optional ?? false])).toEqual([
      [1, "旅行需求", false],
      [2, "想去哪些地方", false],
      [3, "路线和天数", false],
      [4, "补充景点", true],
      [5, "每日行程", false],
    ]);
  });

  it("maps Backbone and Skeleton to the same destinations conversation namespace without merging their actions", () => {
    expect(stageForWorkflowStepV3("backbone")).toBe("destinations");
    expect(stageForWorkflowStepV3("skeleton")).toBe("destinations");
    expect(workflowStepForActionTypeV3("destination.generate")).toBe("backbone");
    expect(workflowStepForActionTypeV3("itinerary.generate")).toBe("skeleton");
    expect(actionBelongsToWorkflowStepV3("destination.generate", "backbone")).toBe(true);
    expect(actionBelongsToWorkflowStepV3("itinerary.generate", "backbone")).toBe(false);
    expect(actionBelongsToWorkflowStepV3("itinerary.generate", "skeleton")).toBe(true);
    expect(actionBelongsToWorkflowStepV3("itinerary.replan", "skeleton")).toBe(true);
    expect(actionBelongsToWorkflowStepV3("itinerary.detail.generate", "detail")).toBe(true);
  });

  it("opens the most useful workflow step from canonical progress", () => {
    const empty = workspace();
    expect(defaultWorkflowStepV3(empty)).toBe("requirements");
    empty.trip.plan.candidates.push({ id: "area", placeId: "city", planningAreaCandidateId: null, planningRole: "planning_area", preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] });
    expect(defaultWorkflowStepV3(empty)).toBe("backbone");
    empty.trip.plan.days.push({ id: "day", dayNumber: 1, date: null, title: "A", detailLevel: "planned", detailStatus: null, startAnchor: { id: "a", placeId: "city", label: null, notes: null }, stops: [], endAnchor: { id: "b", placeId: "city", label: null, notes: null } } as any);
    expect(defaultWorkflowStepV3(empty)).toBe("interests");
    empty.itineraryUpdateState.macro.status = "needs_update";
    expect(defaultWorkflowStepV3(empty)).toBe("skeleton");
    empty.trip.plan.days[0].detailLevel = "detailed";
    expect(defaultWorkflowStepV3(empty)).toBe("skeleton");
  });

  it("parses only supported upstream workflow navigation", () => {
    expect(requiredWorkflowStepFromResultRefV3("requiresWorkflowStep:skeleton")).toBe("skeleton");
    expect(requiredWorkflowStepFromResultRefV3("requiresWorkflowStep:backbone")).toBe("backbone");
    expect(requiredWorkflowStepFromResultRefV3("requiresStage:interests")).toBeNull();
    expect(requiredWorkflowStepFromResultRefV3("requiresWorkflowStep:detail")).toBeNull();
  });

  it("auto-navigates only for a current-generation upstream request", () => {
    const value = workspace();
    value.actions = [
      { id: "old", tripId: "trip", stage: "itinerary", actionType: "itinerary.detail.generate", executor: "ai", origin: "cta", sourceMessageId: null, parameters: {}, targetIds: [], scope: {}, baseGeneration: 0, status: "completed", taskId: null, proposalId: null, resultRef: "requiresWorkflowStep:skeleton", startedAt: null, updatedAt: "2026-09-02T01:00:00Z", completedAt: "2026-09-02T01:00:00Z", errorSummary: null },
      { id: "current", tripId: "trip", stage: "itinerary", actionType: "itinerary.detail.generate", executor: "ai", origin: "cta", sourceMessageId: null, parameters: {}, targetIds: [], scope: {}, baseGeneration: 1, status: "completed", taskId: null, proposalId: null, resultRef: "requiresWorkflowStep:interests", startedAt: null, updatedAt: "2026-09-02T02:00:00Z", completedAt: "2026-09-02T02:00:00Z", errorSummary: null },
    ];
    expect(latestRequiredWorkflowStepV3(value)).toEqual({ step: "interests", actionId: "current" });
    value.trip.contentGeneration = 2;
    expect(latestRequiredWorkflowStepV3(value)).toBeNull();
  });

  it("switches Step 2/3 UI ownership for a conversation action without executing it", () => {
    const value = workspace();
    value.actions = [{ id: "route-change", tripId: "trip", stage: "destinations", actionType: "itinerary.replan", executor: "ai", origin: "conversation", sourceMessageId: "message", parameters: {}, targetIds: [], scope: {}, baseGeneration: 1, status: "pending_confirmation", taskId: null, proposalId: null, resultRef: null, startedAt: null, updatedAt: "2026-09-02T03:00:00Z", completedAt: null, errorSummary: null }];
    expect(latestRequiredWorkflowStepV3(value)).toEqual({ step: "skeleton", actionId: "route-change" });
    expect(value.actions[0].status).toBe("pending_confirmation");
  });
});
