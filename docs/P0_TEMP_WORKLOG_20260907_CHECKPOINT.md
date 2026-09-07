# P0 Temporary Worklog — 2026-09-07 Checkpoint

> 当前事实版。更早的逐步记录见 `docs/P0_TEMP_WORKLOG.md`。P0 完成后统一整理并删除临时文件。

## P0-1 — Runtime 拆分

`planner-runtime-v3.ts` 仍约 100KB。

已建立的独立模块包括：Action Scope、Proposal diff、Resolution current-state、Itinerary structural validation/commands/impact、Action Context、Resolution/Route coordinator、deterministic commands、candidate output。

已明确接回 Runtime：Action Scope、Proposal diff、Resolution current-state、Itinerary structural validation、Itinerary command derivation。

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

### Stop / detailed / skeleton 写链

Stop PlanCommand 已 canonical-first：

- add/update/move/remove 普通 derived Stop 直接修改 finalRoute。
- `candidateId` 视为由 node `placeId` + Candidate set 派生，不再保存 candidate detach 第二状态。
- place-only Stop update 直接改 canonical Place；Candidate 自动重新派生。
- add Stop 未给 candidateId 时也按 Place canonicalize，Day 派生时自动关联已有 Candidate。
- tentative/no_go 使用与旧 bridge 相同的 inactive-node anchoring 规则。
- `markDayForReview()` 语义保留。

Detailed initial generation 已先写 finalRoute 再派生 Day；旧 Day-only fixture 仅保留窄 fallback。

Skeleton initial 直接建立 canonical boundary nodes；同 Place 多晚 = 多个不同 node ID。

Skeleton replan 已在 workflow 内显式 canonicalize，不再等 Store 第一次发现 Day route mutation。

### 过渡 canonical Store boundary 已在运行时启用

新增：

- `derived-day-integrity-v3.ts`
- `canonical-plan-write-v3.ts`
- `canonical-travel-store-v3.ts`

`index-cutover-v3.ts` 在动态 import `index-v3.ts` 前安装：

`installCanonicalTravelStoreWriteBoundaryV3()`

它只包住公开 plan 写入口：

- `writePlan`
- `writePlanAndPlaceResolution`
- `applyProposalPlan`

底层仍调用原 `TravelStoreV3`，没有复制/替换 SQLite transaction、generation CAS、revision、Proposal transaction、cleanup/reconcilePendingState。

安装器：

- prototype 不可枚举标记保证幂等；
- stale generation / 非 pending Proposal 时直接回原 Store，保持原 CAS/状态错误顺序。

### Day structural writes 已继续从 generic conversion 中拆出

`canonicalizePlanWriteV3()` 当前按下面顺序处理已有 canonical finalRoute 的旧 Day 写：

1. finalRoute 本身已改：finalRoute authoritative，正向派生 Day。
2. stale Day / metadata-only：正向派生覆盖 stale route view。
3. **transferMode-only**：`final-route-day-transfer-v3.ts`
   - 直接写该 Day segment 第一个 active route node 的 transport。
   - 使用 `updateFinalRouteTransportV3()`，因此用户改 mode 时会清空旧 distance/duration-like transport 数字/说明并重置为 `unverified`，不伪造 Provider 事实。
   - 同次写中的其它 trip/candidate/place canonical 变化保留。
4. **non-null anchor Place-only**：`final-route-day-anchor-v3.ts`
   - Day1 start -> `trip.originPlaceId`。
   - 后续 Day start -> 前一天 boundary node Place。
   - Day end -> 当前 Day boundary node Place。
   - 两个 anchor 若要求同一个 canonical boundary 去不同 Place，则不猜，退回旧 conversion。
   - null anchor 暂不直接 canonicalize，因为 FinalRouteNode 不能表达 null Place；继续旧兼容路径。
