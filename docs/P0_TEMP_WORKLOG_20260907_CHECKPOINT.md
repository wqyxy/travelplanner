# P0 Temporary Worklog — 2026-09-07 Checkpoint

> 当前事实版。更早逐步记录见 `docs/P0_TEMP_WORKLOG.md`。P0 完成后统一整理并删除临时文件。

## P0-1 — Runtime 拆分

`planner-runtime-v3.ts` 已完成第一轮大职责拆分，以下模块均已真正接线：

- Action Scope：`planner-action-scope-v3.ts`
- Proposal diff：`planner-proposal-v3.ts`
- Resolution current-state：`planner-resolution-state-v3.ts`
- Itinerary structural validation：`planner-itinerary-validation-v3.ts`
- Itinerary command derivation：`planner-itinerary-commands-v3.ts`
- Itinerary impact：`planner-itinerary-impact-v3.ts`
- Action Context：`planner-action-context-v3.ts`
- deterministic Action -> PlanCommand：`planner-deterministic-commands-v3.ts`
- candidate/destination output helpers：`planner-candidate-output-v3.ts`
- Resolution coordinator：`planner-resolution-coordinator-v3.ts`
- Route coordinator：`planner-route-coordinator-v3.ts`
- Interest Discovery coordinator：`planner-interest-discovery-coordinator-v3.ts`

### 关键 Runtime 提交

`5927becabdb601fab387408eba25c948cb6cd707`：pure/domain delegates 接线。仅 Runtime，`+17/-259`。

`e2429f602c2b45f958ba49661db3e8412547a37f`：Resolution/Route coordinator 接线。仅 Runtime，`+36/-101`。

`d7234d71ebe60bd711ffe507da44b5f5156991f1`：Interest Discovery coordinator 接线。新增 coordinator 321 行；Runtime `+14/-222`。

Interest Discovery 原多区域 worker、commit gate、stop、全局失败分类、定位汇总现全部由 coordinator 负责；Runtime 仅提供 progress、active-run 注册、resolution、document event 回调。Action claim/fail/complete 生命周期仍在 Runtime。

### Runtime 当前仍负责

- workspace/read-model 聚合。
- dialogue thread / turn / web-required 生命周期。
- Action claim / confirmation / execution 生命周期与每旅行 AI Action 串行限制。
- requirements.capture/update/clear 特殊 deterministic 持久化。
- AI Action output dispatcher 与 destination/itinerary 各 Action 持久化编排。
- Proposal create/apply/reject/undo 编排。
- Google Maps link preview/apply。

下一块优先拆 **AI Action output persistence coordinator**；Action claim/execute 生命周期继续最后处理。

## P0-2 — V2/V3 capability seam

Store/Provider seam 第一阶段已完成：

- `index-v3.ts` 已去掉已知 V2/V3 `unknown as` Store/Resolver 强转。
- 废弃 `place-resolver-adapter-v3.ts` 已删除。
- `provider-store-capabilities-v3.ts`：Resolution/Route 使用窄 Store capability。
- `provider-resolver-capability-v3.ts`：定义 Planner-facing Resolver capability。
- `planner-resolution-coordinator-v3.ts` 已改依赖 resolver capability。
- Runtime resolver option 已改为 `PlannerPlaceResolverCapabilityV3`。
- `selectResolution()` / `setDirectResolution()` 两个 `as any` 已删除；提交 `158d5b631c785cab3c6d52808b8758d63b457d90` 的 Runtime diff 只有 type import、option type、两处直接调用。

Provider 搜索/消歧、coordinates、geometry、distance、duration 算法均未改。

## P0-3 — finalRoute / Day / Route canonical boundary

- canonical route：`finalRoute.nodes`。
- Day 为派生/read model + metadata + Provider route input。
- Stop add/update/move/remove 已 canonical-first。
- detailed initial / skeleton initial / skeleton replan 已在 Store 前 canonical。
- Day transferMode / nullable anchor / pure reorder 已有 direct canonical adapter。
- Day `title/date` 为可持久 metadata override。

关键提交 `f8fefe8f89b043416864851d0e7f55eb2d2a57f3`：`TravelStoreV3.writePlanWithinTransaction()` 直接执行 `canonicalizePlanWriteV3()`；严格 diff 只改 import 和 `nextPlan` 一行，事务/CAS/revision/Proposal 顺序未改。

canonical plan 未知独立 Day Stop/endTransport/Day-ID/anchor-ID 写入会抛 `DERIVED_DAY_ROUTE_WRITE_UNSUPPORTED`；只有已知旧 Day order/transfer/anchor 混合 batch 与纯 Day-only legacy/bootstrap 暂时使用 compatibility conversion。

## 验证状态

尚未主动运行 test / typecheck / build / app / Provider E2E。GitHub 没有自动 CI run。当前按 `AGENTS.md` 只做静态 diff/review。

## 不得破坏

- finalRoute 是唯一用户维护线路。
- Provider facts 不得伪造。
- unresolved 允许保留。
- 用户决策优先；旅行合理性 advisory，不是 canonical blocker。
- generation CAS / Proposal Scope / SQLite transaction 不得弱化。
- 不恢复 v2 -> v3 migration/双写。

## 下一步

1. 抽 AI Action output persistence coordinator，保留 Proposal lifecycle 在 Runtime。
2. 再审 requirements deterministic 特例、Google Maps link、workspace/dialogue 是否值得继续拆。
3. Action claim/execute 生命周期最后处理。
4. 每次大文件替换继续使用 blob + commit diff + file compare 严格核对。
5. P0 结束后整理正式文档并删除临时 worklog。