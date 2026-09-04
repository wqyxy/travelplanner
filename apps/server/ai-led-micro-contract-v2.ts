import { z } from "zod";
import { containsForbiddenResearchLink } from "./candidate-discovery-policy-v2.js";
import {
  IdSchema,
  PlaceSchema,
  TextSchema,
  type MicroCandidateDiscoveryOutput,
} from "./contracts-v2.js";

const prominence = z.enum(["iconic", "major", "supporting"]);
const experienceType = z.enum([
  "landmark",
  "photo",
  "viewpoint",
  "museum_culture",
  "nature",
  "heritage_architecture",
  "family",
  "outdoor",
]);
const visitPointType = z.enum([
  "venue",
  "landmark",
  "photo_spot",
  "viewpoint",
  "trailhead",
  "attraction_entrance",
  "experience_meeting_point",
]);
const researchBasis = z.enum(["multi_guide_consensus", "official_status_verified", "user_theme_match"]);

const item = z.object({
  temporaryId: IdSchema,
  placeTemporaryId: IdSchema,
  planningAreaCandidateId: IdSchema.nullable(),
  aiReason: TextSchema.max(1000),
  aiScore: z.number().int().min(0).max(100),
  suggestedDurationMinutes: z.number().int().min(0).max(10080).nullable(),
  tags: z.array(TextSchema.max(120)).max(30),
  defaultPreference: z.literal("optional"),
  prominence,
  experienceTypes: z.array(experienceType).min(1).max(8),
  visitPointType,
  researchBasis: z.array(researchBasis).min(1).max(3),
}).strict();

export const AiLedMicroCandidateDiscoveryOutputSchema = z.object({
  schemaVersion: z.literal(1),
  baseGeneration: z.number().int().min(0),
  assistantMessage: TextSchema.max(12000),
  areaTargets: z.array(z.object({
    planningAreaCandidateId: IdSchema,
    targetCount: z.number().int().min(0).max(9),
    reason: TextSchema.max(1000),
  }).strict()).length(1),
  places: z.array(PlaceSchema).max(9),
  candidates: z.array(item).max(9),
}).strict().superRefine((value, context) => {
  if (containsForbiddenResearchLink(value)) {
    context.addIssue({ code: "custom", path: [], message: "兴趣点研究来源链接或引用列表不得写入结构化输出。" });
  }
  const targetId = value.areaTargets[0]?.planningAreaCandidateId;
  const placeIds = new Set(value.places.map((place) => place.id));
  if (placeIds.size !== value.places.length) context.addIssue({ code: "custom", path: ["places"], message: "临时 Place ID 不能重复。" });
  const candidateIds = new Set<string>();
  const refs = new Set<string>();
  for (const [index, candidate] of value.candidates.entries()) {
    if (candidateIds.has(candidate.temporaryId)) context.addIssue({ code: "custom", path: ["candidates", index, "temporaryId"], message: "临时 Candidate ID 不能重复。" });
    if (!placeIds.has(candidate.placeTemporaryId)) context.addIssue({ code: "custom", path: ["candidates", index, "placeTemporaryId"], message: "Candidate 必须引用本轮 Place。" });
    if (refs.has(candidate.placeTemporaryId)) context.addIssue({ code: "custom", path: ["candidates", index, "placeTemporaryId"], message: "同一 Place 只能生成一个 Candidate。" });
    if (!candidate.planningAreaCandidateId || candidate.planningAreaCandidateId !== targetId) context.addIssue({ code: "custom", path: ["candidates", index, "planningAreaCandidateId"], message: "每个兴趣点 Candidate 必须归属本轮唯一 Planning Area Candidate。" });
    candidateIds.add(candidate.temporaryId);
    refs.add(candidate.placeTemporaryId);
  }
  if (value.places.length !== value.candidates.length) context.addIssue({ code: "custom", path: ["places"], message: "Place 与 Candidate 数量必须一致。" });
  if (value.areaTargets[0] && value.areaTargets[0].targetCount !== value.candidates.length) context.addIssue({ code: "custom", path: ["areaTargets", 0, "targetCount"], message: "targetCount 必须等于实际 Candidate 数量。" });
});

export const AiLedMicroCandidateDiscoveryOutputJsonSchema = z.toJSONSchema(AiLedMicroCandidateDiscoveryOutputSchema) as Record<string, unknown>;

export type AiLedMicroCandidateDiscoveryOutput = MicroCandidateDiscoveryOutput;
