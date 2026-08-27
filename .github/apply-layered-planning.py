from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    Path(path).write_text(value, encoding="utf-8")


def replace_once(value: str, old: str, new: str, label: str) -> str:
    count = value.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return value.replace(old, new, 1)


# ---------------------------------------------------------------------------
# Canonical contracts: persist an explicit Macro -> Micro candidate relation.
# ---------------------------------------------------------------------------
path = "apps/server/contracts-v2.ts"
s = read(path)
s = replace_once(
    s,
    "  placeId: IdSchema,\n  preference: CandidatePreferenceSchema,",
    "  placeId: IdSchema,\n  planningAreaCandidateId: IdSchema.nullable(),\n  preference: CandidatePreferenceSchema,",
    "TripCandidate planningAreaCandidateId",
)
s = replace_once(
    s,
    "  const candidateIds = new Set<string>();\n  const candidatePlaces = new Set<string>();",
    "  const placesById = new Map(value.places.map((place) => [place.id, place]));\n  const candidateIds = new Set<string>();\n  const candidatePlaces = new Set<string>();",
    "document places map",
)
s = replace_once(
    s,
    "\n  const tripRefs = [value.trip.originPlaceId, ...value.trip.destinationPlaceIds].filter((item): item is string => Boolean(item));",
    """
  for (const [index, candidate] of value.candidates.entries()) {
    if (!candidate.planningAreaCandidateId) continue;
    const parent = candidates.get(candidate.planningAreaCandidateId);
    const parentPlace = parent ? placesById.get(parent.placeId) : null;
    if (!parent || parent.id === candidate.id) {
      context.addIssue({ code: "custom", path: ["candidates", index, "planningAreaCandidateId"], message: "Micro Candidate 必须引用另一条已存在的 Macro Candidate。" });
      continue;
    }
    if (parentPlace?.kind !== "city") {
      context.addIssue({ code: "custom", path: ["candidates", index, "planningAreaCandidateId"], message: "planningAreaCandidateId 必须指向 Macro 目的地 Candidate。" });
    }
    const ownPlace = placesById.get(candidate.placeId);
    if (ownPlace?.kind === "city") {
      context.addIssue({ code: "custom", path: ["candidates", index, "planningAreaCandidateId"], message: "Macro Candidate 不得再归属于其他 Macro Candidate。" });
    }
  }

  const tripRefs = [value.trip.originPlaceId, ...value.trip.destinationPlaceIds].filter((item): item is string => Boolean(item));""",
    "document candidate parent validation",
)
s = replace_once(
    s,
    "    placeTemporaryId: IdSchema,\n    aiReason: TextSchema.max(1000),",
    "    placeTemporaryId: IdSchema,\n    planningAreaCandidateId: IdSchema.nullable(),\n    aiReason: TextSchema.max(1000),",
    "discovery parent field",
)
write(path, s)

path = "apps/web/src/v2-types.ts"
s = read(path)
s = replace_once(
    s,
    "  placeId: string;\n  preference: CandidatePreference;",
    "  placeId: string;\n  planningAreaCandidateId: string | null;\n  preference: CandidatePreference;",
    "web TripCandidate parent field",
)
s = replace_once(
    s,
    "export type Workspace = {\n  trip: Trip;",
    """export type PlanningCoverageStatus = "ready" | "attention" | "blocked";
export type PlanningAreaCoverage = {
  areaKey: string;
  label: string;
  macroCandidateId: string;
  preference: CandidatePreference;
  microCandidateCount: number;
  resolvedMicroCount: number;
  participatingResolvedMicroCount: number;
  status: PlanningCoverageStatus;
};
export type Workspace = {
  trip: Trip;""",
    "web coverage types",
)
s = replace_once(s, "  revisions: Revision[];\n};", "  revisions: Revision[];\n  coverage: PlanningAreaCoverage[];\n};", "workspace coverage field")
write(path, s)


# ---------------------------------------------------------------------------
# Same-v2 compatibility: normalize old JSON candidates to parent=null on read.
# This is not a DB migration and does not alter the sqlite schema/version.
# ---------------------------------------------------------------------------
path = "apps/server/travel-store-v2.ts"
s = read(path)
s = replace_once(
    s,
    "const parse = <T>(value: unknown, fallback: T): T => {\n  try {\n    return typeof value === \"string\" ? JSON.parse(value) as T : fallback;\n  } catch {\n    return fallback;\n  }\n};\n",
    """const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === "string" ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
};

function normalizeCandidateAreaLinks(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const cloned = structuredClone(value) as unknown;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    if ("id" in record && "placeId" in record && "preference" in record && "source" in record && "tags" in record && !("planningAreaCandidateId" in record)) {
      record.planningAreaCandidateId = null;
    }
    Object.values(record).forEach(visit);
  };
  visit(cloned);
  return cloned;
}

const parseTravelPlanJson = (value: unknown) => TravelPlanDocumentSchema.parse(normalizeCandidateAreaLinks(parse(value, null)));
const parseProposalJson = (value: unknown) => AiProposalSchema.parse(normalizeCandidateAreaLinks(parse(value, null)));
""",
    "store candidate normalization",
)
s = s.replace("TravelPlanDocumentSchema.parse(parse(row.current_plan_json, null))", "parseTravelPlanJson(row.current_plan_json)")
s = s.replace("TravelPlanDocumentSchema.parse(parse(row.plan_json, null))", "parseTravelPlanJson(row.plan_json)")
s = s.replace("AiProposalSchema.parse(parse(row.proposal_json, null))", "parseProposalJson(row.proposal_json)")
write(path, s)


