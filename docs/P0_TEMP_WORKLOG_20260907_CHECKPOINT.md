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
- `1ae5e6690e75e4d02758fdad2d4a5a33a5a1a1d9`：`index-v3.ts` 删除剩余两个 `store as unknown as TravelStoreV2`，直接传 `TravelStoreV3`。
- `29d4b46d349530157e8e629352de6b5a32c0c894`：新增 `provider-store-capabilities-v3.ts`，定义独立 Provider Store capability。
- `51057bd60178bbf8f61792d2e7b102504e85a2a5`：Route Service 改依赖独立 capability，不再依赖 `TravelStoreV2` 类型。
- `f25da1f5d6eac8e47f2872f6fb35ca250f9a150d`：Resolver 改依赖独立 capability，不再依赖 `TravelStoreV2` 类型。

当前 capability：

- Place Resolution：`requireTrip / listPlaceResolutions / upsertPlaceResolution`。
- Day Route：`getWorkspace / requireTrip / listPlaceResolutions / getDayRoute / setDayRoute`。

结论：Provider 服务仍使用原来的 Resolver / Route 实现和 Provider 算法，但不再知道具体 Store 是 V2 还是 V3。

### P0-3 — finalRoute / Day / Route canonical boundary

已确认当前真正的正向派生入口：

- `deriveFinalRouteDaysV3()`：`finalRoute.nodes -> Day[]`。
- `rebuildFinalRouteDaysV3()`：把派生 Day 写回内存 plan；Day 仍是派生视图。
- FinalRoute mutation（状态、日界、交通、移动、删除、插入、多一晚）都会通过 `applyMutation()` 后重新派生 Day。

同时存在过渡性反向写桥：

- `TravelStoreV3.writePlanWithinTransaction()` 保存前调用 `syncFinalRouteForLegacyWriteV3(before, plan)`。
- 若 `finalRoute` 未改但 `days` 改了，会调用 `rebuildFinalRouteFromDayViewV3()`，把 Day 改动反向翻译成 finalRoute。
- 所以持久化仍只有一个 canonical finalRoute，但旧调用方暂时还能通过 Day 间接写 canonical route。

不能直接删这个桥。当前 `PlanCommandSchema/applyPlanCommands()` 仍包含并执行：

- `set_day_anchor`
- `add_day_stop`
- `update_day_stop`
- `move_day_stop`
- `remove_day_stop`
- `move_day`
- `update_day`

Runtime 的 itinerary deterministic/detail/refine 等链路仍依赖其中一部分。因此若先删 Store bridge，会直接断掉现有 AI 详细行程与局部编辑。

#### Canonical node detail 能力已落地

已创建 `apps/server/final-route-node-detail-v3.ts`，提交：

- `4739b8e2ace287dc97458d4c95e3eaa0b67fdee9` — `feat: add canonical final route detail update`

`updateFinalRouteNodeDetailV3()` 只允许修改：

- `activity`
- `period`
- `scheduleText`
- `startTime`
- `endTime`
- `durationMinutes`
- `scheduleVerification`
- `costNote`
- `costVerification`
- `notes`

明确排除：

- `id / placeId`：节点身份。
- `status`：使用独立 route status mutation。
- `endsDay`：使用独立 boundary mutation。
- `transportFromPrevious`：使用独立 transport mutation。
- Provider geometry / route distance / route duration：根本不属于 FinalRouteNode，不能通过该 helper 写入。

该 helper 修改 canonical finalRoute node 后立即调用 `rebuildFinalRouteDaysV3()`，因此 Day 只由 finalRoute 正向重新派生。

已新增独立测试：

- `b93524a175257d8e1ae97e24819bbacc18a7a55d` — `apps/server/final-route-node-detail-v3.test.ts`
- 覆盖：更新非日界节点的详细字段后，派生 Day stop 同步；空更新拒绝。
- 尚未运行测试。

一个重要语义已确认：`deriveFinalRouteDaysV3()` 中 segment 最后一个 `endsDay` 节点是 Day `endAnchor`，不是普通 stop；因此 P0-3 迁移 `update_day_stop` 时只应把真正的 Day stop 映射到其同 ID finalRoute node，不应顺手把住宿/日界 anchor 复制成普通 stop。

#### P0-3 正确迁移顺序

1. 已完成：补 canonical finalRoute node detail update helper。
2. 下一步：把真实 `update_day_stop` 生产者分类，先迁移纯 detail 更新到 finalRoute node detail command/operation。
3. 再迁移 `add/remove/move_day_stop` 为 finalRoute node 增删移动；move/add 必须正确处理全局 route index 与目标日程块。
4. 把 anchor/day reorder/update 迁移为 origin/boundary/segment 语义，而不是继续把 Day 当独立实体编辑。
5. 所有真实写入口迁完后，让 Store 拒绝“finalRoute 未改但 Day 被改”的写入。
6. 最后删除 `syncFinalRouteForLegacyWriteV3()` 的 Day -> finalRoute 反向桥；只保留 finalRoute -> Day 正向派生。

结论：P0-3 的目标不是“删 days[]”，而是**消灭 Day 作为写入口**。Day 可以继续作为派生 read model、AI context 和 Route Provider 输入。

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
- finalRoute -> Day 已有唯一明确派生函数；当前问题是旧 Day 写入口仍通过兼容桥存在，而不是保存了第二份独立 canonical route。

## 验证状态

尚未运行：

- test
- typecheck
- build
- app
- Provider/E2E

当前仍遵守 `AGENTS.md`：普通施工先静态 review，完整验证需用户确认。

## 下一步

1. 盘点所有旧 Day PlanCommand 的真实生产者，区分“纯 detail”“节点增删移动”“anchor/day 元数据”。
2. 设计最小 canonical finalRoute detail command，避免一次性迁移全部旧 Day 合同。
3. 同时继续 P0-1 的 Runtime 小风险接线；不做 100KB 大爆炸替换。
4. 迁移旧 Day 写入口后再删除 Store legacy write bridge。
5. P0 完成后把两份临时 worklog 整理进正式文档并删除临时文件。
