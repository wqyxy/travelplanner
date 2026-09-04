# User Control Correction 实施进度

> 分支：`codex/user-control-correction`
> PR：Draft PR #5
> 状态：代码收口完成，暂不合并 main；完整 Gate 待用户确认

## 已完成

- Canonical validation 已拆分为结构完整性为主；日期反向、天数不一致、时间不完整/跨夜/重叠、excluded 已排入、PlanningRole/PlaceKind 不一致等不再作为 canonical blocker。
- `scheduleText` 已进入 DayStop / PlanCommand / AI detail contract / replacement/refinement diff / Step 5 UI。
- PlanningRole 与 PlaceKind 已解耦；legacy 缺失 planningRole 时仍保留 `city -> planning_area / 其他 -> detail_interest` 的读取兼容。
- Planning Area helper 已改为 planningRole 驱动。
- semantic/name duplicate 不再静默过滤或拒绝；精确同一 canonical Place ID 仍只允许一个 Candidate。
- `planning-advisories-v3.ts` 已建立纯派生 Advisory；workspace API 已接入，前端右侧步骤区使用统一 Advisory renderer。
- Detailed apply/runtime 已移除 unresolved、excluded、city Stop、area membership、overlap、must-go coverage 等规划型 blocker，保留未知引用与结构边界。
- `plan-commands-v2.ts` 不再因 `preference=excluded` 自动删除已排 Stop，不再因普通 command 自动重写 Day 日期，也不再拒绝 semantic duplicate。
- Route 保持 best-effort；未定位端点保留 Day/Stop，只返回 attention/warning，不伪造 Provider 路线事实。
- 五步导航始终可进入；Step 3/4/5 的规划型 disabled/gate 已清理。
- Step 3 允许 must_go 暂不安排、excluded 加回路线、分配天数与旅行参考天数不一致以及超过旧 90 天限制的 stayDays。
- Step 4 显示 excluded，父 Planning Area 可为空，路线需更新不再阻止研究/补充。
- Step 5 支持自然时间、部分时间、疑似跨夜时间以及未定位地点继续存在。
- 手工新增地点会原样保存用户选择的 `Place.kind`，不再按 planningRole 自动映射 city/attraction。
- Repair #8 去掉 90 天业务上限，并支持多位数字（如 120 天、+120 天）；负数结果仍作为结构无效拒绝。
- 新增 `days` Proposal Scope；单日、多日 Detail Update/Refine 均使用最小 Day/Days Scope。
- 局部 deterministic itinerary Action 的 Scope 元数据已收紧：Stop 增删改、Anchor、局部 edit 为 Day Scope，跨日 Stop move 为 Days Scope；Day reorder 因影响整条 Day 顺序仍保留 Trip Scope。
- AI Read Context 与 Mutation Scope 已分离；excluded 候选仍进入 AI 可读上下文，并通过 preference 表达“默认不选”，不再因 preference 被隐藏。
- Shared Prompt 与 Step 2/3/5 核心 Action Prompt 已调整为“规划质量 best effort，用户明确要求优先”。
- 已移除残留的旅行规模业务上限：前置合同中的 365 天、90 Day、80 Stop、1800 Candidate/Place 等不再限制用户方案；单次兴趣点 0–9、Refine 小批次、Proposal/Verify 100 commands 等明确的单次操作资源保护继续保留。
- `docs/IMPLEMENTATION_STATUS.md`、README、AGENTS 与原五步文档已加入 User Control Correction 优先级，旧 Phase 7 最终回归不再作为当前验收基准。

## 已执行的轻量 Gate

2026-09-04 已执行专项 targeted regression gate，以下 4 个测试文件通过：

- `apps/server/user-control-correction-v3.test.ts`
- `apps/server/user-control-days-scope-v3.test.ts`
- `apps/server/user-control-size-context-v3.test.ts`
- `apps/server/replan-intent-v3.test.ts`

覆盖重点包括：canonical 规划冲突可保存、结构损坏仍拒绝、Days Scope 越界拒绝、120+ 天/90+ Day/80+ Stop/1800+ Candidate 旧业务上限已移除、excluded 候选仍进入 AI read context、Repair #8 多位数字明确指令。

## 仍未执行

按项目既定约束，以下完整 Gate **尚未执行**：

- 全量 `npm test`
- 完整 `typecheck`
- 完整 `build`
- Browser E2E
- 真实 AI / private_data E2E

这些属于最终综合验收，执行前应先列出范围与成本并取得用户确认。

## 当前结论

User Control Correction 的代码与文档收口已完成，分支继续保持 Draft，不合并 main。下一步不是继续增加产品规则，而是等待是否进入完整综合 Gate；若完整 Gate 发现问题，再按本专项原则修复回归。
