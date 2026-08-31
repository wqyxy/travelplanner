import type { ReasoningEffort, ReasoningSummary } from "./codex-client.js";
import type {
  ActionResultPolicyV3,
  AiActionExecutor,
  AiActionType,
  ConversationStage,
  InputContractIdV3,
  OutputContractIdV3,
  PromptIdV3,
  PromptWebPolicyV3,
  ScopePolicyIdV3,
} from "./ai-stage-contracts-v3.js";

export type PromptRegistrationV3 =
  | { id: "shared.travel-rules"; relativePath: string; kind: "shared" }
  | { id: PromptIdV3; relativePath: string; kind: "dialogue"; stage: ConversationStage; reasoning: "none"; reasoningSummary: "none"; web: "disabled"; outputContract: "stage.dialogue.output" }
  | { id: PromptIdV3; relativePath: string; kind: "action"; stage: ConversationStage | "map"; reasoning: "low" | "medium" | "high"; reasoningSummary: "none" | "auto" | "detailed"; web: PromptWebPolicyV3; outputContract: OutputContractIdV3 };

export type ActionRegistrationV3 = {
  id: AiActionType;
  stage: ConversationStage | "map";
  executor: AiActionExecutor;
  promptId?: PromptIdV3;
  reasoning?: Extract<ReasoningEffort, "low" | "medium" | "high">;
  reasoningSummary?: Extract<ReasoningSummary, "none" | "auto" | "detailed">;
  web?: PromptWebPolicyV3;
  /** Optional Action-wide timeout. Structured repair attempts remain within this budget. */
  timeoutMs?: number;
  inputContract: InputContractIdV3;
  outputContract: OutputContractIdV3;
  scopePolicy: ScopePolicyIdV3;
  resultPolicy: ActionResultPolicyV3;
};

export const PROMPT_REGISTRY_V3: readonly PromptRegistrationV3[] = [
  { id: "shared.travel-rules", relativePath: "shared/旅行规划共享规则.md", kind: "shared" },
  { id: "dialogue.requirements", relativePath: "dialogues/旅行需求对话.md", kind: "dialogue", stage: "requirements", reasoning: "none", reasoningSummary: "none", web: "disabled", outputContract: "stage.dialogue.output" },
  { id: "dialogue.destinations", relativePath: "dialogues/目的地对话.md", kind: "dialogue", stage: "destinations", reasoning: "none", reasoningSummary: "none", web: "disabled", outputContract: "stage.dialogue.output" },
  { id: "dialogue.interests", relativePath: "dialogues/兴趣点对话.md", kind: "dialogue", stage: "interests", reasoning: "none", reasoningSummary: "none", web: "disabled", outputContract: "stage.dialogue.output" },
  { id: "dialogue.itinerary", relativePath: "dialogues/行程对话.md", kind: "dialogue", stage: "itinerary", reasoning: "none", reasoningSummary: "none", web: "disabled", outputContract: "stage.dialogue.output" },
  { id: "action.destination.generate", relativePath: "actions/destinations/生成目的地建议.md", kind: "action", stage: "destinations", reasoning: "medium", reasoningSummary: "none", web: "required", outputContract: "destination.generate.output" },
  { id: "action.destination.add", relativePath: "actions/destinations/新增目的地.md", kind: "action", stage: "destinations", reasoning: "low", reasoningSummary: "none", web: "allowed", outputContract: "destination.add.output" },
  { id: "action.destination.replace", relativePath: "actions/destinations/替换目的地.md", kind: "action", stage: "destinations", reasoning: "medium", reasoningSummary: "none", web: "allowed", outputContract: "destination.replace.output" },
  { id: "action.interest.discover", relativePath: "actions/interests/发现兴趣点.md", kind: "action", stage: "interests", reasoning: "medium", reasoningSummary: "none", web: "required", outputContract: "interest.discover.output" },
  { id: "action.interest.supplement", relativePath: "actions/interests/补充兴趣点.md", kind: "action", stage: "interests", reasoning: "medium", reasoningSummary: "none", web: "required", outputContract: "interest.supplement.output" },
  { id: "action.interest.add", relativePath: "actions/interests/新增兴趣点.md", kind: "action", stage: "interests", reasoning: "low", reasoningSummary: "none", web: "allowed", outputContract: "interest.add.output" },
  { id: "action.interest.replace", relativePath: "actions/interests/替换兴趣点.md", kind: "action", stage: "interests", reasoning: "medium", reasoningSummary: "none", web: "allowed", outputContract: "interest.replace.output" },
  { id: "action.itinerary.generate", relativePath: "actions/itinerary/生成行程.md", kind: "action", stage: "itinerary", reasoning: "high", reasoningSummary: "none", web: "disabled", outputContract: "itinerary.generate.output" },
  { id: "action.itinerary.replan", relativePath: "actions/itinerary/重新规划行程.md", kind: "action", stage: "itinerary", reasoning: "high", reasoningSummary: "none", web: "disabled", outputContract: "itinerary.replan.output" },
  { id: "action.itinerary.day.optimize", relativePath: "actions/itinerary/优化单日游览顺序.md", kind: "action", stage: "itinerary", reasoning: "high", reasoningSummary: "none", web: "disabled", outputContract: "itinerary.day.optimize.output" },
  { id: "action.itinerary.repair", relativePath: "actions/itinerary/修复行程可行性.md", kind: "action", stage: "itinerary", reasoning: "high", reasoningSummary: "none", web: "disabled", outputContract: "itinerary.repair.output" },
  { id: "action.itinerary.verify", relativePath: "actions/itinerary/核验行程动态信息.md", kind: "action", stage: "itinerary", reasoning: "medium", reasoningSummary: "none", web: "required", outputContract: "itinerary.verify.output" },
  { id: "action.itinerary.refine", relativePath: "actions/itinerary/细化每日行程.md", kind: "action", stage: "itinerary", reasoning: "medium", reasoningSummary: "none", web: "allowed", outputContract: "itinerary.refine.output" },
  { id: "action.map.disambiguate", relativePath: "actions/maps/地图地点消歧.md", kind: "action", stage: "map", reasoning: "low", reasoningSummary: "none", web: "disabled", outputContract: "map.disambiguate.output" },
] as const;

