# P0 Temporary Worklog

> P0 唯一临时施工记忆文件。
>
> 开始时间：2026-09-07
> 当前分支：main
> 当前状态：**P0-1 / P0-2 / P0-3 实现完成，待验证**

## P0 目标

1. `planner-runtime-v3.ts`：行为保持地拆分 God Object，让 Runtime 回到 application facade / orchestration。
2. V2/V3 边界：消除 P0 主链上的不安全 Store/Resolver cast；保留仍在工作的 V2 命名算法，不盲删。
3. finalRoute / Day / Route：`finalRoute.nodes` 成为唯一用户维护线路；Day 是派生/read model + metadata + Provider route input。

## 不得破坏的产品/工程事实

- 用户只维护 `finalRoute`；Day 自动派生。
- 同一 Place 可在线路中多次出现，每次拥有独立 route node ID。
- `tentative / no_go` 保留，但退出当前 Day / Route。
- `住 / 不住` 控制日程分界；`多一晚` 新增同 Place 独立 route node。
- 右侧最终线路是唯一业务操作入口；地图负责展示/选择/聚焦/响应定位选点。
- Provider 坐标、Place ID、geometry、distance、duration、verified 状态不能由 AI/前端伪造。
- 用户是旅行方案唯一决策者；旅行“合理性”原则上是 advisory，不是 canonical blocker。
- SQLite transaction、generation CAS、Proposal Scope、Provider fact chain 不得弱化。
- 不恢复 v2 -> v3 migration/双写。

---

# P0-1 — Runtime architecture

## 结果

`planner-runtime-v3.ts` 从最初约 100KB 收缩到约 40KB，当前主要保留：

- workspace/read-model facade 聚合；
- dialogue thread / turn / web-required 生命周期；
- Action claim / confirmation / execution 生命周期与每旅行 AI Action 串行限制；
- Proposal create/apply/reject/undo 生命周期；
- direct `applyCommands()` facade 编排；
- coordinator 装配和 public thin wrappers。

这些是 Runtime 作为 application facade/orchestrator 的合理职责；不再为了缩文件机械拆 Action/Dialog lifecycle。

## 已建立并真正接入 Runtime 的模块

- `planner-action-scope-v3.ts`
- `planner-proposal-v3.ts`
- `planner-resolution-state-v3.ts`
- `planner-itinerary-validation-v3.ts`
- `planner-itinerary-commands-v3.ts`
- `planner-itinerary-impact-v3.ts`
- `planner-action-context-v3.ts`
- `planner-deterministic-commands-v3.ts`
- `planner-candidate-output-v3.ts`
- `planner-resolution-coordinator-v3.ts`
- `planner-route-coordinator-v3.ts`
- `planner-interest-discovery-coordinator-v3.ts`
- `planner-action-persistence-coordinator-v3.ts`
- `planner-google-maps-link-coordinator-v3.ts`
- `planner-requirements-mutation-v3.ts`

## 关键提交

早期纯 helper：

- Action Scope：`3880aa1fcb43356345972655c76f270e818d0025` / Runtime 接线 `8d2aeafa72b7838b05cee518e24134fff719c6a0`
- Proposal diff：`5445665dc8e9a7e857fac95f513eee98780e1f4e` / Runtime 接线 `c42c854f85e5279b8d386fcd639505c186c9925a`
- Resolution current-state：`6a51b558627a7e8f61c2a01c0d690c0b7453f61c` / Runtime 接线 `2bcacd9c5692997e3882359a86fe43ab4bbb021f`
- Itinerary structural validation：`5819163f3c9b57280f0ca43fda7a6af9e3190298` / Runtime 接线 `bdadeb84cfb6efe90fab0a7ed51c22175338d099`

Runtime 大职责接线：

