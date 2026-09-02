import type {
  MacroCandidateDiscoveryOutput,
  MicroCandidateDiscoveryOutput,
  TravelPlanDocument,
} from "./contracts-v2.js";
import { semanticPlaceKey } from "./plan-commands-v2.js";
import { effectivePlanningRole } from "./planning-roles-v3.js";

export const CANDIDATE_DISCOVERY_BATCH_LIMIT = 9;
export const MICRO_DISCOVERY_AREA_BATCH_SIZE = 1;

const MARKDOWN_LINK_PATTERN = /!?\[[^\]\r\n]*\]\(\s*[^)\r\n]+\s*\)/iu;
const URL_SCHEME_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/iu;
const PROTOCOL_RELATIVE_URL_PATTERN = /(?:^|[\s("'])\/\/(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,63}(?::\d{2,5})?(?:[/?#][^\s"'<>)]*)?/iu;
const WWW_DOMAIN_PATTERN = /\bwww\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{2,5})?(?:[/?#][^\s"'<>)]*)?/iu;
const BARE_DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|edu|gov|mil|int|io|ai|co|me|tv|info|biz|app|dev|tech|travel|museum|cloud|shop|store|news|online|site|xyz|guide|hotel|blog|pro|name|mobi|aero|jobs|cat|asia|[a-z]{2})(?::\d{2,5})?(?:[/?#][^\s"'<>)]*)?\b/iu;
const SOURCE_LIST_PATTERN = /(?:来源|引用|参考(?:资料|链接)?|source(?:s)?|reference(?:s)?)\s*[:：]/iu;

export function containsForbiddenResearchLink(value: unknown) {
  const text = JSON.stringify(value);
  return MARKDOWN_LINK_PATTERN.test(text)
    || URL_SCHEME_PATTERN.test(text)
    || PROTOCOL_RELATIVE_URL_PATTERN.test(text)
    || WWW_DOMAIN_PATTERN.test(text)
    || BARE_DOMAIN_PATTERN.test(text)
    || SOURCE_LIST_PATTERN.test(text);
}

/** Compatibility name retained for callers. targetCount is now a per-request maximum. */
export type FixedAreaTargetV2 = { planningAreaCandidateId: string; targetCount: number };
export type RejectedDiscoveryCandidateV2 = { planningAreaCandidateId: string | null; name: string; reason: string };

export function buildFixedMicroDiscoveryTargets(_plan: unknown, targetIds: string[], _resolvedPlaceIds: Set<string>) {
  return [...new Set(targetIds)].map((planningAreaCandidateId) => ({ planningAreaCandidateId, targetCount: CANDIDATE_DISCOVERY_BATCH_LIMIT }));
}

export function splitMicroDiscoveryTargets(targets: FixedAreaTargetV2[]) {
  return targets.map((target) => [target]);
}

export function countCandidatesByArea(candidates: MicroCandidateDiscoveryOutput["candidates"]) {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.planningAreaCandidateId) continue;
    counts.set(candidate.planningAreaCandidateId, (counts.get(candidate.planningAreaCandidateId) ?? 0) + 1);
  }
  return counts;
}

export function validateMacroCandidateDiscovery(output: MacroCandidateDiscoveryOutput) {
  if (output.candidates.length > 80) throw new Error("单次目的地候选最多 80 个。");
  return output;
}

export function validateMicroCandidateDiscovery(output: MicroCandidateDiscoveryOutput, targetIds: string[], areaRequests: FixedAreaTargetV2[]) {
  if (containsForbiddenResearchLink(output)) throw new Error("兴趣点研究来源链接或引用列表不得写入结构化输出或持久化数据。");
  if (targetIds.length !== MICRO_DISCOVERY_AREA_BATCH_SIZE) throw new Error("每次兴趣点研究必须且只能处理 1 个目的地。");
  const expectedIds = new Set(targetIds);
  const requests = new Map(areaRequests.map((request) => [request.planningAreaCandidateId, request.targetCount]));
  if (requests.size !== expectedIds.size || [...expectedIds].some((id) => !requests.has(id))) throw new Error("兴趣点研究请求与本批目的地不一致。");

  const targets = new Map<string, number>();
  for (const target of output.areaTargets) {
    if (targets.has(target.planningAreaCandidateId)) throw new Error(`目的地覆盖目标重复：${target.planningAreaCandidateId}`);
    if (!expectedIds.has(target.planningAreaCandidateId)) throw new Error(`目的地覆盖目标超出本批范围：${target.planningAreaCandidateId}`);
    if (target.targetCount < 0 || target.targetCount > CANDIDATE_DISCOVERY_BATCH_LIMIT) throw new Error(`目的地 ${target.planningAreaCandidateId} 的 AI 建议数量必须在 0–9 之间。`);
    const max = requests.get(target.planningAreaCandidateId) ?? CANDIDATE_DISCOVERY_BATCH_LIMIT;
    if (target.targetCount > max) throw new Error(`目的地 ${target.planningAreaCandidateId} 超出本轮最多 ${max} 个的资源上限。`);
    targets.set(target.planningAreaCandidateId, target.targetCount);
  }
  if (targets.size !== expectedIds.size || [...expectedIds].some((id) => !targets.has(id))) throw new Error("AI 必须逐项返回本批目的地的实际建议数量。");
  if (output.places.length > CANDIDATE_DISCOVERY_BATCH_LIMIT || output.candidates.length > CANDIDATE_DISCOVERY_BATCH_LIMIT) throw new Error("单区域单次最多允许 9 个详细地点。");
  if (output.places.length !== output.candidates.length) throw new Error("兴趣点 Place 与 Candidate 数量必须严格一致。");

  const outputCounts = countCandidatesByArea(output.candidates);
  for (const [targetId, targetCount] of targets) {
    if ((outputCounts.get(targetId) ?? 0) !== targetCount) throw new Error(`目的地 ${targetId} 的 targetCount、Place 数量和 Candidate 数量必须一致。`);
  }
  return output;
}

export function filterCoreVisitDuplicatesV3(plan: TravelPlanDocument, output: MicroCandidateDiscoveryOutput) {
  const places = new Map(plan.places.map((place) => [place.id, place]));
  const coreKeys = new Set(plan.candidates.flatMap((candidate) => {
    const place = places.get(candidate.placeId);
    return place && effectivePlanningRole(candidate, place) === "core_visit" ? [semanticPlaceKey(place)] : [];
  }));
  if (!coreKeys.size || !output.candidates.length) return { output, skippedCoreDuplicateCount: 0 };

  const incomingPlaces = new Map(output.places.map((place) => [place.id, place]));
  const skippedPlaceIds = new Set<string>();
  for (const candidate of output.candidates) {
    const place = incomingPlaces.get(candidate.placeTemporaryId);
    if (place && coreKeys.has(semanticPlaceKey(place))) skippedPlaceIds.add(candidate.placeTemporaryId);
  }
  if (!skippedPlaceIds.size) return { output, skippedCoreDuplicateCount: 0 };

  const candidates = output.candidates.filter((candidate) => !skippedPlaceIds.has(candidate.placeTemporaryId));
  const usedPlaceIds = new Set(candidates.map((candidate) => candidate.placeTemporaryId));
  const placesAfterFilter = output.places.filter((place) => usedPlaceIds.has(place.id));
  const filtered: MicroCandidateDiscoveryOutput = {
    ...structuredClone(output),
    areaTargets: output.areaTargets.map((target) => ({ ...target, targetCount: candidates.length })),
    places: structuredClone(placesAfterFilter),
    candidates: structuredClone(candidates),
  };
  return { output: filtered, skippedCoreDuplicateCount: skippedPlaceIds.size };
}

export function discoveryShortfalls(_output: MicroCandidateDiscoveryOutput, _acceptedCandidates: MicroCandidateDiscoveryOutput["candidates"]): FixedAreaTargetV2[] {
  return [];
}

export function microTourismPlaceRejection() { return null; }
export function microTourismProviderRejection() { return null; }
