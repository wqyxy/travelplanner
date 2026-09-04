export type PlanningCandidatePreference = "must_go" | "want_to_go" | "optional" | "excluded";
export type PlanningRoleV3Compat = "planning_area" | "core_visit" | "detail_interest";
export type PlanningAreaPlace = { id: string; nameZh: string; nameLocal: string | null; nameEn: string | null; kind: string; city: string | null; region: string | null; country: string | null; countryCode: string | null };
export type PlanningAreaCandidate = { id: string; placeId: string; planningAreaCandidateId: string | null; planningRole?: PlanningRoleV3Compat; preference: PlanningCandidatePreference };
export type PlanningAreaPlan = { places: PlanningAreaPlace[]; candidates: PlanningAreaCandidate[] };

const preferenceRank: Record<PlanningCandidatePreference, number> = { must_go: 0, want_to_go: 1, optional: 2, excluded: 3 };
const effectiveRole = (candidate: PlanningAreaCandidate, place: PlanningAreaPlace | undefined): PlanningRoleV3Compat => candidate.planningRole ?? (place?.kind === "city" ? "planning_area" : "detail_interest");

export type PlanningAreaV2 = {
  key: string;
  label: string;
  cityPlaceId: string | null;
  cityCandidateId: string | null;
  planningAreaPlaceId: string | null;
  planningAreaCandidateId: string | null;
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
  planningAreaCandidateIds: Set<string>;
  conflicts: string[];
};

type AreaDraft = {
  key: string;
  label: string;
  planningAreaCandidateId: string | null;
  planningAreaPlaceId: string | null;
  cityPlaceId: string | null;
  candidateIds: string[];
  childCandidateIds: string[];
};

function fallbackArea(candidate: PlanningAreaCandidate, place: PlanningAreaPlace): AreaDraft {
  return {
    key: `unassigned:${candidate.id}`,
    label: place.nameZh,
    planningAreaCandidateId: null,
    planningAreaPlaceId: null,
    cityPlaceId: null,
    candidateIds: [],
    childCandidateIds: [],
  };
}

export function buildPlanningAreaContext(plan: PlanningAreaPlan): PlanningAreaContextV2 {
  const placesById = new Map(plan.places.map((place) => [place.id, place]));
  const candidatesById = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const drafts = new Map<string, AreaDraft>();
  const areaKeyByCandidateId = new Map<string, string>();

  const planningAreas = plan.candidates.filter((candidate) => effectiveRole(candidate, placesById.get(candidate.placeId)) === "planning_area");
  for (const candidate of planningAreas) {
    const place = placesById.get(candidate.placeId);
    if (!place) continue;
    const key = `planning-area:${candidate.id}`;
    drafts.set(key, {
      key,
      label: place.nameZh,
      planningAreaCandidateId: candidate.id,
      planningAreaPlaceId: place.id,
      cityPlaceId: place.kind === "city" ? place.id : null,
      candidateIds: [candidate.id],
      childCandidateIds: [],
    });
    areaKeyByCandidateId.set(candidate.id, key);
  }

  for (const candidate of plan.candidates) {
    const place = placesById.get(candidate.placeId);
    if (!place || effectiveRole(candidate, place) === "planning_area") continue;
    const parent = candidate.planningAreaCandidateId ? candidatesById.get(candidate.planningAreaCandidateId) : null;
    const parentPlace = parent ? placesById.get(parent.placeId) : null;
    const validPlanningAreaParent = Boolean(parent && parentPlace && effectiveRole(parent, parentPlace) === "planning_area");
    const key = validPlanningAreaParent ? `planning-area:${parent!.id}` : `unassigned:${candidate.id}`;
    const draft = drafts.get(key) ?? fallbackArea(candidate, place);
    draft.candidateIds.push(candidate.id);
    draft.childCandidateIds.push(candidate.id);
    drafts.set(key, draft);
    areaKeyByCandidateId.set(candidate.id, key);
  }

  const conflicts: string[] = [];
  const participatingCandidateIds = new Set<string>();
  const suppressedCandidateIds = new Set<string>();
  const cityCandidateIds = new Set<string>();
  const planningAreaCandidateIds = new Set<string>();
  const areas: PlanningAreaV2[] = [];

  for (const draft of drafts.values()) {
    const macroCandidate = draft.planningAreaCandidateId ? candidatesById.get(draft.planningAreaCandidateId) ?? null : null;
    if (macroCandidate) planningAreaCandidateIds.add(macroCandidate.id);
    if (macroCandidate && placesById.get(macroCandidate.placeId)?.kind === "city") cityCandidateIds.add(macroCandidate.id);

    const macroExcluded = macroCandidate?.preference === "excluded";
    if (macroExcluded) {
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
        conflicts.push(`${draft.label} 已标记为“不考虑”，但其中仍有“必去/想去”地点：${names.join("、")}`);
      }
    }

    // excluded 只影响默认参与规划，不再表示 canonical 禁止关系。
    const participating = draft.candidateIds.filter((candidateId) => candidatesById.get(candidateId)?.preference !== "excluded");
    const participatingSet = new Set(participating);
    const suppressed = draft.candidateIds.filter((candidateId) => !participatingSet.has(candidateId));
    participating.forEach((id) => participatingCandidateIds.add(id));
    suppressed.forEach((id) => suppressedCandidateIds.add(id));
    const effectivePreference = participating.map((id) => candidatesById.get(id)?.preference ?? "optional").sort((a, b) => preferenceRank[a] - preferenceRank[b])[0] ?? "excluded";

    areas.push({
      key: draft.key,
      label: draft.label,
      cityPlaceId: draft.cityPlaceId,
      cityCandidateId: macroCandidate && placesById.get(macroCandidate.placeId)?.kind === "city" ? macroCandidate.id : null,
      planningAreaPlaceId: draft.planningAreaPlaceId,
      planningAreaCandidateId: draft.planningAreaCandidateId,
      candidateIds: draft.candidateIds,
      childCandidateIds: draft.childCandidateIds,
      participatingCandidateIds: participating,
      suppressedCandidateIds: suppressed,
      effectivePreference,
    });
  }

  areas.sort((a, b) => preferenceRank[a.effectivePreference] - preferenceRank[b.effectivePreference] || a.label.localeCompare(b.label, "zh-CN"));
  return { areas, areaKeyByCandidateId, participatingCandidateIds, suppressedCandidateIds, cityCandidateIds, planningAreaCandidateIds, conflicts };
}

