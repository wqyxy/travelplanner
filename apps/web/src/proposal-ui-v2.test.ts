import { describe, expect, it } from "vitest";
import { proposalActionPath, proposalCreateBody, proposalCreatePath, proposalScopeOptions, proposalUiState } from "./proposal-ui-v2";
import type { AiProposal, Workspace } from "./v2-types";

const workspace = {
  trip: {
    id: "trip-1", title: "关西旅行", contentGeneration: 4,
    plan: {
      candidates: [{ id: "candidate-1", placeId: "place-1" }],
      places: [{ id: "place-1", nameZh: "清水寺" }],
      days: [{ id: "day-1", dayNumber: 1, title: "京都", stops: [{ id: "stop-1", placeId: "place-1" }] }],
    },
  },
} as unknown as Workspace;

const proposal = (overrides: Partial<AiProposal> = {}): AiProposal => ({
  id: "proposal-1", tripId: "trip-1", baseGeneration: 4,
  scope: { type: "day", id: "day-1" }, status: "pending",
  title: "放松 DAY 1", explanation: "减少跨区移动", commands: [],
  diff: { summary: "调整两项", commandSummaries: [], affectedCandidateIds: [], affectedPlaceIds: [], affectedDayIds: ["day-1"] },
  createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z", appliedRevisionVersion: null,
  ...overrides,
});

describe("proposal scope options", () => {
  it("offers Candidate and Place scopes for a selected Candidate", () => {
    const options = proposalScopeOptions(workspace, { type: "candidate", id: "candidate-1" });
    expect(options.map((item) => item.scope.type)).toEqual(["candidate", "place", "candidate_pool", "trip"]);
  });

  it("maps a selected Stop to its Day and Place scopes", () => {
    const options = proposalScopeOptions(workspace, { type: "stop", id: "stop-1" });
    expect(options.map((item) => item.scope.type)).toEqual(["day", "place", "candidate_pool", "trip"]);
  });
});

describe("proposal action availability", () => {
  it("allows Apply and Reject only for a current pending Proposal", () => {
    expect(proposalUiState(proposal(), 4).actions).toEqual(["apply", "reject"]);
    expect(proposalUiState(proposal(), 5)).toMatchObject({ effectiveStatus: "expired", actions: [] });
  });

  it("allows Undo only while the applied generation is still current", () => {
    const applied = proposal({ status: "applied", appliedRevisionVersion: 6 });
    expect(proposalUiState(applied, 5).actions).toEqual(["undo"]);
    expect(proposalUiState(applied, 6).actions).toEqual([]);
  });

  it("never exposes actions for terminal Proposal states", () => {
    for (const status of ["rejected", "superseded", "undone"] as const) {
      expect(proposalUiState(proposal({ status }), 4).actions).toEqual([]);
    }
  });
});


describe("proposal API isolation", () => {
  it("builds only Proposal state-machine endpoints", () => {
    expect(proposalCreatePath("trip/1")).toBe("/api/trips/trip%2F1/proposals");
    for (const action of ["apply", "reject", "undo"] as const) {
      const path = proposalActionPath("trip/1", "proposal/1", action);
      expect(path).toContain("/proposals/");
      expect(path).not.toContain("/commands");
    }
  });

  it("trims the adjustment request and preserves the explicit Scope", () => {
    expect(proposalCreateBody("  放松一点  ", { type: "day", id: "day-1" })).toEqual({ message: "放松一点", scope: { type: "day", id: "day-1" } });
    expect(() => proposalCreateBody("   ", { type: "trip", id: null })).toThrow();
  });
});
