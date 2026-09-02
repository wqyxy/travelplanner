import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiActionRecordSchema } from "./ai-stage-contracts-v3.js";
import { confirmDetailToCorePromotionV3 } from "./core-promotion-v3.js";
import { emptyTravelPlan, TravelPlanDocumentSchema } from "./contracts-v2.js";
import { derivePlanMacroBasisStateV3, computeMacroDependencyFingerprintV3 } from "./planning-state-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function store() {
  const root = mkdtempSync(path.join(tmpdir(), "core-promotion-v3-"));
  roots.push(root);
  return new TravelStoreV3(path.join(root, "travel.sqlite3"));
}

function currentPlan() {
  const base = emptyTravelPlan();
  const prepared = TravelPlanDocumentSchema.parse({
    ...base,
    stage: "itinerary_refinement",
    trip: { ...base.trip, dates: { start: null, end: null, requestedDurationDays: 1 } },
    places: [
      { id: "area-place", nameZh: "蒂阿瑙", nameLocal: null, nameEn: "Te Anau", kind: "city", city: "Te Anau", region: null, country: "New Zealand", countryCode: "NZ", approximate: false },
      { id: "detail-place", nameZh: "萤火虫洞", nameLocal: null, nameEn: "Glowworm Caves", kind: "attraction", city: "Te Anau", region: null, country: "New Zealand", countryCode: "NZ", approximate: false },
    ],
    candidates: [
      { id: "area", placeId: "area-place", planningAreaCandidateId: null, planningRole: "planning_area", preference: "must_go", source: "user", aiReason: null, aiScore: null, suggestedDurationMinutes: null, tags: [] },
      { id: "detail", placeId: "detail-place", planningAreaCandidateId: "area", planningRole: "detail_interest", preference: "must_go", source: "user", aiReason: "想去", aiScore: null, suggestedDurationMinutes: 90, tags: [] },
    ],
    days: [{
      id: "day-1", dayNumber: 1, date: null, title: "蒂阿瑙", stayBlockId: "block-area", transferMode: "none", detailLevel: "detailed", detailStatus: "ready",
      startAnchor: { id: "start-1", placeId: "area-place", label: null, notes: null },
      stops: [{ id: "stop-1", candidateId: "detail", placeId: "detail-place", activity: "游览萤火虫洞", period: "morning", startTime: "09:00", endTime: "10:30", durationMinutes: 90, transportFromPrevious: null, scheduleVerification: { status: "estimated", checkedAt: null }, costNote: null, costVerification: null, notes: null }],
      endAnchor: { id: "end-1", placeId: "area-place", label: null, notes: null },
    }],
  });
  return TravelPlanDocumentSchema.parse({
    ...prepared,
    planningState: { macroBasisVersion: 1, macroBasisFingerprint: computeMacroDependencyFingerprintV3(prepared) },
  });
}

function conversationParameters(request: "promote_to_core" | null) {
  return {
    request,
    candidateId: "detail",
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
    changes: null,
    placeChanges: null,
    candidateChanges: { suggestedDurationMinutes: 480, aiReason: "重要游览地，预留一天" },
    allowWeb: null,
  };
}

function action(tripId: string, baseGeneration: number, origin: "conversation" | "cta" = "conversation", request: "promote_to_core" | null = "promote_to_core") {
  return AiActionRecordSchema.parse({
    id: `${origin}-${request ?? "ordinary"}`, tripId, stage: "destinations", actionType: "destination.edit", executor: "deterministic", origin,
    sourceMessageId: origin === "conversation" ? "message-1" : null,
    parameters: origin === "conversation"
      ? conversationParameters(request)
      : { candidateId: "detail", request: "promote_to_core", candidateChanges: { suggestedDurationMinutes: 480, aiReason: "重要游览地，预留一天" } },
    targetIds: ["detail"], scope: { type: "candidate_pool", id: null }, baseGeneration, status: "pending_confirmation",
    taskId: null, proposalId: null, resultRef: null, startedAt: null, updatedAt: "2026-09-03T00:00:00.000Z", completedAt: null, errorSummary: null,
  });
}

describe("controlled Detail to Core promotion", () => {
  it("keeps the candidate unchanged until confirmation, then promotes it while preserving parent and invalidating only dependent planning", () => {
    const db = store();
    const trip = db.createTrip();
    db.writePlan(trip.id, currentPlan(), 0, { source: "test", summary: "fixture" });
    const before = db.requireTrip(trip.id);
    expect(derivePlanMacroBasisStateV3(before.plan)).toBe("current");
    db.createAction(action(trip.id, before.contentGeneration));
    expect(db.requireTrip(trip.id).plan.candidates.find((candidate) => candidate.id === "detail")?.planningRole).toBe("detail_interest");

    const result = confirmDetailToCorePromotionV3(db, trip.id, "conversation-promote_to_core", { expectedGeneration: before.contentGeneration });
    expect(result?.action.status).toBe("completed");
    const after = db.requireTrip(trip.id);
    const promoted = after.plan.candidates.find((candidate) => candidate.id === "detail");
    expect(promoted).toMatchObject({ planningRole: "core_visit", planningAreaCandidateId: "area", suggestedDurationMinutes: 480 });
    expect(derivePlanMacroBasisStateV3(after.plan)).toBe("dirty");
    expect(after.plan.days[0]).toMatchObject({ id: "day-1", stayBlockId: "block-area", detailLevel: "detailed", detailStatus: "needs_review" });
    expect(after.plan.days[0].stops[0].id).toBe("stop-1");
    db.close();
  });

  it("does not treat an ordinary destination edit as a Core promotion without the explicit sentinel", () => {
    const db = store();
    const trip = db.createTrip();
    db.writePlan(trip.id, currentPlan(), 0, { source: "test", summary: "fixture" });
    const current = db.requireTrip(trip.id);
    db.createAction(action(trip.id, current.contentGeneration, "conversation", null));
    expect(confirmDetailToCorePromotionV3(db, trip.id, "conversation-ordinary", { expectedGeneration: current.contentGeneration })).toBeNull();
    expect(db.requireTrip(trip.id).plan.candidates.find((candidate) => candidate.id === "detail")?.planningRole).toBe("detail_interest");
    db.close();
  });

  it("does not expose the promotion shortcut to CTA-origin destination.edit actions even with the sentinel", () => {
    const db = store();
    const trip = db.createTrip();
    db.writePlan(trip.id, currentPlan(), 0, { source: "test", summary: "fixture" });
    const current = db.requireTrip(trip.id);
    db.createAction(action(trip.id, current.contentGeneration, "cta"));
    expect(confirmDetailToCorePromotionV3(db, trip.id, "cta-promote_to_core", { expectedGeneration: current.contentGeneration })).toBeNull();
    expect(db.requireTrip(trip.id).plan.candidates.find((candidate) => candidate.id === "detail")?.planningRole).toBe("detail_interest");
    db.close();
  });
});