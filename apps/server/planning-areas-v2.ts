export type PlanningCandidatePreference = "must_go" | "want_to_go" | "optional" | "excluded";

export type PlanningAreaPlace = {
  id: string;
  nameZh: string;
  nameLocal: string | null;
  nameEn: string | null;
  kind: string;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
};

export type PlanningAreaCandidate = {
  id: string;
  placeId: string;
  preference: PlanningCandidatePreference;
};

export type PlanningAreaPlan = {
  places: PlanningAreaPlace[];
  candidates: PlanningAreaCandidate[];
};

const normalizeAreaText = (value: string | null | undefined) => (value ?? "")
  .normalize("NFKC")
  .trim()
  .toLocaleLowerCase()
  .replace(/[\p{P}\p{S}\s]+/gu, "");

const preferenceRank: Record<PlanningCandidatePreference, number> = {
  must_go: 0,
  want_to_go: 1,
  optional: 2,
  excluded: 3,
};

export type PlanningAreaV2 = {
  key: string;
  label: string;
  cityPlaceId: string | null;
  cityCandidateId: string | null;
  candidateIds: string[];
  childCandidateIds: string[];
  participatingCandidateIds: string[];
  suppressedCandidateIds: string[];
  effectivePreference: PlanningCandidatePreference;
};

export type PlanningAreaContextV2 = {
  areas: PlanningAreaV2[];
  areaKeyByCandidateId: Map<string, string>;
  participatingCandidateIds: Set<string>;
  suppressedCandidateIds: Set<string>;
  cityCandidateIds: Set<string>;
  conflicts: string[];
};

type AreaIdentity = { key: string; label: string; cityPlaceId: string | null };

function cityAliases(place: PlanningAreaPlace) {
  return [place.nameZh, place.nameLocal, place.nameEn, place.city]
    .map(normalizeAreaText)
    .filter(Boolean);
}

function uniqueCityAliases(places: PlanningAreaPlace[]) {
  const candidates = new Map<string, Set<string>>();
  for (const place of places) {
    if (place.kind !== "city") continue;
    for (const alias of cityAliases(place)) {
      const ids = candidates.get(alias) ?? new Set<string>();
      ids.add(place.id);
      candidates.set(alias, ids);
    }
  }
  const result = new Map<string, string>();
  for (const [alias, ids] of candidates) {
    if (ids.size === 1) result.set(alias, [...ids][0]);
  }
  return result;
}

function areaIdentity(place: PlanningAreaPlace, placesById: Map<string, PlanningAreaPlace>, cityByAlias: Map<string, string>): AreaIdentity {
  if (place.kind === "city") return { key: `city:${place.id}`, label: place.nameZh, cityPlaceId: place.id };

  const city = normalizeAreaText(place.city);
  const country = normalizeAreaText(place.countryCode ?? place.country);
  const matchedCityId = city ? cityByAlias.get(city) ?? null : null;
  if (matchedCityId) {
    const matched = placesById.get(matchedCityId);
    return { key: `city:${matchedCityId}`, label: matched?.nameZh ?? place.city ?? "城市", cityPlaceId: matchedCityId };
  }
  if (city) return { key: `city-name:${country}:${city}`, label: place.city ?? "城市", cityPlaceId: null };

  const region = normalizeAreaText(place.region);
  if (region) return { key: `region:${country}:${region}`, label: place.region ?? "区域", cityPlaceId: null };
  if (country) return { key: `country:${country}`, label: place.country ?? place.countryCode ?? "区域", cityPlaceId: null };
  return { key: `place:${place.id}`, label: "其他地点", cityPlaceId: null };
}

