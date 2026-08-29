import type {
  MacroCandidateDiscoveryOutput,
  MicroCandidateDiscoveryOutput,
  Place,
  ProviderPlaceCandidate,
  TravelPlanDocument,
} from "./contracts-v2.js";

export const CANDIDATE_DISCOVERY_BATCH_LIMIT = 9;
export const MICRO_DISCOVERY_AREA_BATCH_SIZE = 1;

export type FixedAreaTargetV2 = { planningAreaCandidateId: string; targetCount: number };
export type RejectedDiscoveryCandidateV2 = { planningAreaCandidateId: string | null; name: string; reason: string };

const CORE_PROMINENCE = new Set(["iconic", "major"]);
const NON_TOURISM_NAME = /(?:游客中心|游客服务中心|旅游服务中心|旅游信息中心|信息中心|游客信息|机场|航站楼|火车站|铁路站|汽车站|客运站|公交总站|停车场|市政厅|行政中心|visitor\s+cent(?:er|re)|tourist\s+information|information\s+cent(?:er|re)|airport|aerodrome|railway\s+station|train\s+station|bus\s+station|parking(?:\s+lot)?|city\s+hall|municipal\s+(?:office|building)|hotel|hostel|motel|restaurant|cafe|café)/iu;
const GENERIC_GEOGRAPHY_NAME = /(?:^(?:lake|bay|sound|coast|island|national\s+park|regional\s+park|forest\s+park)\b|(?:国家公园|森林公园|地质公园|湿地公园|风景区|景区|湖|湖泊|海湾|海岸|峡湾|群岛|岛屿|山脉|街区|城区|产区|公园|整段步道|national\s+park|regional\s+park|forest\s+park|lake|bay|sound|coast|coastline|islands?|mountain\s+range|district|region|wine\s+region|park|trail)$)/iu;
const NON_TOURISM_PROVIDER_CATEGORIES = new Set(["aeroway", "railway", "public_transport"]);
const NON_TOURISM_PROVIDER_TYPES = new Set([
  "airport", "aerodrome", "station", "halt", "bus_station", "ferry_terminal",
  "parking", "parking_entrance", "hotel", "hostel", "motel", "guest_house",
  "information", "tourist_information", "restaurant", "cafe", "fast_food",
]);

const normalizeAdministrativeName = (value: string | null | undefined) => {
  const normalized = (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .trim();
  const withoutAdministrativeSuffix = normalized.replace(/(?:\s+(?:city|district|region|province|state)|市|区|县|省|州)$/gu, "").trim();
  return (withoutAdministrativeSuffix || normalized).replace(/[^\p{L}\p{N}]+/gu, "");
};

function administrativeNamesMatch(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizeAdministrativeName(left);
  const b = normalizeAdministrativeName(right);
  return !a || !b || a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b));
}

export function microTourismPlaceRejection(place: Place) {
  if (place.kind !== "attraction") return "兴趣点自动推荐只接受观光景点，不接受交通、住宿、餐饮或其他功能节点";
  const names = [place.nameZh, place.nameLocal, place.nameEn].filter((name): name is string => Boolean(name));
  if (names.some((name) => NON_TOURISM_NAME.test(name))) return "地点名称属于游客服务、交通、住宿、餐饮、停车或行政设施";
  if (names.some((name) => GENERIC_GEOGRAPHY_NAME.test(name.trim()))) return "地点是整片湖泊、公园、海湾、区域或其他不可导航的泛称地理实体";
  return null;
}

export function microTourismProviderRejection(
  candidate: Pick<ProviderPlaceCandidate, "category" | "placeType" | "countryCode" | "region" | "city">,
  place?: Pick<Place, "countryCode" | "region" | "city">,
) {
  const category = candidate.category?.toLocaleLowerCase() ?? "";
  const placeType = candidate.placeType?.toLocaleLowerCase() ?? "";
  if (NON_TOURISM_PROVIDER_CATEGORIES.has(category) || NON_TOURISM_PROVIDER_TYPES.has(placeType)) {
    return "公开地图将该地点识别为交通、住宿、餐饮、停车或游客服务设施";
  }
  if (place?.countryCode && candidate.countryCode && place.countryCode.toLocaleLowerCase() !== candidate.countryCode.toLocaleLowerCase()) {
    return "公开地图返回的国家与候选地点不一致";
  }
  if (place?.city && candidate.city && !administrativeNamesMatch(place.city, candidate.city)) {
    return "公开地图返回了其他城市的同名地点";
  }
  if (place?.region && candidate.region && !administrativeNamesMatch(place.region, candidate.region)) {
    return "公开地图返回了其他行政区域的同名地点";
  }
  return null;
}

export function recommendedMicroMinimum(suggestedDurationMinutes: number | null) {
  const days = suggestedDurationMinutes && suggestedDurationMinutes > 0
    ? Math.max(1, Math.ceil(suggestedDurationMinutes / 1440))
    : 1;
  if (days >= 4) return 9;
  if (days === 3) return 7;
  if (days === 2) return 5;
  return 3;
}

