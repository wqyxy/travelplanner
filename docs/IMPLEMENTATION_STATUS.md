# TravelPlanner Implementation Status

更新时间：2026-08-30  
实施分支：`refactor/stage-dialogue-actions-v3`  
目标文档：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

## Target

实现四个 `ConversationStage` 的独立 Dialogue/Thread/Message、统一 `AiAction` Registry、deterministic/AI executor、Proposal/Apply、fresh SQLite v3，并保持 Candidate-first、canonical v2 Document、Place Resolver、Route Provider、Scope 与 generation CAS 边界不变。

## Current Phase

### Phase 4 — Server Orchestration

**状态：完成。下一阶段：Phase 5。**

## Completed

### Foundations / Prompts / Store
- Phase 1–3 已完成：公共合同、Registry、19 份新 Prompt、专用 Action 输出合同、递归 Prompt loader、fresh v3 Store、stage message/thread/action/task persistence 与原子 Action confirm。

### Stage Dialogue Runtime
- 新增阶段白名单 Context Builder；普通 Dialogue 不再注入完整 canonical plan。
- `requirements / destinations / interests / itinerary` 分别构造最小必要状态，并对 selection 做阶段越界校验。
- Stage Dialogue 默认 `effort=none / summary=none / web=disabled`。
- 如果 Codex/模型协议不支持 none，自动用新线程安全降级为 `minimal / auto`；不改变业务合同。
- `web_required` 第一轮不展示最终动态结论；服务端立即执行同阶段第二次 `web=live` 调用，并只保存第二次核验后的最终回答。
- Stage Thread 保存 prompt hash/version/context generation/turn count；Prompt 变化、达到 turn 上限或 resume 失效时自动换新线程。
- 同一 stage 并发 turn 由 v3 Store 串行保护。
- Dialogue 检出的 Action 只创建 `pending_confirmation` Action；不直接修改 canonical。

### Action Runtime
- CTA 和自然语言 Action 都进入同一 Action Registry / 执行服务。
- CTA 使用稳定 `requestKey` 创建幂等；服务端内部立即 claim，不增加重复确认 UI。
- 对话 Action 使用数据库条件更新抢占 `pending_confirmation → executing`；重复 confirm 不会重复执行。
- 同一 trip 同时只允许一个 AI Action 执行；deterministic Action 不占 AI 执行槽位。
- deterministic Actions 直接转换为受控 canonical mutation/PlanCommand，不调用模型。
- AI Actions 使用 Registry 固定 Prompt、reasoning、summary、web、output contract，且使用临时独立线程。
- generation 在启动、AI 结果保存和 Proposal Apply 处重新校验；计划变化会 supersede 冲突 Action。
- Action/Dialogue task metadata 保存 input bytes、action type、reasoning、web policy、timing 和失败阶段；不保存 Prompt 全文、完整计划或模型内部推理。

### Existing Business Capability Reuse
- Candidate 正式化继续复用现有 `applyCandidateDiscovery`，没有新建第二套 Candidate 事实系统。
- Interest discover/supplement 继续采用“先保存 Candidate，再 best-effort Place Resolution”；定位失败不撤回候选。
- Place Resolver 继续是唯一地图地点解析链；新增 adapter 仅统一 v3 Runtime 方法名。
- Route Provider 继续是路线 geometry/距离/时长唯一事实来源。
- 初次 `itinerary.generate` 只引用已有 Place/Candidate；服务端重新分配 Day/Anchor/Stop 正式 ID，不信任 AI 自造正式 ID。
- 未定位的非 Macro Place 不允许进入新行程；must_go 具体地点不能静默漏排。
- `itinerary.replan / repair / day.optimize / verify / refine` 均转换为受控 Proposal，而不是直接写计划。
- `itinerary.refine` 的 Stop 字段变更存为 PlanCommand；Apply 后服务端再确定性设置受影响 Day 为 `detailed / ready`，因此仍严格经过 Proposal → Apply。
- `requiresStage=interests` 会完成当前行程 Action 而不创建新 Place/Candidate。
- Proposal Apply 时重新执行 Scope validation 和 generation CAS。

