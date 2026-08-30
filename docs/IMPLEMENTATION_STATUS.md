# TravelPlanner Implementation Status

更新时间：2026-08-30  
实施分支：`refactor/stage-dialogue-actions-v3`  
目标文档：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

## Target

按已确认目标实现四个 `ConversationStage`、阶段 Dialogue、统一 Action Registry、deterministic/AI executor 分离、Proposal 边界和 fresh SQLite v3；不改变 Candidate-first、canonical `TravelPlanDocument schemaVersion=2`、三阶段 `TripStage`、Place/Resolution、Route Provider、Scope/generation CAS 等既有事实边界。

## Current Phase

### Phase 3 — v3 Store & Persistence

**状态：完成。下一阶段：Phase 4。**

## Completed

### Phase 1 — Foundations
- `ConversationStage` 与 canonical `TripStage` 分离。
- 封闭 Action/Executor/Status/Origin 合同与 Prompt/Action Registry。
- Structured AI 支持 per-call effort/summary/web 策略。

### Phase 2 — Prompts & Contracts
- shared + 四个 Dialogue + 每个 AI 动作独立 Prompt 已建立。
- 专用 Action 输出合同已建立；itinerary AI 无 `newPlaces/newCandidates`，需要新地点返回 `requiresStage=interests`。
- 新 Prompt loader 支持递归 UTF-8、显式注册、hash/version 和额外/缺失文件拒绝。
- `AGENTS.md` 已切到新架构规则；旧 00–03 仍仅作为旧 Runtime 临时依赖保留。

### Phase 3 — Fresh v3 Persistence
- 新增独立 `TravelStoreV3`，数据库 `PRAGMA user_version=3`。
- Store 只接受：空库→创建完整 v3；完整 version 3→打开；其他情况 fail closed。
- 没有任何 v2→v3 migration、双写或兼容读取。
- v3 `messages.stage` 为非空四阶段值，并可按 stage 隔离查询。
- 同一 `(tripId, stage)` 只允许一个 queued/starting/active 用户 turn；不同阶段可独立存在。
- 新增 `stage_conversation_threads`，保存 thread id、prompt hash/version、context generation、turn count 和时间戳。
- 新增 `ai_actions`，保存 action type、executor、origin、source message、validated parameters、target IDs、server scope、base generation、status、task/proposal/result reference 和时间/错误信息。
- Action confirm 使用事务内条件 UPDATE 抢占 `pending_confirmation → executing`，重复确认不会再次 claimed。
- 增加 `(trip_id, request_key)` 唯一约束，CTA/网络重试可使用稳定 request key 实现创建幂等。
- canonical 写入继续使用 generation CAS、revision 和 derived cleanup。
- canonical 变化会按 concrete Scope 判断 pending/executing/awaiting Action 与 pending Proposal：冲突则 superseded；不冲突则安全 rebase 到新 generation。
- `AiTask.agent` 在 v3 Store 中改为 `dialogue | action | map`。
- 应用重启会中断 stage turn、停止 active task，并把 executing Action 标记 failed，不制造伪成功。
- duplicate 只复制正式 canonical plan 和新初始 revision，不复制 message/thread/action/task/proposal。
- permanent delete 通过外键级联清理新增持久化对象。
- 新增 v3 Store 测试：fresh create、v2 fail closed、stage isolation、same-stage serial、thread metadata、atomic confirm、request idempotency、duplicate isolation。

## Important Decisions

1. `ConversationStage` 不写入 `TravelPlanDocument`。
2. `AiActionStage` 类型允许内部 `map`，而 stage conversation thread 仍只允许四个 ConversationStage。
3. 地图消歧是内部 AI Action；它不产生阶段对话历史。
4. Proposal 仍沿用现有受控 `AiProposal`/Scope/Apply 事实边界；Phase 4 会把 replan/repair/refine 输出确定性转换成可审查 PlanCommand diff，其中 refinement Apply 时由服务端确定性设置 detailLevel/detailStatus。
5. 不新增“AI 结果文件”或把结果正文塞进 task metadata；task metadata 只保存诊断信息。
6. 当前真实 `private_data/travel-v2.sqlite3` 尚未删除、移动或打开为 v3。

## Files Changed

- `apps/server/ai-stage-contracts-v3.ts`
- `apps/server/ai-registries-v3.ts`
- `apps/server/ai-action-contracts-v3.ts`
- `apps/server/prompt-registry-v3.ts`
- `apps/server/travel-store-v3.ts`
- `apps/server/travel-store-v3.test.ts`
- `apps/server/ai-registries-v3.test.ts`
- `apps/server/prompt-registry-v3.test.ts`
- `apps/server/codex-client.ts`
- `apps/server/structured-ai-v2.ts`
- `AGENTS.md`
- `prompts/shared/**`
- `prompts/dialogues/**`
- `prompts/actions/**`
- `docs/IMPLEMENTATION_STATUS.md`

## Tests / Checks

测试文件已编写，但未执行测试、typecheck、build、真实 Codex 或浏览器验收。完整验证按项目规则留到全部修改后一次确认。

## Known Issues / Risks

- `TravelStoreV3` 目前是与旧 `TravelStoreV2` 并存的开发实现，活动 `index.ts` 仍使用旧 Store；这是有意的 pre-cutover 状态。
- `map.disambiguate` 注册为 `stage=map`；Phase 4 内部执行路径不得把它伪装成用户 ConversationStage。
- 新 Store 与旧业务服务存在 TypeScript concrete store 类型耦合；Phase 4 应通过窄接口/适配层复用 Candidate/Resolver/Route 能力，不复制第二套业务事实链。
- 旧 `AiProposal` 的 command 模型不直接保存 Day 的 detailLevel/detailStatus；Phase 4 必须把 refinement 的可见字段变成 commands，并在 Apply 时基于 proposal affectedDayIds 确定性设置 `detailed/ready`，不能绕过 Proposal。

## Next Phase

### Phase 4 — Server Orchestration

- v3 Task monitor 与阶段白名单 context builder。
- 四阶段 Dialogue：首次 no-web/no-reasoning；`web_required` → 第二次 live web → 最终回答。
- stage thread hash/version/context/turn rotation 与同阶段串行。
- Action create/confirm/cancel + Registry 分发。
- deterministic Action 直接受控命令，不调用模型。
- AI Action 使用独立 Prompt、固定 reasoning/web、临时 thread。
- destination / interest / itinerary / map 适配现有 Candidate、Resolver、Route、PlanCommand、Proposal 业务服务。
- generation CAS、停止、失败、superseded、幂等和 timing/input-size 诊断。
- 新 stage/action API；仍不做真实 DB cutover。

## Recommended Model

GPT-5.6 Sol / high。

## Do Not Do

- 不迁移或删除真实 v2 数据库。
- 不切 `main` 活动 runtime。
- 不复制新的 Candidate/Map/Route 事实系统。
- 不扩 PlaceKind 或 canonical TripStage。
