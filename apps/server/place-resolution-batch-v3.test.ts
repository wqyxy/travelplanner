import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyTravelPlan, type Place } from "./contracts-v2.js";
import type { MapCandidate } from "./map-service.js";
import { PLACE_RESOLUTION_BATCH_CONCURRENCY, PlaceResolverV2 } from "./place-resolver-v2.js";
import { TravelStoreV2 } from "./travel-store-v2.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function seededStore(names: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), "place-resolution-batch-v3-"));
  roots.push(root);
  const store = new TravelStoreV2(path.join(root, "travel.sqlite3"));
  const created = store.createTrip();
  const plan = emptyTravelPlan();
  names.forEach((name, index) => {
    const place: Place = {
      id: `place-${index + 1}`,
      nameZh: name,
      nameLocal: null,
      nameEn: name,
      kind: "city",
      city: name,
      region: null,
      country: "Testland",
      countryCode: "TT",
      approximate: false,
    };
    plan.places.push(place);
    plan.candidates.push({ id: `candidate-${index + 1}`, placeId: place.id, planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: null, aiScore: 80, suggestedDurationMinutes: 1440, tags: [] });
  });
  const written = store.writePlan(created.id, plan, 0, { source: "test", summary: "batch resolution fixture" });
  return { store, tripId: created.id, generation: written.generation };
}

function exactCandidate(name: string, index = 0): MapCandidate {
  return {
    providerPlaceId: `provider-${name}-${index}`,
    name,
    displayName: `${name}, Testland`,
    latitude: 40 + index,
    longitude: 170 + index,
    category: "place",
    placeType: "city",
    countryCode: "tt",
    region: null,
    city: name,
    timezone: null,
  };
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitFor(check: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error("condition timeout");
}

describe("PlaceResolverV2 cooperative batches", () => {
  it("uses three Place workers while leaving Provider throttling to MapService", async () => {
    const { store, tripId, generation } = seededStore(["One", "Two", "Three", "Four"]);
    let active = 0;
    let maxActive = 0;
    const resolver = new PlaceResolverV2({
      store,
      maps: {
        search: async (query: string) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await sleep(20);
            const name = query.split(",", 1)[0].trim();
            return [exactCandidate(name)];
          } finally {
            active -= 1;
          }
        },
        reverse: async () => null,
      },
    });
    const progress: Array<{ placeId: string; status: string; completed: number; total: number }> = [];
    const result = await resolver.resolveMany(tripId, ["place-1", "place-2", "place-3", "place-4"], generation, undefined, (event) => progress.push(event));

    expect(PLACE_RESOLUTION_BATCH_CONCURRENCY).toBe(3);
    expect(maxActive).toBe(3);
    expect(result).toHaveLength(4);
    expect(result.every((item) => item.resolution.status === "resolved")).toBe(true);
    for (const placeId of ["place-1", "place-2", "place-3", "place-4"]) {
      expect(progress.filter((event) => event.placeId === placeId).map((event) => event.status)).toEqual(["resolving", "resolved"]);
    }
    expect(progress.at(-1)).toMatchObject({ completed: 4, total: 4 });
    store.close();
  });

  it("does not let one slow AI ambiguity block easier Places behind it", async () => {
    const { store, tripId, generation } = seededStore(["Ambiguous", "Easy Two", "Easy Three"]);
    let releaseAssist!: () => void;
    const assistGate = new Promise<void>((resolve) => { releaseAssist = resolve; });
    let assistStarted!: () => void;
    const assistStartedPromise = new Promise<void>((resolve) => { assistStarted = resolve; });
    const progress: Array<{ placeId: string; status: string }> = [];
    const resolver = new PlaceResolverV2({
      store,
      maps: {
        search: async (query: string) => {
          await sleep(5);
          const name = query.split(",", 1)[0].trim();
          if (name === "Ambiguous") {
            return [
              { ...exactCandidate("Ambiguous Central", 1), city: "Ambiguous" },
              { ...exactCandidate("Ambiguous District", 2), city: "Ambiguous" },
            ];
          }
          return [exactCandidate(name)];
        },
        reverse: async () => null,
      },
      assist: async ({ candidates }) => {
        assistStarted();
        await assistGate;
        return { schemaVersion: 1, action: "choose_candidate", providerPlaceId: candidates[0].providerPlaceId, searchHints: [], reason: "选择第一项。" };
      },
    });

    const batch = resolver.resolveMany(tripId, ["place-1", "place-2", "place-3"], generation, undefined, (event) => progress.push({ placeId: event.placeId, status: event.status }));
    await assistStartedPromise;
    await waitFor(() => progress.some((event) => event.placeId === "place-2" && event.status === "resolved") && progress.some((event) => event.placeId === "place-3" && event.status === "resolved"));
    expect(progress.some((event) => event.placeId === "place-1" && event.status === "resolved")).toBe(false);
    releaseAssist();
    const result = await batch;
    expect(result.every((item) => item.resolution.status === "resolved")).toBe(true);
    store.close();
  });
});