# ---------------------------------------------------------------------------
# Candidate apply: validate and persist explicit parent links while preserving
# user preferences and rejecting silent reassociation.
# ---------------------------------------------------------------------------
path = "apps/server/candidate-workflow-v2.ts"
s = read(path)
s = replace_once(
    s,
    "  const candidateByPlaceId = new Map(plan.candidates.map((candidate) => [candidate.placeId, candidate]));\n  const addedCandidateIds: string[] = [];",
    "  const candidateByPlaceId = new Map(plan.candidates.map((candidate) => [candidate.placeId, candidate]));\n  const canonicalCandidateById = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));\n  const addedCandidateIds: string[] = [];",
    "candidate canonical map",
)
s = replace_once(
    s,
    "    const existing = candidateByPlaceId.get(placeId);\n    if (existing) {",
    """    const parentId = source.planningAreaCandidateId;
    if (parentId) {
      const parent = canonicalCandidateById.get(parentId);
      const parentPlace = parent ? plan.places.find((place) => place.id === parent.placeId) : null;
      if (!parent || parentPlace?.kind !== "city") throw new Error(`Candidate Discovery 引用无效 Macro Candidate：${parentId}`);
    }
    const existing = candidateByPlaceId.get(placeId);
    if (existing) {""",
    "candidate parent validation",
)
s = replace_once(
    s,
    "      const previousScore = existing.aiScore ?? -1;\n      if (source.aiScore >= previousScore) {",
    """      if (parentId && existing.planningAreaCandidateId && existing.planningAreaCandidateId !== parentId) {
        throw new Error(`Candidate 已归属其他 Macro，拒绝静默重关联：${existing.id}`);
      }
      if (parentId && !existing.planningAreaCandidateId) {
        existing.planningAreaCandidateId = parentId;
        updatedCandidateIds.add(existing.id);
      }
      const previousScore = existing.aiScore ?? -1;
      if (source.aiScore >= previousScore) {""",
    "candidate parent merge",
)
s = replace_once(
    s,
    "      placeId,\n      preference: \"optional\",",
    "      placeId,\n      planningAreaCandidateId: parentId,\n      preference: \"optional\",",
    "candidate parent persist",
)
s = replace_once(
    s,
    "    candidateByPlaceId.set(placeId, candidate);\n    idMappings.set(source.temporaryId, candidate.id);",
    "    candidateByPlaceId.set(placeId, candidate);\n    canonicalCandidateById.set(candidate.id, candidate);\n    idMappings.set(source.temporaryId, candidate.id);",
    "candidate parent map update",
)
write(path, s)


# ---------------------------------------------------------------------------
# Planning areas: explicit parent wins; text matching remains legacy fallback.
# Also expose deterministic Coverage derived from canonical + resolutions.
# ---------------------------------------------------------------------------
path = "apps/server/planning-areas-v2.ts"
s = read(path)
s = replace_once(
    s,
    "export type PlanningAreaCandidate = {\n  id: string;\n  placeId: string;\n  preference: PlanningCandidatePreference;\n};",
    """export type PlanningAreaCandidate = {
  id: string;
  placeId: string;
  planningAreaCandidateId: string | null;
  preference: PlanningCandidatePreference;
};""",
    "planning candidate parent type",
)
s = replace_once(
    s,
    "    const identity = areaIdentity(place, placesById, cityByAlias);\n    const draft = drafts.get(identity.key) ?? { identity, candidateIds: [], childCandidateIds: [] };",
    """    const parentCandidate = candidate.planningAreaCandidateId ? candidatesById.get(candidate.planningAreaCandidateId) ?? null : null;
    const parentPlace = parentCandidate ? placesById.get(parentCandidate.placeId) ?? null : null;
    const identity = parentPlace?.kind === "city"
      ? { key: `city:${parentPlace.id}`, label: parentPlace.nameZh, cityPlaceId: parentPlace.id }
      : areaIdentity(place, placesById, cityByAlias);
    const draft = drafts.get(identity.key) ?? { identity, candidateIds: [], childCandidateIds: [] };""",
    "planning explicit parent identity",
)
coverage = r'''

export type PlanningCoverageStatusV2 = "ready" | "attention" | "blocked";
export type PlanningAreaCoverageV2 = {
  areaKey: string;
  label: string;
  macroCandidateId: string;
  preference: PlanningCandidatePreference;
  microCandidateCount: number;
  resolvedMicroCount: number;
  participatingResolvedMicroCount: number;
  status: PlanningCoverageStatusV2;
};

export function buildPlanningCoverage(plan: PlanningAreaPlan, resolvedPlaceIds: Set<string>): PlanningAreaCoverageV2[] {
  const context = buildPlanningAreaContext(plan);
  const candidatesById = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  return context.areas.flatMap((area) => {
    if (!area.cityCandidateId) return [];
    const macro = candidatesById.get(area.cityCandidateId);
    if (!macro) return [];
    const microCandidateIds = area.childCandidateIds;
    const participatingMicroCandidateIds = microCandidateIds.filter((candidateId) => area.participatingCandidateIds.includes(candidateId));
    const resolvedMicroCount = microCandidateIds.filter((candidateId) => {
      const candidate = candidatesById.get(candidateId);
      return Boolean(candidate && resolvedPlaceIds.has(candidate.placeId));
    }).length;
    const participatingResolvedMicroCount = participatingMicroCandidateIds.filter((candidateId) => {
      const candidate = candidatesById.get(candidateId);
      return Boolean(candidate && resolvedPlaceIds.has(candidate.placeId));
    }).length;
    const status: PlanningCoverageStatusV2 = macro.preference === "excluded" || participatingResolvedMicroCount > 0
      ? "ready"
      : macro.preference === "must_go" ? "blocked" : "attention";
    return [{
      areaKey: area.key,
      label: area.label,
      macroCandidateId: macro.id,
      preference: macro.preference,
      microCandidateCount: microCandidateIds.length,
      resolvedMicroCount,
      participatingResolvedMicroCount,
      status,
    }];
  });
}
'''
s = replace_once(s, "\nexport function fulfilledMacroCityCandidateIds", coverage + "\nexport function fulfilledMacroCityCandidateIds", "planning coverage helper")
write(path, s)


