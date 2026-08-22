import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TravelAgentOutputSchema } from "./contracts.js";
import { TravelStore } from "./travel-store.js";

const folders: string[] = [];
async function makeStore() {
  const folder = await mkdtemp(path.join(tmpdir(), "travelplanner-test-"));
  folders.push(folder);
  return new TravelStore(path.join(folder, "travel.sqlite3"));
}

const plan = (name = "京都春日漫游") => ({
  tripName: name, travelerSummary: "两位成人", pace: "舒缓", themes: ["美食", "古迹"], timezone: "Asia/Tokyo", budgetNote: "预算待确认", warnings: ["营业时间请在出发前核验"],
  days: [{ dayNumber: 1, date: "2026-04-10", title: "抵达京都", activities: [{ id: "d1-a1", startTime: "10:00", endTime: "12:00", placeName: "清水寺", activity: "参观寺院与周边街区", durationMinutes: 120, transportMode: "walk", transportMinutes: 15, costNote: "门票以现场为准" }] }], generatedBy: "codex" as const
});
const output = (name?: string) => TravelAgentOutputSchema.parse({ schemaVersion: 1, replyType: "plan_updated", assistantMessage: "已整理为可执行的第一版行程。", requirements: { destinations: [{ city: "京都", country: "日本", timezone: "Asia/Tokyo" }], dates: { durationDays: 1 }, travelers: { summary: "两位成人", adults: 2 }, budget: { note: "预算待确认" }, pace: "舒缓", themes: ["美食", "古迹"], preferences: [], assumptions: [], openQuestions: [] }, plan: plan(name), assumptions: [], verificationNotes: ["开放时间待核验"] });

afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

describe("TravelStore revisions", () => {
  it("creates an immediate version for an AI plan and restores by creating another version", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    const message = store.createUserMessage(trip.id, "安排京都一日游");
    expect(store.applyAgentOutput(trip.id, message, output()).version).toBe(1);
    const secondMessage = store.createUserMessage(trip.id, "想多安排咖啡店");
    expect(store.applyAgentOutput(trip.id, secondMessage, output("京都咖啡漫游")).version).toBe(2);
    const restored = store.restoreRevision(trip.id, 1);
    expect(restored.version).toBe(3);
    expect(restored.trip.activeRevision?.plan.tripName).toBe("京都春日漫游");
    store.close();
  });

  it("keeps the duplicated itinerary bound to the new trip's requirement revision", async () => {
    const store = await makeStore();
    const trip = store.createTrip();
    const message = store.createUserMessage(trip.id, "安排京都一日游");
    store.applyAgentOutput(trip.id, message, output());
    const duplicate = store.duplicate(trip.id);
    expect(store.getRevision(duplicate.id, 1)?.requirements.destinations[0]?.city).toBe("京都");
    store.close();
  });

  it("rejects a plan update without a complete plan before storage", () => {
    expect(() => TravelAgentOutputSchema.parse({ schemaVersion: 1, replyType: "plan_updated", assistantMessage: "没有行程", requirements: {}, assumptions: [], verificationNotes: [] })).toThrow();
  });
});