- `5927becabdb601fab387408eba25c948cb6cd707`：Action Context / deterministic commands / candidate output / impact。Runtime `+17/-259`。
- `e2429f602c2b45f958ba49661db3e8412547a37f`：Resolution / Route coordinator。Runtime `+36/-101`。
- `d7234d71ebe60bd711ffe507da44b5f5156991f1`：Interest Discovery coordinator。Runtime `+14/-222`。
- `2a207dea718e7bdb980bd882a786c7986bc986b6`：AI Action persistence coordinator；destination/itinerary AI 输出具体落库/Proposal 准备移出 Runtime，Proposal lifecycle 留在 Runtime。
- `f06af021f0fa8cfca7ab5e3b2b94f17587ac6747`：Google Maps link coordinator 最终接线状态。
- `e0cdb74dc845015baa5bc5f0d74ad4c06fb1c523`：Action persistence 复用统一 `dayMutationScope`，删除第二份 Scope Policy。
- `6746fd0573afdc93415d7b03b9f16daf883c683f`：requirements mutation builder 接回 Runtime。

> 曾在聊天最终回复中误写 requirements commit SHA；**正确值是 `6746fd0573afdc93415d7b03b9f16daf883c683f`**。

## requirements mutation

`planner-requirements-mutation-v3.ts` 纯构建：

- `requirements.capture`
- `requirements.update`
- `requirements.clear`

Runtime 继续负责原 Store write、generation CAS、revision 与 `travel.document.changed`。

静态核对旧语义：

- 同一组允许字段；
- `brief` 仍 merge；
- clear 未知字段仍忽略；
- 错误文案不变；
- revision source / summary 不变；
- Runtime 原 `REQUIREMENT_FIELDS` 和 `(next.trip as any)[key]` 已删除。

## Google Maps 接线事故记录

第一次大文件替换曾误删 `captureAdditionalRequirements()`；commit diff 当场发现，并在 `f06af021f0fa8cfca7ab5e3b2b94f17587ac6747` 恢复。

最终相对接线前净 compare：

- 新增 coordinator 90 行；
- Runtime `+14/-36`；
- `captureAdditionalRequirements()` 保留。

结论：以后大文件写入成功不等于完成；必须再做 commit diff + base/head compare。

---

# P0-2 — V2/V3 capability seam

## 结果

P0 Provider/Store 主链的不安全边界已收口：

- `index-v3.ts` 已去掉已知 V2/V3 `unknown as` Store/Resolver 强转；
- 废弃 `place-resolver-adapter-v3.ts` 已删除；
- `provider-store-capabilities-v3.ts` 提供 Resolution/Route 所需窄 Store capability；
- `provider-resolver-capability-v3.ts` 提供 Planner-facing Resolver capability；
- `planner-resolution-coordinator-v3.ts` 改依赖 resolver capability；
- Runtime resolver option 改为 `PlannerPlaceResolverCapabilityV3`；
- `selectResolution()` / `setDirectResolution()` 两个 Runtime `as any` 已删除。

关键提交：`158d5b631c785cab3c6d52808b8758d63b457d90`。

当前 `index-v3.ts` 直接把 `TravelStoreV3` 传给：

- `PlaceResolverV2`
- `DayRouteServiceV2`

二者依赖窄 capability，不再要求 `TravelStoreV2` 类型。

`PlaceResolverV2` / `DayRouteServiceV2` 文件名虽然仍带 v2，但它们仍是当前 Provider fact chain 的活跃实现；**不因命名盲删或重写**。

Provider 搜索、消歧、coordinates、geometry、distance、duration 算法未改。

---

# P0-3 — finalRoute / Day / Route canonical boundary

## 当前 canonical 规则

- canonical route：`finalRoute.nodes`。
- Day：派生/read model + metadata + Provider route input。
- Stop add/update/move/remove：canonical-first。
- detailed initial：先写 finalRoute，再派生 Day。
- skeleton initial：直接创建 canonical boundary nodes。
- Day `transferMode` / nullable anchor / pure reorder：已有 direct canonical adapter。
- Day `title/date`：允许持久 metadata override。
- canonical plan 未知独立 Day Stop/endTransport/Day-ID/anchor-ID 写：抛 `DERIVED_DAY_ROUTE_WRITE_UNSUPPORTED`。