# ---------------------------------------------------------------------------
# Runtime: scoped Macro/Micro discovery + Coverage + plan-time auto supplement.
# ---------------------------------------------------------------------------
path = "apps/server/planner-runtime-core-v2.ts"
s = read(path)
s = replace_once(s, 'import { buildPlanningAreaContext } from "./planning-areas-v2.js";', 'import { buildPlanningAreaContext, buildPlanningCoverage } from "./planning-areas-v2.js";', "runtime coverage import")
s = replace_once(
    s,
    "export type ModelOptionsV2 = { model?: string; effort?: ReasoningEffort };",
    "export type ModelOptionsV2 = { model?: string; effort?: ReasoningEffort };\nexport type CandidateDiscoveryModeV2 = \"macro\" | \"micro\";",
    "discovery mode type",
)
s = replace_once(
    s,
    "  discoverCandidates(input: { trip: TripDetailV2; message: string | null }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<CandidateDiscoveryOutput>>;",
    "  discoverCandidates(input: { trip: TripDetailV2; message: string | null; mode: CandidateDiscoveryModeV2; planningAreaCandidateIds: string[] }, progress?: (value: StructuredAiProgress) => void): Promise<RuntimeAiHandle<CandidateDiscoveryOutput>>;",
    "TravelAi discovery signature",
)
s = replace_once(
    s,
    "  discoverCandidates(input: { trip: TripDetailV2; message: string | null }, progress?: (value: StructuredAiProgress) => void) {",
    "  discoverCandidates(input: { trip: TripDetailV2; message: string | null; mode: CandidateDiscoveryModeV2; planningAreaCandidateIds: string[] }, progress?: (value: StructuredAiProgress) => void) {",
    "Codex discovery signature",
)
s = replace_once(
    s,
    "        userRequest: input.message,\n        initialDiscovery: input.trip.plan.candidates.length === 0,\n        existingCandidatePlaceIds: input.trip.plan.candidates.map((item) => item.placeId),",
    """        userRequest: input.message,
        discoveryMode: input.mode,
        initialDiscovery: input.mode === "macro" && !input.trip.plan.candidates.some((candidate) => input.trip.plan.places.find((place) => place.id === candidate.placeId)?.kind === "city"),
        existingCandidatePlaceIds: input.trip.plan.candidates.map((item) => item.placeId),
        planningAreaCandidateIds: input.planningAreaCandidateIds,
        planningAreaCandidates: input.trip.plan.candidates
          .filter((candidate) => input.planningAreaCandidateIds.includes(candidate.id))
          .map((candidate) => ({ ...candidate, place: input.trip.plan.places.find((place) => place.id === candidate.placeId) ?? null })),""",
    "Codex discovery task state",
)
s = replace_once(
    s,
    "  workspace(tripId: string) {\n    const workspace = this.options.store.getWorkspace(tripId);\n    return {\n      ...workspace,\n      resolutions: currentResolutions(workspace.trip, workspace.resolutions),",
    """  workspace(tripId: string) {
    const workspace = this.options.store.getWorkspace(tripId);
    const resolutions = currentResolutions(workspace.trip, workspace.resolutions);
    return {
      ...workspace,
      resolutions,
      coverage: buildPlanningCoverage(workspace.trip.plan, new Set(resolutions.map((resolution) => resolution.placeId))),""",
    "runtime workspace coverage",
)

old_discovery = re.compile(r'''  startCandidateDiscovery\(tripId: string, message: string \| null = null\) \{.*?\n  \}\n\n  startPlanGeneration''', re.S)
match = old_discovery.search(s)
if not match:
    raise SystemExit("runtime startCandidateDiscovery block not found")
