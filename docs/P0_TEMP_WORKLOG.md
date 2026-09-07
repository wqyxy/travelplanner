# P0 Temporary Worklog

> 临时施工记忆文件。P0 完成后应整理有效结论到正式文档，再删除本文件。
>
> 开始时间：2026-09-07
> 当前分支：main
> 当前状态：P0-1 runtime architecture analysis complete; first extraction prepared

## 目标

P0 分三条主线，按风险从低到高推进：

1. `planner-runtime-v3.ts`：先做行为保持的职责拆分，降低 God Object 风险。
2. V2/V3 边界：识别真正 legacy、canonical-but-misnamed 和可复用 capability，消除不安全 cast，不做盲目改名/删除。
3. finalRoute / Day / Route：收敛 canonical 与派生边界，保持 finalRoute 为唯一用户维护线路，Day/Route 为派生/Provider 事实。

当前优先处理 P0-1；除非拆分需要，不提前改 canonical 数据结构。

## 当前产品事实（不得破坏）

- 产品只有 `规划 · 旅行需求` / `行程 · 最终线路` 两个主工作区。
- 用户只维护 `finalRoute`；Day 自动派生。
- 同一 Place 可在线路中多次出现，每次拥有独立 route node ID。
- `tentative / no_go` 保留，但退出当前 Day / Route。
- `住 / 不住` 控制日程分界；`多一晚` 新增同 Place 独立 route node。
- 右侧最终线路是唯一业务操作入口；地图负责展示/选择/聚焦/响应定位选点。
- Provider 坐标、Place ID、geometry、distance、duration、verified 状态不能由 AI/前端伪造。
- 用户是旅行方案唯一决策者；“不合理”原则上是 advisory，不是 canonical blocker。

## 工程边界

- fresh v3 数据库策略保持；不重新加入 v2 -> v3 migration/双写。
- SQLite 事务、generation CAS、Proposal Scope、Provider 事实边界不可弱化。
- 不为了架构整洁改变 Action 权限或 AI scope。
- 普通施工不运行完整 test/typecheck/build；先静态 review。完整验证需用户确认。

## 已确认的 P0-1 问题

`apps/server/planner-runtime-v3.ts` 当前是一个明显的 God Object，同时承担：

1. workspace read-model 聚合；
2. Dialogue thread / turn / web-required 生命周期；
3. CTA / conversation Action 创建、确认、取消、执行；
4. Action state/context 构造；
5. deterministic Action -> PlanCommand；
6. AI Action output -> Proposal/canonical 持久化；
7. interest discovery 并发批处理；
8. Place resolution 协调；
9. Day route / macro route / route batch 协调；
10. Google Maps link preview/commit；
11. task/event/active-run 协调；
12. domain validation / diff / command derivation。

因此不能继续在同一个 Runtime 里追加新产品逻辑。

## Runtime 当前依赖簇

### A. Dialogue / AI orchestration

- `StagedTravelAiV3`
- `LoadedPromptRegistryV3`
- `AiTaskMonitorV3`
- stage context / action registry / action input contracts

### B. Canonical mutation / proposal

- `applyPlanCommands`
- `assertProposalCommandsWithinScope`
- `TravelPlanDocumentSchema`
- `TravelStoreV3`

### C. Planning domain

- backbone / skeleton / interest / detail planning contexts
- planning role / coverage / itinerary impact
- detailed itinerary command derivation

### D. Provider facts

- `PlaceResolverV2`
- `DayRouteServiceV2`
- `GoogleMapsLinkService`

### E. Runtime coordination

- active AI runs
- route batches
- generation supersede handling
- event emission

这些依赖簇之间目前通过 `TravelPlannerRuntimeV3` 直接互相耦合。

## 第一阶段拆分顺序（已决定）

原则：先拆纯函数，再拆有状态 service；保留 `TravelPlannerRuntimeV3` 作为 facade，使 HTTP/API 调用方暂时不变。

### Slice 1 — Action Scope Policy

