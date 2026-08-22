import { describe, expect, it } from "vitest";
import { applyMapPatch } from "./map-patch-reducer";
import type { MapSnapshot } from "./types";

const snapshot = (): MapSnapshot => ({ itineraryVersion: 1, mapVersion: 1, sequence: 3, scope: "all", dayNumber: null, status: "analyzing", summary: "", warnings: [], entities: [], places: [], visits: [], routes: [], dayPaths: [] });

describe("applyMapPatch", () => {
  it("merges v4 place/visit updates without losing prior patches", () => {
    const first = applyMapPatch(snapshot(), { tripId: "t", itineraryVersion: 1, mapVersion: 1, sequence: 4, places: { upsert: [{ id: "p1", displayName: "歌剧院", kind: "attraction", query: "", city: "悉尼", status: "pending", location: null }], remove: [] }, visits: { upsert: [{ id: "v1", placeId: "p1", dayNumber: 1, order: 1 }], remove: [] }, routes: { upsert: [], remove: [] } });
    const next = applyMapPatch(first, { tripId: "t", itineraryVersion: 1, mapVersion: 1, sequence: 5, places: { upsert: [{ id: "p2", displayName: "海港大桥", kind: "attraction", query: "", city: "悉尼", status: "pending", location: null }], remove: [] }, routes: { upsert: [], remove: [] } });
    expect(next?.places?.map((place) => place.id)).toEqual(["p1", "p2"]);
    expect(next?.visits?.[0]?.placeId).toBe("p1");
  });

  it("requests a snapshot after a sequence gap", () => {
    expect(applyMapPatch(snapshot(), { tripId: "t", itineraryVersion: 1, mapVersion: 1, sequence: 5, routes: { upsert: [], remove: [] } })).toBeNull();
  });

  it("upserts one day path without dropping earlier days", () => {
    const current = { ...snapshot(), dayPaths: [{ dayNumber: 1, entityIds: ["p1"], startEntityId: "p1", endEntityId: "p1", overnightEntityId: "p1" }] };
    const next = applyMapPatch(current, { tripId: "t", itineraryVersion: 1, mapVersion: 1, sequence: 4, routes: { upsert: [], remove: [] }, dayPaths: [{ dayNumber: 2, entityIds: ["p2"], startEntityId: "p2", endEntityId: "p2", overnightEntityId: "p2" }] });
    expect(next?.dayPaths.map((path) => path.dayNumber)).toEqual([1, 2]);
  });
});