new_discovery = r'''  private candidateDiscoveryTargets(trip: TripDetailV2, mode: CandidateDiscoveryModeV2, requestedIds: string[]) {
    if (mode === "macro") return [];
    const places = new Map(trip.plan.places.map((place) => [place.id, place]));
    const activeMacroIds = trip.plan.candidates
      .filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city")
      .map((candidate) => candidate.id);
    const targetIds = [...new Set(requestedIds.length ? requestedIds : activeMacroIds)];
    if (!targetIds.length) throw new Error("请先在“目的地”步骤生成并保留至少一个目的地。");
    for (const candidateId of targetIds) {
      const candidate = trip.plan.candidates.find((item) => item.id === candidateId);
      const place = candidate ? places.get(candidate.placeId) : null;
      if (!candidate || candidate.preference === "excluded" || place?.kind !== "city") {
        throw new Error(`详细兴趣点只能围绕有效 Macro 目的地生成：${candidateId}`);
      }
    }
    return targetIds;
  }

  private validateCandidateDiscoveryScope(trip: TripDetailV2, output: CandidateDiscoveryOutput, mode: CandidateDiscoveryModeV2, targetIds: string[]) {
    const outputPlaces = new Map(output.places.map((place) => [place.id, place]));
    const allowedParents = new Set(targetIds);
    for (const candidate of output.candidates) {
      const place = outputPlaces.get(candidate.placeTemporaryId);
      if (!place) continue;
      if (mode === "macro") {
        if (place.kind !== "city") throw new Error(`目的地发现只能生成 Macro 节点，不能直接生成具体地点：${place.nameZh}`);
        if (candidate.planningAreaCandidateId !== null) throw new Error("Macro Candidate 的 planningAreaCandidateId 必须为 null。");
        continue;
      }
      if (place.kind === "city") throw new Error(`详细兴趣点阶段不得再次生成 Macro 城市：${place.nameZh}`);
      if (!candidate.planningAreaCandidateId || !allowedParents.has(candidate.planningAreaCandidateId)) {
        throw new Error(`详细兴趣点必须显式归属于本次指定的 Macro Candidate：${place.nameZh}`);
      }
    }
    if (output.baseGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
  }

  private async applyScopedCandidateDiscovery(tripId: string, output: CandidateDiscoveryOutput, mode: CandidateDiscoveryModeV2, requestedIds: string[]) {
    const before = this.options.store.requireTrip(tripId);
    const targetIds = this.candidateDiscoveryTargets(before, mode, requestedIds);
    if (output.candidates.length > 80) throw new Error("单次候选地点最多 80 个。");
    this.validateCandidateDiscoveryScope(before, output, mode, targetIds);
    const applied = applyCandidateDiscoveryToStore(this.options.store, tripId, output);
    this.emit("travel.document.changed", { tripId, generation: applied.generation, changedDayIds: [] });
    const placeIds = [...new Set([
      ...applied.addedPlaceIds,
      ...applied.updatedCandidateIds.map((candidateId) => applied.trip.plan.candidates.find((candidate) => candidate.id === candidateId)?.placeId).filter((id): id is string => Boolean(id)),
    ])];
    await this.resolveChangedPlaces(tripId, placeIds, applied.generation);
    return applied;
  }

  startCandidateDiscovery(tripId: string, mode: CandidateDiscoveryModeV2 = "macro", planningAreaCandidateIds: string[] = [], message: string | null = null) {
    const taskHolder = { id: "" };
    const label = mode === "macro" ? "生成目的地建议" : "生成详细兴趣点";
    const result = this.begin({
      tripId,
      label,
      run: async () => {
        const trip = this.options.store.requireTrip(tripId);
        const targetIds = this.candidateDiscoveryTargets(trip, mode, planningAreaCandidateIds);
        return this.options.ai.discoverCandidates({ trip, message: message?.trim() || null, mode, planningAreaCandidateIds: targetIds }, this.progress(taskHolder.id));
      },
      complete: async (output: CandidateDiscoveryOutput) => {
        const applied = await this.applyScopedCandidateDiscovery(tripId, output, mode, planningAreaCandidateIds);
        this.options.store.createAssistantMessage(tripId, output.assistantMessage, { mode: "discover_candidates", discoveryMode: mode, addedCandidateIds: applied.addedCandidateIds });
      },
    });
    taskHolder.id = result.taskId;
    return result;
  }

  startPlanGeneration'''
s = s[:match.start()] + new_discovery + s[match.end():]

old_plan_chunk = re.compile(r'''        const latestTrip = this\.options\.store\.requireTrip\(tripId\);.*?        this\.options\.tasks\.update\(taskHolder\.id, "running", "正在规划城市顺序、停留天数和城市内景点", "plan:generating"\);''', re.S)
match = old_plan_chunk.search(s)
if not match:
    raise SystemExit("runtime plan coverage chunk not found")
