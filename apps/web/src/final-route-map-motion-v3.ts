export function finalRouteMapEaseInOutCubicV3(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

// Map motion is an explicit workspace interaction, so it must not collapse to a jump.
export const finalRouteMapCameraMotionV3 = {
  duration: 800,
  easing: finalRouteMapEaseInOutCubicV3,
  essential: true,
} as const;
