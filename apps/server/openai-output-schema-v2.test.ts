import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AdjustmentProposalOutputSchema,
  CandidateDiscoveryOutputSchema,
  ConversationOutputSchema,
  DetailBatchOutputV2Schema,
  MapResolutionAssistOutputSchema,
  PlanGenerationOutputSchema,
} from "./contracts-v2.js";
import {
  buildOpenAiStructuredOutputSchema,
  normalizeStructuredOutputTransport,
} from "./openai-output-schema-v2.js";

const outputSchemas = [
  ConversationOutputSchema,
  CandidateDiscoveryOutputSchema,
  PlanGenerationOutputSchema,
  AdjustmentProposalOutputSchema,
  DetailBatchOutputV2Schema,
  MapResolutionAssistOutputSchema,
] as const;

function assertOpenAiCompatible(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(assertOpenAiCompatible);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const forbidden of ["oneOf", "allOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas"]) {
    expect(record, `forbidden keyword ${forbidden}`).not.toHaveProperty(forbidden);
  }
  const objectType = record.type === "object" || (Array.isArray(record.type) && record.type.includes("object"));
  if (objectType && record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    const keys = Object.keys(record.properties as Record<string, unknown>).sort();
    expect(record.additionalProperties).toBe(false);
    expect([...(record.required as string[] ?? [])].sort()).toEqual(keys);
  }
  Object.values(record).forEach(assertOpenAiCompatible);
}

describe("OpenAI structured output adapter", () => {
  it("builds compatible schemas for every AI output contract", () => {
    for (const schema of outputSchemas) {
      const converted = buildOpenAiStructuredOutputSchema(schema);
      expect(converted.type).toBe("object");
      assertOpenAiCompatible(converted);
    }
  });

  it("does not silently change mixed required/optional object semantics", () => {
    const mixed = z.object({ required: z.string(), optional: z.string().optional() }).strict();
    expect(() => buildOpenAiStructuredOutputSchema(mixed)).toThrow("不能混用 required/optional");
  });

  it("preserves partial update semantics through patch transport", () => {
    const transport = {
      schemaVersion: 1,
      baseGeneration: 7,
      scope: { type: "trip", id: null },
      assistantMessage: "已调整标题。",
      title: "调整第 3 天",
      explanation: "只更新标题，不修改日期。",
      commands: [{
        type: "update_day",
        dayId: "day-3",
        changes: {
          __patch: [{ field: "title", value: "皇后镇休闲日" }],
        },
      }],
    };
    const normalized = normalizeStructuredOutputTransport(transport) as any;
    expect(normalized.commands[0].changes).toEqual({ title: "皇后镇休闲日" });
    expect("date" in normalized.commands[0].changes).toBe(false);
    expect(AdjustmentProposalOutputSchema.parse(normalized).commands[0]).toMatchObject({
      type: "update_day",
      changes: { title: "皇后镇休闲日" },
    });
  });

  it("distinguishes explicit null from an omitted update field", () => {
    const normalized = normalizeStructuredOutputTransport({
      __patch: [{ field: "nameLocal", value: null }],
    });
    expect(normalized).toEqual({ nameLocal: null });
  });

  it("rejects duplicate patch fields", () => {
    expect(() => normalizeStructuredOutputTransport({
      __patch: [
        { field: "title", value: "A" },
        { field: "title", value: "B" },
      ],
    })).toThrow("字段重复");
  });
});
