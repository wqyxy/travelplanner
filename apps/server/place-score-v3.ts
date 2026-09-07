import { z } from "zod";

export const PlaceScoreBreakdownSchema = z.object({
  uniqueness: z.number().int().min(0).max(100),
  scenery: z.number().int().min(0).max(100),
  culture: z.number().int().min(0).max(100),
  experience: z.number().int().min(0).max(100),
  representativeness: z.number().int().min(0).max(100),
}).strict();

export type PlaceScoreBreakdown = z.infer<typeof PlaceScoreBreakdownSchema>;

export function computePlaceScore(scores: PlaceScoreBreakdown) {
  const ordered = Object.values(scores).sort((left, right) => right - left);
  const weights = [0.35, 0.25, 0.18, 0.12, 0.10] as const;
  const weighted = ordered.reduce((sum, value, index) => sum + value * weights[index], 0);
  const top = ordered[0] ?? 0;
  const bonus = top >= 98 ? 5 : top >= 95 ? 4 : top >= 90 ? 2 : 0;
  return Math.min(100, Math.round(weighted + bonus));
}