const D = "deterministic" as const;
const A = "ai" as const;
export const ACTION_REGISTRY_V3: readonly ActionRegistrationV3[] = [
  { id: "requirements.update", stage: "requirements", executor: D, inputContract: "requirements.mutation.input", outputContract: "deterministic.result", scopePolicy: "trip-facts", resultPolicy: "deterministic_apply" },
  { id: "requirements.clear", stage: "requirements", executor: D, inputContract: "requirements.mutation.input", outputContract: "deterministic.result", scopePolicy: "trip-facts", resultPolicy: "deterministic_apply" },
  { id: "destination.generate", stage: "destinations", executor: A, promptId: "action.destination.generate", reasoning: "medium", reasoningSummary: "none", web: "required", inputContract: "destination.action.input", outputContract: "destination.generate.output", scopePolicy: "macro-candidate", resultPolicy: "save_result" },
  { id: "destination.add", stage: "destinations", executor: A, promptId: "action.destination.add", reasoning: "low", reasoningSummary: "none", web: "allowed", inputContract: "destination.action.input", outputContract: "destination.add.output", scopePolicy: "macro-candidate", resultPolicy: "proposal_required" },
  { id: "destination.remove", stage: "destinations", executor: D, inputContract: "destination.action.input", outputContract: "deterministic.result", scopePolicy: "macro-candidate", resultPolicy: "deterministic_apply" },
  { id: "destination.replace", stage: "destinations", executor: A, promptId: "action.destination.replace", reasoning: "medium", reasoningSummary: "none", web: "allowed", inputContract: "destination.action.input", outputContract: "destination.replace.output", scopePolicy: "macro-candidate", resultPolicy: "proposal_required" },
  { id: "destination.edit", stage: "destinations", executor: D, inputContract: "destination.action.input", outputContract: "deterministic.result", scopePolicy: "macro-candidate", resultPolicy: "deterministic_apply" },
  { id: "destination.preference", stage: "destinations", executor: D, inputContract: "destination.action.input", outputContract: "deterministic.result", scopePolicy: "macro-candidate", resultPolicy: "deterministic_apply" },
  { id: "interest.discover", stage: "interests", executor: A, promptId: "action.interest.discover", reasoning: "medium", reasoningSummary: "none", web: "required", inputContract: "interest.action.input", outputContract: "interest.discover.output", scopePolicy: "micro-candidate", resultPolicy: "save_result" },
  { id: "interest.supplement", stage: "interests", executor: A, promptId: "action.interest.supplement", reasoning: "medium", reasoningSummary: "none", web: "required", inputContract: "interest.action.input", outputContract: "interest.supplement.output", scopePolicy: "micro-candidate", resultPolicy: "save_result" },
  { id: "interest.add", stage: "interests", executor: A, promptId: "action.interest.add", reasoning: "low", reasoningSummary: "none", web: "allowed", inputContract: "interest.action.input", outputContract: "interest.add.output", scopePolicy: "micro-candidate", resultPolicy: "proposal_required" },
  { id: "interest.remove", stage: "interests", executor: D, inputContract: "interest.action.input", outputContract: "deterministic.result", scopePolicy: "micro-candidate", resultPolicy: "deterministic_apply" },
  { id: "interest.replace", stage: "interests", executor: A, promptId: "action.interest.replace", reasoning: "medium", reasoningSummary: "none", web: "allowed", inputContract: "interest.action.input", outputContract: "interest.replace.output", scopePolicy: "micro-candidate", resultPolicy: "proposal_required" },
  { id: "interest.edit", stage: "interests", executor: D, inputContract: "interest.action.input", outputContract: "deterministic.result", scopePolicy: "micro-candidate", resultPolicy: "deterministic_apply" },
  { id: "interest.preference", stage: "interests", executor: D, inputContract: "interest.action.input", outputContract: "deterministic.result", scopePolicy: "micro-candidate", resultPolicy: "deterministic_apply" },
  { id: "itinerary.generate", stage: "itinerary", executor: A, promptId: "action.itinerary.generate", reasoning: "high", reasoningSummary: "none", web: "disabled", timeoutMs: 240_000, inputContract: "itinerary.action.input", outputContract: "itinerary.generate.output", scopePolicy: "itinerary", resultPolicy: "save_result" },
  { id: "itinerary.replan", stage: "itinerary", executor: A, promptId: "action.itinerary.replan", reasoning: "high", reasoningSummary: "none", web: "disabled", inputContract: "itinerary.action.input", outputContract: "itinerary.replan.output", scopePolicy: "itinerary", resultPolicy: "proposal_required" },
  { id: "itinerary.stop.add", stage: "itinerary", executor: D, inputContract: "itinerary.action.input", outputContract: "deterministic.result", scopePolicy: "itinerary", resultPolicy: "deterministic_apply" },
  { id: "itinerary.stop.remove", stage: "itinerary", executor: D, inputContract: "itinerary.action.input", outputContract: "deterministic.result", scopePolicy: "itinerary", resultPolicy: "deterministic_apply" },
  { id: "itinerary.stop.replace", stage: "itinerary", executor: D, inputContract: "itinerary.action.input", outputContract: "deterministic.result", scopePolicy: "itinerary", resultPolicy: "deterministic_apply" },
  { id: "itinerary.stop.move", stage: "itinerary", executor: D, inputContract: "itinerary.action.input", outputContract: "deterministic.result", scopePolicy: "itinerary", resultPolicy: "deterministic_apply" },
  { id: "itinerary.day.reorder", stage: "itinerary", executor: D, inputContract: "itinerary.action.input", outputContract: "deterministic.result", scopePolicy: "itinerary", resultPolicy: "deterministic_apply" },
  { id: "itinerary.edit", stage: "itinerary", executor: D, inputContract: "itinerary.action.input", outputContract: "deterministic.result", scopePolicy: "itinerary", resultPolicy: "deterministic_apply" },
  { id: "itinerary.anchor.set", stage: "itinerary", executor: D, inputContract: "itinerary.action.input", outputContract: "deterministic.result", scopePolicy: "itinerary", resultPolicy: "deterministic_apply" },
  { id: "itinerary.day.optimize", stage: "itinerary", executor: A, promptId: "action.itinerary.day.optimize", reasoning: "high", reasoningSummary: "none", web: "disabled", inputContract: "itinerary.action.input", outputContract: "itinerary.day.optimize.output", scopePolicy: "day", resultPolicy: "proposal_required" },
  { id: "itinerary.repair", stage: "itinerary", executor: A, promptId: "action.itinerary.repair", reasoning: "high", reasoningSummary: "none", web: "disabled", inputContract: "itinerary.action.input", outputContract: "itinerary.repair.output", scopePolicy: "itinerary", resultPolicy: "proposal_required" },
  { id: "itinerary.verify", stage: "itinerary", executor: A, promptId: "action.itinerary.verify", reasoning: "medium", reasoningSummary: "none", web: "required", inputContract: "itinerary.action.input", outputContract: "itinerary.verify.output", scopePolicy: "itinerary", resultPolicy: "proposal_required" },
  { id: "itinerary.refine", stage: "itinerary", executor: A, promptId: "action.itinerary.refine", reasoning: "medium", reasoningSummary: "none", web: "allowed", inputContract: "itinerary.action.input", outputContract: "itinerary.refine.output", scopePolicy: "day", resultPolicy: "proposal_required" },
  { id: "map.disambiguate", stage: "map", executor: A, promptId: "action.map.disambiguate", reasoning: "low", reasoningSummary: "none", web: "disabled", inputContract: "map.disambiguate.input", outputContract: "map.disambiguate.output", scopePolicy: "map-candidate", resultPolicy: "save_result" },
] as const;