目标文件：`apps/server/planner-action-scope-v3.ts`

迁移：

- `dayMutationScope`
- `actionScope`

原因：

- 无 DB / async 副作用；
- 是 AI 修改权限的关键边界；
- 可以独立测试；
- 第一刀只应是 move + import，不改变错误文案与 scope 行为。

### Slice 2 — Proposal Domain

候选文件：`apps/server/planner-proposal-v3.ts`

优先迁移纯逻辑：

- `proposalDiff`
- `replacementCommands`
- `refinementCommands`
- 与 Proposal 生成相关但不依赖 Runtime mutable state 的校验/command derivation

暂不把 `createProposalForAction` 整体搬走，因为它直接依赖 Store、event 和 action lifecycle；先让纯领域逻辑脱离 Runtime。

### Slice 3 — Action Context Builder

候选文件：`apps/server/planner-action-context-v3.ts`

迁移 `buildActionState` 的纯 read-model/context 构造部分。

注意：它当前读取 Route Service，因此最好依赖窄接口/输入 DTO，而不是直接依赖整个 Runtime。

### Slice 4 — Provider Coordinator

候选文件：

- `planner-resolution-coordinator-v3.ts`
- `planner-route-coordinator-v3.ts`

迁移：

- resolution progress / resolve changed places
- route batch / dirty route / macro route coordination

Provider 的事实生产者保持不变，只拆 orchestration。

### Slice 5 — Action Executor

最后才处理：

- `confirmClaimedAction`
- `executeAction`
- `executeDeterministic`
- AI output persistence dispatch

这是高风险部分，必须建立在前四个 slice 已稳定之后。

## P0-1 不做的事

- 不顺手改变 finalRoute/Day 数据模型。
- 不删除 V2 命名文件。
- 不改变 Prompt/Action 合同。
- 不把 advisory 重新变成 blocker。
- 不改 Provider 事实来源。
- 不改 Store transaction/CAS 顺序。
- 不做“Clean Architecture”式大爆炸重写。

## P0-2 已记录的明确问题

`apps/server/index-v3.ts` 当前存在 V2/V3 边界强转：

- `store as unknown as TravelStoreV2` -> `PlaceResolverV2`
- `store as unknown as TravelStoreV2` -> `DayRouteServiceV2`
- `resolver as unknown as PlaceResolverV2` -> `TravelPlannerRuntimeV3`

当前还有 `PlaceResolverAdapterV3`，说明 V3 已经开始做 capability 适配，但接口边界没有收完。

处理原则：

1. 先列出 Resolver / Route 真正需要的 Store methods；
2. 定义窄 capability interface；
3. 让 V2/V3 store 都可以结构化满足接口；
4. 去掉 `unknown as`；
5. 最后再决定是否改文件名，绝不先改名。

## 当前读取基线

已读/复核：

- `AGENTS.md`
- `README.md`
- `docs/PLAN_PROGRESS.md`
- `apps/server/planner-runtime-v3.ts` 全部主要职责区段
- `apps/server/index-v3.ts` runtime/resolver/route wiring

注意：`AGENTS.md` 仍引用不存在的 `docs/IMPLEMENTATION_STATUS.md`，且有旧五步/city-only 规则与后面的 User Control Correction 冲突。属于后续 P2 文档清理，不在当前 P0 顺手修改。

## 当前施工决定

第一处实际代码重构从 Action Scope Policy 开始。

完成标准：

- Runtime 不再本地定义 `dayMutationScope/actionScope`；
- 新模块只依赖 action/contracts，不依赖 Store/AI/Provider；
- 调用行为、错误信息、scope 结果完全不变；
- 至少做静态 import/call-site review；
- 不运行完整测试。

## 下一步

1. 落地 `planner-action-scope-v3.ts` 并接回 Runtime。
2. 静态检查 conversation Action 与 CTA Action 两条调用链。
3. 把完成 commit、改动文件和发现的问题继续写回本文件。
4. 然后进入 Proposal Domain 纯函数拆分。
