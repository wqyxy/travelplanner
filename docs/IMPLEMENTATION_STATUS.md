# TravelPlanner Implementation Status

更新时间：2026-08-30  
实施分支：`refactor/stage-dialogue-actions-v3`  
目标文档：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

## Target

实现四个 `ConversationStage` 的独立 Dialogue / Thread / Message、统一 `AiAction` Registry、deterministic / AI executor、Proposal / Apply、fresh SQLite v3，并继续保持 Candidate-first、canonical `TravelPlanDocument.schemaVersion=2`、三阶段 `TripStage`、Place Resolver、Route Provider、Scope 与 generation CAS 边界。

## Current Phase

### Phase 6 / 7 — Atomic Code Cutover & Cleanup

**代码级状态：完成。**  
**完整验证：尚未执行，等待用户按项目规则明确授权。**  
**真实本地数据库破坏性 cutover：尚未执行，必须独立确认。**

## Completed

### Phase 0 — Repository Analysis
- 完成目标方案与 current main 映射，确认旧全局 Planner Prompt/Thread/Message/taskMode 是主要替换层。
- 明确保留 Candidate-first、PlanCommand、Proposal Scope、generation CAS、Place Resolver、Route Provider 和兴趣点 save-first / map-best-effort 能力。

### Phase 1 — Foundations
- 新增 `ConversationStage`、`AiActionType / Executor / Status`、Stage Dialogue/Web 合同。
- 建立 Prompt Registry / Action Registry，明确 AI 与 deterministic executor。
- Structured AI 支持 per-call `effort / reasoningSummary / web`；`structuredTurn()` 不再强制所有调用 `summary=detailed`。

### Phase 2 — Prompts & Contracts
- 新 Prompt 目录固定为 `prompts/shared / dialogues / actions`。
- 四个 Dialogue Prompt 独立；每个 AI Action 使用独立 Prompt。
- strict Prompt Registry 递归校验缺失、额外、重复、空 Prompt。
- Dialogue Action `parameters` 已从自由 `Record<string, unknown>` 模型输出收紧为固定 closed 参数信封；未使用字段使用 null/[]，不能创造任意键。
- active itinerary AI 输出合同不包含 `newPlaces / newCandidates`；需要新地点时返回 `requiresStage=interests`。
- 新增 strict structured-output 合同测试。

### Phase 3 — Fresh SQLite v3
- 新建 `TravelStoreV3`，只接受空 DB 创建或完整 user_version=3 DB。
- version 2 / 未知 / 损坏数据库 fail closed；不实现迁移、双写、静默 reset。
- messages 增加 stage；增加 stage threads、ai_actions；AiTask agent 改为 dialogue/action/map。
- Action confirm 使用数据库条件更新原子抢占，requestKey 保证 CTA 幂等。
- duplicate 只复制 canonical plan。

### Phase 4 — Server Orchestration
- 四阶段 Dialogue 只回答、澄清、`web_required` 或识别 Action，不直接 mutation。
- `web_required` 第一轮不保存最终结论；第二次 live web 后才持久化最终回答和 verification。
- 主 CTA 进入统一 Action service，点击即确认；聊天 Action 保持 pending_confirmation。
- deterministic Action 不调用模型；AI Action 使用 Registry 指定 Prompt / reasoning / web / output contract。
- AI 修改类结果使用 Proposal → Apply；`itinerary.refine` 也走 Proposal。
- 继续复用现有 Resolution、Route、PlanCommand、Proposal Scope 与 generation CAS。

### Phase 5 — Right-Side UI
- `AppV3` 固定 requirements / destinations / interests / itinerary 四步。
- `WorkspaceAssistantV3` 删除旧“对话 / 调整”双模式。
- 四阶段 message history 与 draft 独立；Action Card / Proposal 挂在右侧对应消息或阶段任务区。
- 地图没有第二套 AI 输入；地图只负责展示、选择和 Provider/手工坐标交互。
- 主 CTA 不再重复确认；精确 preference、编辑、拖拽、Anchor、地图、Route 等继续 deterministic。
- Action Card 已显示 pending/executing/awaiting_apply/completed/applied/rejected/cancelled/failed/superseded。

