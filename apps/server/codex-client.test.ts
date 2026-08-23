import { describe, expect, it } from "vitest";
import {
  CodexRpcError,
  classifyCodexFailure,
  nextCodexRetry,
  structuredTurn,
  type ReasoningSummary,
  type TurnStartParams,
} from "./codex-client.js";

describe("Codex app-server protocol", () => {
  it("accepts only the app-server reasoning-summary variants", () => {
    const legal: ReasoningSummary[] = ["auto", "concise", "detailed", "none"];
    expect(legal).toHaveLength(4);

    // This assertion is intentionally checked by tsc, not at runtime.
    // @ts-expect-error Business task labels are not ReasoningSummary values.
    const invalid: TurnStartParams = { threadId: "thread", input: [], summary: "route outline" };
    expect(invalid.summary).toBe("route outline");
    // @ts-expect-error Arbitrary UI text is not a protocol reasoning-effort value.
    const invalidEffort: TurnStartParams = { threadId: "thread", input: [], effort: "deep thinking" };
    expect(invalidEffort.effort).toBe("deep thinking");
  });

  it.each([
    "ordinary question",
    "route update",
    "route skeleton repair",
    "critical transport verification",
    "daily detail",
    "daily repair",
    "map manifest",
    "map resolution",
  ])("builds %s turns with a legal detailed summary", () => {
    const request = structuredTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "controlled input", text_elements: [] }],
      outputSchema: { type: "object" },
      model: "gpt-5",
      effort: "medium",
    });
    expect(request.summary).toBe("detailed");
  });

  it.each([
    [new CodexRpcError("Invalid request: unknown variant route outline, expected one of auto, concise, detailed, none"), "protocol"],
    [new Error("output schema is invalid"), "protocol"],
    [new Error("login required"), "authentication"],
    [new Error("model is unavailable"), "model"],
    [new Error("ECONNRESET: stream disconnected"), "transient"],
    [new Error("request timeout"), "transient"],
    [new Error("unexpected application failure"), "unknown"],
  ] as const)("classifies %s as %s", (error, expected) => {
    expect(classifyCodexFailure(error)).toBe(expected);
  });

  it("limits transient retries to 15/30/60 seconds", () => {
    expect(nextCodexRetry(0)).toEqual({ attempt: 1, delayMs: 15_000 });
    expect(nextCodexRetry(1)).toEqual({ attempt: 2, delayMs: 30_000 });
    expect(nextCodexRetry(2)).toEqual({ attempt: 3, delayMs: 60_000 });
    expect(nextCodexRetry(3)).toBeNull();
    expect(nextCodexRetry(99)).toBeNull();
  });
});
