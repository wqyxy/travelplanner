type RecordValue = Record<string, unknown>;

type ReplanHistoryAction = {
  actionType: string;
  status: string;
  sourceMessageId: string | null;
  updatedAt: string;
  completedAt: string | null;
};

type ReplanHistoryMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
};

export type ReplanHistoryStoreV3 = {
  listActions: (tripId: string) => ReplanHistoryAction[];
  listMessages: (tripId: string) => ReplanHistoryMessage[];
};

export type ExplicitReplanStayConstraintV3 = {
  candidateId: string;
  placeName: string;
  baselineDays: number;
  expectedDays: number;
  kind: "delta" | "absolute";
  deltaDays: number | null;
};

const SUCCESSFUL_ACTION_STATUSES = new Set(["completed", "applied"]);
const CHINESE_DIGITS: Record<string, number> = {
  "零": 0,
  "一": 1,
  "二": 2,
  "两": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
  "十": 10,
};
const NUMBER_TOKEN = "(\\d+|[零一二两三四五六七八九十])";

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function actionTime(action: ReplanHistoryAction) {
  return Date.parse(action.completedAt ?? action.updatedAt) || 0;
}

function isMacroSourceAction(actionType: string) {
  return actionType.startsWith("requirements.") || actionType.startsWith("destination.");
}

function parseCount(value: string) {
  if (/^\d+$/u.test(value)) return Number(value);
  return CHINESE_DIGITS[value];
}

function uniqueNames(area: RecordValue) {
  const place = asRecord(area.place);
  return [...new Set([place?.nameZh, place?.nameLocal, place?.nameEn]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))]
    .sort((left, right) => right.length - left.length);
}

function tailAfterName(request: string, name: string) {
  const index = request.indexOf(name);
  if (index < 0) return null;
  return request.slice(index + name.length, index + name.length + 40);
}

function parseInstruction(tail: string) {
  const separator = "^[\\s，,：:]*";
  const increase = new RegExp(`${separator}(?:多留|多住|增加(?:停留)?|多|加|延长)\\s*${NUMBER_TOKEN}\\s*天`, "u").exec(tail);
  if (increase) {
    const days = parseCount(increase[1]);
    return Number.isSafeInteger(days) ? { kind: "delta" as const, deltaDays: days } : null;
  }
  const decrease = new RegExp(`${separator}(?:少留|少住|减少(?:停留)?|少|减|缩短)\\s*${NUMBER_TOKEN}\\s*天`, "u").exec(tail);
  if (decrease) {
    const days = parseCount(decrease[1]);
    return Number.isSafeInteger(days) ? { kind: "delta" as const, deltaDays: -days } : null;
  }
  const absolute = new RegExp(`${separator}(?:改为|调整为|变为|变成|总共|一共|停留|住)\\s*(?:到|为)?\\s*${NUMBER_TOKEN}\\s*天`, "u").exec(tail);
  if (absolute) {
    const days = parseCount(absolute[1]);
    return Number.isSafeInteger(days) ? { kind: "absolute" as const, expectedDays: days } : null;
  }
  const signed = new RegExp(`${separator}([+-])\\s*(\\d+)\\s*(?:天|days?)`, "iu").exec(tail);
  if (signed) {
    const days = Number(signed[2]);
    return Number.isSafeInteger(days) ? { kind: "delta" as const, deltaDays: signed[1] === "+" ? days : -days } : null;
  }
  return null;
}

export function recoverReplanCtaParametersV3(
  store: ReplanHistoryStoreV3,
  tripId: string,
  actionType: string,
  parameters: Record<string, unknown>,
) {
  if (actionType !== "itinerary.replan") return parameters;
  const explicit = typeof parameters.request === "string" ? parameters.request.trim() : "";
  if (explicit) return parameters;

  const actions = store.listActions(tripId);
  const baseline = actions
    .filter((action) => (action.actionType === "itinerary.generate" || action.actionType === "itinerary.replan") && SUCCESSFUL_ACTION_STATUSES.has(action.status))
    .sort((left, right) => actionTime(right) - actionTime(left))[0];
  if (!baseline) return parameters;

  const baselineAt = actionTime(baseline);
  const messages = new Map(store.listMessages(tripId).map((message) => [message.id, message]));
  const causal = actions
    .filter((action) => action.sourceMessageId
      && SUCCESSFUL_ACTION_STATUSES.has(action.status)
      && isMacroSourceAction(action.actionType)
      && actionTime(action) > baselineAt)
    .sort((left, right) => actionTime(right) - actionTime(left));

  for (const action of causal) {
    const message = action.sourceMessageId ? messages.get(action.sourceMessageId) : null;
    if (!message || message.role !== "user") continue;
    const request = message.content.trim();
    if (request) return { ...parameters, request: request.slice(0, 4000) };
  }
  return parameters;
}

export function deriveExplicitReplanStayConstraintsV3(stateValue: unknown): ExplicitReplanStayConstraintV3[] {
  const state = asRecord(stateValue);
  const parameters = asRecord(state?.parameters);
  const request = typeof parameters?.request === "string" ? parameters.request.trim() : "";
  if (!state || !request) return [];

  const stays = Array.isArray(state.currentStays) ? state.currentStays.map(asRecord).filter((item): item is RecordValue => Boolean(item)) : [];
  const baselineByArea = new Map<string, number>();
  for (const stay of stays) {
    if (typeof stay.planningAreaCandidateId !== "string") continue;
    const stayDays = typeof stay.stayDays === "number" ? stay.stayDays : 0;
    baselineByArea.set(stay.planningAreaCandidateId, (baselineByArea.get(stay.planningAreaCandidateId) ?? 0) + stayDays);
  }

  const areas = Array.isArray(state.planningAreas) ? state.planningAreas.map(asRecord).filter((item): item is RecordValue => Boolean(item)) : [];
  const constraints: ExplicitReplanStayConstraintV3[] = [];
  for (const area of areas) {
    if (typeof area.id !== "string") continue;
    const names = uniqueNames(area);
    const matchedName = names.find((name) => request.includes(name));
    if (!matchedName) continue;
    const tail = tailAfterName(request, matchedName);
    if (tail === null) continue;
    const instruction = parseInstruction(tail);
    if (!instruction) continue;
    const baselineDays = baselineByArea.get(area.id) ?? 0;
    const expectedDays = instruction.kind === "delta" ? baselineDays + instruction.deltaDays : instruction.expectedDays;
    if (!Number.isSafeInteger(expectedDays) || expectedDays < 0) {
      throw new Error(`用户对${matchedName}的明确停留天数调整无法形成非负整数天数。`);
    }
    constraints.push({
      candidateId: area.id,
      placeName: matchedName,
      baselineDays,
      expectedDays,
      kind: instruction.kind,
      deltaDays: instruction.kind === "delta" ? instruction.deltaDays : null,
    });
  }
  return constraints;
}