### Phase 6 — Atomic Code Cutover
- 前端 `main.tsx` 已切换 `AppV3` + `stage-ai-v3.css`。
- 服务端 active runtime 已切换 `index-v3.ts / TravelStoreV3 / StagedTravelAiV3 / TravelPlannerRuntimeV3 / travel-api-v3`。
- 新增 `index-cutover-v3.ts` 启动守卫：HTTP server 监听前先执行 strict Prompt 校验、fresh-v3/fail-closed DB 校验和运行时数据库不变量安装。
- package dev/dev:server/start 已全部指向 `index-cutover-v3`。
- run.cmd / run.ps1 / run.command 已同步指向 `dist/server/index-cutover-v3.js`。
- 旧 00–03 Prompt 已删除；strict Prompt Registry 是唯一 Prompt 入口。
- 旧 planner-runtime-v2/core/base、旧 prompt-contract-v2、旧全局 App/Assistant/ProposalPanel 和旧 AI API 主路径已从分支删除。
- 新数据库不变量：canonical generation 变化会清理 Stage thread；stale context-generation thread 不保留；deterministic Action 成功最终态归一为 `applied`。
- 为数据库不变量增加独立测试，并将 Runtime deterministic 测试基线更新为 `applied`。

### Phase 7 — Docs & Cleanup
- README、docs/README、AGENTS 已更新到 staged-v3 / fresh-v3 / right-side-only 基线。
- `docs/LOCAL_TEST_PROMPT.md` 已改写为 staged-v3 验收流程，删除旧固定 3/5/7/9、map-precheck-before-save、single-trip-thread 等过期断言。
- 便携启动入口已与 V3 cutover guard 对齐。

## Database Cutover Decision

固定路径仍是：

```text
private_data/travel-v2.sqlite3
```

但活动 Runtime 要求内部：

```text
PRAGMA user_version = 3
```

已确认策略：
- 不迁移、不保留现有 v2 数据；
- 正常启动绝不自动删除/移动/覆盖旧库；
- 旧 v2 文件仍存在时，V3 会在 server 监听前 fail closed；
- 真正删除或人工移走真实 `private_data/travel-v2.sqlite3` 是独立破坏性步骤，尚未执行，也无法通过 GitHub connector 代替用户执行。

## Tests / Checks

截至本状态更新：
- 已完成 GitHub 只读静态 Review、入口/Prompt 目录/branch diff 检查；
- 已编写/更新 V3 Registry、Prompt、Store、Runtime、strict Dialogue schema、runtime invariant 测试；
- **尚未运行**完整 Vitest、`npm run typecheck`、`npm run build`、真实 Codex smoke、浏览器 E2E 或便携打包。

根据 `AGENTS.md`，完整验证必须在代码修改收尾后一次性向用户说明范围并获得明确授权，不能自动执行。

## Known Issues / Risks

### P1 — 多 Macro 兴趣点 CTA 有一轮冗余 AI 调用

当前 `interest.discover / interest.supplement` 在 targetIds 包含多个 Macro 时，Runtime 首先启动一次 Action AI，然后持久化阶段再逐 Macro 串行研究；多目标情况下首轮结果会被丢弃，因此会多消耗一次模型调用。最终每个 Macro 的结果仍按单目标合同验证并保存，数据正确性不受影响。

处理建议：完整 typecheck/test 通过后，再决定是否对 841 行 Runtime 做一个受控小重构，把首个 Macro 直接复用第一次输出。不要为了省一轮调用在验证前大面积改写 Runtime。

### Verification Risk

- `AppV3` 继续通过结构兼容 cast 复用 CandidatePanel / ItineraryPanelV2 / WorkspaceMapV2；最终 typecheck 是确认该复用边界的必要关卡。
- strict Stage Dialogue Schema 本轮刚收紧，需要最终合同测试确认 OpenAI transport 没有自由 additionalProperties / mixed required-optional 问题。
- V3 startup guard 和 SQLite triggers 需要自动化测试 + fresh DB smoke 双重确认。

## Next Step

完整验证建议一次性执行：
1. `git diff --check`；
2. V3/相关 Vitest（或 `npm test`）；
3. `npm run typecheck`；
4. `npm run build`；
5. 临时 v2 DB fail-closed smoke；
6. 临时 fresh v3 启动 smoke；
7. 真实 Codex Stage Dialogue / AI Action smoke；
8. 浏览器四阶段 E2E；
9. 验证通过后再 fast-forward / merge 到 main；
10. 最后单独确认真实本地旧 v2 DB 的备份/移走/删除。

## Do Not Do

- 不自动删除、迁移或覆盖真实 v2 数据库。
- 不恢复旧全局 AI Conversation/Adjustment、旧 00–03 Prompt 或 taskMode 主链。
- 不增加新 PlaceKind 或四阶段 canonical TripStage。
- 未获用户明确授权前不运行完整测试、typecheck、build、真实 Codex 或浏览器 E2E。
