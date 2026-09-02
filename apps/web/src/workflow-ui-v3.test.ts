import { describe, expect, it } from "vitest";
import { actionBelongsToWorkflowStepV3, defaultWorkflowStepV3, requiredWorkflowStepFromResultRefV3, WORKFLOW_STEPS_V3 } from "./workflow-ui-v3";
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

  it("separates Backbone and Skeleton while they still share the destinations conversation namespace", () => {
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
  });

  it("parses only supported upstream workflow navigation", () => {
    expect(requiredWorkflowStepFromResultRefV3("requiresWorkflowStep:skeleton")).toBe("skeleton");
    expect(requiredWorkflowStepFromResultRefV3("requiresWorkflowStep:backbone")).toBe("backbone");
    expect(requiredWorkflowStepFromResultRefV3("requiresStage:interests")).toBeNull();
    expect(requiredWorkflowStepFromResultRefV3("requiresWorkflowStep:detail")).toBeNull();
  });
});
