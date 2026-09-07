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
- AI Action persistence coordinator：`planner-action-persistence-coordinator-v3.ts`
- Google Maps link coordinator：`planner-google-maps-link-coordinator-v3.ts`

### 关键 Runtime 提交

- `5927becabdb601fab387408eba25c948cb6cd707`：pure/domain delegates。Runtime `+17/-259`。
- `e2429f602c2b45f958ba49661db3e8412547a37f`：Resolution/Route coordinator。Runtime `+36/-101`。
- `d7234d71ebe60bd711ffe507da44b5f5156991f1`：Interest Discovery coordinator。Runtime `+14/-222`。
- `2a207dea718e7bdb980bd882a786c7986bc986b6`：AI Action persistence coordinator 接线；destination/itinerary 各 Action 的具体 AI 输出落库/Proposal 准备移出 Runtime，Proposal create/apply lifecycle 仍留 Runtime。
- `f06af021f0fa8cfca7ab5e3b2b94f17587ac6747`：Google Maps link coordinator 最终接线状态。

Google Maps 接线过程中，第一次整文件替换误删了 `captureAdditionalRequirements()`；静态 commit diff 当场发现，已在 `f06af021f0fa8cfca7ab5e3b2b94f17587ac6747` 恢复。最终相对 Google 接线前的净 compare 只有：

- 新增 `planner-google-maps-link-coordinator-v3.ts` 90 行；
- Runtime `+14/-36`；
- `captureAdditionalRequirements()` 保留。

因此后续所有大文件替换继续强制执行“commit diff + base/head file compare”，不以写入成功代替审核。

### Runtime 当前仍负责

- workspace/read-model 聚合。
- dialogue thread / turn / web-required 生命周期。
- Action claim / confirmation / execution 生命周期与每旅行 AI Action 串行限制。
- requirements.capture/update/clear 特殊 deterministic 持久化。
- Proposal create/apply/reject/undo 编排。
- direct `applyCommands()` 编排。
- coordinator 的装配与薄 public wrapper。

Runtime 已不再直接负责：

- Action Context / Scope / deterministic command derivation；
- Provider resolution/route batch；
- Interest Discovery 多区域并发；
- 各 AI Action 输出的具体持久化规则；
- Google Maps link 的解析后落库/PlaceResolution 构建。

下一步先清 AI persistence coordinator 中重复的 `dayMutationScope`，再抽 requirements deterministic mutation。Action claim/execute lifecycle 继续最后处理。

## P0-2 — V2/V3 capability seam

Store/Provider seam 第一阶段已完成：

- `index-v3.ts` 已去掉已知 V2/V3 `unknown as` Store/Resolver 强转。
- 废弃 `place-resolver-adapter-v3.ts` 已删除。
- `provider-store-capabilities-v3.ts`：Resolution/Route 使用窄 Store capability。
- `provider-resolver-capability-v3.ts`：定义 Planner-facing Resolver capability。
- `planner-resolution-coordinator-v3.ts` 已改依赖 resolver capability。
- Runtime resolver option 已改为 `PlannerPlaceResolverCapabilityV3`。
- `selectResolution()` / `setDirectResolution()` 两个 `as any` 已删除；提交 `158d5b631c785cab3c6d52808b8758d63b457d90` 只做类型 seam 与两处直接调用。

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

1. persistence coordinator 复用统一 `dayMutationScope`，删除第二份 Scope Policy。
2. 抽 requirements deterministic mutation，去掉 Runtime 的 `REQUIREMENT_FIELDS` 与 `(next.trip as any)` 动态写法。
3. 再审 workspace/dialogue 是否值得继续拆；Action claim/execute lifecycle 最后处理。
4. 每次大文件替换继续 blob + commit diff + file compare。
5. P0 结束后整理正式文档并删除临时 worklog。