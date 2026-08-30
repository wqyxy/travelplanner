# TravelPlanner Implementation Status

更新时间：2026-08-30  
实施分支：`refactor/stage-dialogue-actions-v3`  
目标文档：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

## Target

按已确认目标实现：

```text
右侧唯一 AI 入口
→ requirements / destinations / interests / itinerary 四个 ConversationStage
→ 阶段 Dialogue 只回答、澄清、web_required、识别 Action
→ Action Registry 固定 deterministic / ai executor
→ AI 修改生成 Proposal
→ Apply 后才修改 canonical TravelPlanDocument
```

必须保持：Candidate-first、canonical `TravelPlanDocument schemaVersion=2`、三阶段 `TripStage`、Place/Resolution 边界、PlanCommand/Scope/generation CAS、Route Dirty 和地图 Provider 事实边界。

## Current Phase

### Phase 1 — Foundations

**状态：完成。下一阶段：Phase 2。**

## Completed

- 新增 `ConversationStage`，与 canonical `TripStage` 完全分离。
- 新增封闭 `AiActionType`、`AiActionExecutor`、`AiActionStatus`、`AiActionOrigin`、`AiTaskAgentV3`。
- 新增 `StageDialogueOutput`、`WebDialogueOutput`、阶段 turn 输入、Action confirm/cancel、timing、stage thread、持久化 Action 记录合同。
- 新增 Prompt Registry 与 Action Registry 定义。
- Registry 已静态覆盖全部目标 Action ID。
- deterministic Action 明确禁止绑定 Prompt / reasoning / web。
- AI Action 固定绑定唯一 Prompt、stage、输入/输出合同、Scope Policy 和 resultPolicy。
- `structuredTurn()` 不再只能强制 `summary=detailed`；调用方可显式传 reasoning summary，同时旧调用未传参数时仍保持旧行为。
- `StructuredAiRunnerV2` 新增 per-call `reasoningSummary`，结构化修复 turn 也继承相同策略。
- 新增 Registry invariant 单元测试文件。

## Important Decisions

1. 不改 `contracts-v2.ts` 中 canonical `TripStage`。
2. `ConversationStage` 只属于 UI / message / thread / Action 命名空间。
3. 当前仍保留旧 00–03 Prompt 和旧 Runtime；Phase 1 未提前切换运行链。
4. 全部后续开发留在独立分支，避免半切换状态进入 `main`。
5. 真实 `private_data/travel-v2.sqlite3` 不在 Phase 1–5 删除或修改。

## Files Changed

- `apps/server/ai-stage-contracts-v3.ts`
- `apps/server/ai-registries-v3.ts`
- `apps/server/ai-registries-v3.test.ts`
- `apps/server/codex-client.ts`
- `apps/server/structured-ai-v2.ts`
- `docs/IMPLEMENTATION_STATUS.md`

## Tests / Checks

未运行测试、typecheck、build 或真实 Codex。当前环境通过 GitHub connector 修改远端仓库，没有本地工作树执行环境；最终验证仍按项目规则单独取得用户确认后执行。

## Known Issues / Risks

- Phase 2 创建新 Prompt 后，旧 00–03 仍需暂时存在，直到最终 cutover。
- Registry 的文件系统递归完整性校验尚未接入；这是 Phase 2 任务。
- 底层模型若不支持 `effort=none` / `summary=none`，Runtime 仍需在后续加入能力降级策略。
- 当前旧 Runtime 仍共享 planner thread、完整 canonical plan 和 live web；后续 Phase 4 才替换。
- GitHub remote 无法观察开发机未提交的本地改动；任何本地接手者仍需先执行 `git status` / `git diff`。

## Next Phase

### Phase 2 — New Prompts & Output Contracts

只做：

- 创建 shared、四个 Dialogue、各 AI Action Prompt；
- 建立专用 AI Action 输出合同；
- itinerary AI 输出删除创建新 Place/Candidate 的能力，并支持 `requiresStage: interests`；
- 实现新 Prompt Registry 的递归 UTF-8 文件校验；
- 更新 `AGENTS.md` 的新 Prompt 规则；
- 旧 00–03 Prompt 暂时保留给旧 Runtime。

## Recommended Model

GPT-5.6 Sol / high。

## Do Not Do

- 不扩展 `PlaceKind`。
- 不把四个 ConversationStage 写入 canonical plan。
- 不迁移或删除真实 v2 数据库。
- 不删除旧 Prompt，直到 Phase 6 原子 cutover。
- 不让 deterministic Action 重新调用 AI。