export function reliableMicroCounts(plan: TravelPlanDocument, resolvedPlaceIds: Set<string>) {
  const places = new Map(plan.places.map((place) => [place.id, place]));
  const counts = new Map<string, number>();
  for (const candidate of plan.candidates) {
    if (candidate.preference === "excluded" || !candidate.planningAreaCandidateId || !resolvedPlaceIds.has(candidate.placeId)) continue;
    const place = places.get(candidate.placeId);
    if (!place || microTourismPlaceRejection(place)) continue;
    counts.set(candidate.planningAreaCandidateId, (counts.get(candidate.planningAreaCandidateId) ?? 0) + 1);
  }
  return counts;
}

export function buildFixedMicroDiscoveryTargets(plan: TravelPlanDocument, targetIds: string[], resolvedPlaceIds: Set<string>) {
  const candidates = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const counts = reliableMicroCounts(plan, resolvedPlaceIds);
  return targetIds.flatMap((planningAreaCandidateId) => {
    const candidate = candidates.get(planningAreaCandidateId);
    if (!candidate) return [];
    const targetCount = Math.max(0, recommendedMicroMinimum(candidate.suggestedDurationMinutes) - (counts.get(planningAreaCandidateId) ?? 0));
    return targetCount ? [{ planningAreaCandidateId, targetCount }] : [];
  });
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

export function validateMicroCandidateDiscovery(
  output: MicroCandidateDiscoveryOutput,
  targetIds: string[],
  fixedTargets: FixedAreaTargetV2[],
) {
  if (/https?:\/\//iu.test(JSON.stringify(output))) throw new Error("兴趣点研究来源链接不得写入结构化输出或持久化数据。");
  const expectedIds = new Set(targetIds);
  const targets = new Map<string, number>();
  for (const target of output.areaTargets) {
    if (targets.has(target.planningAreaCandidateId)) throw new Error(`目的地覆盖目标重复：${target.planningAreaCandidateId}`);
    if (!expectedIds.has(target.planningAreaCandidateId)) throw new Error(`目的地覆盖目标超出本批范围：${target.planningAreaCandidateId}`);
    targets.set(target.planningAreaCandidateId, target.targetCount);
  }
  if (targets.size !== expectedIds.size || [...expectedIds].some((id) => !targets.has(id))) throw new Error("AI 返回的目的地覆盖目标与本批范围不一致。");

  const expectedTargets = new Map(fixedTargets.map((target) => [target.planningAreaCandidateId, target.targetCount]));
  if (expectedTargets.size !== targets.size) throw new Error("AI 必须逐项返回服务端指定的固定兴趣点目标。");
  for (const [targetId, targetCount] of expectedTargets) {
    if (targets.get(targetId) !== targetCount) throw new Error(`AI 不得降低固定目标：${targetId} 本轮必须返回 ${targetCount} 个。`);
  }

  const totalTarget = [...targets.values()].reduce((sum, value) => sum + value, 0);
  if (targets.size !== MICRO_DISCOVERY_AREA_BATCH_SIZE || totalTarget > CANDIDATE_DISCOVERY_BATCH_LIMIT || output.candidates.length > CANDIDATE_DISCOVERY_BATCH_LIMIT) {
    throw new Error("每次兴趣点研究必须且只能处理 1 个目的地，候选最多 9 个。");
  }

  const outputCounts = countCandidatesByArea(output.candidates);
  for (const [targetId, targetCount] of targets) {
    if ((outputCounts.get(targetId) ?? 0) !== targetCount) throw new Error(`目的地 ${targetId} 应输出 ${targetCount} 个候选地点。`);
    const areaCandidates = output.candidates.filter((candidate) => candidate.planningAreaCandidateId === targetId);
    if (areaCandidates.some((candidate) => !candidate.researchBasis.includes("multi_guide_consensus"))) {
      throw new Error(`目的地 ${targetId} 的每个兴趣点都必须包含多份攻略共识依据。`);
    }
    if (!areaCandidates.some((candidate) => CORE_PROMINENCE.has(candidate.prominence))) {
      throw new Error(`目的地 ${targetId} 至少需要一个 iconic 或 major 兴趣点。`);
    }
    const experienceCount = new Set(areaCandidates.flatMap((candidate) => candidate.experienceTypes)).size;
    const minimumExperienceCount = targetCount >= 5 ? 3 : targetCount >= 3 ? 2 : 1;
    if (experienceCount < minimumExperienceCount) {
      throw new Error(`目的地 ${targetId} 的 ${targetCount} 个兴趣点至少需要覆盖 ${minimumExperienceCount} 类体验。`);
    }
  }
  return output;
}

export function discoveryShortfalls(output: MicroCandidateDiscoveryOutput, acceptedCandidates: MicroCandidateDiscoveryOutput["candidates"]): FixedAreaTargetV2[] {
  const accepted = countCandidatesByArea(acceptedCandidates);
  return output.areaTargets.flatMap((target) => {
    const missing = Math.max(0, target.targetCount - (accepted.get(target.planningAreaCandidateId) ?? 0));
    return missing ? [{ planningAreaCandidateId: target.planningAreaCandidateId, targetCount: missing }] : [];
  });
}