export function buildPlanningAreaContext(plan: PlanningAreaPlan): PlanningAreaContextV2 {
  const placesById = new Map(plan.places.map((place) => [place.id, place]));
  const candidatesById = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const cityByAlias = uniqueCityAliases(plan.places);
  const drafts = new Map<string, { identity: AreaIdentity; candidateIds: string[]; childCandidateIds: string[] }>();
  const areaKeyByCandidateId = new Map<string, string>();

  for (const candidate of plan.candidates) {
    const place = placesById.get(candidate.placeId);
    if (!place) continue;
    const identity = areaIdentity(place, placesById, cityByAlias);
    const draft = drafts.get(identity.key) ?? { identity, candidateIds: [], childCandidateIds: [] };
    draft.candidateIds.push(candidate.id);
    if (place.kind !== "city") draft.childCandidateIds.push(candidate.id);
    drafts.set(identity.key, draft);
    areaKeyByCandidateId.set(candidate.id, identity.key);
  }

  const conflicts: string[] = [];
  const participatingCandidateIds = new Set<string>();
  const suppressedCandidateIds = new Set<string>();
  const cityCandidateIds = new Set<string>();
  const areas: PlanningAreaV2[] = [];

  for (const draft of drafts.values()) {
    const cityCandidateId = draft.identity.cityPlaceId
      ? plan.candidates.find((candidate) => candidate.placeId === draft.identity.cityPlaceId)?.id ?? null
      : null;
    if (cityCandidateId) cityCandidateIds.add(cityCandidateId);
    const cityPreference = cityCandidateId ? candidatesById.get(cityCandidateId)?.preference ?? null : null;

    if (cityPreference === "excluded") {
      const contradictory = draft.childCandidateIds.filter((candidateId) => {
        const preference = candidatesById.get(candidateId)?.preference;
        return preference === "must_go" || preference === "want_to_go";
      });
      if (contradictory.length) {
        const names = contradictory.map((candidateId) => {
          const candidate = candidatesById.get(candidateId);
          const place = candidate ? placesById.get(candidate.placeId) : null;
          return place?.nameZh ?? candidateId;
        });
        conflicts.push(`${draft.identity.label} 已标记为“不去”，但其中仍有“必去/想去”地点：${names.join("、")}`);
      }
      for (const candidateId of draft.candidateIds) suppressedCandidateIds.add(candidateId);
      areas.push({
        key: draft.identity.key,
        label: draft.identity.label,
        cityPlaceId: draft.identity.cityPlaceId,
        cityCandidateId,
        candidateIds: draft.candidateIds,
        childCandidateIds: draft.childCandidateIds,
        participatingCandidateIds: [],
        suppressedCandidateIds: [...draft.candidateIds],
        effectivePreference: "excluded",
      });
      continue;
    }

    const participating = draft.candidateIds.filter((candidateId) => candidatesById.get(candidateId)?.preference !== "excluded");
    const participatingSet = new Set(participating);
    const suppressed = draft.candidateIds.filter((candidateId) => !participatingSet.has(candidateId));
    participating.forEach((candidateId) => participatingCandidateIds.add(candidateId));
    suppressed.forEach((candidateId) => suppressedCandidateIds.add(candidateId));
    const effectivePreference = participating
      .map((candidateId) => candidatesById.get(candidateId)?.preference ?? "optional")
      .sort((left, right) => preferenceRank[left] - preferenceRank[right])[0] ?? "excluded";

    areas.push({
      key: draft.identity.key,
      label: draft.identity.label,
      cityPlaceId: draft.identity.cityPlaceId,
      cityCandidateId,
      candidateIds: draft.candidateIds,
      childCandidateIds: draft.childCandidateIds,
      participatingCandidateIds: participating,
      suppressedCandidateIds: suppressed,
      effectivePreference,
    });
  }

  areas.sort((left, right) => preferenceRank[left.effectivePreference] - preferenceRank[right.effectivePreference] || left.label.localeCompare(right.label, "zh-CN"));
  return { areas, areaKeyByCandidateId, participatingCandidateIds, suppressedCandidateIds, cityCandidateIds, conflicts };
}

export function fulfilledMacroCityCandidateIds(context: PlanningAreaContextV2, scheduledCandidateIds: Set<string>) {
  const fulfilled = new Set<string>();
  for (const area of context.areas) {
    if (!area.cityCandidateId || !area.participatingCandidateIds.includes(area.cityCandidateId)) continue;
    if (scheduledCandidateIds.has(area.cityCandidateId) || area.childCandidateIds.some((candidateId) => scheduledCandidateIds.has(candidateId))) {
      fulfilled.add(area.cityCandidateId);
    }
  }
  return fulfilled;
}

export function planningAreaForCandidate(context: PlanningAreaContextV2, candidateId: string) {
  const key = context.areaKeyByCandidateId.get(candidateId);
  return key ? context.areas.find((area) => area.key === key) ?? null : null;
}
