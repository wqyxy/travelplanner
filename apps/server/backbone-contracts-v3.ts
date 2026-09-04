import { z } from "zod";
import {
  IdSchema,
  PlaceSchema,
  TextSchema,
  type Place,
} from "./contracts-v2.js";

export const BackbonePlanningRoleSchema = z.enum(["planning_area", "core_visit"]);
export type BackbonePlanningRole = z.infer<typeof BackbonePlanningRoleSchema>;

export const ParentCandidateRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("existing"), candidateId: IdSchema }).strict(),
  z.object({ type: z.literal("generated"), temporaryCandidateId: IdSchema }).strict(),
]);
export type ParentCandidateRef = z.infer<typeof ParentCandidateRefSchema>;

export const BackboneCandidateDraftSchema = z.object({
  temporaryId: IdSchema,
  placeTemporaryId: IdSchema,
  planningRole: BackbonePlanningRoleSchema,
  parentCandidateRef: ParentCandidateRefSchema.nullable(),
  aiReason: TextSchema.max(1000),
  aiScore: z.number().int().min(0).max(100),
  suggestedDurationMinutes: z.number().int().min(0).max(10080).nullable(),
  tags: z.array(TextSchema.max(120)).max(30),
  defaultPreference: z.literal("optional"),
}).strict();
export type BackboneCandidateDraft = z.infer<typeof BackboneCandidateDraftSchema>;

export function validateBackboneDraftBatch(
  value: { places: Place[]; candidates: BackboneCandidateDraft[] },
  context: z.RefinementCtx,
) {
  const placesById = new Map(value.places.map((place) => [place.id, place]));
  if (placesById.size !== value.places.length) {
    context.addIssue({ code: "custom", path: ["places"], message: "临时 Place ID 不能重复。" });
  }

  const candidatesById = new Map<string, BackboneCandidateDraft>();
  const referencedPlaceIds = new Set<string>();
  for (const [index, candidate] of value.candidates.entries()) {
    if (candidatesById.has(candidate.temporaryId)) {
      context.addIssue({ code: "custom", path: ["candidates", index, "temporaryId"], message: "临时 Candidate ID 不能重复。" });
    }
    if (!placesById.has(candidate.placeTemporaryId)) {
      context.addIssue({ code: "custom", path: ["candidates", index, "placeTemporaryId"], message: "Candidate 必须引用本轮 Place。" });
    }
    if (referencedPlaceIds.has(candidate.placeTemporaryId)) {
      context.addIssue({ code: "custom", path: ["candidates", index, "placeTemporaryId"], message: "同一临时 Place 只能对应一个 Backbone Candidate。" });
    }
    referencedPlaceIds.add(candidate.placeTemporaryId);
    candidatesById.set(candidate.temporaryId, candidate);
  }

  for (const [index, candidate] of value.candidates.entries()) {
    const parent = candidate.parentCandidateRef;
    if (!parent) continue;
    if (parent.type === "existing") {
      if (candidatesById.has(parent.candidateId)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "parentCandidateRef"],
          message: "existing parent 不得引用本轮 temporaryId；本轮生成的父 Candidate 必须使用 generated parent。",
        });
      }
      continue;
    }
    if (parent.temporaryCandidateId === candidate.temporaryId) {
      context.addIssue({
        code: "custom",
        path: ["candidates", index, "parentCandidateRef"],
        message: "Candidate 不得把自己设为父级。",
      });
      continue;
    }
    if (!candidatesById.has(parent.temporaryCandidateId)) {
      context.addIssue({
        code: "custom",
        path: ["candidates", index, "parentCandidateRef"],
        message: "generated parent 必须引用本轮存在的 Candidate。",
      });
    }
  }

  for (const [index, candidate] of value.candidates.entries()) {
    const seen = new Set<string>([candidate.temporaryId]);
    let current: BackboneCandidateDraft | undefined = candidate;
    while (current?.parentCandidateRef?.type === "generated") {
      const parentId = current.parentCandidateRef.temporaryCandidateId;
      if (seen.has(parentId)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "parentCandidateRef"],
          message: "Candidate 父级关系不得形成循环。",
        });
        break;
      }
      seen.add(parentId);
      current = candidatesById.get(parentId);
      if (!current) break;
    }
  }
}
