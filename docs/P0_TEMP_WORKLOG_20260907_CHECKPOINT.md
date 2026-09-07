# P0 Temporary Worklog — 2026-09-07 Checkpoint

> 当前事实版。更早逐步记录见 `docs/P0_TEMP_WORKLOG.md`。P0 完成后统一整理并删除临时文件。

## P0-1 — Runtime 拆分

`planner-runtime-v3.ts` 已完成第一轮大职责拆分。Runtime 现在主要承担 facade / orchestration，而不是继续内嵌各领域算法。

### 已建立并真正接入 Runtime

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
- requirements mutation builder：`planner-requirements-mutation-v3.ts`

### 关键 Runtime 提交

- `5927becabdb601fab387408eba25c948cb6cd707`：pure/domain delegates。Runtime `+17/-259`。
- `e2429f602c2b45f958ba49661db3e8412547a37f`：Resolution/Route coordinator。Runtime `+36/-101`。
- `d7234d71ebe60bd711ffe507da44b5f5156991f1`：Interest Discovery coordinator。Runtime `+14/-222`。
- `2a207dea718e7bdb980bd882a786c7986bc986b6`：AI Action persistence coordinator；destination/itinerary 各 AI 输出的具体落库/Proposal 准备移出 Runtime，Proposal lifecycle 仍留 Runtime。
- `f06af021f0fa8cfca7ab5e3b2b94f17587ac6747`：Google Maps link coordinator 最终接线状态。
- `e0cdb74dc845015baa5bc5f0d74ad4c06fb1c523`：Action persistence 复用统一 `dayMutationScope`，删除第二份 Scope Policy。
- `6746fd0573afdc93415d7b03b9f16daf883c683f`：requirements mutation builder 接回 Runtime。

> 上一轮聊天最终回复误写了 requirements commit SHA；正确值是上面的 `6746fd0573afdc93415d7b03b9f16daf883c683f`。

### requirements mutation 当前状态

`planner-requirements-mutation-v3.ts` 负责纯 next-plan 构建：

- `requirements.capture`
- `requirements.update`
- `requirements.clear`

Runtime 仍负责原 Store write、generation CAS、revision 写入与 `travel.document.changed` event。

与旧实现逐项核对：

- 同一组允许字段；
- `brief` 继续 merge，不改为整块覆盖；
- clear 中未知字段仍忽略；
- 原错误文案保持；
- 原 revision source / summary 保持；
- Runtime 的 `REQUIREMENT_FIELDS` 与 `(next.trip as any)[key]` 已删除。

### Google Maps 接线事故与修复

第一次整文件替换曾误删 `captureAdditionalRequirements()`；commit diff 当场发现并在 `f06af021f0fa8cfca7ab5e3b2b94f17587ac6747` 恢复。

最终相对 Google 接线前净 compare 只有：

- 新增 `planner-google-maps-link-coordinator-v3.ts` 90 行；
- Runtime `+14/-36`；
- `captureAdditionalRequirements()` 保留。

后续大文件替换继续强制执行 commit diff + base/head compare；写入成功不等于审核完成。

### Runtime 当前应继续保留的主要职责

- workspace/read-model facade 聚合；
- dialogue thread / turn / web-required 生命周期；
- Action claim / confirmation / execution 生命周期与每旅行 AI Action 串行限制；
- Proposal create/apply/reject/undo 生命周期；
- direct `applyCommands()` facade 编排；
- coordinator 装配与 public thin wrappers。

这些属于 Runtime 作为 application facade/orchestrator 的合理职责。除非剩余风险扫描发现明显的独立算法/类型逃逸，否则不要为了缩文件继续机械拆分 Action/Dialog lifecycle。

## P0-2 — V2/V3 capability seam

已完成的已知主链：

- `index-v3.ts` 已去掉已知 V2/V3 `unknown as` Store/Resolver 强转；
- 废弃 `place-resolver-adapter-v3.ts` 已删除；
- `provider-store-capabilities-v3.ts`：Resolution/Route 使用窄 Store capability；
- `provider-resolver-capability-v3.ts`：Planner-facing Resolver capability；
- `planner-resolution-coordinator-v3.ts` 依赖 resolver capability；
- Runtime resolver option 已改为 `PlannerPlaceResolverCapabilityV3`；
- `selectResolution()` / `setDirectResolution()` 两个 `as any` 已删除（`158d5b631c785cab3c6d52808b8758d63b457d90`）。

Provider 搜索/消歧、coordinates、geometry、distance、duration 算法均未改。

下一步做一次 repo 级残余 `unknown as` / `as any` / V2-V3 Store seam 搜描，只处理与 P0 Provider/canonical 主链直接相关的结果，不做无关清洁。

## P0-3 — finalRoute / Day / Route canonical boundary

- canonical route：`finalRoute.nodes`；
- Day 为派生/read model + metadata + Provider route input；
- Stop add/update/move/remove 已 canonical-first；
- detailed initial / skeleton initial / skeleton replan 已在 Store 前 canonical；
- Day transferMode / nullable anchor / pure reorder 已有 direct canonical adapter；
- Day `title/date` 为可持久 metadata override。

关键提交 `f8fefe8f89b043416864851d0e7f55eb2d2a57f3`：`TravelStoreV3.writePlanWithinTransaction()` 直接执行 `canonicalizePlanWriteV3()`；严格 diff 只改 import 和 `nextPlan` normalization 一行，事务/CAS/revision/Proposal 顺序未改。

canonical plan 未知独立 Day Stop/endTransport/Day-ID/anchor-ID 写入会抛 `DERIVED_DAY_ROUTE_WRITE_UNSUPPORTED`；只有已知旧 Day order/transfer/anchor 混合 batch 与纯 Day-only legacy/bootstrap 暂时使用 compatibility conversion。

## 验证状态

尚未主动运行 test / typecheck / build / app / Provider E2E。GitHub 当前没有自动 CI run。当前按 `AGENTS.md` 普通施工约束只做静态 diff/review。

## 不得破坏

- finalRoute 是唯一用户维护线路；
- Provider facts 不得伪造；
- unresolved 允许保留；
- 用户决策优先；旅行合理性 advisory，不是 canonical blocker；
- generation CAS / Proposal Scope / SQLite transaction 不得弱化；
- 不恢复 v2 -> v3 migration/双写。

## 下一步

1. repo 级扫描 P0 相关残余 type escape / V2-V3 seam / Runtime 内嵌独立算法。
2. 若无必须项，把 P0-1/P0-2 标记进入收尾，不再机械拆 facade 生命周期。
3. 再审核 P0-3 legacy compatibility conversion 的剩余调用是否都属于明确兼容形态。
4. P0 收尾后整理正式文档，并删除/合并临时 worklog。