## Store 本体 canonical boundary

关键提交：`f8fefe8f89b043416864851d0e7f55eb2d2a57f3`。

`TravelStoreV3.writePlanWithinTransaction()` 已直接执行 `canonicalizePlanWriteV3()`，不再把 generic reverse bridge 当默认保存逻辑。

该 Store 大文件严格 diff 只有：

1. import 改为 `canonicalizePlanWriteV3`；
2. `nextPlan` normalization 一行替换。

SQLite transaction、generation CAS、revision、cleanup、Proposal reconcile/apply/undo 顺序未改。

## Skeleton replan 已脱离 generic reverse bridge

原 `applySkeletonReplanToFinalRouteV3()` 直接调用 `syncFinalRouteForLegacyWriteV3(before, desired)`。

提交 `5da6245471462c11c9a051878aaed8db043b6d9d` 后：

- Skeleton replan 使用专用 canonical adapter；
- transient Day 数据只用于 Stay Block / Day identity 匹配；
- Store 前显式生成 finalRoute；
- 保留旧 translator 的 node mapping、Day continuity、inactive-node anchoring、detail mapping 和 transport mapping 语义；
- **这一笔没有顺带修改 Provider transport 行为**，避免架构施工夹带业务变化；
- `skeleton-final-route-v3.ts` 不再 import/call `syncFinalRouteForLegacyWriteV3`。

回归测试提交 `cc9e06ef2e937378c2d2632745a253761536c123` 新增覆盖：

- Stay Block 重排时复用已有详细 Stop；
- Stop canonical node ID / detail / transport 保留；
- 被移动的 detailed Day 标记 `needs_review`；
- 最终结果仍满足 derived Day 与 canonical finalRoute 一致。

本次 P0-3 base/head compare（`515d08f...` -> `cc9e06e...`）只有：

- `skeleton-final-route-v3.ts`；
- `itinerary-workflow-final-route-v3.test.ts`。

## generic compatibility bridge 仍保留在哪里

`syncFinalRouteForLegacyWriteV3()` 仍作为明确兼容实现存在，主要由 `canonical-plan-write-v3.ts` 在以下窄场景使用：

- 纯 Day-only legacy/bootstrap；
- 已知旧 Day order/transfer/anchor 混合 batch。

对于正常 canonical plan：

- finalRoute 变化 -> finalRoute authoritative；
- pure transfer/anchor/reorder -> direct adapter；
- stale/metadata-only Day -> forward derive；
- 未登记独立 Day route mutation -> hard reject。

因此 generic bridge 已不是 Store 默认 canonical 写链，也不再承担 Skeleton replan 主生产路径。

---

# 当前结论

**P0-1、P0-2、P0-3 的代码实施已经完成。**

目前没有发现还需要继续机械拆 Runtime、盲删 V2 文件或继续扩大 canonical rewrite 的 P0 必须项。

下一阶段应先验证，而不是继续改结构。

## 验证状态

截至当前仍未主动运行：

- test
- typecheck
- build
- app
- Provider E2E

GitHub 当前未看到自动 CI run。

这符合 `AGENTS.md` 普通施工约束：普通修改不自动跑整套 test/typecheck/build；完整验证需要用户确认。

## P0 下一步（需要进入验证）

优先验证顺序建议：

1. P0 相关 targeted tests：canonical write、finalRoute Day adapters、Skeleton replan、detail canonical writes、Provider capability seam。
2. typecheck。
3. 再根据结果决定是否需要修补。
4. 用户确认后再做 full test/build/app/E2E。

P0 验证通过后，把最终结论同步到正式项目状态/架构文档，并删除本临时文件。
