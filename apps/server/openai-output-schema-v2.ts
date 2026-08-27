import { z, type ZodType } from "zod";

export const STRUCTURED_PATCH_KEY = "__patch";
const FORBIDDEN_SCHEMA_KEYS = new Set(["allOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isObjectSchema(record: Record<string, unknown>) {
  return record.type === "object" || (Array.isArray(record.type) && record.type.includes("object"));
}

function transportSchema(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item, index) => transportSchema(item, [...path, String(index)]));
  if (!isRecord(value)) return value;

  const record = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transportSchema(item, [...path, key])])) as Record<string, unknown>;
  delete record.$schema;

  if (Array.isArray(record.oneOf)) {
    if (record.anyOf !== undefined) throw new Error(`AI output schema 同时包含 oneOf/anyOf：${path.join(".") || "root"}`);
    record.anyOf = record.oneOf;
    delete record.oneOf;
  }

  for (const key of FORBIDDEN_SCHEMA_KEYS) {
    if (record[key] !== undefined) throw new Error(`AI output schema 不支持 ${key}：${path.join(".") || "root"}`);
  }

  if (isObjectSchema(record) && isRecord(record.properties)) {
    const properties = record.properties;
    const keys = Object.keys(properties);
    if (keys.includes(STRUCTURED_PATCH_KEY)) throw new Error(`业务 Schema 不得使用保留字段 ${STRUCTURED_PATCH_KEY}：${path.join(".") || "root"}`);
    const required = new Set(Array.isArray(record.required) ? record.required.filter((item): item is string => typeof item === "string") : []);
    const optionalKeys = keys.filter((key) => !required.has(key));

    if (optionalKeys.length) {
      if (required.size) throw new Error(`AI output object 不能混用 required/optional 字段：${path.join(".") || "root"}`);
      if (!keys.length) throw new Error(`AI output optional object 没有可修改字段：${path.join(".") || "root"}`);
      return {
        type: "object",
        properties: {
          [STRUCTURED_PATCH_KEY]: {
            type: "array",
            minItems: 1,
            maxItems: keys.length,
            items: {
              anyOf: keys.map((key) => ({
                type: "object",
                properties: {
                  field: { type: "string", const: key },
                  value: properties[key],
                },
                required: ["field", "value"],
                additionalProperties: false,
              })),
            },
          },
        },
        required: [STRUCTURED_PATCH_KEY],
        additionalProperties: false,
      };
    }

    if (required.size !== keys.length) throw new Error(`AI output object required 与 properties 不一致：${path.join(".") || "root"}`);
    record.required = keys;
    record.additionalProperties = false;
  }

  return record;
}

export function buildOpenAiStructuredOutputSchema(schema: ZodType<unknown>): Record<string, unknown> {
  const converted = transportSchema(z.toJSONSchema(schema));
  if (!isRecord(converted) || !isObjectSchema(converted)) throw new Error("AI output schema 根节点必须是 object。");
  return converted;
}

export function normalizeStructuredOutputTransport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStructuredOutputTransport);
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === STRUCTURED_PATCH_KEY) {
    const entries = value[STRUCTURED_PATCH_KEY];
    if (!Array.isArray(entries) || !entries.length) throw new Error("AI patch 至少需要一个字段修改。");
    const result: Record<string, unknown> = {};
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.field !== "string" || !("value" in entry)) throw new Error("AI patch 项格式无效。");
      if (entry.field in result) throw new Error(`AI patch 字段重复：${entry.field}`);
      result[entry.field] = normalizeStructuredOutputTransport(entry.value);
    }
    return result;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeStructuredOutputTransport(item)]));
}
