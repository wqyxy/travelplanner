# TravelPlanner v3 Implementation Status

更新时间：2026-08-27
目标文档：`docs/TRAVEL_WORKBENCH_V3.md`
实施分支：`codex/v3-candidate-workbench`
Draft PR：#1

## Target

将当前“聊天直接生成完整 itinerary、AI 可联网输出坐标、地图统一自动重算”的 v2 流程替换为 Candidate-first 工作台：地点发现与筛选 → Place Resolver → Day/Anchor 计划 → 确定性编辑 → Route Dirty → AI Scope Proposal / Preview / Apply / Undo → 细化。

## Current Phase

Phase 4 — v2 Server Runtime、API 与 Prompt 切换。

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


### Phase 3 — Candidate、PlanCommand 与 Place Resolver 后端

- 新增 `applyPlanCommands()` 固定命令执行器，覆盖 Candidate preference/批量 preference、Candidate/Place 更新、Anchor、Stop 增删改、同日与跨 Day 移动、Day 排序与 Day 更新；不使用开放式 JSON Patch。
- 服务端在执行前收集本轮临时 ID，并为新增 Place、Candidate、Stop 分配正式 UUID；正式 ID、dayNumber 和 generation 不由 AI 或客户端决定。
- 命令在 canonical 副本上完整应用、标准化、Place GC 和 Zod/业务校验后一次写入；`excluded` Candidate 在同一原子操作删除关联 DayStop。
- 新增 Candidate/Place/Day/Trip Scope 校验；Day Scope 不允许跨 Day 移动，Candidate Pool Scope 不允许修改 Day/Anchor/Stop。
- 新增结构化 Effects：changed Candidate/Place/Day、removed Candidate/Place 与 `routeDirtyDayIds`；route dirty 仍由路线输入变化推导，不持久化布尔值。
- 新增 Candidate Discovery 正式化服务：语义地点去重、服务端正式 ID、重复推荐合并、保留用户 preference/source、AI metadata 更新和 generation CAS 写入。
- 新增 Plan Generation 正式化服务：只从无 Day 的 `place_selection` 开始，正式化 Day/Anchor/Stop/辅助 Place ID，确保非 excluded Candidate 必须排程或提供未排程理由，`must_go` 不允许未排程。
- 新增 `PlaceResolverV2`：确定性 query、国家/类型过滤、评分、阈值和分差自动选择；02 只能选择已注入的有限 Provider Candidate 或返回搜索提示，坐标始终取自地图 Provider。
- 新增 Provider 候选重新校验、单个/批量解析、地图点选和手工坐标；直接坐标可做 reverse country 校验，但 Provider 不可用时仍保留用户明确输入。
- 新增地理指纹和 `resolutionIsCurrent()`，Place 语义身份变化后旧 Resolution 会被视为 stale。
- `TripCandidate.source` 删除 `migration`，只允许 `ai | user`。
- Phase 3 新链路不依赖 03 坐标 Agent；旧 v1 runtime 的 03 入口留到 Phase 4 runtime cutover 时与旧 Store/API 一次删除，避免在切换前制造不可运行的半状态。

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

Phase 2：

- `docs/TRAVEL_WORKBENCH_V3.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `apps/server/travel-store-v2.ts`
- `apps/server/travel-store-v2.test.ts`
- 删除 `apps/server/migration-v2.ts`
- 删除 `apps/server/migration-v2.test.ts`

Phase 3：

- `apps/server/contracts-v2.ts`
- `apps/server/plan-commands-v2.ts`
- `apps/server/plan-commands-v2.test.ts`
- `apps/server/candidate-workflow-v2.ts`
- `apps/server/candidate-workflow-v2.test.ts`
- `apps/server/place-resolver-v2.ts`
- `apps/server/place-resolver-v2.test.ts`
- `docs/IMPLEMENTATION_STATUS.md`

## Tests / Checks

Phase 2 的 GitHub Actions 已验证：

- Web/Server typecheck 通过。
- 21 个测试文件、136 个测试通过。
- 生产 build 通过。
- 首次正式 commit 仅被两份 Markdown 行尾空格拦截；业务代码无失败。

Phase 3 本地完整验证：

- `npm run typecheck` 通过。
- 24 个测试文件、161 个测试全部通过。
- `npm run build` 通过。
- 新增模块定向范围：5 个测试文件、39 个测试全部通过。

Phase 2 已由 GitHub Node.js 24 verified bundle 门禁形成正式提交 `38f2028`。Phase 3 在同一代码内容上完成本地全量验证，并由本阶段 verified bundle 重复执行类型检查、全量测试、生产 build 与 diff 检查后才形成正式提交。未运行真实服务、真实 Codex、真实地图 Provider 或浏览器 E2E；未读取或接触 `private_data/`。

## Known Issues / Risks

- 当前 `apps/server/index.ts` 仍运行 v1 Store、v1 contracts、旧 `/turns` 和旧 MapPipeline；v2 后端模块尚未成为运行时入口。
- 旧 03 坐标 Agent 和 CoordinateResearch 合同仍被 v1 runtime 引用；必须在 Phase 4 切换时一次删除，不能与 v2 Resolver 并存到最终版本。
- PlaceResolver 的 Provider 候选目前按请求即时计算，尚未接入 API 的候选选择 UI。
- Proposal Store 与 Scope/Command 原语已完成，但 AI Proposal 创建、Preview/Apply/Undo API 尚未串联。
- 前端仍是旧单一行程面板与“聊天唯一入口”。

## Next Phase

Phase 4：

- 新建 v2 Prompt loader 与 00/01/02 Prompt 合同，00 按 `conversation | discover_candidates | generate_plan | propose_adjustment` 使用独立输出 Schema。
- 将服务端入口切换到 `TravelStoreV2`，只接受新数据库；删除 v1 Store/runtime 引用、CoordinateResearch/03 坐标 Agent 和旧 MapPipeline 的 AI 坐标研究入口。
- 增加 workspace、Candidate discovery、Candidate preference/批量操作、Plan generation、PlanCommand、Place resolution retry/select/direct 与 Day route API。
- WebSocket 广播 document、resolution、route、proposal、task 和 turn 变化；所有异步结果校验 generation。
- 先保留旧前端可构建，但 API 响应提供完整 v2 workspace；前端 Candidate 双 Tab 在下一 Phase 实现。
- 不在本阶段实现拖拽 UI、Proposal Preview UI 或完整细化 UI。

## Recommended Model

高推理 Reviewer 负责 runtime 切换半径、旧入口删除、异步 generation 与安全边界；Worker 实施 API 和 Prompt 适配。

## Do Not Do

- 不触碰真实 `private_data/`。
- 不恢复任何旧数据迁移或兼容层。
- 不保存 routeDirty 布尔值。
- 不让 AI 输出或直接修改坐标。
- 不增加开放式 Patch、额外业务 stage 或新的坐标 Agent。
- 不保留 v1/v2 双写或长期并行 runtime。
