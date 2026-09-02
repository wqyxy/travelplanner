import { z } from "zod";
import {
  DialogueActionParametersSchema,
  type AiActionOrigin,
  type AiActionType,
  type InputContractIdV3,
} from "./ai-stage-contracts-v3.js";

const Id = z.string().trim().min(1).max(160);
const Request = z.string().trim().min(1).max(4000);
const Preference = z.enum(["must_go", "want_to_go", "optional", "excluded"]);
const RequirementField = z.enum(["title", "brief", "dates", "travelers", "budget", "pace", "themes", "preferences", "constraints", "assumptions"]);
const Assumption = z.object({ text: z.string().trim().min(1).max(500), source: z.enum(["user", "ai", "system"]), confidence: z.enum(["low", "medium", "high"]) }).strict();
const RequirementsPatch = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  brief: z.object({
    destination: z.string().trim().max(500).optional(),
    origin: z.string().trim().max(500).optional(),
    departureTime: z.string().trim().max(500).optional(),
    duration: z.string().trim().max(500).optional(),
    travelers: z.string().trim().max(500).optional(),
    transport: z.string().trim().max(500).optional(),
    additionalRequirements: z.string().trim().max(4000).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "brief 至少需要一个字段。").optional(),
  dates: z.object({ start: z.string().trim().min(1).max(40).nullable(), end: z.string().trim().min(1).max(40).nullable(), requestedDurationDays: z.number().int().min(1).max(365).nullable() }).strict().optional(),
  travelers: z.object({ summary: z.string().max(1000), adults: z.number().int().min(0).max(100).nullable(), children: z.number().int().min(0).max(100).nullable() }).strict().optional(),
  budget: z.object({ amount: z.number().finite().nonnegative().nullable(), currency: z.string().trim().min(1).max(20).nullable(), note: z.string().max(1000).nullable() }).strict().optional(),
  pace: z.string().trim().min(1).max(120).nullable().optional(),
  themes: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  preferences: z.array(z.string().trim().min(1).max(500)).max(40).optional(),
  constraints: z.array(z.string().trim().min(1).max(500)).max(40).optional(),
  assumptions: z.array(Assumption).max(40).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "requirements.update 至少需要一个旅行需求字段。");
