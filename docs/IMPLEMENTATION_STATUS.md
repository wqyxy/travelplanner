# TravelPlanner v3 Implementation Status

更新时间：2026-08-27  
目标分支：`main`  
产品依据：`docs/PRODUCT_PLAN.md`  
数据策略：独立新数据库，不做旧数据库迁移

## Target

实现 Candidate-first AI 旅行规划工作台：

```text
自然语言需求
→ Candidate Pool
→ Place Resolver
→ 用户 preference
→ 使用真实地理信息生成 Day / Anchor
→ 初始路线
→ 确定性编辑 + Route Dirty
→ Scoped AI Proposal / Preview / Apply / Undo
→ 两日一批 Refinement
```

## Current Status

本轮针对 main 静态 Review 中发现的 P0 缺口完成代码修复，并同步产品、改进和本地测试文档。

本轮按用户要求：

- 只修改代码和文档；
- 不运行测试；
- 不运行 typecheck；
- 不运行 build；
- 不启动应用；
- 不读取或修改真实 `private_data`；
- 不实现数据库迁移。

## Completed in This Change

### Resolution Consistency

- Workspace 不再向前端返回 fingerprint 已过期的 Resolution。
- Plan Generation 只使用当前 Place identity 对应的 resolved 数据。
- Place 修改或用户新增地点后自动重新解析。
- 批量重试跳过仍然有效的 resolved 地点。

### Plan Generation

- AI 输入包含当前 Resolution、坐标、地址、Candidate preference、建议时长和服务端地理分组。
- Day 数量按日期范围或 requestedDurationDays 硬校验。
- want_to_go 不允许静默未排入。
- 首次 Candidate Discovery 要求 10–80 个地点，补充推荐上限 80。

### Proposal Scope

- 新增独立服务端 Scope Policy。
- Candidate Pool、Candidate、Place、Day 和 Trip Scope 使用明确不同的命令边界。
- Day Scope 禁止跨日移动和 Day 重排。
- Apply 时重新校验 Scope，不信任已保存 Proposal。

### Refinement

- 01 行程细化 Agent 接入 `TravelAiV2`、Runtime、API 和 UI。
- 每批最多两个 Day。
- 细化输出不能新增 Place、Candidate 或 Stop。
- 细化不能修改 Day / Anchor / Stop identity、地点引用或顺序。
- 支持“细化下一批”和“细化单日”。
- 编辑已细化 Day 前，服务端将受影响 Day 转为 `planned / needs_review`，顶层 Stage 不回退。

### Candidate and Editing UI

- Candidate Tab 支持手动创建 Place + Candidate。
- 新地点保存后自动进入 Place Resolver。
- 支持全选当前筛选结果。
- 把已排程 Candidate 标记为 excluded 前显示受影响 Day，并在确认后原子移除 Stop。
- 行程 Tab 允许同一地点多次到访。
- Stop 选中状态和滚动定位接入 WorkspaceSelection。

### Route

- 新增批量更新全部 dirty Day API 和 UI。
- dirty Day 不再把旧距离和旧时间显示为当前结果。
- 地图 dirty 路线显示为弱化虚线，并标注旧路线仅供参考。

### Map Synchronization

- Candidate 模式显示 Candidate Marker。
- Day 模式显示当天 Anchor / Stop 节点和路线。
- 点击 Stop Marker 定位右侧 DayStop。
- 点击 DayStop 高亮并定位地图 Marker。
- Day 切换后地图 fit 当天节点。

### Documentation

- `docs/README.md`：文档优先级和数据库决策。
- `docs/PRODUCT_PLAN.md`：当前唯一产品方案。
- `docs/IMPROVEMENT_STEPS.md`：本轮修复和后续步骤。
- `docs/LOCAL_TEST_PROMPT.md`：本地完整验收提示词。
- 本文件同步当前实现状态。

## Important Decisions

1. Canonical 为 `TravelPlanDocument schemaVersion=2`。
2. 产品 Stage 只有：
   - `place_selection`
   - `itinerary_planning`
   - `itinerary_refinement`
3. V3 使用 `private_data/travel-v2.sqlite3`。
4. 不迁移、不兼容读取、不双写旧数据库。
5. Place 是语义实体，Resolution 是可重新构建的地图派生数据。
6. AI 不输出坐标、路线 geometry、Provider 距离或时间。
7. 用户基础编辑使用固定 PlanCommand。
8. AI 修改必须先生成 Proposal。
9. Route Dirty 由 fingerprint 比较派生。
10. 公交、铁路、轮渡和航班没有真实 Provider 时必须显示 attention/unsupported。

## Files Changed

### Server

- `apps/server/planner-runtime-v2.ts`
- `apps/server/travel-api-v2.ts`
- `apps/server/refinement-workflow-v2.ts`
- `apps/server/proposal-scope-policy-v2.ts`
- `apps/server/plan-command-preparation-v2.ts`

### Web

- `apps/web/src/App.tsx`
- `apps/web/src/CandidatePanel.tsx`
- `apps/web/src/ItineraryPanelV2.tsx`
- `apps/web/src/WorkspaceMapV2.tsx`
- `apps/web/src/main.tsx`
- `apps/web/src/v3-fixes.css`

### Prompts

- `prompts/00-旅行规划Agent.md`
- `prompts/01-行程细化Agent.md`

### Docs

- `docs/README.md`
- `docs/PRODUCT_PLAN.md`
- `docs/IMPROVEMENT_STEPS.md`
- `docs/LOCAL_TEST_PROMPT.md`
- `docs/IMPLEMENTATION_STATUS.md`

## Tests / Checks

未执行。

用户明确要求只修复代码并提交，由用户在本地测试。因此本轮没有运行：

```text
npm test
npm run typecheck
npm run build
git diff --check
真实浏览器 E2E
真实 Codex Smoke
真实 Nominatim / Route Provider Smoke
```

本地测试请使用 `docs/LOCAL_TEST_PROMPT.md`。

## Known Risks Before Local Test

- 本轮为静态修改，编译、运行时和浏览器交互仍需本地验证。
- 真实 Codex 返回是否稳定满足严格输出合同需要 Smoke Test。
- Nominatim / 公共 Route Provider 的可用性、限速和地区覆盖需要真实网络验证。
- 30–80 个 Candidate 下的 UI 性能和地图可用性需要浏览器验证。
- 旧 v1 源码仍保留在仓库中但不属于当前活动入口；物理删除属于后续 P1 清理。
- Google Maps 链接、正式距离聚类、真实公共交通、营业时间聚合等仍为 P1。

## Next Step

在本地按 `docs/LOCAL_TEST_PROMPT.md` 执行只读测试并输出缺陷报告。

若出现问题，修复顺序：

1. typecheck / build / 启动阻断；
2. Candidate → Resolution → Plan 主闭环；
3. Command / Proposal / generation 一致性；
4. Route stale / dirty；
5. Refinement 边界；
6. UI 可用性；
7. P1 功能。

## Do Not Do

- 不加入旧数据库迁移或兼容层。
- 不恢复 v1 canonical 双轨。
- 不让 AI 生成坐标或真实路线数据。
- 不放松 generation CAS 或 Scope 校验。
- 不使用开放式 JSON Patch。
- 不把 dirty 旧路线显示为当前路线。
- 不因测试失败静默 reset 数据库。
- 不在 P0 顺手加入天气、票务、预订、协作或付费 Provider。
