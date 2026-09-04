# User Control Correction 实施进度

> 分支：`codex/user-control-correction`
> 状态：施工中，暂不合并 main

## 已完成

- Canonical validation 已拆分为结构完整性为主；日期反向、天数不一致、时间不完整/跨夜/重叠、excluded 已排入、PlanningRole/PlaceKind 不一致等不再作为 canonical blocker。
- `scheduleText` 已进入 DayStop / PlanCommand / AI detail contract / Step 5 UI。
- PlanningRole 与 PlaceKind 解耦；legacy 缺失 planningRole 时仍保留 city→planning_area、其他→detail_interest 的读取兼容。
- Planning Area helper 已改为 planningRole 驱动。
- semantic duplicate 不再静默过滤；精确同一 Place ID 仍只允许一个 Candidate。
- `planning-advisories-v3.ts` 已建立纯派生 Advisory；workspace API 已接入，前端右侧步骤区已有统一 Advisory renderer。
- Detailed apply/runtime 已移除 unresolved、excluded、city Stop、area membership、overlap、must-go coverage 等规划型 blocker，保留未知引用与结构边界。
- `plan-commands-v2.ts` 不再因 preference=excluded 自动删除已排 Stop，不再因普通 command 自动重写 Day 日期，也不再拒绝 semantic duplicate。
- 五步导航改为始终可进入；Step 3/4/5 的规划型 disabled/gate 已大幅清理。
- Step 3 允许 must_go 暂不安排、excluded 加回路线、超过旧 90 天限制的 stayDays。
- Step 4 显示 excluded，父 Planning Area 可为空，路线需更新不再阻止研究/补充。
- Step 5 支持自然时间、部分时间以及未定位地点继续存在。
- Repair #8 去掉 90 天业务上限，并支持多位数字（如 120 天、+120 天）；负数结果仍结构性拒绝。
- 新增 `days` Proposal Scope 及两套 Scope Policy 支持，已添加专项回归测试。
- Shared Prompt 与 Step 2/3/5 核心 Action Prompt 已调整为“规划质量是 best effort，用户明确要求优先”。

## 仍需收口

1. `planner-runtime-v3.ts`
   - 单日 Scope 已收紧。
   - 多日 `itinerary.detail.update` / `itinerary.refine` 仍需从兼容的 Trip Scope 切换为 `{ type: "days", ids: [...] }`。
   - 整趟 `itinerary.generate` / 明确 `itinerary.replan` / 显式全局 repair 可继续使用 Trip Scope。

2. `apps/web/src/AppWorkflowV3.tsx`
   - `CandidateWorkflowPanelV3` 已允许用户独立选择 PlaceKind。
   - App 层手工 `addCandidate` 仍需把 `draft.placeKind` 原样写入 Place.kind，不能继续按 planningRole 自动映射 city/attraction。

3. 文档收尾
   - 更新 `docs/IMPLEMENTATION_STATUS.md`、README/AGENTS 中旧的 city-only / Phase 7 状态。
   - 原五步 Phase 7 最终回归应继续暂缓，待本专项完成后重新定义验收。

4. 最终 Gate
   - 当前未执行完整 test/typecheck/build/Browser E2E/真实 AI E2E。
   - 完成上述两处代码接线后，先做 targeted static/test review；完整 Gate 按项目约定另行确认。
