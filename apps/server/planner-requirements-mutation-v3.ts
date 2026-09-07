import type { AiActionRecord } from "./ai-stage-contracts-v3.js";
import {
  TravelPlanDocumentSchema,
  emptyTravelPlan,
  type TravelPlanDocument,
} from "./contracts-v2.js";

export type RequirementsMutationV3 = {
  plan: TravelPlanDocument;
  revision: { source: string; summary: string };
};

const clone = <T>(value: T): T => structuredClone(value);

function applyRequirementPatch(
  plan: TravelPlanDocument,
  raw: Record<string, unknown>,
) {
  if (!Object.keys(raw).length) throw new Error("requirements.update 没有可执行字段。");
  const next = clone(plan);

  if (Object.hasOwn(raw, "title")) next.trip.title = clone(raw.title) as typeof next.trip.title;
  if (Object.hasOwn(raw, "brief")) {
    next.trip.brief = {
      ...next.trip.brief,
      ...(clone(raw.brief) as Partial<typeof next.trip.brief>),
    };
  }
  if (Object.hasOwn(raw, "dates")) next.trip.dates = clone(raw.dates) as typeof next.trip.dates;
  if (Object.hasOwn(raw, "travelers")) next.trip.travelers = clone(raw.travelers) as typeof next.trip.travelers;
  if (Object.hasOwn(raw, "budget")) next.trip.budget = clone(raw.budget) as typeof next.trip.budget;
  if (Object.hasOwn(raw, "pace")) next.trip.pace = clone(raw.pace) as typeof next.trip.pace;
  if (Object.hasOwn(raw, "themes")) next.trip.themes = clone(raw.themes) as typeof next.trip.themes;
  if (Object.hasOwn(raw, "preferences")) next.trip.preferences = clone(raw.preferences) as typeof next.trip.preferences;
  if (Object.hasOwn(raw, "constraints")) next.trip.constraints = clone(raw.constraints) as typeof next.trip.constraints;
  if (Object.hasOwn(raw, "assumptions")) next.trip.assumptions = clone(raw.assumptions) as typeof next.trip.assumptions;

  return TravelPlanDocumentSchema.parse(next);
}

function clearRequirementFields(plan: TravelPlanDocument, fields: string[]) {
  if (!fields.length) throw new Error("requirements.clear 没有指定字段。");
  const defaults = emptyTravelPlan().trip;
  const next = clone(plan);

  for (const key of fields) {
    switch (key) {
      case "title": next.trip.title = clone(defaults.title); break;
      case "brief": next.trip.brief = clone(defaults.brief); break;
      case "dates": next.trip.dates = clone(defaults.dates); break;
      case "travelers": next.trip.travelers = clone(defaults.travelers); break;
      case "budget": next.trip.budget = clone(defaults.budget); break;
      case "pace": next.trip.pace = clone(defaults.pace); break;
      case "themes": next.trip.themes = clone(defaults.themes); break;
      case "preferences": next.trip.preferences = clone(defaults.preferences); break;
      case "constraints": next.trip.constraints = clone(defaults.constraints); break;
      case "assumptions": next.trip.assumptions = clone(defaults.assumptions); break;
    }
  }
  return TravelPlanDocumentSchema.parse(next);
}

/**
 * Build one deterministic requirements mutation without touching Store state.
 * Returns null for non-requirements deterministic actions.
 */
export function buildRequirementsMutationV3(
  action: AiActionRecord,
  current: TravelPlanDocument,
): RequirementsMutationV3 | null {
  if (action.actionType === "requirements.capture") {
    const additionalRequirements = String(action.parameters.additionalRequirements ?? "").trim();
    if (!additionalRequirements) throw new Error("requirements.capture 缺少其他需求。");
    const next = clone(current);
    next.trip.brief.additionalRequirements = additionalRequirements;
    return {
      plan: TravelPlanDocumentSchema.parse(next),
      revision: { source: "action:requirements.capture", summary: "记录其他需求" },
    };
  }

  if (action.actionType === "requirements.update") {
    const raw = action.parameters.changes
      && typeof action.parameters.changes === "object"
      && !Array.isArray(action.parameters.changes)
      ? action.parameters.changes as Record<string, unknown>
      : {};
    return {
      plan: applyRequirementPatch(current, raw),
      revision: { source: "action:requirements.update", summary: "更新旅行需求" },
    };
  }

  if (action.actionType === "requirements.clear") {
    const fields = Array.isArray(action.parameters.fields)
      ? action.parameters.fields.map(String)
      : [];
    return {
      plan: clearRequirementFields(current, fields),
      revision: { source: "action:requirements.clear", summary: "更新旅行需求" },
    };
  }

  return null;
}
