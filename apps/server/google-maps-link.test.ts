import { describe, expect, it } from "vitest";
import { GoogleMapsLinkService } from "./google-maps-link.js";

const maps = {
  reverse: async () => ({
    providerPlaceId: "n-1", name: "清水寺", displayName: "清水寺, 京都市, 京都府, 日本", latitude: 34.994856, longitude: 135.785046,
    category: "tourism", placeType: "attraction", countryCode: "jp", country: "日本", region: "京都府", city: "京都市", timezone: null,
  }),
};

describe("GoogleMapsLinkService", () => {
  it("prefers place coordinates embedded in a Maps place URL", async () => {
    const service = new GoogleMapsLinkService(maps);
    await expect(service.preview("https://www.google.com/maps/place/Kiyomizu-dera/data=!3d34.994856!4d135.785046/@34.99,135.78,15z"))
      .resolves.toMatchObject({ name: "Kiyomizu-dera", latitude: 34.994856, longitude: 135.785046, city: "京都市", countryCode: "JP" });
  });

  it("expands an allowed short link without downloading a Google page", async () => {
    let requested = "";
    const service = new GoogleMapsLinkService(maps, async (input) => {
      requested = String(input);
      return new Response(null, { status: 302, headers: { location: "https://www.google.com/maps/search/?api=1&query=34.994856%2C135.785046" } });
    });
    await expect(service.preview("https://maps.app.goo.gl/example")).resolves.toMatchObject({ latitude: 34.994856, longitude: 135.785046 });
    expect(requested).toContain("maps.app.goo.gl");
  });

  it("rejects unsafe redirects and links without a definite coordinate", async () => {
    const unsafe = new GoogleMapsLinkService(maps, async () => new Response(null, { status: 302, headers: { location: "https://example.com/redirect" } }));
    await expect(unsafe.preview("https://maps.app.goo.gl/example")).rejects.toThrow(/不受支持/);
    const service = new GoogleMapsLinkService(maps);
    await expect(service.preview("https://www.google.com/maps/search/?api=1&query=Kyoto+Station")).rejects.toThrow(/坐标/);
    await expect(service.preview("https://example.com/maps/?q=35,135")).rejects.toThrow(/Google Maps/);
  });
});
