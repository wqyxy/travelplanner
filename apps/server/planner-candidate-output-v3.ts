import type { DestinationGenerateOutput } from "./ai-action-contracts-v3.js";
import {
  PlanCommandSchema,
  type TravelPlanDocument,
} from "./contracts-v2.js";

const destinationCountryAliases: Record<string, readonly string[]> = {
  GB: ["英国", "uk", "united kingdom", "great britain", "英格兰", "苏格兰", "威尔士", "北爱尔兰"],
  FR: ["法国", "france"],
  JP: ["日本", "japan"],
  US: ["美国", "united states", "usa"],
  NZ: ["新西兰", "new zealand"],
  AU: ["澳大利亚", "australia"],
  IT: ["意大利", "italy"],
  ES: ["西班牙", "spain"],
  DE: ["德国", "germany"],
  CA: ["加拿大", "canada"],
  CN: ["中国", "china"],
};

function requiredDestinationCountryCodes(destination: string) {
  const normalized = destination.trim().toLocaleLowerCase();
  return Object.entries(destinationCountryAliases)
    .filter(([, aliases]) => aliases.some((alias) => normalized.includes(alias)))
    .map(([code]) => code);
}

export function hasTravelRequirements(plan: TravelPlanDocument) {
  return plan.trip.brief.destination.trim().length > 0;
}

export function assertDestinationOutputWithinBrief(
  plan: TravelPlanDocument,
  output: DestinationGenerateOutput,
) {
  const destination = plan.trip.brief.destination.trim();
  if (!destination) throw new Error("请先填写目的地，再生成目的地建议。");
  const allowedCountryCodes = requiredDestinationCountryCodes(destination);
  if (!allowedCountryCodes.length) return;
  const invalid = output.places.filter(
    (place) => !place.countryCode || !allowedCountryCodes.includes(place.countryCode),
  );
  if (invalid.length) {
    throw new Error(
      `目的地范围为“${destination}”，AI 返回了范围外地点：${invalid.map((place) => place.nameZh).join("、")}。`,
    );
  }
}

export function normalizeCandidateDiscoveryOutput(output: any, mode: "macro" | "micro") {
  if (mode === "macro") {
    return {
      schemaVersion: 2,
      baseGeneration: output.baseGeneration,
      assistantMessage: output.assistantMessage,
      places: output.places,
      candidates: output.candidates.map((candidate: any) => {
        const { planningAreaCandidateId: _legacyParent, ...backboneCandidate } = candidate;
        return { ...backboneCandidate, defaultPreference: "optional" };
      }),
    };
  }
  return output;
}

export function candidateCommand(output: { places: any[]; candidates: any[] }) {
  const source = output.candidates[0];
  const place = output.places.find((item) => item.id === source?.placeTemporaryId) ?? output.places[0];
  if (!source || !place) throw new Error("AI 没有返回可正式化的地点。");
  return PlanCommandSchema.parse({
    type: "add_candidate",
    place,
    candidate: {
      id: source.temporaryId,
      placeId: place.id,
      planningAreaCandidateId: source.planningAreaCandidateId,
      ...(source.planningRole ? { planningRole: source.planningRole } : {}),
      preference: "optional",
      source: "ai",
      aiReason: source.aiReason,
      aiScore: source.aiScore,
      suggestedDurationMinutes: source.suggestedDurationMinutes,
      tags: source.tags,
    },
  });
}
