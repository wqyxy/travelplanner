import {
  type AdjustmentProposalOutput,
  type PlanCommand,
  type ProposalScope,
  type TravelPlanDocument,
} from "./contracts-v2.js";
import { applyPlanCommands, type ApplyPlanCommandsResult } from "./plan-commands-v2.js";
import { preparePlanForCommands } from "./plan-command-preparation-v2.js";
import { assertProposalCommandsWithinScope } from "./proposal-scope-policy-v2.js";

export type ValidatedAdjustmentProposal = {
  output: AdjustmentProposalOutput;
  scope: ProposalScope;
  commands: PlanCommand[];
  preview: ApplyPlanCommandsResult;
};

export function validateAdjustmentProposal(
  plan: TravelPlanDocument,
  requestedScope: ProposalScope,
  output: AdjustmentProposalOutput,
): ValidatedAdjustmentProposal {
  if (JSON.stringify(output.scope) !== JSON.stringify(requestedScope)) {
    throw new Error("AI 返回的 Proposal Scope 与请求不一致。");
  }
  const checked = assertProposalCommandsWithinScope(plan, requestedScope, output.commands);
  const prepared = preparePlanForCommands(plan, checked.commands);
  const preview = applyPlanCommands(prepared, checked.commands);
  return {
    output: { ...output, scope: checked.scope, commands: checked.commands },
    scope: checked.scope,
    commands: checked.commands,
    preview,
  };
}
