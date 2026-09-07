# P0 Temporary Worklog — 2026-09-07 Checkpoint

> 当前事实版。更早的逐步记录见 `docs/P0_TEMP_WORKLOG.md`。P0 完成后统一整理并删除临时文件。

## P0-1 — Runtime 拆分

`planner-runtime-v3.ts` 仍约 100KB。

已建立独立模块：

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

尚待接回 Runtime：

- `planner-itinerary-impact-v3.ts`
- `planner-action-context-v3.ts`
- `planner-resolution-coordinator-v3.ts`
- `planner-route-coordinator-v3.ts`
- `planner-deterministic-commands-v3.ts`
- `planner-candidate-output-v3.ts`

现在已确认 GitHub `fetch_blob` 可以完整读取大文件，因此后续可安全对 Runtime 做完整文本替换，并通过 commit diff 严格核对，不再因为 100KB 文件停滞。

## P0-2 — V2/V3 capability seam

第一阶段已完成：

- `index-v3.ts` 已去掉已知 V2/V3 `unknown as` Store/Resolver 强转。
- 废弃 `place-resolver-adapter-v3.ts` 已删除。
- 新增 `provider-store-capabilities-v3.ts`。
- Resolution capability：`requireTrip / listPlaceResolutions / upsertPlaceResolution`。
- Route capability：`getWorkspace / requireTrip / listPlaceResolutions / getDayRoute / setDayRoute`。
- Resolver / DayRoute 继续使用原 Provider 算法，但不再依赖 `TravelStoreV2` 类型。

Provider 搜索、消歧、geometry、distance、duration 的事实来源未改。

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

### Day 级旧操作已拆出明确 canonical 适配

- `final-route-day-transfer-v3.ts`
  - `update_day.transferMode` -> Day segment 第一个 active node transport。
  - 用户改 mode 时旧 Provider-like duration/note/verification 被清空并重置 `unverified`，不伪造 Provider 事实。
- `final-route-day-anchor-v3.ts`
  - Day1 start -> `trip.originPlaceId`。
  - 后续 Day start -> 前一天 boundary node Place。
  - Day end -> 当前 boundary node Place。
  - nullable anchor 使用旧算法相同的 stop/start fallback Place，因此可直接 canonicalize。
- `final-route-day-reorder-v3.ts`
  - 纯 Day reorder -> 重排完整 active route segment。
  - inactive node anchoring 与旧 bridge 保持一致。
  - first->last / last->first 测试以旧 conversion 的 finalRoute + Day 全量结果为基准。

### Store 本体已经执行 canonical boundary

关键提交：

- `f8fefe8f89b043416864851d0e7f55eb2d2a57f3`：`TravelStoreV3.writePlanWithinTransaction()` 从直接调用 `syncFinalRouteForLegacyWriteV3()` 改为调用 `canonicalizePlanWriteV3()`。

严格 diff 已确认该 50KB Store 修改只有：

1. 新增 `canonicalizePlanWriteV3` import；
2. 删除 Store 对 `syncFinalRouteForLegacyWriteV3` 的直接 import；
3. `nextPlan` 一行替换。

SQLite transaction、generation CAS、revision、cleanup、Proposal reconcile/apply/undo 顺序均未改。

此前用于过渡的 `canonical-travel-store-v3.ts` prototype wrapper 已删除，`index-cutover-v3.ts` 也已恢复为不安装 wrapper。

### canonical boundary 当前策略

`canonicalizePlanWriteV3(before, incoming)`：

1. finalRoute 本身已改：finalRoute authoritative，正向派生 Day。
2. stale Day / metadata-only：正向派生 route view，并保留允许的显式 metadata。
3. transferMode-only：direct canonical adapter。
4. anchor Place（含 null）：direct canonical adapter。
5. pure Day reorder：direct canonical adapter。
6. 只允许仍已知的旧 Day order/transfer/anchor 混合形态进入兼容 translation。
7. canonical plan 中直接出现 Stop / endTransport / Day-ID / anchor-ID 等未知独立 Day 结构写：抛 `DERIVED_DAY_ROUTE_WRITE_UNSUPPORTED`，不再万能兜底。
8. 纯 Day-only legacy/bootstrap 数据暂时继续旧 compatibility conversion。

### Day metadata 已明确

`title/date` 正式作为可持久 Day metadata override 保留。

Store 本体现在也经过同一个 canonical boundary，因此不会再被第二次旧 bridge 静默覆盖。集成测试已增加：

- title/date 持久化；
- stale generation 仍由原 Store CAS 拒绝；
- 直接绕过 finalRoute 改 Stop 会被 Store 拒绝。

### 当前仍保留的 legacy

`syncFinalRouteForLegacyWriteV3()` 仍作为：

- Day-only legacy/bootstrap 兼容；
- 已知旧 Day order/transfer/anchor 混合 batch 的临时 translation；
- skeleton replan 等已明确标注的过渡 adapter 内部实现。

它已不再是 `TravelStoreV3` 的 generic 默认保存逻辑。

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

1. 回 P0-1：完整读取 `planner-runtime-v3.ts` blob，依次接回 Action Context、impact、deterministic/candidate helper、Resolution/Route coordinator。
2. 每次 Runtime 接线后只接受“import + 删除原地实现 + 薄 wrapper/委托”的 diff，不改变 Action/Provider/Store 合同。
3. P0-1 接线完成后再审剩余 Runtime 职责，决定是否继续拆 Action executor。
4. P0 结束后统一整理正式文档，并删除临时 worklog。