const PlaceChanges = z.object({
  nameZh: z.string().trim().min(1).max(300).optional(),
  nameLocal: z.string().trim().min(1).max(300).nullable().optional(),
  nameEn: z.string().trim().min(1).max(300).nullable().optional(),
  kind: z.enum(["city", "attraction", "lodging", "meal", "airport", "station", "port", "stop", "waypoint"]).optional(),
  city: z.string().trim().min(1).max(160).nullable().optional(),
  region: z.string().trim().min(1).max(160).nullable().optional(),
  country: z.string().trim().min(1).max(160).nullable().optional(),
  countryCode: z.string().trim().length(2).nullable().optional(),
  approximate: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "地点编辑至少需要一个字段。");
const CandidateChanges = z.object({
  aiReason: z.string().trim().min(1).max(1000).nullable().optional(),
  aiScore: z.number().finite().min(0).max(100).nullable().optional(),
  suggestedDurationMinutes: z.number().int().min(0).max(10080).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Candidate 编辑至少需要一个字段。");
const ItineraryChanges = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  date: z.string().trim().min(1).max(40).nullable().optional(),
  activity: z.string().trim().min(1).max(2000).optional(),
  period: z.enum(["morning", "afternoon", "evening", "night", "all_day"]).nullable().optional(),
  startTime: z.string().trim().min(1).max(20).nullable().optional(),
  endTime: z.string().trim().min(1).max(20).nullable().optional(),
  durationMinutes: z.number().int().min(0).max(10080).nullable().optional(),
  costNote: z.string().max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  scheduleVerification: z.object({ status: z.enum(["verified", "estimated", "unverified"]), checkedAt: z.string().datetime({ offset: true }).nullable() }).strict().nullable().optional(),
  costVerification: z.object({ status: z.enum(["verified", "estimated", "unverified"]), checkedAt: z.string().datetime({ offset: true }).nullable() }).strict().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "行程编辑至少需要一个字段。");

const Empty = z.object({}).strict();
const RequirementsCapture = z.object({ additionalRequirements: z.string().trim().min(1).max(4000) }).strict();
const Intent = z.object({ request: Request.optional(), allowWeb: z.boolean().optional() }).strict();
const CandidateTarget = z.object({ candidateId: Id.optional() }).strict();
const PreferenceInput = z.object({ candidateId: Id.optional(), candidateIds: z.array(Id).max(200).optional(), preference: Preference }).strict();
const CandidateEdit = z.object({ candidateId: Id.optional(), placeChanges: PlaceChanges.optional(), candidateChanges: CandidateChanges.optional() }).strict().refine((value) => Boolean(value.placeChanges || value.candidateChanges), "编辑动作至少需要 placeChanges 或 candidateChanges。");
const DestinationCandidateEdit = z.object({
  candidateId: Id.optional(),
  request: z.literal("promote_to_core").optional(),
  placeChanges: PlaceChanges.optional(),
  candidateChanges: CandidateChanges.optional(),
}).strict().refine((value) => Boolean(value.placeChanges || value.candidateChanges || value.request === "promote_to_core"), "目的地编辑至少需要字段修改或受控重要游览地升级意图。");
const DayOptimize = z.object({ dayId: Id.optional(), request: Request.optional() }).strict();
const Refine = z.object({ dayIds: z.array(Id).max(2).optional(), request: Request.optional(), allowWeb: z.boolean().optional() }).strict();
const DetailUpdate = z.object({ dayIds: z.array(Id).max(90).optional(), request: Request.optional(), allowWeb: z.boolean().optional() }).strict();

const ACTION_INPUT_CONTRACTS: Record<AiActionType, InputContractIdV3> = {
  "requirements.update": "requirements.mutation.input",
  "requirements.clear": "requirements.mutation.input",
  "requirements.capture": "requirements.capture.input",
  "destination.generate": "destination.action.input",
  "destination.add": "destination.action.input",
  "destination.remove": "destination.action.input",
  "destination.replace": "destination.action.input",
  "destination.edit": "destination.action.input",
  "destination.preference": "destination.action.input",
  "interest.discover": "interest.action.input",
  "interest.supplement": "interest.action.input",
  "interest.add": "interest.action.input",
  "interest.remove": "interest.action.input",
  "interest.replace": "interest.action.input",
  "interest.edit": "interest.action.input",
  "interest.preference": "interest.action.input",
  "itinerary.generate": "itinerary.action.input",
  "itinerary.replan": "itinerary.action.input",
  "itinerary.detail.generate": "itinerary.action.input",
  "itinerary.detail.update": "itinerary.action.input",
  "itinerary.stop.add": "itinerary.action.input",
  "itinerary.stop.remove": "itinerary.action.input",
  "itinerary.stop.replace": "itinerary.action.input",
  "itinerary.stop.move": "itinerary.action.input",
  "itinerary.day.reorder": "itinerary.action.input",
  "itinerary.edit": "itinerary.action.input",
  "itinerary.anchor.set": "itinerary.action.input",
  "itinerary.day.optimize": "itinerary.action.input",
  "itinerary.repair": "itinerary.action.input",
  "itinerary.verify": "itinerary.action.input",
  "itinerary.refine": "itinerary.action.input",
  "map.disambiguate": "map.disambiguate.input",
};

const CTA_SCHEMAS: Record<AiActionType, z.ZodType<Record<string, unknown>>> = {
  "requirements.update": z.object({ changes: RequirementsPatch }).strict(),
  "requirements.clear": z.object({ fields: z.array(RequirementField).min(1).max(9) }).strict(),
  "requirements.capture": RequirementsCapture,
  "destination.generate": Intent,
  "destination.add": Intent,
  "destination.remove": CandidateTarget,
  "destination.replace": z.object({ candidateId: Id.optional(), request: Request.optional(), allowWeb: z.boolean().optional() }).strict(),
  "destination.edit": DestinationCandidateEdit,
  "destination.preference": PreferenceInput,
  "interest.discover": Intent,
  "interest.supplement": Intent,
  "interest.add": Intent,
  "interest.remove": CandidateTarget,
  "interest.replace": z.object({ candidateId: Id.optional(), request: Request.optional(), allowWeb: z.boolean().optional() }).strict(),
  "interest.edit": CandidateEdit,
  "interest.preference": PreferenceInput,
  "itinerary.generate": Intent,
  "itinerary.replan": Intent,
  "itinerary.detail.generate": Intent,
  "itinerary.detail.update": DetailUpdate,
  "itinerary.stop.add": z.object({ dayId: Id.optional(), candidateId: Id, index: z.number().int().min(0).max(100).nullable().optional(), activity: z.string().trim().min(1).max(2000).optional() }).strict(),
  "itinerary.stop.remove": z.object({ stopId: Id.optional() }).strict(),
  "itinerary.stop.replace": z.object({ stopId: Id.optional(), candidateId: Id, activity: z.string().trim().min(1).max(2000).optional() }).strict(),
  "itinerary.stop.move": z.object({ stopId: Id.optional(), targetDayId: Id, targetIndex: z.number().int().min(0).max(100) }).strict(),
  "itinerary.day.reorder": z.object({ dayId: Id.optional(), targetIndex: z.number().int().min(0).max(100) }).strict(),
  "itinerary.edit": z.object({ dayId: Id.optional(), stopId: Id.optional(), changes: ItineraryChanges }).strict().refine((value) => Boolean(value.dayId || value.stopId), "itinerary.edit 需要 dayId 或 stopId。"),
  "itinerary.anchor.set": z.object({ dayId: Id.optional(), anchor: z.enum(["start", "end"]), placeId: Id.nullable().optional(), label: z.string().trim().min(1).max(300).nullable().optional(), notes: z.string().max(2000).nullable().optional() }).strict(),
  "itinerary.day.optimize": DayOptimize,
  "itinerary.repair": Intent,
  "itinerary.verify": Intent,
  "itinerary.refine": Refine,
  "map.disambiguate": Empty,
};

function compactDialogue(actionType: AiActionType, value: unknown): Record<string, unknown> {
  if (actionType === "requirements.capture") return RequirementsCapture.parse(value);
  const p = DialogueActionParametersSchema.parse(value);
  const intent = () => ({ ...(p.request ? { request: p.request } : {}), ...(p.allowWeb !== null ? { allowWeb: p.allowWeb } : {}) });
  switch (actionType) {
    case "requirements.update": return CTA_SCHEMAS[actionType].parse({ changes: p.changes });
    case "requirements.clear": return CTA_SCHEMAS[actionType].parse({ fields: p.fields });
    case "destination.generate": case "destination.add": case "interest.discover": case "interest.supplement": case "interest.add": case "itinerary.generate": case "itinerary.replan": case "itinerary.detail.generate": case "itinerary.repair": case "itinerary.verify": return CTA_SCHEMAS[actionType].parse(intent());
    case "destination.remove": case "interest.remove": return CTA_SCHEMAS[actionType].parse({ ...(p.candidateId ? { candidateId: p.candidateId } : {}) });
    case "destination.replace": case "interest.replace": return CTA_SCHEMAS[actionType].parse({ ...(p.candidateId ? { candidateId: p.candidateId } : {}), ...intent() });
    case "destination.edit": return CTA_SCHEMAS[actionType].parse({ ...(p.candidateId ? { candidateId: p.candidateId } : {}), ...(p.request === "promote_to_core" ? { request: p.request } : {}), ...(p.placeChanges ? { placeChanges: p.placeChanges } : {}), ...(p.candidateChanges ? { candidateChanges: p.candidateChanges } : {}) });
    case "interest.edit": return CTA_SCHEMAS[actionType].parse({ ...(p.candidateId ? { candidateId: p.candidateId } : {}), ...(p.placeChanges ? { placeChanges: p.placeChanges } : {}), ...(p.candidateChanges ? { candidateChanges: p.candidateChanges } : {}) });
    case "destination.preference": case "interest.preference": return CTA_SCHEMAS[actionType].parse({ ...(p.candidateId ? { candidateId: p.candidateId } : {}), ...(p.candidateIds.length ? { candidateIds: p.candidateIds } : {}), preference: p.preference });
    case "itinerary.stop.add": return CTA_SCHEMAS[actionType].parse({ ...(p.dayId ? { dayId: p.dayId } : {}), ...(p.candidateId ? { candidateId: p.candidateId } : {}), index: p.index, ...(p.activity ? { activity: p.activity } : {}) });
    case "itinerary.stop.remove": return CTA_SCHEMAS[actionType].parse({ ...(p.stopId ? { stopId: p.stopId } : {}) });
    case "itinerary.stop.replace": return CTA_SCHEMAS[actionType].parse({ ...(p.stopId ? { stopId: p.stopId } : {}), ...(p.candidateId ? { candidateId: p.candidateId } : {}), ...(p.activity ? { activity: p.activity } : {}) });
    case "itinerary.stop.move": return CTA_SCHEMAS[actionType].parse({ ...(p.stopId ? { stopId: p.stopId } : {}), ...(p.targetDayId ? { targetDayId: p.targetDayId } : {}), ...(p.targetIndex !== null ? { targetIndex: p.targetIndex } : {}) });
    case "itinerary.day.reorder": return CTA_SCHEMAS[actionType].parse({ ...(p.dayId ? { dayId: p.dayId } : {}), ...(p.targetIndex !== null ? { targetIndex: p.targetIndex } : {}) });
    case "itinerary.edit": return CTA_SCHEMAS[actionType].parse({ ...(p.dayId ? { dayId: p.dayId } : {}), ...(p.stopId ? { stopId: p.stopId } : {}), ...(p.changes ? { changes: p.changes } : {}) });
    case "itinerary.anchor.set": return CTA_SCHEMAS[actionType].parse({ ...(p.dayId ? { dayId: p.dayId } : {}), ...(p.anchor ? { anchor: p.anchor } : {}), placeId: p.placeId, label: p.label, notes: p.notes });
    case "itinerary.day.optimize": return CTA_SCHEMAS[actionType].parse({ ...(p.dayId ? { dayId: p.dayId } : {}), ...(p.request ? { request: p.request } : {}) });
    case "itinerary.refine": return CTA_SCHEMAS[actionType].parse({ ...(p.dayIds.length ? { dayIds: p.dayIds } : {}), ...intent() });
    case "itinerary.detail.update": return CTA_SCHEMAS[actionType].parse({ ...(p.dayIds.length ? { dayIds: p.dayIds } : {}), ...intent() });
    case "map.disambiguate": return {};
  }
}

export function parseActionParametersV3(actionType: AiActionType, inputContract: InputContractIdV3, origin: AiActionOrigin, value: unknown): Record<string, unknown> {
  if (ACTION_INPUT_CONTRACTS[actionType] !== inputContract) throw new Error(`Action inputContract 注册不一致：${actionType}`);
  if (actionType === "requirements.capture") return RequirementsCapture.parse(value);
  if (origin === "conversation") return compactDialogue(actionType, value);
  return CTA_SCHEMAS[actionType].parse(value ?? {});
}
