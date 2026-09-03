import { describe, expect, it } from "vitest";
import { actionBelongsToWorkflowStepV3, conversationRouteForWorkflowStepV3, defaultWorkflowStepV3, latestRequiredWorkflowStepV3, requiredWorkflowStepFromResultRefV3, stageForWorkflowStepV3, workflowStepForActionTypeV3, WORKFLOW_STEPS_V3 } from "./workflow-ui-v3";
import type { WorkspaceV3 } from "./v3-types";

function workspace(): WorkspaceV3 {
  return {
    trip: { id: "trip", title: "测试", state: "active", updatedAt: "2026-09-02T00:00:00Z", planLanguage: "zh", contentGeneration: 1, plan: { schemaVersion: 2, stage: "place_selection", trip: {} as any, places: [], candidates: [], days: [], warnings: [] } },
    resolutions: [], routes: [], proposals: [], actions: [], routeStates: [], macroRouteStates: [], itineraryUpdateState: { macro: { status: "ready" }, detail: { status: "ready", affectedDayIds: [] } }, messages: { requirements: [], destinations: [], interests: [], itinerary: [] }, tasks: [], revisions: [], coverage: [],
  } as WorkspaceV3;
}

function workspaceWithDetailCandidate() {
  const value = workspace();
  value.trip.plan.places = [
    { id: "area-place", nameZh: "蒂阿瑙", nameLocal: null, nameEn: "Te Anau", kind: "city", city: "Te Anau", region: null, country: "New Zealand", countryCode: "NZ", approximate: false },
    { id: "detail-place", nameZh: "萤火虫洞", nameLocal: null, nameEn: "Glowworm Caves", kind: "attraction", city: "Te Anau", region: null, country: "New Zealand", countryCode: "NZ", approximate: false },
  ];
  value.trip.plan.candidates = [
    { id: "area", placeId: "area-place", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
    { id: "detail", placeId: "detail-place", planningAreaCandidateId: "area", planningRole: "detail_interest", preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: 90, tags: [] },
  ];
  value.trip.plan.days = [{ id: "day", dayNumber: 1, date: null, title: "蒂阿瑙", detailLevel: "detailed", detailStatus: "ready", startAnchor: { id: "a", placeId: "area-place", label: null, notes: null }, stops: [{ id: "stop", candidateId: "detail", placeId: "detail-place", activity: "游览", period: null, startTime: "10:00", endTime: "11:30", durationMinutes: 90, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }], endAnchor: { id: "b", placeId: "area-place", label: null, notes: null } } as any];
  return value;
}

function workspaceWithMacroAreas() {
  const value = workspace();
  value.trip.plan.places = [
    { id: "queenstown-place", nameZh: "皇后镇", nameLocal: "Queenstown", nameEn: "Queenstown", kind: "city", city: "Queenstown", region: null, country: "New Zealand", countryCode: "NZ", approximate: false },
    { id: "wanaka-place", nameZh: "瓦纳卡", nameLocal: "Wānaka", nameEn: "Wanaka", kind: "city", city: "Wanaka", region: null, country: "New Zealand", countryCode: "NZ", approximate: false },
  ];
  value.trip.plan.candidates = [
    { id: "queenstown", placeId: "queenstown-place", planningAreaCandidateId: null, planningRole: "planning_area", preference: "want_to_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
    { id: "wanaka", placeId: "wanaka-place", planningAreaCandidateId: null, planningRole: "planning_area", preference: "optional", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
  ];
  return value;
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

  it("routes explicit Detail-to-Core intent from Step 4 to the Step 2 conversation while preserving the candidate", () => {
    const value = workspaceWithDetailCandidate();
    expect(conversationRouteForWorkflowStepV3(value, "interests", { type: "candidate", id: "detail" }, "这个地方很重要，要单独留一天")).toEqual({
      stage: "destinations",
      selection: { type: "candidate", id: "detail" },
    });
  });

  it("routes the same promotion intent from a Step 5 stop to its candidate, but leaves normal detail chat in Step 5", () => {
    const value = workspaceWithDetailCandidate();
    expect(conversationRouteForWorkflowStepV3(value, "detail", { type: "stop", id: "stop" }, "把这里提升为重要游览地")).toEqual({
      stage: "destinations",
      selection: { type: "candidate", id: "detail" },
    });
    expect(conversationRouteForWorkflowStepV3(value, "detail", { type: "stop", id: "stop" }, "今天晚一点出发")).toEqual({
      stage: "itinerary",
      selection: { type: "stop", id: "stop" },
    });
  });

  it("routes an explicit Step 5 planning-area day change back to the Step 3 conversation", () => {
    const value = workspaceWithMacroAreas();
    expect(conversationRouteForWorkflowStepV3(value, "detail", { type: "trip", id: null }, "我想把瓦纳卡多留一天，皇后镇少一天，总天数仍然保持20天。")).toEqual({
      stage: "destinations",
      selection: { type: "trip", id: null },
    });
  });

  it("does not route ordinary detailed-itinerary discussion just because a planning area and day count are mentioned", () => {
    const value = workspaceWithMacroAreas();
    expect(conversationRouteForWorkflowStepV3(value, "detail", { type: "trip", id: null }, "皇后镇住两天的话，每天怎么玩比较合适？")).toEqual({
      stage: "itinerary",
      selection: { type: "trip", id: null },
    });
  });
});