new_plan_chunk = r'''        let latestTrip = this.options.store.requireTrip(tripId);
        if (latestTrip.contentGeneration !== trip.contentGeneration) throw new Error("CONTENT_GENERATION_SUPERSEDED");
        let resolutions = currentResolutions(latestTrip, this.options.store.listPlaceResolutions(tripId));
        let coverage = buildPlanningCoverage(latestTrip.plan, new Set(resolutions.map((resolution) => resolution.placeId)));
        const supplementMacroIds = coverage
          .filter((item) => item.status === "blocked" || (item.status === "attention" && item.preference === "want_to_go"))
          .map((item) => item.macroCandidateId);

        if (supplementMacroIds.length) {
          this.options.tasks.update(taskHolder.id, "running", `正在为 ${supplementMacroIds.length} 个目的地自动补充具体兴趣点`, "coverage:supplementing");
          try {
            const supplementTrip = this.options.store.requireTrip(tripId);
            const handle = await this.options.ai.discoverCandidates({
              trip: supplementTrip,
              message: "自动补全缺少可用于真实路线的具体兴趣点；只补充本次指定的目的地，不修改其他目的地。",
              mode: "micro",
              planningAreaCandidateIds: supplementMacroIds,
            }, this.progress(taskHolder.id));
            const discoveryOutput = await handle.result;
            await this.applyScopedCandidateDiscovery(tripId, discoveryOutput, "micro", supplementMacroIds);
          } catch (error) {
            const summary = normalizePublicAiSummary(aiErrorMessage(error)) || "自动补充兴趣点失败";
            this.options.tasks.update(taskHolder.id, "running", `自动补充未完成：${summary}；继续检查可生成性`, "coverage:attention");
          }
          latestTrip = this.options.store.requireTrip(tripId);
          resolutions = currentResolutions(latestTrip, this.options.store.listPlaceResolutions(tripId));
          coverage = buildPlanningCoverage(latestTrip.plan, new Set(resolutions.map((resolution) => resolution.placeId)));
        }

        const latestAreas = buildPlanningAreaContext(latestTrip.plan);
        if (latestAreas.conflicts.length) throw new Error(`目的地与具体兴趣点偏好冲突：${latestAreas.conflicts.join("；")}`);
        const latestResolvedIds = new Set(resolutions.map((resolution) => resolution.placeId));
        const places = new Map(latestTrip.plan.places.map((place) => [place.id, place]));

        const unresolvedConcreteMustGo = latestTrip.plan.candidates.filter((candidate) => {
          if (!latestAreas.participatingCandidateIds.has(candidate.id) || candidate.preference !== "must_go") return false;
          const place = places.get(candidate.placeId);
          return place?.kind !== "city" && !latestResolvedIds.has(candidate.placeId);
        });
        if (unresolvedConcreteMustGo.length) {
          const names = unresolvedConcreteMustGo.map((candidate) => places.get(candidate.placeId)?.nameZh ?? candidate.id).join("、");
          throw new Error(`以下“必去”具体地点自动定位失败，请先在右侧兴趣点步骤修复定位：${names}`);
        }

        const unavailableMustGoAreas = coverage.filter((item) => item.status === "blocked");
        if (unavailableMustGoAreas.length) {
          throw new Error(`自动补充后，以下“必去”目的地仍缺少可用于真实线路的已定位具体地点：${unavailableMustGoAreas.map((item) => item.label).join("、")}。请在右侧“兴趣点”步骤补充推荐、手动添加或修复定位。`);
        }

        this.options.tasks.update(taskHolder.id, "running", "正在规划目的地顺序、停留天数和区域内兴趣点", "plan:generating");'''
s = s[:match.start()] + new_plan_chunk + s[match.end():]
write(path, s)


# ---------------------------------------------------------------------------
# API exposes explicit discovery mode and target Macro candidate IDs.
# ---------------------------------------------------------------------------
path = "apps/server/travel-api-v2.ts"
s = read(path)
s = replace_once(
    s,
    '  if (method === "POST" && match) return { status: 202, data: deps.runtime.startCandidateDiscovery(decode(match[1]), typeof body.message === "string" ? body.message : null) };',
    '''  if (method === "POST" && match) {
    if (body.mode !== "macro" && body.mode !== "micro") throw new Error("候选地点发现 mode 必须是 macro 或 micro。");
    const planningAreaCandidateIds = Array.isArray(body.planningAreaCandidateIds) ? body.planningAreaCandidateIds.map(String) : [];
    return { status: 202, data: deps.runtime.startCandidateDiscovery(decode(match[1]), body.mode, planningAreaCandidateIds, typeof body.message === "string" ? body.message : null) };
  }''',
    "candidate discovery API mode",
)
write(path, s)


# ---------------------------------------------------------------------------
# Web grouping uses explicit parent first; view counts respect excluded Macro.
# ---------------------------------------------------------------------------
path = "apps/web/src/workspace-v2.ts"
s = read(path)
s = replace_once(
    s,
    "  const cityRows = rows.filter((row) => row.place.kind === \"city\");\n  const aliases = new Map<string, CandidateRow | null>();",
    """  const cityRows = rows.filter((row) => row.place.kind === "city");
  const rowsByCandidateId = new Map(rows.map((row) => [row.candidate.id, row]));
  const aliases = new Map<string, CandidateRow | null>();""",
    "web grouping candidate map",
)
old_else = '''    } else {
      const cityAlias = normalizeArea(row.place.city);
      const matched = cityAlias ? aliases.get(cityAlias) ?? null : null;
      if (matched) {
        key = `city:${matched.place.id}`;
        label = matched.place.nameZh;
        cityRow = matched;
      } else if (cityAlias) {
        key = `city-name:${normalizeArea(row.place.countryCode ?? row.place.country)}:${cityAlias}`;
        label = row.place.city ?? "城市";
      } else if (row.place.region) {
        key = `region:${normalizeArea(row.place.countryCode ?? row.place.country)}:${normalizeArea(row.place.region)}`;
        label = row.place.region;
      } else if (row.place.country || row.place.countryCode) {
        key = `country:${normalizeArea(row.place.countryCode ?? row.place.country)}`;
        label = row.place.country ?? row.place.countryCode ?? "区域";
      } else {
        key = `place:${row.place.id}`;
        label = "其他地点";
      }
    }
'''
new_else = '''    } else {
      const explicitParent = row.candidate.planningAreaCandidateId ? rowsByCandidateId.get(row.candidate.planningAreaCandidateId) ?? null : null;
      if (explicitParent?.place.kind === "city") {
        key = `city:${explicitParent.place.id}`;
        label = explicitParent.place.nameZh;
        cityRow = explicitParent;
      } else {
        const cityAlias = normalizeArea(row.place.city);
        const matched = cityAlias ? aliases.get(cityAlias) ?? null : null;
        if (matched) {
          key = `city:${matched.place.id}`;
          label = matched.place.nameZh;
          cityRow = matched;
        } else if (cityAlias) {
          key = `city-name:${normalizeArea(row.place.countryCode ?? row.place.country)}:${cityAlias}`;
          label = row.place.city ?? "城市";
        } else if (row.place.region) {
          key = `region:${normalizeArea(row.place.countryCode ?? row.place.country)}:${normalizeArea(row.place.region)}`;
          label = row.place.region;
        } else if (row.place.country || row.place.countryCode) {
          key = `country:${normalizeArea(row.place.countryCode ?? row.place.country)}`;
          label = row.place.country ?? row.place.countryCode ?? "区域";
        } else {
          key = `place:${row.place.id}`;
          label = "其他地点";
        }
      }
    }
'''
s = replace_once(s, old_else, new_else, "web explicit grouping")
s = replace_once(
    s,
    "export function candidateCounts(rows: CandidateRow[]) {\n  const participating = participatingCandidateIds(rows);\n  const result = { all: rows.length, must_go: 0, want_to_go: 0, optional: 0, excluded: 0, unresolved: 0, selected: participating.size };",
    """export function candidateCounts(rows: CandidateRow[], contextRows: CandidateRow[] = rows) {
  const participating = participatingCandidateIds(contextRows);
  const result = { all: rows.length, must_go: 0, want_to_go: 0, optional: 0, excluded: 0, unresolved: 0, selected: rows.filter((row) => participating.has(row.candidate.id)).length };""",
    "web candidate counts context",
)
s = replace_once(
    s,
    "export function selectedUnresolvedRows(rows: CandidateRow[]) {\n  const participating = participatingCandidateIds(rows);",
    "export function selectedUnresolvedRows(rows: CandidateRow[], contextRows: CandidateRow[] = rows) {\n  const participating = participatingCandidateIds(contextRows);",
    "web unresolved context",
)
write(path, s)


