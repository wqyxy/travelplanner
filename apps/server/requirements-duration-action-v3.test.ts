import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiActionRecordSchema } from "./ai-stage-contracts-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function databasePath() {
  const root = mkdtempSync(path.join(tmpdir(), "requirements-duration-action-v3-"));
  roots.push(root);
  return path.join(root, "travel.sqlite3");
}

describe("requirements duration normalization at the shared Action boundary", () => {
  it("adds requestedDurationDays for a conversation requirements.update that only carries brief.duration", () => {
    const store = new TravelStoreV3(databasePath());
    try {
      const trip = store.createTrip();
      const messageId = store.createUserMessage(trip.id, "requirements", "旅行时长仍然是20天。");
      const action = AiActionRecordSchema.parse({
        id: "requirements-duration-action",
        tripId: trip.id,
        stage: "requirements",
        actionType: "requirements.update",
        executor: "deterministic",
        origin: "conversation",
        sourceMessageId: messageId,
        parameters: {
          request: null,
          candidateId: null,
          candidateIds: [],
          preference: null,
          dayId: null,
          dayIds: [],
          stopId: null,
          targetDayId: null,
          targetIndex: null,
          index: null,
          anchor: null,
          placeId: null,
          label: null,
          notes: null,
          activity: null,
          fields: [],
          changes: { brief: { duration: "20天" } },
          placeChanges: null,
          candidateChanges: null,
          allowWeb: null,
        },
        targetIds: [],
        scope: { type: "trip", id: null },
        baseGeneration: trip.contentGeneration,
        status: "pending_confirmation",
        taskId: null,
        proposalId: null,
        resultRef: null,
        startedAt: null,
        updatedAt: new Date().toISOString(),
        completedAt: null,
        errorSummary: null,
      });

      const created = store.createAction(action).action;
      expect(created.parameters).toEqual({
        changes: {
          brief: { duration: "20天" },
          dates: { start: null, end: null, requestedDurationDays: 20 },
        },
      });
    } finally {
      store.close();
    }
  });
});
