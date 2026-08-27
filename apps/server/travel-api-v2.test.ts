import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchTravelApiV2 } from "./travel-api-v2.js";
import { TravelStoreV2 } from "./travel-store-v2.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "travel-api-v2-"));
  const store = new TravelStoreV2(path.join(root, "travel.sqlite3"));
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const runtime: any = {
    workspace: (tripId: string) => ({ trip: store.requireTrip(tripId) }),
    applyCommands: (...args: unknown[]) => { calls.push({ method: "applyCommands", args }); return { ok: true }; },
  };
  return { store, runtime, calls };
}

describe("dispatchTravelApiV2", () => {
  it("creates and reads a v2 trip workspace", async () => {
    const { store, runtime } = await fixture();
    const created = await dispatchTravelApiV2("POST", "/api/trips", new URLSearchParams(), {}, { store, runtime });
    const trip = (created!.data as any).trip;
    const workspace = await dispatchTravelApiV2("GET", `/api/trips/${trip.id}/workspace`, new URLSearchParams(), {}, { store, runtime });
    expect((workspace!.data as any).trip.plan.schemaVersion).toBe(2);
    store.close();
  });

  it("maps candidate preference to a controlled command", async () => {
    const { store, runtime, calls } = await fixture();
    const trip = store.createTrip();
    await dispatchTravelApiV2("PATCH", `/api/trips/${trip.id}/candidates/c1`, new URLSearchParams(), { expectedGeneration: 0, preference: "must_go" }, { store, runtime });
    expect(calls[0].method).toBe("applyCommands");
    expect((calls[0].args[1] as any).commands[0]).toMatchObject({ type: "set_candidate_preference", candidateId: "c1", preference: "must_go" });
    store.close();
  });
});
