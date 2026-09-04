# User Control Correction 实施进度

> 分支：`codex/user-control-correction`
> PR：Draft PR #5
> 状态：代码收口完成，暂不合并 main；完整 Gate 由用户在 Codex 执行

## 已完成

- Canonical validation 已拆分为结构完整性为主；日期反向、天数不一致、时间不完整/跨夜/重叠、excluded 已排入、PlanningRole/PlaceKind 不一致等不再作为 canonical blocker。
- `scheduleText` 已进入 DayStop / PlanCommand / AI detail contract / replacement/refinement diff / Step 5 UI。
- PlanningRole 与 PlaceKind 已解耦；legacy 缺失 planningRole 时仍保留 `city -> planning_area / 其他 -> detail_interest` 的读取兼容。
- Planning Area helper 已改为 planningRole 驱动。
- semantic/name duplicate 不再静默过滤或拒绝；精确同一 canonical Place ID 仍只允许一个 Candidate。
- `planning-advisories-v3.ts` 已建立纯派生 Advisory；workspace API 已接入，前端右侧步骤区使用统一 Advisory renderer。
- Advisory 已覆盖 Day 日期断层；must_go Planning Area 以 Day Anchor / 路线是否采用判断覆盖，不再错误要求它必须成为 Stop。
- Detailed apply/runtime 已移除 unresolved、excluded、city Stop、area membership、overlap、must-go coverage 等规划型 blocker，保留未知引用与结构边界。
- `plan-commands-v2.ts` 不再因 `preference=excluded` 自动删除已排 Stop，不再因普通 command 自动重写 Day 日期，也不再拒绝 semantic duplicate；旧 Scope guard 也已支持 `days` Scope。
- Route 保持 best-effort；未定位端点保留 Day/Stop，只返回 attention/warning，不伪造 Provider 路线事实。
- 五步导航始终可进入；Step 3/4/5 的规划型 disabled/gate 已清理。
- Step 3 允许 must_go 暂不安排、excluded 加回路线、分配天数与旅行参考天数不一致以及超过旧 90 天限制的 stayDays。
- Step 4 显示 excluded，父 Planning Area 可为空，路线需更新不再阻止研究/补充；如果尚无已采用的 Stay Block，会回退到现有 Planning Area 作为研究目标，而不是显示可点按钮后再报无 target。
- Step 4 AI discovery 不再硬拒绝 `Place.kind=city`；PlaceKind 不决定 `detail_interest` planningRole。
- Step 5 支持自然时间、部分时间、疑似跨夜时间以及未定位地点继续存在。
- 手工新增地点会原样保存用户选择的 `Place.kind`，不再按 planningRole 自动映射 city/attraction。
- `destination.generate` Prompt 已与真实 Backbone Structured Output 对齐：父级使用 `parentCandidateRef` 的 `existing/generated/null` 合同，不再误写 `planningAreaCandidateId`。
- Repair #8 去掉 90 天业务上限，并支持多位数字（如 120 天、+120 天）；负数结果仍作为结构无效拒绝。
- 新增 `days` Proposal Scope；单日、多日 Detail Update/Refine 均使用最小 Day/Days Scope。
- 局部 deterministic itinerary Action 的 Scope 元数据已收紧：Stop 增删改、Anchor、局部 edit 为 Day Scope，跨日 Stop move 为 Days Scope；Day reorder 因影响整条 Day 顺序仍保留 Trip Scope。
- AI Read Context 与 Mutation Scope 已分离；excluded 候选仍进入 AI 可读上下文，并通过 preference 表达“默认不选”，不再因 preference 被隐藏。
- Shared Prompt 与 Step 2/3/5 核心 Action Prompt 已调整为“规划质量 best effort，用户明确要求优先”。
- 已移除残留的旅行规模业务上限：前置合同中的 365 天、90 Day、80 Stop、1800 Candidate/Place，以及 Candidate `suggestedDurationMinutes <= 10080` 的 7 天业务上限；单次兴趣点 0–9、Refine 小批次、Proposal/Verify 100 commands 等明确的单次操作资源保护继续保留。
- Web `ProposalScope` UI 已支持 `days`；相关旧测试 fixture 已补齐 `transferMode` / `advisories` 类型字段。
- `docs/IMPLEMENTATION_STATUS.md`、README、AGENTS 与原五步文档已加入 User Control Correction 优先级，旧 Phase 7 最终回归不再作为当前验收基准。

## 已执行的历史轻量 Gate

2026-09-04 较早阶段曾执行专项 targeted regression gate，以下 4 个测试文件当时通过：

- `apps/server/user-control-correction-v3.test.ts`
- `apps/server/user-control-days-scope-v3.test.ts`
- `apps/server/user-control-size-context-v3.test.ts`
- `apps/server/replan-intent-v3.test.ts`

随后又新增了若干回归用例与代码修复，因此这些“历史通过”不能替代最终完整测试。

本专项施工期间的一次性文本 patch 只执行 `git diff --check` 后自删除，没有手工启动完整 test/typecheck/build。

## 最新自动 CI 说明

PR 自带的 `v3 branch CI` 会在 push 时自动触发。它曾帮助暴露并修复以下类型断层：

- Web Day fixture 缺 `transferMode`；
- Web Proposal UI 未处理 `days` Scope；
- Workspace fixture 缺 `advisories`；
- Server legacy command guard 未处理 `days` Scope。

最后一次分支 CI 因本 PR 中临时 workflow 变更被 GitHub 标记为 `action_required`，没有实际执行 job。因此最终完整验证仍应由用户在 Codex 环境执行。

## 仍需由 Codex 完整验证

- `git diff --check`
- 完整 `typecheck`
- 全量 test suite
- production build
- Browser E2E
- 真实 AI / private_data E2E（仅在环境与授权可用时）
- 隐藏旧规则残留扫描与测试语义审核

## 当前结论

2026-09-04 最终审查已执行专项 Gate（7 files / 48 tests）、typecheck 和 build，均通过。完整 Vitest 第二轮为 448/455 通过；剩余 7 个失败来自 3 个仍等待已废止 blocker 状态的 runtime/discovery 测试，并伴随 Windows 临时 SQLite 清理 `EPERM`。路线排序对无 parent Candidate 的分组回归已修复，多个旧断言已迁移；Browser 与真实 AI/private_data E2E 没有执行。分支继续保持 Draft，不合并 main。
