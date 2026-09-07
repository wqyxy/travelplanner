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

当前不能直接删这个桥。剩余 legacy Day 命令仍包括：

- `set_day_anchor`
- `move_day`
- `update_day`

`add/update/move/remove_day_stop` 的主要生产路径已经迁到 canonical-first，但极少数无法无损表达的旧语义仍保留 fallback。

#### Canonical node detail 能力

已创建 `apps/server/final-route-node-detail-v3.ts`：

- `4739b8e2ace287dc97458d4c95e3eaa0b67fdee9` — `feat: add canonical final route detail update`
- `b93524a175257d8e1ae97e24819bbacc18a7a55d` — 独立测试。

`updateFinalRouteNodeDetailV3()` 只允许修改 activity / period / schedule / time / duration / verification / cost / notes；明确排除 node identity、status、day boundary、transport 和 Provider route facts。

#### Legacy Stop PlanCommand 已改为 canonical-first

新增 `apps/server/final-route-day-stop-bridge-v3.ts`，当前覆盖：

- `update_day_stop`：纯 detail、candidate+place replacement、itinerary transport；无法无损表达的 candidate detach/place-only 语义返回 null 走临时 fallback。
- `remove_day_stop`：删除同 ID canonical route node。
- `add_day_stop`：在目标 Day 的 Stop/boundary 前插入 canonical route node；保留临时 ID -> 正式 ID 映射。
- `move_day_stop`：重排 active route node，并用与旧 bridge 相同的 inactive-node bucket 规则保留 tentative/no_go 相对锚定。

关键提交：

- `21a8cf3f8571a42bdcc1c96f408c313ba3440605` — removal bridge。
- `bb1d1a6c56f057b999bffc8d5c47fcb7fbccb88c` — add/move 与 legacy bridge 等价测试。
- `65ec5ca2a89e38e32e114109b8af6a121c774b9c` — `applyPlanCommands()` 四种 Stop case 接入 canonical-first，原 legacy fallback 保留。
- `dfc3a3e12c5d30023a3bd00b079059f05816d53a` — PlanCommand 集成测试。

接线时明确保留了原来的 `markDayForReview()` 语义：详细 Day 经 Stop 修改后仍标记 `needs_review`；canonical bridge 不会偷偷改变这条产品状态规则。

#### 首次详细行程已直接写 canonical finalRoute

`itinerary.detail.generate` 原本由 `applyDetailedUpdatesPhase5V3()` 直接返回修改后的 `days`，Store 再反向重建 finalRoute。现已改为：

1. 根据 AI update 构造 desired Stop sequence；
2. 通过 canonical add/move/update/remove bridge 修改 finalRoute；
3. 每次由 finalRoute 正向重新派生 Day；
4. 最后只在派生 Day 上标 `detailLevel=detailed / detailStatus=ready`。

提交：

- `5351b1a95b4e20ade2e6537082afda70f1eac4d5` — canonicalize detailed itinerary。
- `abeed9f8c101083931f3e3dfbab59baee1819686` — 仅为旧 Day-only 测试/内存 fixture 保留狭窄 fallback；真实 finalRoute 数据走 canonical path。
- `3759ea18e9508ec1c6a520fffbcccb684292ad7a` — 真实 finalRoute fixture 测试，覆盖 reorder/add/remove/detail update。

已记录一个待处理 edge case：若首次 detailed update 想把“trip origin 同 Place”作为第一个普通 Stop，正向派生可能把该节点折叠成 start semantics；不能在未测试前修改派生规则。

#### 首次 skeleton 已直接写 canonical finalRoute

新增 `apps/server/skeleton-final-route-v3.ts`：

- `d14aed8a2e98378279f46a570ac537a17e087ee1` — 首次 skeleton Day -> canonical boundary nodes。
- 每个 Day 对应一个独立 route node；同 Place 多晚仍是不同 node ID。
- 前 N-1 个 boundary `endsDay=true`，自然尾段作为最后一个 Day。
- Day `transferMode` 写入 boundary `transportFromPrevious`，duration/verification 保持 unverified，不伪造 Provider 事实。
- desired Day 仅作为 stayBlockId/date/detail metadata source，最终立即由 finalRoute 正向 re-derive。

`applySkeletonPlanV3()` 已接入该 helper：

- `ff8d381edf1d188f3cd5cfa1e8d0ef69c1bbcab8` — 仅当旧 Day 和 finalRoute 都为空时走 canonical initial path；已有路线 replan 保持旧行为。
- `eba45a9291edee878ac67c9dbc8063fd8bb300ab` — 集成测试，锁住“同 Place 多晚 = 多个独立 route node”、独立 Day ID 和 transport 正向派生。

当前因此已有三条真实生产写链不再依赖 Store 的隐式反向转换：

1. legacy Stop PlanCommand 的主要路径；
2. 首次详细行程；
3. 首次 skeleton 生成。

#### 尚未迁完

仍需处理：

1. skeleton replan：当前仍生成 `diff.days`，最终由 Store bridge 翻译；可复用同一个 `syncFinalRouteForLegacyWriteV3` 提前到 workflow 内执行以保持行为不变。
2. `set_day_anchor / move_day / update_day`：仍是 Day-level structural write。
3. Stop bridge 的少数 legacy fallback。
4. metadata-only Day 写入（如 `detailStatus=needs_review`）需要与结构写入区分；最终 Store 应只拒绝 route-structural Day 写入，不应破坏派生状态 metadata。

结论：P0-3 的目标不是“删 days[]”，而是**消灭 Day 作为路线结构写入口**。Day 可以继续作为派生 read model、AI context、detail状态 metadata 和 Route Provider 输入。

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
- Provider capability 改造没有改 Resolution 搜索/消歧、Route Provider 调用、distance/duration/geometry 写入逻辑。
- `index-v3.ts` 的三处已知 `unknown as` seam 已移除。
- Resolver Adapter 已无引用并删除，没有引入第二套定位事实链。
- finalRoute -> Day 已有唯一明确派生函数；当前问题是少量旧 Day 写入口仍通过兼容桥存在，而不是保存了第二份独立 canonical route。
- 所有新 canonical helper 都立即调用正向 Day derivation，不维护第二份独立路线结构。

## 验证状态

尚未运行：

- test
- typecheck
- build
- app
- Provider/E2E

当前仍遵守 `AGENTS.md`：普通施工先静态 review，完整验证需用户确认。

## 下一步

1. skeleton replan 显式 canonicalize，使该 workflow 也不再依赖 Store 隐式 bridge。
2. 处理 `set_day_anchor / move_day / update_day`，优先保持当前 legacy conversion 等价语义，不发明新的路线规则。
3. 区分 Day route-structural fields 与 metadata-only fields，为最终删除 Store generic reverse bridge 做准备。
4. 同时继续 P0-1 的 Runtime 小风险接线，不做 100KB 大爆炸替换。
5. P0 完成后把两份临时 worklog 整理进正式文档并删除临时文件。
