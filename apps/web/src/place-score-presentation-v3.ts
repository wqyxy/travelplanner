export const PLACE_SCORE_TAG_PREFIX_V3 = "__place_score:";

export const placeScoreLabelsV3 = {
  uniqueness: "独特性",
  scenery: "风景",
  culture: "人文",
} as const;

export type PlaceScoreKeyV3 = keyof typeof placeScoreLabelsV3;
export type PlaceScoreBreakdownV3 = Record<PlaceScoreKeyV3, number>;

const scoreKeys = Object.keys(placeScoreLabelsV3) as PlaceScoreKeyV3[];

export function placeScoreBreakdownFromTagsV3(tags: string[]): PlaceScoreBreakdownV3 | null {
  const values = new Map<PlaceScoreKeyV3, number>();
  for (const tag of tags) {
    if (!tag.startsWith(PLACE_SCORE_TAG_PREFIX_V3)) continue;
    const [rawKey, rawValue] = tag.slice(PLACE_SCORE_TAG_PREFIX_V3.length).split("=");
    if (!scoreKeys.includes(rawKey as PlaceScoreKeyV3)) continue;
    const value = Number(rawValue);
    if (Number.isInteger(value) && value >= 0 && value <= 100) values.set(rawKey as PlaceScoreKeyV3, value);
  }
  if (!scoreKeys.every((key) => values.has(key))) return null;
  return Object.fromEntries(scoreKeys.map((key) => [key, values.get(key)!])) as PlaceScoreBreakdownV3;
}

export function placeScoreTooltipV3(tags: string[]) {
  const scores = placeScoreBreakdownFromTagsV3(tags);
  return scores ? scoreKeys.map((key) => `${placeScoreLabelsV3[key]}：${scores[key]}`).join("\n") : null;
}
