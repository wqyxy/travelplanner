import { describe, expect, it } from "vitest";
import { finalRouteMapCameraMotionV3, finalRouteMapEaseInOutCubicV3 } from "./final-route-map-motion-v3";

describe("final route map camera motion", () => {
  it("starts and ends at the requested camera position", () => {
    expect(finalRouteMapEaseInOutCubicV3(0)).toBe(0);
    expect(finalRouteMapEaseInOutCubicV3(1)).toBe(1);
    expect(finalRouteMapCameraMotionV3.duration).toBe(800);
    expect(finalRouteMapCameraMotionV3.essential).toBe(true);
  });

  it("accelerates into and decelerates out of the camera movement", () => {
    const samples = Array.from({ length: 21 }, (_, index) => finalRouteMapEaseInOutCubicV3(index / 20));
    samples.slice(1).forEach((value, index) => expect(value).toBeGreaterThanOrEqual(samples[index]));

    const quarter = finalRouteMapEaseInOutCubicV3(0.25);
    const halfway = finalRouteMapEaseInOutCubicV3(0.5);
    const threeQuarters = finalRouteMapEaseInOutCubicV3(0.75);
    expect(quarter).toBeLessThan(0.25);
    expect(threeQuarters).toBeGreaterThan(0.75);
    expect(halfway - quarter).toBeGreaterThan(quarter);
    expect(threeQuarters - halfway).toBeGreaterThan(1 - threeQuarters);
  });
});