# ---------------------------------------------------------------------------
# CandidatePanel: preserve parent group while filtering Macro/Micro cards,
# display Coverage, and require a parent when manually adding Micro places.
# ---------------------------------------------------------------------------
path = "apps/web/src/CandidatePanel.tsx"
s = read(path)
s = replace_once(s, "  tags: string;\n};", "  tags: string;\n  planningAreaCandidateId: string;\n};", "new form parent field")
s = replace_once(s, "  tags: string[];\n};", "  tags: string[];\n  planningAreaCandidateId: string | null;\n};", "new draft parent field")
s = replace_once(s, '  tags: "",\n});', '  tags: "",\n  planningAreaCandidateId: "",\n});', "empty form parent")
s = replace_once(
    s,
    "  const counts = useMemo(() => candidateCounts(rows), [rows]);\n  const isMacro = view === \"macro\";",
    """  const counts = useMemo(() => candidateCounts(rows, allRows), [rows, allRows]);
  const isMacro = view === "macro";
  const macroRows = useMemo(() => allRows.filter((row) => row.place.kind === "city" && row.candidate.preference !== "excluded"), [allRows]);
  const coverageByMacroId = useMemo(() => new Map(workspace.coverage.map((item) => [item.macroCandidateId, item])), [workspace.coverage]);""",
    "candidate panel coverage state",
)
s = replace_once(
    s,
    "    return candidateAreaGroups(rows)\n      .map((group) => ({ ...group, rows: group.rows.filter((row) => visibleCandidateIds.has(row.candidate.id)) }))",
    "    return candidateAreaGroups(allRows)\n      .map((group) => ({ ...group, rows: group.rows.filter((row) => visibleCandidateIds.has(row.candidate.id)) }))",
    "candidate panel grouping context",
)
s = replace_once(s, "  }, [rows, visible]);\n  const unresolvedSelected = useMemo(() => selectedUnresolvedRows(rows), [rows]);", "  }, [allRows, visible]);\n  const unresolvedSelected = useMemo(() => selectedUnresolvedRows(rows, allRows), [rows, allRows]);", "candidate panel unresolved context")
s = replace_once(
    s,
    '    if (!nameZh) { setNewCandidateError("请输入具体地点名称。"); return; }',
    '    if (!nameZh) { setNewCandidateError("请输入具体地点名称。"); return; }\n    if (!isMacro && !newCandidate.planningAreaCandidateId) { setNewCandidateError("请选择这个兴趣点所属的目的地。"); return; }',
    "manual micro parent required",
)
s = replace_once(
    s,
    "        tags: [...new Set(newCandidate.tags.split(/[，,]/u).map((tag) => tag.trim()).filter(Boolean))].slice(0, 30),\n      });",
    "        tags: [...new Set(newCandidate.tags.split(/[，,]/u).map((tag) => tag.trim()).filter(Boolean))].slice(0, 30),\n        planningAreaCandidateId: isMacro ? null : newCandidate.planningAreaCandidateId,\n      });",
    "manual draft parent submit",
)
s = replace_once(
    s,
    "        const concreteCount = group.rows.filter((row) => row.place.kind !== \"city\").length;\n        const participatingCount = areaExcluded ? 0 : group.rows.filter((row) => row.candidate.preference !== \"excluded\").length;",
    """        const coverage = group.cityRow ? coverageByMacroId.get(group.cityRow.candidate.id) ?? null : null;
        const concreteCount = coverage?.microCandidateCount ?? group.rows.filter((row) => row.place.kind !== "city").length;
        const participatingCount = areaExcluded ? 0 : group.rows.filter((row) => row.candidate.preference !== "excluded").length;""",
    "candidate coverage group values",
)
s = replace_once(
    s,
    '<span><strong>{group.label}</strong><small>{group.cityRow ? "城市级规划 · " : "区域分组 · "}{concreteCount} 个具体地点 · {participatingCount} 个参与规划{areaExcluded ? " · 整座城市不去" : ""}</small></span>',
    '<span><strong>{group.label}</strong><small>{group.cityRow ? "目的地规划 · " : "区域分组 · "}{concreteCount} 个具体地点{coverage ? ` · ${coverage.participatingResolvedMicroCount} 个已定位可用` : ` · ${participatingCount} 个参与规划`}{areaExcluded ? " · 本次不去" : coverage?.status === "blocked" ? " · 需要补充具体地点" : coverage?.status === "attention" ? " · 建议补充具体地点" : ""}</small></span>',
    "candidate coverage group label",
)
# Insert explicit Macro selector before type selector in manual add dialog.
s = replace_once(
    s,
    '      <label>英文名称<input value={newCandidate.nameEn} onChange={(event) => setNewCandidate({ ...newCandidate, nameEn: event.target.value })} placeholder="可选"/></label>\n      <label>类型<select value={newCandidate.kind} onChange={(event) => setNewCandidate({ ...newCandidate, kind: event.target.value as PlaceKind })}>{(Object.keys(kindLabels) as PlaceKind[]).map((kind) => <option value={kind} key={kind}>{kindLabels[kind]}</option>)}</select></label>',
    '      <label>英文名称<input value={newCandidate.nameEn} onChange={(event) => setNewCandidate({ ...newCandidate, nameEn: event.target.value })} placeholder="可选"/></label>\n      {!isMacro && <label className="wide">所属目的地<select value={newCandidate.planningAreaCandidateId} onChange={(event) => setNewCandidate({ ...newCandidate, planningAreaCandidateId: event.target.value })}><option value="">请选择目的地</option>{macroRows.map((row) => <option key={row.candidate.id} value={row.candidate.id}>{row.place.nameZh}</option>)}</select></label>}\n      <label>类型<select value={newCandidate.kind} disabled={isMacro} onChange={(event) => setNewCandidate({ ...newCandidate, kind: event.target.value as PlaceKind })}>{(Object.keys(kindLabels) as PlaceKind[]).filter((kind) => isMacro ? kind === "city" : kind !== "city").map((kind) => <option value={kind} key={kind}>{kindLabels[kind]}</option>)}</select></label>',
    "manual macro selector",
)
write(path, s)