5. **pure Day reorder**：`final-route-day-reorder-v3.ts`
   - 直接移动完整 active route segments。
   - inactive nodes 使用旧 bridge 相同 anchoring。
   - 最后 segment 保留其 boundary 原来的 `endsDay`，这是此前实验与 legacy finalRoute diff 不一致的关键原因。
   - 测试用 first->last、last->first 比较 legacy conversion 的 `finalRoute.nodes` 与 `days` 全量相等。
6. 其它 mixed/null/fallback Day structural write：暂时显式调用 `syncFinalRouteForLegacyWriteV3`。
7. 纯 Day-only legacy/bootstrap：继续同一 compatibility conversion。

因此当前 `itinerary.day.reorder`、大多数 `itinerary.anchor.set`、`update_day.transferMode` 已有明确 direct canonical 路径；不是所有 Day-level 变化都再落到 generic translator。

### Store 内部 reverse bridge 仍存在

`TravelStoreV3.writePlanWithinTransaction()` 仍调用：

`syncFinalRouteForLegacyWriteV3(before, plan)`

**不要声称已经删除。**

当前运行链：

`调用方 -> 显式 canonical/legacy-translation boundary -> 原 TravelStoreV3 -> Store 内旧 bridge(最后保险)`

外层已经改出 finalRoute 的写入，内层 bridge 只会再次正向派生，不再是第一次发现 route mutation 的地方。

### Day metadata 仍有一个明确未决项

`derived-day-integrity-v3.ts` 的 route projection排除：

- title/date/stayBlockId/detailLevel/detailStatus
- anchor label/notes
- stop candidateId

origin / Candidate / Place 等 canonical 数据变化造成的 stale Day 不会误判为用户独立改 route。

**Day `title/date` 仍未最终解决。**

旧 `itinerary.edit` 允许编辑 title/date；外层 boundary 能识别并暂存该显式 metadata，但 Store 内 legacy bridge 的最后一次 Day 派生仍不保证 end-to-end 保留。后续必须二选一并明确落地：

1. 正式把 title/date 设计为可持久的 Day metadata override；或
2. 从新 canonical 产品合同移除这项旧编辑能力。

不能静默丢用户修改。

### 测试文件已补，但尚未运行

覆盖包括：

- canonical node detail；
- Stop add/update/move/remove；
- Stop candidate relation 派生；
- initial detailed itinerary；
- initial skeleton / replan；
- derived Day structural-vs-stale classification；
- canonical plan boundary；
- legacy Day transfer mode direct mapping；
- non-null anchor direct mapping + legacy continuity equivalence；
- Day reorder first->last / last->first legacy exact equivalence；
- real `TravelStoreV3.writePlan` boundary；
- boundary repeated install idempotency；
- generation CAS stale write。

GitHub 当前没有自动 CI/status/workflow run。

## 当前不得破坏

- finalRoute 是唯一用户维护线路。
- Provider facts 不得伪造。
- unresolved 允许保留。
- 用户决策优先；旅行合理性 advisory，不是 canonical blocker。
- generation CAS / Proposal Scope / SQLite transaction 不得弱化。
- 不恢复 v2 -> v3 migration/双写。
- 不因文件名带 v2 就盲删；先判断是否仍是 active implementation。

## 验证状态

尚未主动运行：test / typecheck / build / app / Provider E2E。

目前按 `AGENTS.md` 只做静态 diff/review；完整验证需用户确认。

## 下一步

1. 审核 generic fallback 实际剩余形态：重点是 null anchor、mixed Day structural batch、少量无法映射的旧 fixture。
2. 明确 Day `title/date` 最终产品语义，解决 end-to-end persistence。
3. generic fallback 收窄到明确兼容形态后，把 normal canonical plan 的未识别 Day structural write 改为 hard reject。
4. 条件成熟后删除/收窄 Store 内 generic reverse bridge。
5. 再回 P0-1 继续 Runtime 未接线模块；仍避免 100KB 大爆炸替换。