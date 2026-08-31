import { describe, expect, it } from "vitest";
import { ACTION_REGISTRY_V3, PROMPT_REGISTRY_V3, validateRegistryDefinitionsV3 } from "./ai-registries-v3.js";
import { AiActionTypeSchema, ConversationStageSchema } from "./ai-stage-contracts-v3.js";

describe("staged AI registries", () => {
  it("keeps ConversationStage separate from canonical TripStage values", () => {
    expect(ConversationStageSchema.options).toEqual(["requirements", "destinations", "interests", "itinerary"]);
    expect(ConversationStageSchema.safeParse("place_selection").success).toBe(false);
  });

  it("registers every closed action exactly once", () => {
    const expected = new Set(AiActionTypeSchema.options);
    const actual = new Set(ACTION_REGISTRY_V3.map((item) => item.id));
    expect(actual).toEqual(expected);
    expect(ACTION_REGISTRY_V3).toHaveLength(expected.size);
  });

  it("never binds AI configuration to deterministic actions", () => {
    for (const action of ACTION_REGISTRY_V3.filter((item) => item.executor === "deterministic")) {
      expect(action.promptId).toBeUndefined();
      expect(action.reasoning).toBeUndefined();
      expect(action.reasoningSummary).toBeUndefined();
      expect(action.web).toBeUndefined();
    }
  });

  it("binds every AI action to one action prompt with matching stage and output contract", () => {
    for (const action of ACTION_REGISTRY_V3.filter((item) => item.executor === "ai")) {
      const prompt = PROMPT_REGISTRY_V3.find((item) => item.id === action.promptId);
      expect(prompt?.kind).toBe("action");
      if (prompt?.kind === "action") {
        expect(prompt.stage).toBe(action.stage);
        expect(prompt.outputContract).toBe(action.outputContract);
      }
    }
    expect(validateRegistryDefinitionsV3()).toBe(true);
  });
});
