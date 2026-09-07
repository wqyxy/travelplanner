# P0 Temporary Worklog — 2026-09-07 Checkpoint

> 当前事实版。更早的逐步记录见 `docs/P0_TEMP_WORKLOG.md`。P0 完成后统一整理并删除临时文件。

## P0-1 — Runtime 拆分

`planner-runtime-v3.ts` 仍约 100KB。已建立：

- `planner-action-scope-v3.ts`
- `planner-proposal-v3.ts`
- `planner-resolution-state-v3.ts`
- `planner-itinerary-validation-v3.ts`
- `planner-itinerary-commands-v3.ts`
- `planner-itinerary-impact-v3.ts`
- `planner-action-context-v3.ts`
- `planner-resolution-coordinator-v3.ts`
- `planner-route-coordinator-v3.ts`
- `planner-deterministic-commands-v3.ts`
- `planner-candidate-output-v3.ts`

已明确接回 Runtime：Action Scope、Proposal diff、Resolution current-state、Itinerary structural validation、Itinerary command derivation。

尚未接回 Runtime：impact helper、Action Context、Resolution/Route coordinator、deterministic command、candidate output。不要把“文件已建立”误写成“已接线”。因为 GitHub 当前只能整文件替换，继续避免高风险重写 100KB Runtime。

## P0-2 — V2/V3 capability seam

已完成第一阶段：Provider fact chain 不再靠 `unknown as` 连接 V2/V3 Store。

关键提交：

- `964313b7bea0ad39ab49930c24b5fb24f28eabfe`：移除 Runtime resolver cast。
- `5ca40331dfc46e929167230f010aeca7e35f88ff`：删除废弃 `place-resolver-adapter-v3.ts`。
- `1ae5e6690e75e4d02758fdad2d4a5a33a5a1a1d9`：`index-v3.ts` 删除两个 Store cast。
- `29d4b46d349530157e8e629352de6b5a32c0c894`：新增 `provider-store-capabilities-v3.ts`。
- `51057bd60178bbf8f61792d2e7b102504e85a2a5`：Route Service 改依赖独立 capability。
- `f25da1f5d6eac8e47f2872f6fb35ca250f9a150d`：Resolver 改依赖独立 capability。

Provider capability：

- Resolution：`requireTrip / listPlaceResolutions / upsertPlaceResolution`。
- Route：`getWorkspace / requireTrip / listPlaceResolutions / getDayRoute / setDayRoute`。

Provider 搜索/消歧、geometry、distance、duration 生产逻辑未改。

## P0-3 — finalRoute / Day / Route canonical boundary

### 核心结论

- canonical route：`finalRoute.nodes`。
- 正向派生：`deriveFinalRouteDaysV3()` / `rebuildFinalRouteDaysV3()`。
- Day 继续保留，但目标是消灭 Day 作为独立路线结构写入口；Day 可继续承担 read model、AI context、detail metadata、Provider route input。
- `tentative/no_go` 保留在 finalRoute，但退出当前 Day/Route。
- 同 Place 多晚必须是多个独立 route node ID。

### Legacy Store reverse bridge 仍存在

`TravelStoreV3.writePlanWithinTransaction()` 当前仍调用 `syncFinalRouteForLegacyWriteV3(before, plan)`。这意味着 Store 仍会替旧调用方把 Day route structure 反向翻译为 finalRoute。

**该 generic Store bridge 尚未收紧。不要声称已经删除。**

已确认 Store 内不仅 `writePlan` 使用 private writer，`writePlanAndPlaceResolution / applyProposalPlan / undoProposal` 也直接经过它，所以不能用外层 wrapper 假装替代 Store boundary。

### Canonical node detail

- `4739b8e2ace287dc97458d4c95e3eaa0b67fdee9`：新增 `final-route-node-detail-v3.ts`。
- `b93524a175257d8e1ae97e24819bbacc18a7a55d`：测试。

允许节点 detail：activity / period / scheduleText / time / duration / schedule verification / cost / notes。

明确排除：id/placeId、status、endsDay、transport、Provider route facts。

### Legacy Stop PlanCommand 已 canonical-first

`final-route-day-stop-bridge-v3.ts` 覆盖：

- update Stop detail / candidate+place replace / itinerary transport；
- remove Stop；
- add Stop；
- move Stop；
- tentative/no_go 使用与旧 bridge 等价的 inactive-node anchoring 规则。

关键提交：

- `65ec5ca2a89e38e32e114109b8af6a121c774b9c`：`applyPlanCommands()` 四种 Stop case canonical-first；不能无损表达时才走 legacy fallback。
- `bb1d1a6c56f057b999bffc8d5c47fcb7fbccb88c`：add/move 与旧 bridge 等价测试。
- `dfc3a3e12c5d30023a3bd00b079059f05816d53a`：PlanCommand 集成测试。

保留了原 `markDayForReview()` 语义。

### 所有有 canonical finalRoute 的 PlanCommand 输出现在都会收口

- `9dddc18d8e8b4a4d75cfc6af07fdeaa462808685` — `refactor: canonicalize V3 plan command results`

`applyPlanCommands()` 在输入已有 `finalRoute.nodes` 时，返回前显式执行现有 `syncFinalRouteForLegacyWriteV3(before, validated)`。

因此 V3 下即使是仍保留旧合同的：

