# P0 Temporary Worklog — 2026-09-07 Checkpoint

> 当前事实版。更早的逐步记录见 `docs/P0_TEMP_WORKLOG.md`。P0 完成后统一整理并删除临时文件。

## P0-1 — Runtime 拆分

`planner-runtime-v3.ts` 的第一轮职责拆分已经真正接线，不再只是“先建文件”。

### 已接入 Runtime 的独立模块

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

### Runtime pure/domain delegate 接线

提交 `5927becabdb601fab387408eba25c948cb6cd707`：

- Action Context 改由 `buildPlannerActionStateV3()` 构建；Runtime 仅提供 Store 数据与惰性 Route getter。
- deterministic Action -> PlanCommand 改由 `deterministicCommands()` 负责。
- itinerary impact 改由 `markImpact()` 负责。
- destination/candidate output 的 requirements gate、范围校验、normalization、candidate command 改由 `planner-candidate-output-v3.ts` 负责。
- 删除 Runtime 内对应重复实现。

文件级 compare：仅 `planner-runtime-v3.ts`，`+17 / -259`。

### Provider coordinator 接线

提交 `e2429f602c2b45f958ba49661db3e8412547a37f`：

- Runtime 不再持有 `routeBatches` Map。
- resolution progress / resolveChangedPlaces / retryResolutions 移交 `PlannerResolutionCoordinatorV3`。
- route recalculation / dirty route batch / macro route batch / route-task abort 移交 `PlannerRouteCoordinatorV3`。
- Runtime 保留原公开方法名和薄 wrapper，因此 API 调用方不变。
- `stopTask()` 仍保持旧行为：AI active run 优先；否则尝试停止 route batch；找不到时继续抛“当前任务已经结束。”。
- coordinator 通过 Runtime callback 发出原 `travel.resolution.changed` / `travel.route.changed` 事件。

文件级 compare：仅 `planner-runtime-v3.ts`，`+36 / -101`。

Provider 搜索/消歧、route geometry/distance/duration 算法没有修改；generation supersede、Abort 和 task 状态文案保持原逻辑。

### Runtime 当前仍负责的主要事情

- workspace/read-model 聚合。
- dialogue thread / turn / web-required 生命周期。
- Action claim / confirmation / execution 生命周期与每旅行 AI Action 串行限制。
- requirements.capture/update/clear 的特殊 deterministic 持久化。
- AI Action output dispatcher 和各 Action 的持久化编排。
- interest discovery 的多区域并发 worker / commit gate / stop / failure 分类。
- Proposal create/apply/reject/undo 编排。
- Google Maps link preview/apply。

下一步不要再拆纯 helper；优先清理剩余 resolver `as any` seam，然后决定是否把 interest discovery 或 AI output persistence 抽成 coordinator。Action lifecycle/claim executor 仍最后处理。

## P0-2 — V2/V3 capability seam

第一阶段已完成：

- `index-v3.ts` 已去掉已知 V2/V3 `unknown as` Store/Resolver 强转。
- 废弃 `place-resolver-adapter-v3.ts` 已删除。
- 新增 `provider-store-capabilities-v3.ts`。
- Resolution capability：`requireTrip / listPlaceResolutions / upsertPlaceResolution`。
- Route capability：`getWorkspace / requireTrip / listPlaceResolutions / getDayRoute / setDayRoute`。
- Resolver / DayRoute 继续使用原 Provider 算法，但不再依赖 `TravelStoreV2` 类型。

当前还剩 Runtime 两个类型逃逸：

- `selectResolution()` 对 resolver 的 `as any`。
- `setDirectResolution()` 对 resolver 的 `as any`。

`index-v3.ts` 实际已经给 resolverCore 增加 `selectCandidate / setDirect` alias，因此下一步应定义窄 resolver capability/interface，把这两个 `as any` 正式去掉，而不是改 Provider 实现。

## P0-3 — finalRoute / Day / Route canonical boundary

### 当前原则

