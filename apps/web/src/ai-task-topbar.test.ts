import { describe, expect, it } from "vitest";
import { getAiTaskTopbarState } from "./AiTaskTopbar";
import type { AiTask } from "./v2-types";

const task = (id: string, status: AiTask["status"], updatedAt: string): AiTask => ({
  id,
  tripId: "trip-1",
  agent: "planner",
  label: id,
  status,
  summary: id,
  startedAt: "2026-08-28T00:00:00.000Z",
  updatedAt,
  canStop: ["starting", "running", "waiting", "reconnecting"].includes(status),
  retryCount: 0,
  nextAttemptAt: null,
  lastError: null,
  events: [],
});

describe("AI task topbar state", () => {
  it("keeps an older active task selected over a newer completed task", () => {
    const state = getAiTaskTopbarState([
      task("completed", "completed", "2026-08-28T00:02:00.000Z"),
      task("running", "running", "2026-08-28T00:01:00.000Z"),
    ]);

    expect(state.selected?.id).toBe("running");
    expect(state.visible.map((item) => item.id)).toEqual(["running", "completed"]);
  });

  it("selects the most recently updated active task and counts all active tasks", () => {
    const state = getAiTaskTopbarState([
      task("waiting", "waiting", "2026-08-28T00:02:00.000Z"),
      task("running", "running", "2026-08-28T00:03:00.000Z"),
      task("completed", "completed", "2026-08-28T00:04:00.000Z"),
    ]);

    expect(state.selected?.id).toBe("running");
    expect(state.activeCount).toBe(2);
  });

  it("selects the latest terminal task when no task is active", () => {
    const state = getAiTaskTopbarState([
      task("failed", "failed", "2026-08-28T00:01:00.000Z"),
      task("completed", "completed", "2026-08-28T00:02:00.000Z"),
    ]);

    expect(state.selected?.id).toBe("completed");
    expect(state.activeCount).toBe(0);
  });

  it("keeps every active task and fills the remaining twelve slots with recent history", () => {
    const active = Array.from({ length: 3 }, (_, index) => task(`active-${index}`, "running", `2026-08-28T00:0${index}:00.000Z`));
    const history = Array.from({ length: 15 }, (_, index) => task(`history-${index}`, "completed", `2026-08-27T00:${String(index).padStart(2, "0")}:00.000Z`));
    const state = getAiTaskTopbarState([...history, ...active]);

    expect(state.visible).toHaveLength(12);
    expect(state.visible.slice(0, 3).map((item) => item.id)).toEqual(["active-2", "active-1", "active-0"]);
    expect(state.visible.slice(3).map((item) => item.id)).toEqual(history.slice(-9).reverse().map((item) => item.id));
  });

  it("does not drop active tasks when more than twelve are running", () => {
    const active = Array.from({ length: 13 }, (_, index) => task(`active-${index}`, "reconnecting", `2026-08-28T00:${String(index).padStart(2, "0")}:00.000Z`));
    const state = getAiTaskTopbarState([...active, task("completed", "completed", "2026-08-28T01:00:00.000Z")]);

    expect(state.visible).toHaveLength(13);
    expect(state.visible.every((item) => item.status === "reconnecting")).toBe(true);
    expect(state.activeCount).toBe(13);
  });

  it("falls back to the latest terminal state after the active task completes", () => {
    const running = task("current", "running", "2026-08-28T00:01:00.000Z");
    expect(getAiTaskTopbarState([running]).selected?.status).toBe("running");

    const completed = { ...running, status: "completed" as const, updatedAt: "2026-08-28T00:02:00.000Z", canStop: false };
    expect(getAiTaskTopbarState([completed]).selected?.status).toBe("completed");
  });
});
