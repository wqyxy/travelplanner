# P0 Temporary Worklog — 2026-09-07 Checkpoint

> P0 临时施工记忆续页。此前详细记录在 `docs/P0_TEMP_WORKLOG.md`。P0 完成后统一整理并删除临时文件。

## 当前状态

P0-1 已从 `planner-runtime-v3.ts` 抽出/建立以下边界：

- `planner-action-scope-v3.ts`：Action Scope。
- `planner-proposal-v3.ts`：Proposal diff。
- `planner-resolution-state-v3.ts`：当前有效 Resolution 过滤。
- `planner-itinerary-validation-v3.ts`：仅结构引用硬校验。
- `planner-itinerary-commands-v3.ts`：replacement/refinement -> PlanCommand。
- `planner-itinerary-impact-v3.ts`：受影响 detailed Day -> needs_review；不阻止保存。
- `planner-action-context-v3.ts`：各 Action 的 AI 输入上下文；Route 使用 lazy getter。
- `planner-resolution-coordinator-v3.ts`：地点定位批处理协调，Provider 算法不变。
- `planner-route-coordinator-v3.ts`：Route/macro route/batch/task 协调，Provider 算法不变。
- `planner-deterministic-commands-v3.ts`：deterministic Action -> PlanCommand。
- `planner-candidate-output-v3.ts`：目的地范围校验、candidate discovery normalize、candidate command。

已接回 Runtime 的边界至少包括：Action Scope、Proposal diff、Resolution current-state、Itinerary structural validation、Itinerary command derivation、Action Context、Itinerary impact。

Resolution/Route coordinator、deterministic command、candidate output 已建立模块，下一步完成 Runtime 接线和静态 diff。

## 不得破坏的产品/安全边界

- 用户只维护 `finalRoute`，Day/Route 为派生事实链。
- 用户是旅行方案唯一决策者；旅行合理性是 advisory，不是 canonical blocker。
- 未定位允许保留。
- AI 不生成可信坐标、Provider Place ID、route geometry、Provider distance/duration/verified。
- generation CAS、Proposal Scope、SQLite transaction、Provider 事实来源不能弱化。
- 不恢复 v2 -> v3 migration/双写。
- 不盲目删除/改名 V2 文件。

## 当前静态检查结论

- 新拆出的结构校验只处理未知引用和 Candidate/Place 身份不一致。
- `markImpact` 只把已 detailed 的受影响 Day 标为 `needs_review`，没有新增 blocker。
- Action Context 保持原 target/adjacent day 算法；destination/interest 不额外读取 Route。
- Resolution/Route coordinator 只搬 orchestration，未新增任何 Provider 事实生成逻辑。
- deterministic/candidate helper 保持原错误文案和 PlanCommand 形状。

## 验证状态

尚未运行：

- test
- typecheck
- build
- app
- Provider/E2E

当前仍遵守 `AGENTS.md`：普通施工先静态 review，完整验证需用户确认。

## 下一步

1. 将 Resolution/Route coordinator 接入 Runtime，移除 Runtime 的 `routeBatches` 和 resolution/route orchestration 实现。
2. 将 deterministic/candidate helper 接入 Runtime。
3. 再决定是否抽 `interest discovery` service，或进入 P0-2 的 V2/V3 capability interface。
4. P0-2 首要目标：消除 `index-v3.ts` 中 `store as unknown as TravelStoreV2` / resolver cast，不先改文件名。