export type PlanningCoverageStatusV2 = "ready" | "attention" | "blocked";
export type PlanningAreaCoverageV2 = { areaKey: string; label: string; macroCandidateId: string; preference: PlanningCandidatePreference; microCandidateCount: number; resolvedMicroCount: number; participatingResolvedMicroCount: number; status: PlanningCoverageStatusV2 };

export function buildPlanningCoverage(plan: PlanningAreaPlan, resolvedPlaceIds: Set<string>): PlanningAreaCoverageV2[] {
  const context = buildPlanningAreaContext(plan);
  const candidatesById = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  return context.areas.flatMap((area) => {
    if (!area.planningAreaCandidateId) return [];
    const macro = candidatesById.get(area.planningAreaCandidateId);
    if (!macro) return [];
    const microCandidateIds = area.childCandidateIds;
    const participating = microCandidateIds.filter((id) => area.participatingCandidateIds.includes(id));
    const resolvedMicroCount = microCandidateIds.filter((id) => { const c = candidatesById.get(id); return Boolean(c && resolvedPlaceIds.has(c.placeId)); }).length;
    const participatingResolvedMicroCount = participating.filter((id) => { const c = candidatesById.get(id); return Boolean(c && resolvedPlaceIds.has(c.placeId)); }).length;
    return [{ areaKey: area.key, label: area.label, macroCandidateId: macro.id, preference: macro.preference, microCandidateCount: microCandidateIds.length, resolvedMicroCount, participatingResolvedMicroCount, status: "ready" as const }];
  });
}

/** Compatibility helper retained for callers; planning areas are no longer required to be cities. */
export function fulfilledMacroCityCandidateIds(context: PlanningAreaContextV2, _scheduledCandidateIds: Set<string>) {
  const fulfilled = new Set<string>();
  for (const area of context.areas) if (area.planningAreaCandidateId && area.participatingCandidateIds.includes(area.planningAreaCandidateId)) fulfilled.add(area.planningAreaCandidateId);
  return fulfilled;
}

export function planningAreaForCandidate(context: PlanningAreaContextV2, candidateId: string) {
  const key = context.areaKeyByCandidateId.get(candidateId);
  return key ? context.areas.find((area) => area.key === key) ?? null : null;
}
