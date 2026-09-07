import { z } from "zod";

export const PlaceScoreBreakdownSchema = z.object({
  uniqueness: z.number().int().min(0).max(100),
  scenery: z.number().int().min(0).max(100),
  culture: z.number().int().min(0).max(100),
}).strict();

export type PlaceScoreBreakdown = z.infer<typeof PlaceScoreBreakdownSchema>;

export function computePlaceScore(scores: PlaceScoreBreakdown) {
  const ordered = Object.values(scores).sort((left, right) => right - left);
  const [first = 0, second = 0] = ordered;
  return Math.min(100, Math.ceil(first * 0.70 + second * 0.30));
}
