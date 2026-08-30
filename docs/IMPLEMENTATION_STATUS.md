# TravelPlanner Implementation Status

更新时间：2026-08-30  
实施分支：`refactor/stage-dialogue-actions-v3`  
目标文档：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

## Target

按已确认目标实现四个 `ConversationStage`、阶段 Dialogue、统一 Action Registry、deterministic/AI executor 分离、Proposal 边界和 fresh SQLite v3；不改变 Candidate-first、canonical `TravelPlanDocument schemaVersion=2`、三阶段 `TripStage`、Place/Resolution、Route Provider、Scope/generation CAS 等既有事实边界。

## Current Phase

### Phase 2 — New Prompts & Output Contracts

**状态：完成。下一阶段：Phase 3。**

## Completed

### Phase 1 — Foundations
- 新增 `ConversationStage`、封闭 `AiActionType`、executor/status/origin/task-agent 合同。
- 新增 Stage Dialogue、Web Dialogue、Action、thread、timing 公共合同。
- 新增 Prompt Registry / Action Registry 与完整性校验。
- `StructuredAiRunnerV2` 支持 per-call `reasoningSummary`；旧调用未指定时保持 `detailed` 兼容。

### Phase 2 — Prompts & Contracts
- 创建 `prompts/shared/旅行规划共享规则.md`。
- 创建四份阶段 Dialogue Prompt：旅行需求、目的地、兴趣点、行程。
- 创建目的地 AI Action Prompt：生成、新增、替换。
- 创建兴趣点 AI Action Prompt：发现、补充、新增、替换。
- 创建行程 AI Action Prompt：生成、重新规划、单日优化、可行性修复、动态核验、每日细化。
- 创建地图消歧 Action Prompt。
- 新增 `ai-action-contracts-v3.ts`，为每个 AI Action 提供固定输出合同。
- itinerary 新合同没有 `newPlaces/newCandidates`；需要新地点时结构化返回 `requiresStage: interests`。
- 新增 `prompt-registry-v3.ts`：递归 UTF-8 加载、缺失/额外 Prompt 拒绝、重复注册由 Registry 拒绝、共享 + 当前单 Prompt 拼接、prompt hash/version。
- loader 提供仅供开发过渡的 `allowLegacyFiles`；最终 Runtime 默认严格模式不会接受旧 00–03。
- 更新根 `AGENTS.md`，把四阶段、Action Registry、fresh v3 database、Prompt 新目录和安全边界设为当前规则；旧 00–03 明确仅为 cutover 前临时依赖。
- 新增 Registry 与 Prompt loader 测试文件。

## Important Decisions

1. `ConversationStage` 永远不进入 canonical plan。
2. Macro 后台仍统一 `kind=city`；区域/岛屿仅是 UI 语义。
3. Dialogue 不直接 mutation；`web_required` 第一轮不输出最终动态结论。
4. deterministic Action 无 Prompt、无 reasoning、无 web。
5. itinerary AI 不能创建 Place/Candidate。
6. Prompt 运行时只允许“共享规则 + 当前具体 Prompt”。
7. Phase 2 仍保留旧 00–03，未切旧 Runtime。
8. 真实 `private_data/travel-v2.sqlite3` 尚未删除/移动/修改。

## Files Changed

- `apps/server/ai-stage-contracts-v3.ts`
- `apps/server/ai-registries-v3.ts`
- `apps/server/ai-action-contracts-v3.ts`
- `apps/server/prompt-registry-v3.ts`
- `apps/server/codex-client.ts`
- `apps/server/structured-ai-v2.ts`
- `apps/server/ai-registries-v3.test.ts`
- `apps/server/prompt-registry-v3.test.ts`
- `AGENTS.md`
- `prompts/shared/旅行规划共享规则.md`
- `prompts/dialogues/*.md`
- `prompts/actions/destinations/*.md`
- `prompts/actions/interests/*.md`
- `prompts/actions/itinerary/*.md`
- `prompts/actions/maps/地图地点消歧.md`
- `docs/IMPLEMENTATION_STATUS.md`

## Tests / Checks

未运行测试、typecheck、build、真实 Codex 或浏览器验收。测试文件已补齐，但完整验证按项目规则需在全部代码完成后单独取得用户许可。

## Known Issues / Risks

- 新 Prompt/Registry 尚未接入活动 Runtime；这是 Phase 4/6 的工作。
- v3 Store 尚未实现，stage message/thread/action 目前还不能持久化。
- 行程修改类新输出需要服务端在 Phase 4 转换为受控 Proposal/diff；不能直接落 canonical。
- 底层模型不支持 none effort/summary 时的能力降级仍需 Runtime 处理。
- 旧 00–03 仍存在是有意的开发过渡状态，不得提前删除。

## Next Phase

### Phase 3 — v3 Store & Persistence

- fresh SQLite schema version 3；不提供 v2 migration。
- `messages.stage` 非空。
- `stage_conversation_threads` 与 prompt hash/version/context generation/turn count。
- `ai_actions` 按目标字段完整持久化并实现原子 confirm 状态抢占。
- `AiTask.agent` 改为 `dialogue | action | map`。
- duplicate 只复制正式计划；permanent delete 依靠外键级联。
- canonical 改动使冲突 Action/Proposal superseded。
- Store 遇到旧 v2、未知版本或损坏 Schema fail closed。
- 本阶段只写代码和测试，不删除当前真实数据库，不做 cutover。

## Recommended Model

GPT-5.6 Sol / high。

## Do Not Do

- 不实现 v2 → v3 migration。
- 不删除真实数据库。
- 不切换 `main` 活动 Runtime。
- 不扩 PlaceKind 或 canonical TripStage。