# ---------------------------------------------------------------------------
# App: each right-side step calls exactly one scoped discovery endpoint.
# ---------------------------------------------------------------------------
path = "apps/web/src/App.tsx"
s = read(path)
s = replace_once(
    s,
    "  const discover = async () => {\n    if (!trip) return;\n    await runAction(async () => {\n      await api(`/api/trips/${trip.id}/candidates/discover`, { method: \"POST\", body: \"{}\" });\n      await refreshWorkspace();\n    }, \"无法生成地点推荐。\");\n  };",
    """  const discover = async (mode: "macro" | "micro", planningAreaCandidateIds: string[] = []) => {
    if (!trip) return;
    await runAction(async () => {
      await api(`/api/trips/${trip.id}/candidates/discover`, {
        method: "POST",
        body: JSON.stringify({ mode, planningAreaCandidateIds }),
      });
      await refreshWorkspace();
    }, mode === "macro" ? "无法生成目的地建议。" : "无法生成详细兴趣点。");
  };""",
    "scoped discover client",
)
s = replace_once(
    s,
    "        tags: draft.tags,\n      },",
    "        tags: draft.tags,\n        planningAreaCandidateId: draft.kind === \"city\" ? null : draft.planningAreaCandidateId,\n      },",
    "manual candidate parent client",
)
s = s.replace("await discover(); setStep(\"destinations\")", "await discover(\"macro\"); setStep(\"destinations\")")
s = s.replace("onDiscover={discover}", "onDiscover={() => discover(\"macro\")}", 1)
# Replace destination continue and then the micro onDiscover occurrence.
old_continue = 'onContinue={async () => { const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place])); const hasMicro = workspace.trip.plan.candidates.some((candidate) => places.get(candidate.placeId)?.kind !== "city"); if (!hasMicro) await discover(); setStep("interests"); setSelection({ type: "candidate_pool", id: null }); }}'
new_continue = 'onContinue={async () => { const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place])); const macroIds = workspace.trip.plan.candidates.filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city").map((candidate) => candidate.id); await discover("micro", macroIds); setStep("interests"); setSelection({ type: "candidate_pool", id: null }); }}'
s = replace_once(s, old_continue, new_continue, "destination continue scoped discovery")
s = replace_once(s, "onDiscover={discover} onAddCandidate={addCandidate} onContinue={generatePlan}", 'onDiscover={() => { const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place])); const macroIds = workspace.trip.plan.candidates.filter((candidate) => candidate.preference !== "excluded" && places.get(candidate.placeId)?.kind === "city").map((candidate) => candidate.id); return discover("micro", macroIds); }} onAddCandidate={addCandidate} onContinue={generatePlan}', "micro scoped discover prop")
write(path, s)


# ---------------------------------------------------------------------------
# Planner prompt: discover Macro and Micro in two separate, strict passes.
# ---------------------------------------------------------------------------
path = "prompts/00-旅行规划Agent.md"
s = read(path)
pattern = re.compile(r'''### `discover_candidates`\n.*?\n### `generate_plan`''', re.S)
match = pattern.search(s)
if not match:
    raise SystemExit("planner discover prompt section not found")
