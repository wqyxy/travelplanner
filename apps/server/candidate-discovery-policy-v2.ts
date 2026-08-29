import type {
  MacroCandidateDiscoveryOutput,
  MicroCandidateDiscoveryOutput,
} from "./contracts-v2.js";

export const CANDIDATE_DISCOVERY_BATCH_LIMIT = 9;
export const MICRO_DISCOVERY_AREA_BATCH_SIZE = 1;

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
  if (/https?:\/\//iu.test(JSON.stringify(output))) throw new Error("兴趣点研究来源链接不得写入结构化输出或持久化数据。");
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

export function discoveryShortfalls(_output: MicroCandidateDiscoveryOutput, _acceptedCandidates: MicroCandidateDiscoveryOutput["candidates"]): FixedAreaTargetV2[] {
  return [];
}

export function microTourismPlaceRejection() { return null; }
export function microTourismProviderRejection() { return null; }
