import { describe, expect, it } from "vitest";
import { emptyTravelPlan, type AdjustmentProposalOutput } from "./contracts-v2.js";
import { validateAdjustmentProposal } from "./proposal-validation-v2.js";

function proposal(overrides: Partial<AdjustmentProposalOutput> = {}): AdjustmentProposalOutput {
  return {
    schemaVersion: 1,
    baseGeneration: 0,
    scope: { type: "candidate_pool", id: null },
    assistantMessage: "已生成候选地点建议。",
    title: "补充陶波",
    explanation: "增加北岛中部停留选择。",
    commands: [{
      type: "add_candidate",
      place: { id: "temp-place-taupo", nameZh: "陶波", nameLocal: "Taupō", nameEn: "Taupō", kind: "city", city: "Taupō", region: "Waikato", country: "New Zealand", countryCode: "NZ", approximate: false },
      candidate: { id: "temp-candidate-taupo", placeId: "temp-place-taupo", planningAreaCandidateId: null, preference: "optional", source: "ai", aiReason: "北岛湖区目的地", aiScore: 86, suggestedDurationMinutes: 2880, tags: [] },
    }],
    ...overrides,
  };
}

describe("validateAdjustmentProposal", () => {
  it("previews a valid Proposal without mutating the canonical plan", () => {
    const plan = emptyTravelPlan();
    const before = structuredClone(plan);
    const validated = validateAdjustmentProposal(plan, { type: "candidate_pool", id: null }, proposal());

    expect(plan).toEqual(before);
    expect(validated.preview.plan.places.some((place) => place.nameZh === "陶波")).toBe(true);
    expect(validated.preview.plan.candidates).toHaveLength(1);
  });

  it("rejects a Proposal whose returned Scope differs from the request", () => {
    expect(() => validateAdjustmentProposal(
      emptyTravelPlan(),
      { type: "trip", id: null },
      proposal(),
    )).toThrow("AI 返回的 Proposal Scope 与请求不一致");
  });

  it("rejects invalid temporary references before a Proposal can be stored", () => {
    const value = proposal();
    const command = value.commands[0];
    if (command.type !== "add_candidate") throw new Error("测试命令类型错误");
    command.candidate.placeId = "temp-place-other";

    expect(() => validateAdjustmentProposal(
      emptyTravelPlan(),
      { type: "candidate_pool", id: null },
      value,
    )).toThrow("新增 Candidate 必须引用同一命令中的 Place 临时 ID");
  });

  it("rejects semantic duplicates already present in the canonical plan", () => {
    const plan = emptyTravelPlan();
    plan.places.push({ id: "formal-taupo", nameZh: "陶波", nameLocal: "Taupō", nameEn: "Taupō", kind: "city", city: "Taupō", region: "Waikato", country: "New Zealand", countryCode: "NZ", approximate: false });

    expect(() => validateAdjustmentProposal(
      plan,
      { type: "candidate_pool", id: null },
      proposal(),
    )).toThrow("地点已存在：陶波");
  });
});