- `set_day_anchor`
- `move_day`
- `update_day`
- 少数 Stop fallback

返回的 plan 也已经同步为 canonical finalRoute；Day-only/V2 fixture 无 finalRoute nodes 时继续旧行为。

相关测试已扩展，覆盖 Day reorder / end-anchor edit / transferMode edit 后 `inspectDerivedDayWriteV3(...).matchesCanonicalDays === true`。测试尚未运行。

### Detailed itinerary direct write 已 canonical

- `5351b1a95b4e20ade2e6537082afda70f1eac4d5`：`applyDetailedUpdatesPhase5V3()` 改为通过 canonical add/move/update/remove route-node 路径写入，再正向派生 Day。
- `abeed9f8c101083931f3e3dfbab59baee1819686`：仅对旧 Day-only test/in-memory fixture 保留窄 fallback。
- `3759ea18e9508ec1c6a520fffbcccb684292ad7a`：真实 finalRoute fixture 测试。

待处理 edge case：若新增的第一个详细 Stop 与 trip/day start origin 为同一 Place，正向派生可能将其折叠为 start semantics；未验证前不要改变派生规则。

### Skeleton initial + replan 已在 Store 前 canonical

Initial：

- `d14aed8a2e98378279f46a570ac537a17e087ee1`：`skeleton-final-route-v3.ts`，首次 skeleton 直接生成 canonical boundary nodes。
- `ff8d381edf1d188f3cd5cfa1e8d0ef69c1bbcab8`：`applySkeletonPlanV3()` 首次生成接线。
- `eba45a9291edee878ac67c9dbc8063fd8bb300ab`：测试；锁住“住多晚 = 多个同 Place 独立 node”。

Replan：

- `d9eaf0254835d11721769f32446ad09d121ceee9`：`applySkeletonPlanV3()` 对已有 canonical route 的 replan 在 workflow 内显式调用等价 legacy conversion，Store 前 finalRoute 已同步。

该 replan adapter 暂时复用同一 `syncFinalRouteForLegacyWriteV3` 算法，目的是先把隐式 Store 魔法前移到明确 workflow boundary，不改变行为。

曾创建一个“直接移动整个 Day segment”的实验 helper，但静态推演发现不保证与旧 continuity normalization 等价，未接主链并已删除：

- `822052147272765899241a4e9af00b9a91a93f3c`。

### Derived Day integrity

已新增 `derived-day-integrity-v3.ts`：

`inspectDerivedDayWriteV3(plan)` 会用当前 finalRoute 正向重建 Day，并判断 incoming Day 是否能完全 round-trip。

- metadata-only（如 `detailStatus`）可保留；
- Stop identity/order/place/detail/transport 或 Day route structure 独立变化会 mismatch。

已写测试，尚未运行。

### Persistence boundary helper 已建立，但未接 Store

已新增 `canonical-plan-write-v3.ts`：

`canonicalizePlanWriteV3(before, incoming)` 规则：

1. finalRoute 已改：finalRoute authoritative，正向重建 Day；
2. finalRoute 未改但已有 canonical nodes：仅接受能 round-trip 的 Day metadata；否则抛 `DERIVED_DAY_ROUTE_WRITE_REJECTED`；
3. 纯 legacy Day-only plan：暂时继续旧 reverse bridge。

测试覆盖 authoritative finalRoute、metadata-only、非法独立 Day structure、legacy Day-only fallback。

**该 helper 尚未接 `TravelStoreV3.writePlanWithinTransaction()`。**

目前之所以暂不接，是因为 Store 约 50KB，而 GitHub 连接器没有文本 patch 能力，只能整文件替换；已经精确定位到 Store 需要改的只有 import + `nextPlan` normalization，但在没有完整安全重写条件时不冒险。

## 当前生产写链判断

已经在 Store 之前 canonical：

- V3 `applyPlanCommands()` 输出；
- Proposal apply 中通过 PlanCommand 的结构修改；
- itinerary initial skeleton；
- itinerary skeleton replan；
- itinerary initial detailed generation；
- detail update/repair/refine/day optimize/verify 等通过 PlanCommand 的 Proposal 路径。

requirements/candidate/map 类写入不应独立改 route structure；`markImpact` 等只写 Day metadata，未来 Store boundary 应允许其 round-trip。

## 不得破坏

- finalRoute 是唯一用户维护线路。
- Provider facts 不得伪造。
- unresolved 允许保留。
- 用户决策优先；合理性 advisory，不是 canonical blocker。
- generation CAS / Proposal Scope / SQLite transaction 不得弱化。
- 不恢复 v2->v3 migration/双写。

## 验证状态

尚未运行：test / typecheck / build / app / Provider E2E。

目前只做静态 diff/review，符合当前 `AGENTS.md` 普通施工约束。

## 下一步

1. 继续证明 Store 之前所有 production route-structural writes 已 canonical；补缺口而不是先强行改 Store。
2. 条件成熟后，把 `canonicalizePlanWriteV3` 接入 `TravelStoreV3.writePlanWithinTransaction()`，保持 transaction/CAS 顺序完全不变。
3. Store boundary 接通后，generic Day->finalRoute reverse bridge 只保留为 Day-only legacy fallback。
4. 再回 P0-1 处理 Runtime 未接线 helper，仍避免 100KB 大爆炸替换。
