# TravelPlanner v3 Implementation Status

更新时间：2026-08-27
目标文档：`docs/TRAVEL_WORKBENCH_V3.md`
实施分支：`codex/v3-runtime-ui-completion`

## Target

将旧的“聊天直接生成完整 itinerary、AI 可联网输出坐标、地图统一自动重算”流程替换为 Candidate-first 工作台：地点发现与筛选 → Place Resolver → Day/Anchor 计划 → 确定性编辑 → Route Dirty → AI Scope Proposal / Preview / Apply / Undo → 细化。

## Current Phase

Phase 5 — Candidate-first Web 工作台与地图地点模式。

## Completed

### Phase 0 — 目标冻结与仓库分析

- 建立 `docs/TRAVEL_WORKBENCH_V3.md`，作为唯一 v3 目标设计。
- 建立阶段状态记录和 GitHub CI。

### Phase 1 — Contracts v2

- 建立 `TravelPlanDocument schemaVersion=2`、三阶段、Place/Candidate/Day/Anchor/Stop、PlaceResolution、DayRoute、PlanCommand、Proposal 和四种 Planner mode 合同。
- AI 输出 Schema 不含坐标字段。

### Phase 2 — TravelStore v2

- 建立 canonical plan、generation、Revision、Message、AI Task、PlaceResolution、DayRoute 与 AiProposal 的事务存储。
- canonical 写入使用 expectedGeneration CAS；派生状态不递增 canonical generation。
- 用户明确不需要旧行程或旧数据库迁移；不提供迁移、兼容读取或双写。

### Phase 3 — Candidate、PlanCommand 与 Place Resolver

- 建立固定 PlanCommand 执行器、Scope 校验、正式 ID 分配、Candidate discovery 正式化和 Plan generation 正式化。
- 建立 Provider-safe `PlaceResolverV2`，支持自动匹配、有限候选选择、地图点选和手工坐标。
- 坐标始终来自地图 Provider 或用户明确输入，AI 不输出坐标。

### Phase 4 — v2 Server Runtime、API、Prompt 与 Route

- `apps/server/index.ts` 已切换到 `TravelStoreV2`、v2 Prompt、v2 AI Runner、v2 Resolver 和 v2 Route Service；不再运行 v1 Store、v1 Planner、旧 MapPipeline 或 CoordinateResearch。
- 新 Runtime 使用独立结构化 Schema 运行 `conversation | discover_candidates | generate_plan | propose_adjustment`。
- 新增受控 `StructuredAiRunnerV2`，拒绝工具审批请求、收集结构化输出、支持进度、超时和中断。
- 新增 `DayRouteServiceV2`：根据 Day、Anchor、Stop、交通方式和当前 Resolution 构造 fingerprint；`routeDirty` 通过 fingerprint 比较派生。
- 初次生成计划后允许自动计算第一版路线；后续编辑只形成 dirty，由显式路线 API 重算。
- 新增完整 v2 API：workspace、Candidate discovery、单个/批量 preference、Plan generation、PlanCommand、Resolution retry/search/select/manual、Day route、Proposal create/apply/reject/undo、Revision、Task stop。
- WebSocket 广播 document、resolution、route、proposal、task 和 turn 变化。
- 新 v3 数据使用独立 `private_data/travel-v2.sqlite3`，不会读取或覆盖旧 `travel.sqlite3`；这不是迁移或兼容层。
- Prompt 集合严格收敛为 00/01/02；03 坐标搜索 Agent 和旧 v1 Prompt loader 已删除。
- 保留认证、签名 Session、登录限流、Codex 账户/模型设置、地图瓦片缓存和静态资源服务。

## Important Decisions

- Canonical 使用 `TravelPlanDocument schemaVersion=2`。
- 产品阶段只有 `place_selection | itinerary_planning | itinerary_refinement`。
- 语义 Place 与 PlaceResolution 分离；AI 永不输出可信坐标。
- Route Dirty 由 fingerprint 比较派生，不持久化布尔值。
- 用户编辑使用固定 PlanCommand；AI 修改必须先形成 Proposal。
- 正式实体 ID 由服务端分配，模型只使用当前调用临时 ID。
- 不支持旧行程和旧数据库迁移、兼容读取或双写；v3 使用独立全新数据库文件。
- 用户已明确允许连续执行；每个 Phase 必须形成独立 commit，并继续下一阶段。

## Files Changed

Phase 4 关键文件：

- `apps/server/index.ts`
- `apps/server/structured-ai-v2.ts`
- `apps/server/planner-runtime-v2.ts`
- `apps/server/travel-api-v2.ts`
- `apps/server/day-route-v2.ts`
- `apps/server/prompt-contract-v2.ts`
- `apps/server/ai-task-monitor.ts`
- `apps/server/config.ts`
- `prompts/00-旅行规划Agent.md`
- `prompts/01-行程细化Agent.md`
- `prompts/02-地图候选消歧Agent.md`
- 删除 `prompts/03-地图坐标搜索Agent.md`
- 删除旧 `apps/server/prompt-contract.ts` 与测试
- 新增对应单元测试

## Tests / Checks

Phase 4 本地验证：

- `npm run typecheck`：通过。
- 全量 Vitest：27 个测试文件、167 个测试全部通过。
- `npm run build:web`：通过。
- `npm run build:server`：通过。
- `git diff --check`：通过。
- 新 v3 Server 使用空临时 `private_data/` 启动成功并监听 `127.0.0.1:6688`。
- 未调用真实 Codex 账户或真实地图 Provider；未读取用户真实 `private_data/`。

## Known Issues / Risks

- 前端仍是旧单一行程面板；虽然可构建，但没有调用 v2 workspace/Candidate/Resolution API，因此用户视觉上仍不会看到完整 v3 工作台。
- 浏览器端尚未实现 Candidate 筛选、批量 preference、未定位处理和 Candidate Marker 模式。
- 拖拽、跨 Day 编辑、Proposal Preview 和 01 v2 细化 UI 留待后续阶段。
- v1 后端模块仍存在但已无运行入口；最终 Legacy Cleanup 会删除。

## Next Phase

Phase 5：

- 重写 Web 类型和 API client，完全读取 `/api/trips/:id/workspace`。
- 右侧建立 `[地点] [行程]` 双 Tab；当前阶段重点完成地点 Tab。
- 实现 Candidate 卡片、全部/必去/想去/可选/不去/未定位筛选、单个和批量 preference、已选择数量与“根据选中地点生成行程”。
- 实现 Provider Resolution 状态、重试、候选选择、地图点选和手工坐标入口。
- 地图增加 Candidate Marker 模式，支持卡片 → Marker 和 Marker → 卡片双向高亮。
- 保留旧行程展示所需的最小过渡仅限当前 Phase；不得保留旧 API 旁路。

## Recommended Model

Worker 实施组件、类型和 API；高推理 Reviewer 检查状态归属、地图联动和旧 API 旁路。

## Do Not Do

- 不触碰真实 `private_data/`。
- 不恢复旧数据迁移、旧 Store、旧 MapPipeline 或 03 坐标 Agent。
- 不保存 routeDirty 布尔值。
- 不让 AI 输出或直接修改坐标。
- 不新增开放式 Patch、额外业务 stage 或新的坐标 Agent。
