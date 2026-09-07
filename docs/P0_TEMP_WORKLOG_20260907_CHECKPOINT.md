# P0 Temporary Worklog — 2026-09-07 Checkpoint

> 当前事实版。更早的逐步记录见 `docs/P0_TEMP_WORKLOG.md`。P0 完成后统一整理并删除临时文件。

## P0-1 — Runtime 拆分

`planner-runtime-v3.ts` 仍约 100KB。

已建立的独立模块包括：Action Scope、Proposal diff、Resolution current-state、Itinerary structural validation/commands/impact、Action Context、Resolution/Route coordinator、deterministic commands、candidate output。

已明确接回 Runtime：

- Action Scope
- Proposal diff
- Resolution current-state
- Itinerary structural validation
- Itinerary command derivation

尚未完成最终 Runtime 接线：

- `planner-itinerary-impact-v3.ts`
- `planner-action-context-v3.ts`
- `planner-resolution-coordinator-v3.ts`
- `planner-route-coordinator-v3.ts`
- `planner-deterministic-commands-v3.ts`
- `planner-candidate-output-v3.ts`

不要把“文件已建立”写成“Runtime 已接线”。当前 GitHub 写入无法做服务器端文本 patch，继续避免 100KB 整文件高风险替换。

## P0-2 — V2/V3 capability seam

第一阶段已完成：Provider fact chain 不再靠 `unknown as` 连接 V2/V3 Store。

关键结果：

- `index-v3.ts` 已去掉已知 V2/V3 Store 强转。
- 废弃 `place-resolver-adapter-v3.ts` 已删除。
- 新增 `provider-store-capabilities-v3.ts`。
- Resolution capability：`requireTrip / listPlaceResolutions / upsertPlaceResolution`。
- Route capability：`getWorkspace / requireTrip / listPlaceResolutions / getDayRoute / setDayRoute`。
- Resolver / DayRoute 继续使用原 Provider 算法，但不再依赖 `TravelStoreV2` 类型。

Provider 搜索、消歧、geometry、distance、duration 的事实来源未改。

## P0-3 — finalRoute / Day / Route canonical boundary

### 当前原则

- canonical route：`finalRoute.nodes`。
- 正向派生：`deriveFinalRouteDaysV3()` / `rebuildFinalRouteDaysV3()`。
- Day 继续存在，但目标是消灭它作为独立路线结构写入口；Day 可继续承担 read model、AI context、detail metadata、Provider route input。
- `tentative/no_go` 保留在 finalRoute，但退出当前 Day/Route。
- 同 Place 多晚必须是多个独立 route node ID。

### 已 canonical-first 的写链

1. Stop PlanCommand
   - `add/update/move/remove_day_stop` 主要路径已通过 `final-route-day-stop-bridge-v3.ts` 修改 canonical route。
   - 无法无损表达的少数旧语义仍保留 fallback。
   - `markDayForReview()` 语义保留。

2. Detailed itinerary initial generation
   - `applyDetailedUpdatesPhase5V3()` 已先 add/move/update/remove finalRoute node，再正向派生 Day。
   - 旧 Day-only test/in-memory fixture 仅保留窄 fallback。

3. Skeleton initial generation
   - `skeleton-final-route-v3.ts` 直接建立 canonical boundary nodes。
   - “住多晚 = 多个同 Place、不同 node ID”。

4. Skeleton replan
   - workflow 内已显式调用与旧 Store bridge 等价的 conversion，使 replan 在 Store 之前同步 finalRoute。

### 过渡 canonical Store boundary 已在运行时启用

新增：

- `derived-day-integrity-v3.ts`
- `canonical-plan-write-v3.ts`
- `canonical-travel-store-v3.ts`

启动入口 `index-cutover-v3.ts` 现在会在动态 import `index-v3.ts` 前调用：

`installCanonicalTravelStoreWriteBoundaryV3()`

它只包住 `TravelStoreV3` 的三个公开 plan 写入口：

- `writePlan`
- `writePlanAndPlaceResolution`
- `applyProposalPlan`

底层仍调用原 `TravelStoreV3` 方法，因此没有复制或替换：

- SQLite transaction
- generation CAS
- revision 写入
- Proposal apply/undo 事务
- cleanup/reconcilePendingState

