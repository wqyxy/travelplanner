# TravelPlanner v3 Implementation Status

更新时间：2026-08-27
目标文档：`docs/TRAVEL_WORKBENCH_V3.md`
实施分支：`codex/v3-runtime-ui-completion`

## Target

将旧的“聊天直接生成完整 itinerary、AI 可联网输出坐标、地图统一自动重算”流程替换为 Candidate-first 工作台：地点发现与筛选 → Place Resolver → Day/Anchor 计划 → 确定性编辑 → Route Dirty → AI Scope Proposal / Preview / Apply / Undo → 细化。

## Current Phase

Phase 6 — 确定性行程编辑、拖拽与 Route Dirty UI。

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

- 服务入口切换到 `TravelStoreV2`、v2 Prompt、v2 AI Runner、v2 Resolver 和 v2 Route Service。
- 建立 Workspace、Candidate、Plan、Command、Resolution、Route、Proposal、Revision 和 AI Task API。
- WebSocket 广播 document、resolution、route、proposal、task 和 turn 变化。
- Prompt 收敛为 00/01/02；03 坐标搜索 Agent 和旧 Prompt loader 已从运行链删除。
- 新 v3 数据使用独立 `private_data/travel-v2.sqlite3`，不会读取或覆盖旧数据库。

### Phase 5 — Candidate-first Web 工作台与地图地点模式

- `App.tsx` 已完全切换到 `/api/trips/:id/workspace`；活动 UI 不再读取旧 `/map`、旧 itinerary 或旧 MapPipeline 响应。
- 桌面主工作区改为左侧持久地图、右侧 `[地点] [行程]` 双 Tab，首次打开已有 Day 的旅行进入行程 Tab，否则进入地点 Tab。
- 新增 Candidate 卡片、AI 推荐理由/分数/时长/标签、必去/想去/可选/不去四级 preference、单个与批量修改。
- 新增全部/必去/想去/可选/不去/未定位筛选、文本搜索、选择统计、已定位/未定位统计。
- 新增“AI 推荐地点/补充推荐”“批量重新定位”“根据选中地点生成行程”入口；未定位的已选地点会阻止排程。
- 新增 Resolution 修复 UI：重新识别、Provider 候选选择、地图点选、手工坐标；坐标仍只来自 Provider 或用户明确输入。
- 新增 Candidate Marker 地图模式，卡片 → Marker 与 Marker → 卡片双向选中；地图点选使用 crosshair 模式。
- 新增 v2 行程只读视图：Day、start/end Anchor、Stop、交通、Route 状态、dirty 提示与显式更新路线按钮。
- 新增 v2 对话抽屉，明确区分“自然语言旅行需求”与地点发现/排程按钮，不再宣传聊天是唯一规划入口。
- 修复版本历史抽屉，使其读取 v2 Revision 的 `plan`。
- GitHub CI 已扩展到当前实施分支。

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

Phase 5 关键文件：

- `apps/web/src/App.tsx`
- `apps/web/src/v2-types.ts`
- `apps/web/src/workspace-v2.ts`
- `apps/web/src/workspace-v2.test.ts`
- `apps/web/src/CandidatePanel.tsx`
- `apps/web/src/WorkspaceMapV2.tsx`
- `apps/web/src/ItineraryPanelV2.tsx`
- `apps/web/src/WorkspaceAssistantV2.tsx`
- `apps/web/src/VersionDrawerV2.tsx`
- `apps/web/src/AiTaskTopbar.tsx`
- `apps/web/src/styles.css`
- `.github/workflows/v3-ci.yml`
- 删除临时 `.github/workflows/export-phase4-source.yml`

## Tests / Checks

Phase 5 本地验证：

- `npm run typecheck`：Web 与 Server 均通过。
- 全量 Vitest：28 个测试文件、171 个测试全部通过。
- 新增 Candidate-first Web helper：4 个测试通过。
- `npm run build:web`：通过。
- `npm run build:server`：通过。
- 新增/修改源码行尾空格检查：通过。
- 未调用真实 Codex 账户或真实地图 Provider；未读取用户真实 `private_data/`。

## Known Issues / Risks

- 行程 Tab 当前可查看 Day/Anchor/Stop 和手动更新路线，但尚未提供拖拽、跨 Day 移动、增删 Stop 和 Anchor 编辑控件。
- Proposal 后端已经存在，前端 Preview/Apply/Reject/Undo 尚未接入。
- 01 行程细化仍未接入 v2 Runtime/UI。
- 旧 v1 Web/Server 文件仍在仓库中但已无活动 UI/Server 入口；最终 Cleanup 会删除。
- 未完成真实浏览器 E2E；当前以 TypeScript、纯函数测试、全量单元测试和生产构建作为门禁。

## Next Phase

Phase 6：

- 行程 Tab 增加同日原生拖拽、跨 Day 拖拽、键盘移动替代操作。
- 增加 Stop 添加、删除、基础字段编辑和 Day Anchor 设置。
- 所有编辑只提交固定 PlanCommand，不调用 AI。
- 编辑成功后刷新 Workspace；路线 dirty 只由 fingerprint 派生。
- 用户显式点击“更新路线”才调用 Route API；连续拖拽不自动请求路线。
- 增加纯命令构造和 UI 状态测试，覆盖同日/跨日移动和 generation 请求体。

## Recommended Model

Worker 实施拖拽和编辑控件；高推理 Reviewer 检查数组索引、跨 Day 目标位置、generation CAS 和 Route Dirty 边界。

## Do Not Do

- 不触碰真实 `private_data/`。
- 不恢复旧数据迁移、旧 Store、旧 MapPipeline 或 03 坐标 Agent。
- 不保存 routeDirty 布尔值。
- 不让 AI 输出或直接修改坐标。
- 不新增开放式 Patch、额外业务 stage 或新的坐标 Agent。
- 不在拖拽或基础编辑后自动调用 Route Provider。