### v3 API
- 新增显式 stage messages/turns API。
- 新增统一 CTA Action API、Action confirm/cancel API。
- 保留精确 UI 编辑需要的 commands、candidate preference、resolution、route、proposal、revision、task API。
- v3 API 不再提供旧 `/plan/generate`、`/refinement/next`、`/proposals` 直接创建等 AI 旁路。
- 新增 API 路由测试，明确旧 plan-generation endpoint 在 v3 dispatcher 中不存在。

## Important Decisions

1. Prompt thread 不是历史事实源；数据库 message 才是持久化历史。Thread 只是性能上下文，可随时轮换。
2. 地图消歧仍由同一 Action Prompt/Registry 定义并作为内部 Map AI 能力使用，不产生第二个用户 AI 输入入口。
3. 旧 Proposal Command 模型足以承载 refinement：所有可见 Stop 细化字段进入 commands，`detailLevel/detailStatus` 在 Apply 时由服务端根据受影响 Day 确定性设置，不需要新增 Patch/Repair 持久化系统。
4. AI replan/repair 若转换后的命令超过 100 条，会明确失败并要求缩小范围，而不是绕过受控命令上限。
5. 当前 v3 Runtime/API 仍未接到 `index.ts`；活动 main runtime 在 Phase 6 cutover 前继续是旧实现。

## Files Changed

- `apps/server/ai-task-monitor-v3.ts`
- `apps/server/stage-context-v3.ts`
- `apps/server/staged-ai-v3.ts`
- `apps/server/place-resolver-adapter-v3.ts`
- `apps/server/planner-runtime-v3.ts`
- `apps/server/travel-api-v3.ts`
- `apps/server/planner-runtime-v3.test.ts`
- `apps/server/travel-api-v3.test.ts`
- Phase 1–3 文件继续保留。

## Tests / Checks

新测试已写入，但尚未执行 Vitest、server typecheck、web typecheck、build、真实 Codex、地图 smoke 或浏览器 E2E。完整验证仍按项目规则等全部实施完成后统一征求用户确认。

## Known Issues / Risks

- 新 Runtime 尚未成为活动启动链，因此 Phase 5 UI 先面向 v3 API 编写，Phase 6 再原子切换 `index.ts`/DB/Prompt loader。
- `TravelStoreV3` 与现有 Resolver/Route 类存在旧 concrete type 注解；Phase 6 启动装配会使用明确 adapter/窄类型转换来复用同一运行实现，而不是复制服务。
- map.disambiguate 是内部地图 AI，不应显示为用户阶段 Action Card。
- AI Action 多目的地兴趣点发现使用同一独立 Prompt逐目的地执行；最终 cutover 前需通过单测/Smoke 确认批量目标不会产生重复首轮调用。
- 最终 typecheck 可能暴露当前阶段静态未运行代码中的窄类型问题；这些必须在 Phase 7 验收前修完。

## Next Phase

### Phase 5 — Right-Side UI Migration

- `ConversationStage` 成为右侧工作区固定四步。
- 每阶段独立 message history、draft、assistant title/boundary。
- 删除全局“对话 / 调整”双模式。
- 对话识别 Action 显示 Action Card；confirm/cancel 调 v3 Action API。
- CTA 直接调用统一 Action API，不再二次确认。
- Proposal 显示在来源 Action/阶段区域并支持 Apply/Reject/Undo。
- 页面现有 preference、拖拽、明确编辑继续走 deterministic commands。
- 地图不新增 AI 输入入口。

## Recommended Model

Worker 可用高性价比编码模型；完成后由高推理 Reviewer 检查 Phase 5。

## Do Not Do

- 不在 Phase 5 做真实数据库删除。
- 不重新设计地图或 Candidate 数据模型。
- 不保留全局 adjustment AI 旁路。