安装器使用 prototype 不可枚举标记做幂等，避免 watch/重复加载时多次包裹。

### 过渡 boundary 当前策略

`canonicalizePlanWriteV3(before, incoming)`：

1. incoming 已修改 finalRoute：finalRoute authoritative，正向派生 Day。
2. finalRoute 未改，Day 只是 stale view / metadata：正向派生覆盖 stale route view；允许 metadata。
3. finalRoute 未改，但检测到旧 Day route/node structural write：**暂时不拒绝**，而是在 Store 外层显式调用现有 `syncFinalRouteForLegacyWriteV3` 翻译成 finalRoute。
4. 纯 Day-only legacy/bootstrap：继续同一兼容 conversion。

这样当前仍存在的 `itinerary.day.reorder / itinerary.anchor.set / update_day` 不会因 boundary 提前启用而失效。

等这些 Action/fallback 都直接写 finalRoute 后，第 3 条应改为 hard reject，然后才能真正删除 generic reverse bridge。

### Store 内部 reverse bridge 仍存在

`TravelStoreV3.writePlanWithinTransaction()` 当前仍调用：

`syncFinalRouteForLegacyWriteV3(before, plan)`

**不要声称它已经删除或已被替换。**

当前状态是：

`调用方 -> 显式 canonical/legacy-translation boundary -> 原 TravelStoreV3 -> 旧 Store bridge(最后保险)`

对于已在外层翻译成 finalRoute change 的结构写，Store 内 bridge 只会再次走 finalRoute 正向派生，不再是第一次发现 Day route mutation 的地方。

### Day metadata 现状

`derived-day-integrity-v3.ts` 的 route projection 明确排除：

- title/date/stayBlockId/detailLevel/detailStatus
- anchor label/notes
- stop candidateId（由 node Place + Candidate set 派生）

`canonical-plan-write-v3.ts` 会区分：

- caller 主动修改 Day route structure；
- 因 origin / Candidate / Place 等 canonical 数据变化造成的 stale Day。

已修正过一次误判风险：origin 或 Candidate 改变导致 Day 需要重新派生时，不应被当成非法 Day mutation。

已记录一个仍需最终处理的历史语义：Day `title/date` 是旧 `itinerary.edit` 可编辑字段，但 Store 内 legacy bridge 的最终派生并不保证长期保留自定义值。当前 boundary 不应把这一点误写成已解决；后续需要决定是正式保留为 metadata override，还是从新 canonical 产品合同中移除该旧编辑能力，不能静默丢用户修改。

### 测试文件已补，但尚未运行

新增/扩展测试覆盖：

- canonical node detail；
- Stop add/update/move/remove canonical bridge；
- initial detailed itinerary canonical write；
- initial skeleton canonical route；
- skeleton replan canonicalization；
- derived Day structural-vs-stale classification；
- canonical plan boundary；
- 安装后的真实 `TravelStoreV3.writePlan` boundary；
- boundary 重复安装幂等；
- generation CAS 仍由原 Store 拒绝 stale write。

GitHub 当前没有自动 CI/status/workflow run。

## 当前不得破坏

- finalRoute 是唯一用户维护线路。
- Provider facts 不得伪造。
- unresolved 允许保留。
- 用户决策优先；旅行合理性 advisory，不是 canonical blocker。
- generation CAS / Proposal Scope / SQLite transaction 不得弱化。
- 不恢复 v2 -> v3 migration/双写。
- 不因文件名带 v2 就盲删；先判断它是否仍是 active implementation。

## 验证状态

尚未主动运行：test / typecheck / build / app / Provider E2E。

目前按 `AGENTS.md` 只做静态 diff/review；完整验证需用户确认。

## 下一步

1. 继续迁 `itinerary.day.reorder / itinerary.anchor.set / update_day`，让它们直接修改 finalRoute 或明确 Day metadata，而不是依赖过渡 translation。
2. 清掉 Stop fallback 后，把 `canonicalizePlanWriteV3` 的“legacy structural translate”切成 hard reject。
3. 条件成熟后再把 Store 内 `syncFinalRouteForLegacyWriteV3` generic reverse bridge 删除/收窄。
4. 再回 P0-1 继续 Runtime 未接线模块；仍避免 100KB 大爆炸替换。
5. P0 完成后整理正式文档并删除临时 worklog。