export function finalRouteMapEaseInOutCubicV3(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

// `essential: false` lets MapLibre honor the user's reduced-motion preference.
export const finalRouteMapCameraMotionV3 = {
  duration: 800,
  easing: finalRouteMapEaseInOutCubicV3,
  essential: false,
} as const;