- canonical route：`finalRoute.nodes`。
- Day 为派生/read model + metadata + Provider route input，不再应成为独立路线结构真相。
- `tentative/no_go` 保留在 finalRoute，但退出当前 Day/Route。
- 同 Place 多晚 = 多个独立 route node ID。

### 已 canonical-first 的生产写链

- Stop add/update/move/remove：主要路径直接修改 finalRoute。
- Stop `candidateId`：由 node `placeId` + Candidate set 派生，不再保留 candidate detach 第二状态。
- detailed itinerary initial generation：先改 finalRoute，再派生 Day。
- skeleton initial：直接生成 canonical boundary nodes。
- skeleton replan：workflow 内先 canonicalize，再进入 Store。

### Day 级旧操作已有明确 canonical 适配

- `final-route-day-transfer-v3.ts`：`update_day.transferMode` -> segment 首个 active node transport；旧 Provider-like transport 数据失效并重置 `unverified`。
- `final-route-day-anchor-v3.ts`：Day1 start -> trip origin；后续 start / Day end -> boundary node；nullable anchor 使用旧算法相同 fallback Place。
- `final-route-day-reorder-v3.ts`：纯 Day reorder -> 重排 active route segments；inactive anchoring 与旧 bridge 等价。

### Store 本体已经执行 canonical boundary

提交 `f8fefe8f89b043416864851d0e7f55eb2d2a57f3`：

`TravelStoreV3.writePlanWithinTransaction()` 从直接调用 `syncFinalRouteForLegacyWriteV3()` 改为调用 `canonicalizePlanWriteV3()`。

严格 diff 只有 import 和 `nextPlan` normalization 一行变化；SQLite transaction、generation CAS、revision、cleanup、Proposal reconcile/apply/undo 顺序均未改。

此前过渡 `canonical-travel-store-v3.ts` wrapper 已删除，`index-cutover-v3.ts` 不再安装 prototype wrapper。

### canonical boundary 当前策略

1. finalRoute 本身已改：finalRoute authoritative，正向派生 Day。
2. stale Day / metadata-only：正向派生 route view，并保留允许的显式 metadata。
3. transferMode-only：direct canonical adapter。
4. anchor Place（含 null）：direct canonical adapter。
5. pure Day reorder：direct canonical adapter。
6. 只允许已知旧 Day order/transfer/anchor 混合形态进入兼容 translation。
7. canonical plan 中直接出现 Stop / endTransport / Day-ID / anchor-ID 等未知独立 Day 结构写：抛 `DERIVED_DAY_ROUTE_WRITE_UNSUPPORTED`。
8. 纯 Day-only legacy/bootstrap 暂时继续旧 compatibility conversion。

Day `title/date` 已正式作为可持久 metadata override 保留。

`syncFinalRouteForLegacyWriteV3()` 目前只作为 Day-only legacy/bootstrap、已知混合旧 Day batch、skeleton replan 等明确过渡 adapter 的内部实现；它已不是 Store generic 默认保存逻辑。

## 验证状态

尚未主动运行：test / typecheck / build / app / Provider E2E。

GitHub 当前没有自动 CI/status/workflow run。当前阶段仍只做静态 diff/review，遵守 `AGENTS.md` 普通施工约束。

## 当前不得破坏

- finalRoute 是唯一用户维护线路。
- Provider facts 不得伪造。
- unresolved 允许保留。
- 用户决策优先；旅行合理性 advisory，不是 canonical blocker。
- generation CAS / Proposal Scope / SQLite transaction 不得弱化。
- 不恢复 v2 -> v3 migration/双写。

## 下一步

1. 去掉 resolver `selectCandidate / setDirect` 的最后两个 `as any` 类型逃逸。
2. 审 Runtime 剩余最大职责，优先考虑 `persistInterestDiscovery` 或 AI output persistence coordinator；Action claim/execute 生命周期最后处理。
3. 每次大文件修改继续用 GitHub blob + commit diff + file compare 严格核对。
4. P0 结束后整理正式文档并删除临时 worklog。