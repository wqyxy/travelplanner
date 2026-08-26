# TravelPlanner v3 Implementation Status

更新时间：2026-08-27
目标文档：`docs/TRAVEL_WORKBENCH_V3.md`
实施分支：`codex/v3-candidate-workbench`
Draft PR：#1

## Target

将当前“聊天直接生成完整 itinerary、AI 可联网输出坐标、地图统一自动重算”的 v2 流程替换为 Candidate-first 工作台：地点发现与筛选 → Place Resolver → Day/Anchor 计划 → 确定性编辑 → Route Dirty → AI Scope Proposal / Preview / Apply / Undo → 细化。

## Current Phase

Phase 3 — Candidate discovery、PlanCommand 执行器与 Place Resolution 后端。

## Completed

### Phase 0 — 目标冻结与仓库分析

- 建立分支 `codex/v3-candidate-workbench` 与 Draft PR #1。
- 新增 `docs/TRAVEL_WORKBENCH_V3.md` 作为唯一 v3 目标设计。
- 建立分支 CI 和 verified change bundle 工作流。

### Phase 1 — Contracts v2

- 新增 `TravelPlanDocument schemaVersion=2`。
- 阶段收敛为 `place_selection | itinerary_planning | itinerary_refinement`。
- 新增 Place、TripCandidate、DayAnchor、DayStop、PlaceResolution、DayRoute、PlanCommand、Proposal 与四种 Planner mode 合同。
- AI 输出 Schema 不含坐标字段。
- 合同定向测试和 server typecheck 通过。

### Phase 2 — TravelStore v2

- 用户明确决定不保留已有行程或数据库；删除 `migration-v2.ts` 与对应测试，目标文档同步移除迁移、兼容读取和双写要求。
- 新增 `TravelStoreV2`，只接受空数据库或结构完全匹配的 v2 数据库；旧/未知非空库明确拒绝。
- 新库保存 canonical plan、generation、Revision、Message、AI Task、PlaceResolution、DayRoute 与 AiProposal。
- 每次 canonical 写入使用事务与 expectedGeneration CAS，并在同一事务维护标题索引、Revision、派生状态 GC 和 pending Proposal supersede。
- 每个新 Trip 从 Revision v1 开始；每次 canonical 写入均产生 Revision。
- PlaceResolution 与 DayRoute 使用 expectedGeneration 防止异步旧结果写入，但不递增 canonical generation。
- DayRoute version 必须单调递增；数据库不保存 `routeDirty`。
- Proposal Apply 与 Undo 的事务原语已建立；Undo 仅在 Apply 后没有新 canonical 写入时恢复 Apply 前 Revision。
- 新增 Store 单元测试覆盖新库创建、旧库拒绝、CAS、Revision、派生数据、Route version、Proposal Apply/Undo、supersede 与派生 GC。

## Important Decisions

- Canonical 使用 `TravelPlanDocument schemaVersion=2`。
- 产品阶段只有 `place_selection | itinerary_planning | itinerary_refinement`。
- 语义 Place 与 PlaceResolution 分离；AI 永不输出可信坐标。
- Route Dirty 由 fingerprint 比较派生，不持久化布尔值。
- 用户编辑使用固定 PlanCommand；AI 修改使用 Proposal。
- 正式实体 ID 由服务端分配，模型只使用当前调用临时 ID。
- 不支持旧行程和旧数据库：不提供转换器、迁移函数、兼容读取、自动迁移或双写。
- 用户已明确允许连续执行；每个 Phase 必须形成独立 commit，并由 GitHub CI 验证。

## Files Changed

- `docs/TRAVEL_WORKBENCH_V3.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `apps/server/travel-store-v2.ts`
- `apps/server/travel-store-v2.test.ts`
- 删除 `apps/server/migration-v2.ts`
- 删除 `apps/server/migration-v2.test.ts`

## Tests / Checks

Phase 2 commit 由 verified bundle workflow 在 Node.js 24 下执行以下门禁后才会产生：

- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --cached --check`

未运行真实服务、真实 Codex、真实地图 Provider 或浏览器 E2E；未读取或接触 `private_data/`。

## Known Issues / Risks

- 当前应用入口仍运行 v1 Store、v1 contracts 和旧 API；新 Store 尚未接入运行时，这是受控 Phase 边界，后续必须完全切换而不能长期保留双系统。
- Proposal Store 只提供原子持久化原语；Scope 校验和 PlanCommand 执行属于 Phase 3/7。
- 旧 MapPipeline 仍含 AI 坐标研究链路，必须在 Place Resolution 后端阶段删除。
- 前端仍是旧单一行程面板与“聊天唯一入口”。

## Next Phase

Phase 3：

- 新增确定性 `applyPlanCommands()`，覆盖 Candidate preference、Candidate/Place 更新、Anchor、Stop、跨 Day 移动、删除与 Day 排序。
- 服务端拥有新增实体正式 ID；命令在副本上原子应用、标准化、校验、Place/Candidate GC。
- `excluded` Candidate 在同一事务删除其 DayStop；must_go、引用和 Scope 约束继续由 Schema/业务校验保证。
- 新增 Candidate discovery 结果正式化、去重与写入服务。
- 新增 Place Resolver：Provider 搜索、确定性筛选/评分、02 有限候选/搜索提示辅助、单个/批量重试、Provider 候选选择、地图点选和手工坐标。
- 删除 03 坐标 Agent 及 CoordinateResearchOutput 合同/入口；AI 不再联网输出坐标。
- 不进入前端 UI，不实现 Proposal Apply 的 AI 工作流，不自动重算路线。

## Recommended Model

高推理 Reviewer 复核 PlanCommand 原子性、ID/引用与 PlaceResolution 边界；实现使用 Worker。

## Do Not Do

- 不触碰真实 `private_data/`。
- 不恢复任何旧数据迁移或兼容层。
- 不保存 routeDirty 布尔值。
- 不让 AI 输出或直接修改坐标。
- 不增加开放式 Patch、额外业务 stage 或新的坐标 Agent。
- 不在 Phase 3 顺手重写完整 UI。