export function promptRegistration(id: PromptIdV3) {
  const value = PROMPT_REGISTRY_V3.find((item) => item.id === id);
  if (!value) throw new Error(`未注册 Prompt：${id}`);
  return value;
}

export function actionRegistration(id: AiActionType) {
  const value = ACTION_REGISTRY_V3.find((item) => item.id === id);
  if (!value) throw new Error(`未注册 Action：${id}`);
  return value;
}

export function validateRegistryDefinitionsV3() {
  const promptIds = new Set<string>();
  const promptPaths = new Set<string>();
  for (const prompt of PROMPT_REGISTRY_V3) {
    if (promptIds.has(prompt.id)) throw new Error(`Prompt ID 重复：${prompt.id}`);
    if (promptPaths.has(prompt.relativePath)) throw new Error(`Prompt 文件重复注册：${prompt.relativePath}`);
    promptIds.add(prompt.id);
    promptPaths.add(prompt.relativePath);
  }

  const actionIds = new Set<string>();
  for (const raw of ACTION_REGISTRY_V3) {
    const action: ActionRegistrationV3 = raw;
    if (actionIds.has(action.id)) throw new Error(`Action ID 重复：${action.id}`);
    actionIds.add(action.id);
    if (action.executor === "ai") {
      if (!action.promptId || !action.reasoning || !action.reasoningSummary || !action.web) throw new Error(`AI Action 缺少 Prompt/reasoning/web：${action.id}`);
      const prompt = promptRegistration(action.promptId);
      if (prompt.kind !== "action") throw new Error(`AI Action 只能绑定 action Prompt：${action.id}`);
      if (prompt.stage !== action.stage) throw new Error(`Action 与 Prompt stage 不一致：${action.id}`);
      if (prompt.outputContract !== action.outputContract) throw new Error(`Action 与 Prompt outputContract 不一致：${action.id}`);
    } else if (action.promptId || action.reasoning || action.reasoningSummary || action.web) {
      throw new Error(`deterministic Action 不得绑定 AI 策略：${action.id}`);
    }
  }
  return true;
}

validateRegistryDefinitionsV3();