replacement = r'''### `discover_candidates`

根据服务端注入的 `task.discoveryMode` 执行分层地点发现。**Macro 与 Micro 不得在同一轮混合生成。**

#### `discoveryMode=macro`

只生成“这趟旅行去哪里”的 Macro 目的地候选：城市、区域、景区、岛屿或 road-trip 中具有独立停留意义的目的地。

P0 为保持现有 Place kind 合同，Macro 统一使用 `kind=city` 表达；名称可以是城市或明确区域名。

要求：

- 只生成 Macro，不生成具体景点、酒店、车站等 Micro Place；
- 每个输出 Candidate 的 `planningAreaCandidateId` 必须为 `null`；
- 根据旅行天数与用户需求控制数量，优先给出少而清晰的目的地集合，不为凑数量过度拆分；
- 避免与当前已有 Macro 语义重复；
- 默认 preference 固定为 `optional`；
- 不生成坐标、Provider Place ID 或地图平台评分。

#### `discoveryMode=micro`

只围绕 `task.planningAreaCandidates` 中明确注入的 Macro 目的地，生成“到了这里具体玩什么”的可实际访问、可地图解析的 Micro Place。

要求：

- 不生成 `kind=city`；只生成 attraction / lodging / airport / station / port / waypoint / meal / stop 等具体地点；
- 每个输出 Candidate 的 `planningAreaCandidateId` **必须精确引用一个本轮注入的 Macro Candidate 正式 ID**；
- 不允许仅靠 `Place.city` 文本暗示归属；显式父引用是 canonical 归属；
- 对每个目标 Macro 优先推荐若干真正有旅行价值、可搜索、可定位的地点；不要为了数量生成模糊实体；
- 用户要求“补充推荐”时优先补当前池中缺失的类型或区域，不重复已有地点；
- 给出明确推荐理由、0–100 AI 推荐分、建议停留时间和标签；
- 默认 preference 固定为 `optional`；
- `Place.city / region / country` 仍应尽可能准确，用于显示与地图搜索，但不是父子关系来源；
- 不生成坐标、地址坐标、Provider Place ID 或平台评分。

两种模式共同要求：

- 只生成语义 Place 和 TripCandidate 推荐元数据；
- 避免与现有地点或本轮其他地点语义重复；
- 不生成“附近商场”“某个咖啡馆”等无法定位的模糊实体；
- 只返回服务端指定结构，不解释内部推理。

### `generate_plan`'''
s = s[:match.start()] + replacement + s[match.end():]
# Adjustment mode needs the new required field whenever it creates candidates.
s = s.replace("- Candidate Pool Scope 只能新增、移除或更新候选地点，不能替用户修改 preference；", "- Candidate Pool Scope 只能新增、移除或更新候选地点，不能替用户修改 preference；新增 Macro Candidate 的 `planningAreaCandidateId` 必须为 null，新增 Micro Candidate 必须指向已有 Macro Candidate；")
write(path, s)


# ---------------------------------------------------------------------------
# Tests/fixtures: required nullable field + explicit-parent/Coverage regression.
# ---------------------------------------------------------------------------
for test_path in Path("apps").rglob("*.test.ts"):
    value = test_path.read_text(encoding="utf-8")
    value = re.sub(r'(placeId:\s*[^,\n]+,\s*)(preference:)', r'\1planningAreaCandidateId: null, \2', value)
    value = re.sub(r'(?<!planningAreaCandidateId: null, )defaultPreference:\s*"optional"', 'planningAreaCandidateId: null, defaultPreference: "optional"', value)
    test_path.write_text(value, encoding="utf-8")

path = "apps/server/planning-areas-v2.test.ts"
s = read(path)
s = replace_once(s, 'import { buildPlanningAreaContext, fulfilledMacroCityCandidateIds } from "./planning-areas-v2.js";', 'import { buildPlanningAreaContext, buildPlanningCoverage, fulfilledMacroCityCandidateIds } from "./planning-areas-v2.js";', "planning test coverage import")
s = replace_once(
    s,
    'const candidate = (id: string, placeId: string, preference: "must_go" | "want_to_go" | "optional" | "excluded") => ({ id, placeId, planningAreaCandidateId: null, preference });',
    'const candidate = (id: string, placeId: string, preference: "must_go" | "want_to_go" | "optional" | "excluded", planningAreaCandidateId: string | null = null) => ({ id, placeId, planningAreaCandidateId, preference });',
    "planning test candidate helper",
)
append = r'''

  it("uses explicit Macro relation even when Micro city text does not match", () => {
    const plan = {
      places: [
        place("franz", "弗朗茨·约瑟夫冰川地区", "city", "Franz Josef"),
        { ...place("glacier", "Franz Josef Glacier Walk", "attraction", "Westland"), region: "West Coast" },
      ],
      candidates: [
        candidate("franz-c", "franz", "must_go"),
        candidate("glacier-c", "glacier", "optional", "franz-c"),
      ],
    };
    const context = buildPlanningAreaContext(plan);
    expect(context.areas).toHaveLength(1);
    expect(context.areas[0].cityCandidateId).toBe("franz-c");
    expect(context.areas[0].childCandidateIds).toEqual(["glacier-c"]);
    expect(buildPlanningCoverage(plan, new Set(["glacier"]))[0]).toMatchObject({
      macroCandidateId: "franz-c",
      participatingResolvedMicroCount: 1,
      status: "ready",
    });
  });
'''
s = replace_once(s, "\n});\n", append + "\n});\n", "planning explicit relation regression")
write(path, s)

print("layered Macro/Micro planning transformations applied")
