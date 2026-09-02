import type { TravelPlanDocument } from "./contracts-v2.js";

export function requestedDurationDaysFromBriefV3(value: unknown): number | null | undefined {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const daysMatch = text.match(/(\d{1,3})\s*(?:天|日|days?)/iu);
  const weeksMatch = text.match(/(\d{1,2})\s*(?:周|星期|weeks?)/iu);
  const bareMatch = text.match(/^\s*(\d{1,3})\s*$/u);
  const parsed = daysMatch ? Number(daysMatch[1]) : weeksMatch ? Number(weeksMatch[1]) * 7 : bareMatch ? Number(bareMatch[1]) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 90 ? parsed : undefined;
}

export function normalizeRequirementsCtaParametersV3(
  plan: TravelPlanDocument,
  actionType: string,
  parameters: Record<string, unknown>,
) {
  if (actionType !== "requirements.update") return parameters;
  const changes = parameters.changes && typeof parameters.changes === "object" && !Array.isArray(parameters.changes)
    ? parameters.changes as Record<string, unknown>
    : null;
  if (!changes || Object.prototype.hasOwnProperty.call(changes, "dates")) return parameters;
  const brief = changes.brief && typeof changes.brief === "object" && !Array.isArray(changes.brief)
    ? changes.brief as Record<string, unknown>
    : null;
  if (!brief || !Object.prototype.hasOwnProperty.call(brief, "duration")) return parameters;
  const requestedDurationDays = requestedDurationDaysFromBriefV3(brief.duration);
  if (requestedDurationDays === undefined) return parameters;
  return {
    ...parameters,
    changes: {
      ...changes,
      dates: { ...plan.trip.dates, requestedDurationDays },
    },
  };
}
