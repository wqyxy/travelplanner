import { describe, expect, it } from "vitest";
import { plannerQuickActions } from "./AssistantDrawer";
import type { PlannerReply } from "./types";

const reply = (patch: Partial<PlannerReply>): PlannerReply => ({ schemaVersion: 1, operation: "reply", assistantMessage: "", baseGeneration: 3, nextAction: "none", suggestion: null, ...patch });

describe("planner quick actions", () => {
  it("exposes the four architecture-approved actions across separate replies", () => {
    const actions = [
      ...plannerQuickActions(reply({ nextAction: "start_draft" })),
      ...plannerQuickActions(reply({ nextAction: "start_detail" })),
      ...plannerQuickActions(reply({ suggestion: { id: "s1", text: "在京都多住一晚" } })),
    ];
    expect(actions.map((action) => action.label)).toEqual(["开始实施初稿", "开始细化方案", "采用", "不采用"]);
    expect(actions.map((action) => action.message)).toEqual(["开始实施初稿", "开始细化方案", "采用建议：在京都多住一晚", "不采用建议：在京都多住一晚"]);
  });

  it("prioritizes stage actions over suggestions in legacy overlapping replies", () => {
    const suggestion = { id: "duplicate-next-step", text: "下一步可发送开始细化方案" };
    expect(plannerQuickActions(reply({ nextAction: "start_draft", suggestion })).map((action) => action.label)).toEqual(["开始实施初稿"]);
    expect(plannerQuickActions(reply({ nextAction: "start_detail", suggestion })).map((action) => action.label)).toEqual(["开始细化方案"]);
  });
});
