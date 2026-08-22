import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TravelStore } from "./travel-store.js";

describe("per-trip itinerary language", () => {
  it("defaults to bilingual, persists independently, and is copied with the trip", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "travel-language-test-"));
    const store = new TravelStore(path.join(folder, "travel.sqlite3"));
    try {
      const first = store.createTrip();
      const second = store.createTrip();
      expect(first.itineraryLanguage).toBe("bilingual");
      expect(store.setItineraryLanguage(first.id, "en").itineraryLanguage).toBe("en");
      expect(store.requireTrip(second.id).itineraryLanguage).toBe("bilingual");
      expect(store.duplicate(first.id).itineraryLanguage).toBe("en");
    } finally {
      store.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
