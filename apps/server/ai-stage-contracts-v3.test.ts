import { describe, expect, it } from "vitest";
import { StageDialogueOutputSchema } from "./ai-stage-contracts-v3.js";
import { buildOpenAiStructuredOutputSchema } from "./structured-ai-v2.js";

function assertNoFreeFormObjects(value: unknown, path = "root") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoFreeFormObjects(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const objectLike = record.type === "object" || (Array.isArray(record.type) && record.type.includes("object"));
  if (objectLike && record.properties && typeof record.properties === "object") {
    expect(record.additionalProperties, `${path} must be closed`).toBe(false);
  }
  if (record.additionalProperties && record.additionalProperties !== false) {
    throw new Error(`free-form additionalProperties at ${path}`);
  }
  for (const [key, child] of Object.entries(record)) assertNoFreeFormObjects(child, `${path}.${key}`);
}

function emptyParameters() {
  return {
    request: "把节奏改轻松一点",
    candidateId: null,
    candidateIds: [],
    preference: null,
    dayId: null,
    dayIds: [],
    stopId: null,
    targetDayId: null,
    targetIndex: null,
    index: null,
    anchor: null,
    placeId: null,
    label: null,
    notes: null,
    activity: null,
    fields: [],
    changes: { pace: "relaxed" },
    placeChanges: null,
    candidateChanges: null,
    allowWeb: null,
  };
}

describe("StageDialogueOutput strict transport", () => {
  it("builds a closed OpenAI structured-output schema", () => {
    const schema = buildOpenAiStructuredOutputSchema(StageDialogueOutputSchema);
    assertNoFreeFormObjects(schema);
  });

  it("accepts the controlled action envelope and rejects invented parameter keys", () => {
    expect(StageDialogueOutputSchema.safeParse({
      schemaVersion: 1,
      result: {
        type: "action",
        assistantMessage: "可以，我先生成一个待确认动作。",
        actionType: "requirements.update",
        parameters: emptyParameters(),
        targetIds: [],
        impactSummary: "只修改旅行节奏。",
      },
    }).success).toBe(true);

    expect(StageDialogueOutputSchema.safeParse({
      schemaVersion: 1,
      result: {
        type: "action",
        assistantMessage: "测试",
        actionType: "requirements.update",
        parameters: { ...emptyParameters(), inventedKey: "not allowed" },
        targetIds: [],
        impactSummary: "测试",
      },
    }).success).toBe(false);
  });
});
