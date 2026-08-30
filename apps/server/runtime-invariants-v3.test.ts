import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AiActionRecord } from "./ai-stage-contracts-v3.js";
import { installRuntimeInvariantsV3 } from "./runtime-invariants-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const roots: string[] = [];
function databasePath() {
  const root = mkdtempSync(path.join(tmpdir(), "travel-runtime-invariants-v3-"));
  roots.push(root);
  return path.join(root, "travel-v2.sqlite3");
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function pendingDeterministicAction(tripId: string, sourceMessageId: string, generation: number): AiActionRecord {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(), tripId, stage: "requirements", actionType: "requirements.update", executor: "deterministic", origin: "conversation", sourceMessageId,
    parameters: { changes: { pace: "relaxed" } }, targetIds: [], scope: { type: "trip", id: null }, baseGeneration: generation,
    status: "pending_confirmation", taskId: null, proposalId: null, resultRef: null, startedAt: null, updatedAt: timestamp, completedAt: null, errorSummary: null,
  };
}

describe("V3 runtime database invariants", () => {
  it("invalidates stage threads when canonical generation changes", () => {
    const filename = databasePath();
    const bootstrap = new TravelStoreV3(filename);
    const trip = bootstrap.createTrip();
    bootstrap.close();
    installRuntimeInvariantsV3(filename);

    const store = new TravelStoreV3(filename);
    store.setStageThread({ tripId: trip.id, stage: "requirements", threadId: "thread-old", promptHash: "hash", promptVersion: "v1", contextGeneration: 0, turnCount: 3 });
    const next = structuredClone(trip.plan);
    next.trip.pace = "relaxed";
    store.writePlan(trip.id, next, 0, { source: "test", summary: "change generation" });
    expect(store.getStageThread(trip.id, "requirements")).toBeNull();
    store.close();
  });

  it("normalizes a successful deterministic Action to applied", () => {
    const filename = databasePath();
    const bootstrap = new TravelStoreV3(filename);
    const trip = bootstrap.createTrip();
    bootstrap.close();
    installRuntimeInvariantsV3(filename);

    const store = new TravelStoreV3(filename);
    const messageId = store.createUserMessage(trip.id, "requirements", "节奏改轻松");
    store.updateTurn(messageId, "completed");
    const action = store.createAction(pendingDeterministicAction(trip.id, messageId, 0)).action;
    expect(store.claimActionForExecution(action.id, 0).claimed).toBe(true);
    expect(store.completeAction(action.id, "generation:1")?.status).toBe("applied");
    store.close();
  });
});
