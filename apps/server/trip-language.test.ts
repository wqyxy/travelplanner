import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TravelStore } from "./travel-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
describe("itinerary language preference", () => {
  it("is a non-fact trip preference and survives copying", async () => { const directory = await mkdtemp(path.join(os.tmpdir(), "travel-language-v1-")); directories.push(directory); const store = new TravelStore(path.join(directory, "travel.sqlite3")); const trip = store.createTrip(); store.setItineraryLanguage(trip.id, "en"); const copy = store.duplicate(trip.id); expect(store.requireTrip(trip.id).itineraryLanguage).toBe("en"); expect(copy.itineraryLanguage).toBe("en"); expect(copy.itinerary.trip.title).toContain("副本"); store.close(); });
});
