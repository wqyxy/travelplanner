# P0 Temporary Worklog — 2026-09-07 Checkpoint

> P0 临时施工记忆续页。此前详细记录在 `docs/P0_TEMP_WORKLOG.md`。P0 完成后统一整理并删除临时文件。

## 当前状态

### P0-1 — Runtime 拆分

已经从 `planner-runtime-v3.ts` 抽出/建立以下模块：

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

真实 main 状态需要区分“模块已建立”和“Runtime 已接线”：

- 已明确接回 Runtime：Action Scope、Proposal diff、Resolution current-state、Itinerary structural validation、Itinerary command derivation。
- `planner-itinerary-impact-v3.ts`、`planner-action-context-v3.ts`、Resolution/Route coordinator、deterministic command、candidate output 虽已建立，但 Runtime 仍保留对应本地实现，尚未完成最终接线。
- 因 `planner-runtime-v3.ts` 约 100KB，而当前 GitHub contents 写入是整文件替换，后续接线继续按小风险切片处理，避免为了“看起来完成”做高风险大替换。

### P0-2 — V2/V3 capability seam

已完成第一阶段：去掉 Provider 事实链的 V2/V3 不安全强转，并把 Store 依赖收窄为独立 capability。

提交：

- `964313b7bea0ad39ab49930c24b5fb24f28eabfe`：移除 Runtime 的 `resolver as unknown as PlaceResolverV2`；Resolver Core 直接提供兼容别名。
- `5ca40331dfc46e929167230f010aeca7e35f88ff`：删除已无引用的 `place-resolver-adapter-v3.ts`。
- `d0722b52e9dddc102a0523e0da29aa7028c44716`：`DayRouteServiceV2` Store 依赖先收窄到实际 5 个方法。
- `926788ecb90f8807e21516aacd06840145035b99`：`PlaceResolverV2` Store 依赖先收窄到实际 3 个方法。
- `1ae5e6690e75e4d02758fdad2d4a5a33a5a1d9`：`index-v3.ts` 删除剩余两个 `store as unknown as TravelStoreV2`，直接传 `TravelStoreV3`。
- `29d4b46d349530157e8e629352de6b5a32c0c894`：新增 `provider-store-capabilities-v3.ts`，定义独立 Provider Store capability。
- `51057bd60178bbf8f61792d2e7b102504e85a2a5`：Route Service 改依赖独立 capability，不再依赖 `TravelStoreV2` 类型。
- `f25da1f5d6eac8e47f2872f6fb35ca250f9a150d`：Resolver 改依赖独立 capability，不再依赖 `TravelStoreV2` 类型。

当前 capability：

- Place Resolution：`requireTrip / listPlaceResolutions / upsertPlaceResolution`。
- Day Route：`getWorkspace / requireTrip / listPlaceResolutions / getDayRoute / setDayRoute`。

结论：Provider 服务仍使用原来的 Resolver / Route 实现和 Provider 算法，但不再知道具体 Store 是 V2 还是 V3。

## 不得破坏的产品/安全边界

- 用户只维护 `finalRoute`，Day/Route 为派生事实链。
- 用户是旅行方案唯一决策者；旅行合理性是 advisory，不是 canonical blocker。
- 未定位允许保留。
- AI 不生成可信坐标、Provider Place ID、route geometry、Provider distance/duration/verified。
- generation CAS、Proposal Scope、SQLite transaction、Provider 事实来源不能弱化。
- 不恢复 v2 -> v3 migration/双写。
- 不因文件名带 `v2` 就盲目删除/改名；先判断是否仍是 canonical implementation。

## 当前静态检查结论

- 新拆出的结构校验只处理未知引用和 Candidate/Place 身份不一致。
- `markImpact` helper 只把已 detailed 的受影响 Day 标为 `needs_review`，没有新增 blocker；但 Runtime 接线仍待完成。
- Provider capability 改造没有改 Resolution 搜索/消歧、Route Provider 调用、distance/duration/geometry 写入逻辑。
- `index-v3.ts` 的三处已知 `unknown as` seam 已移除。
- Resolver Adapter 已无引用并删除，没有引入第二套定位事实链。

## 验证状态

尚未运行：

- test
- typecheck
- build
- app
- Provider/E2E

当前仍遵守 `AGENTS.md`：普通施工先静态 review，完整验证需用户确认。

## 下一步

1. 回到 P0-1，优先把 deterministic/candidate helper 接回 Runtime；它们比 route batch coordinator 更容易做行为保持接线。
2. 再接 Resolution/Route coordinator，移除 Runtime 自己的 `routeBatches` 和 provider orchestration。
3. 最后处理 Action Context / impact 的重复本地实现，确保 AI 输入字段和 advisory 行为完全不变。
4. 完成 P0-1 后再进入 finalRoute / Day / Route canonical/derived 边界的 P0-3 审核。
