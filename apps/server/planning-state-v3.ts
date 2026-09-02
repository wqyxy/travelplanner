export type MacroBasisStateV3 = "current" | "dirty" | "needs_confirmation";

export function deriveMacroBasisStateV3(
  macroBasisFingerprint: string | null | undefined,
  currentMacroDependencyFingerprint: string,
): MacroBasisStateV3 {
  if (!macroBasisFingerprint) return "needs_confirmation";
  return macroBasisFingerprint === currentMacroDependencyFingerprint ? "current" : "dirty";
}

export function isMacroDirtyV3(
  macroBasisFingerprint: string | null | undefined,
  currentMacroDependencyFingerprint: string,
): boolean {
  return deriveMacroBasisStateV3(macroBasisFingerprint, currentMacroDependencyFingerprint) === "dirty";
}
