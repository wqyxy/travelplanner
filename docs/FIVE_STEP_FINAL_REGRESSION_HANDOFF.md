# TravelPlanner 五步重构最终综合回归 Handoff

> 更新日期：2026-09-03  
> 用途：Phase 7 最终 Codex 综合回归，只测试和报告，不自动修改代码。  
> 实施前基线：`b048c1980247443b5d6568ddd4302c41c9ce832b`  
> Phase 6 最终 PASS HEAD：`0f8cdd2bdb58b248cc39aefbd05c8cdfd0ce2ae7`  
> 最终测试时请以 `feature/five-step-workflow-refactor` 的**实际当前 HEAD**为准，不要把上述 Phase 6 HEAD 当作 Phase 7 文档提交后的最终 HEAD。

---

# 给 Codex 的最终测试任务

你现在只负责对 TravelPlanner 本次“五步规划流程重构”做**独立最终综合回归测试与验收**。

## A. 重要限制

- 这是测试任务，不是实现任务。
- 先不要修改任何源代码、Prompt、测试、配置或数据库。
- 发现失败时先记录、定位、解释；不要自动修复，除非用户之后明确让你修。
- 不读取、复制、重命名、删除或改写真实 `private_data/`。
- 需要旅行数据时使用测试 fixture、临时项目副本、临时 SQLite 或 Browser API fixture。
- 不使用真实私人旅行做 Browser / API E2E。
- 不把缺少环境能力伪造成 PASS；环境阻塞单项标记 `BLOCKED`。
- 以 `docs/TravelPlanner 五步规划流程重构实施方案.md` 为最高优先级专项验收依据。
- UI 同时对照 `docs/五步 UI 交互规范.md`。
- `docs/IMPLEMENTATION_STATUS.md` 只负责说明当前实际状态。
- Phase 0–6 虽然已经逐阶段通过，但本次必须对**当前实际 HEAD**重新验证，不能引用旧 PASS 代替执行。

---

# B. 分支、基线与只读 Diff Review

目标分支：

```text
feature/five-step-workflow-refactor
```

五步实施前基线 / merge-base：

```text
b048c1980247443b5d6568ddd4302c41c9ce832b
```

先执行：

```bash
git status --short --branch
git branch --show-current
git rev-parse HEAD
git merge-base main HEAD
git diff --stat b048c1980247443b5d6568ddd4302c41c9ce832b..HEAD
git diff --name-status b048c1980247443b5d6568ddd4302c41c9ce832b..HEAD
```

要求：

- branch 正确；
- working tree clean；
- merge-base 应对应实施前基线，若 `main` 已变化则说明实际关系；
- 只读审查整个 diff，不只看最后 Phase 7 文档 commit；
- 判断实现是否围绕五步重构，没有无关大改。

按以下分类 review：

```text
KEEP
EXTEND
REPLACE
DO NOT TOUCH
```

重点确认：

```text
PlanningRole
stayBlockId
requiresWorkflowStep
Macro fingerprint
Skeleton atomic save
Impact Analyzer
Resolution readiness
Step 4 optional
Detailed patch-only update
mounted five-step UI
complexity downshift
map ownership
```

还要确认以下边界未被无关修改：

```text
PRAGMA user_version = 3
无 v3 → v4 migration
无自动 private_data rewrite
canonical TripStage 未变成 WorkflowStep / ConversationStage
Place Resolver 仍拥有坐标 / Provider ID 事实
Route Provider 仍拥有 geometry / distance / duration 事实
Core Visit 不成为 Macro Anchor
```

---

# C. 静态完整性

执行：

```bash
git diff --check b048c1980247443b5d6568ddd4302c41c9ce832b..HEAD
```

必须 exit code `0`。

然后读取：

```text
package.json
vitest.config.ts
tsconfig.json
tsconfig.server.json
```

当前已知真实 npm scripts 是：

```text
npm run typecheck
npm run typecheck:web
npm run typecheck:server
npm test
npm run build
npm run build:web
npm run build:server
npm run check:v3
```

仍请以测试时实际 `package.json` 为准；不要凭空发明不存在的脚本。

---

# D. Phase 1–6 Targeted Tests 并集

至少运行以下当前真实测试文件的并集：

```text
apps/server/contracts-v2.test.ts
apps/server/planning-roles-v3.test.ts
apps/server/ai-action-contracts-v3.test.ts
apps/server/ai-action-contracts-v3-detail-phase5.test.ts
apps/server/ai-stage-contracts-v3.test.ts
apps/server/stage-context-v3.test.ts
apps/server/candidate-workflow-v2.test.ts
apps/server/candidate-discovery-policy-v2.test.ts
apps/server/interest-discovery-v3.test.ts
apps/server/itinerary-workflow-v3.test.ts
apps/server/itinerary-impact-v3.test.ts
apps/server/planning-context-v3.test.ts
apps/server/detail-itinerary-v3.test.ts
apps/server/planner-runtime-v3-ai-actions.test.ts
apps/server/planner-runtime-v3-detail-phase5.test.ts
apps/server/planner-runtime-v3-detail-unavailable-phase5.test.ts
apps/server/requirements-duration-v3.test.ts
apps/server/travel-api-v3-phase6.test.ts
apps/server/skeleton-edit-api-v3.test.ts
apps/server/plan-route-order-v2.test.ts
apps/web/src/editor-actions-v2.test.ts
apps/web/src/workflow-ui-v3.test.ts
apps/web/src/skeleton-ui-v3.test.ts
apps/web/src/workspace-map-presentation-v2.test.ts
apps/web/src/workspace-v2.test.ts
apps/web/src/ai-task-topbar.test.ts
```

推荐一次运行：

```bash
npx vitest run --config vitest.config.ts \
apps/server/contracts-v2.test.ts \
apps/server/planning-roles-v3.test.ts \
apps/server/ai-action-contracts-v3.test.ts \
apps/server/ai-action-contracts-v3-detail-phase5.test.ts \
apps/server/ai-stage-contracts-v3.test.ts \
apps/server/stage-context-v3.test.ts \
apps/server/candidate-workflow-v2.test.ts \
apps/server/candidate-discovery-policy-v2.test.ts \
apps/server/interest-discovery-v3.test.ts \
apps/server/itinerary-workflow-v3.test.ts \
apps/server/itinerary-impact-v3.test.ts \
apps/server/planning-context-v3.test.ts \
apps/server/detail-itinerary-v3.test.ts \
apps/server/planner-runtime-v3-ai-actions.test.ts \
apps/server/planner-runtime-v3-detail-phase5.test.ts \
apps/server/planner-runtime-v3-detail-unavailable-phase5.test.ts \
apps/server/requirements-duration-v3.test.ts \
apps/server/travel-api-v3-phase6.test.ts \
apps/server/skeleton-edit-api-v3.test.ts \
apps/server/plan-route-order-v2.test.ts \
apps/web/src/editor-actions-v2.test.ts \
apps/web/src/workflow-ui-v3.test.ts \
apps/web/src/skeleton-ui-v3.test.ts \
apps/web/src/workspace-map-presentation-v2.test.ts \
apps/web/src/workspace-v2.test.ts \
apps/web/src/ai-task-topbar.test.ts
```

如果 Windows shell 不支持反斜杠换行，请改成同一条单行命令；不要改变测试集合。

报告：

```text
Test Files
Tests
Errors
Exit code
```

---

# E. Typecheck / Full Test / Build

依次执行：

```bash
npm run typecheck
npm test
npm run build
```

每个命令单独报告：

```text
exit code
通过/失败数量
首个失败
是否属于产品 / 测试 / 环境问题
```

不要因为 targeted tests 通过就跳过 full test。

不要因为 typecheck 通过就跳过 build。

---

# F. 必须重新覆盖的核心业务场景

以下对应实施方案第 29 节，必须逐项给 `PASS / FAIL / BLOCKED` 与证据。

## F1. 普通用户复杂度

普通用户不知道：

```text
PlanningRole
Macro
Skeleton
fingerprint
dirty
affectedDayIds
Resolution
WorkflowStep
CAS
```

仍可走完：

```text
旅行需求
→ 想去哪些地方
→ 路线和天数
→ 补充景点（可选）
→ 每日行程
```

Mounted entry 必须是：

```text
main.tsx → AppWorkflowV3
```

## F2. Planning Area preference

构造：

```text
A must_go
B want_to_go
C optional
D excluded
```

Step 3 必须：

```text
A 必须进入
B 优先；omitted 必须解释
C 可 omitted
D 绝不能进入
```

UI 主操作只突出：

```text
必去
想去
```

C 不要求长期 Badge；D 通过移除 / 不考虑表达。

## F3. 新西兰 20 天 / Milford Sound

构造：

```text
Te Anau = planning_area
Milford Sound = core_visit
parent = Te Anau
Milford preference = must_go
```

验证：

```text
Milford 不是 city
Milford 不成为 Stay Block / Macro Anchor
Milford 影响 Te Anau 时间容量
resolved Milford 在 Step 5 成为 Stop
UI 只把它称为“重要游览地”
```

## F4. 环线重复 Auckland

```text
Auckland #1
...
Auckland #2
```

验证：

```text
两个独立稳定 stayBlockId
修改一个不默认修改另一个
UI 显示两段独立奥克兰
UI 不显示 stayBlockId
```

## F5. Step 3 19 / 20 天手工分配

先：

```text
Queenstown 4 → 3
```

若总分配 19 / 20：

```text
不能保存
显示“还剩 1 天需要安排”
```

再：

```text
Te Anau 2 → 3
```

恢复 20 / 20：

```text
一次原子保存成功
```

验证 canonical 不经过中间非法半成品。

## F6. Detail → Core ownership / impact

用户表达：

```text
这个地方很重要，要单独留一天
```

验证现有实现是否按设计：

```text
不要求用户编辑 planningRole
意图归 Step 2 / Backbone ownership
Detail → Core 后产生正确 Impact
需要时让 Step 3 重新确认
不在 Step 4 / Step 5 静默做 role mutation
```

如果现有实现无法完成这条设计合同，判 FAIL，不要因为其他 Phase 通过而跳过。

## F7. Replan Macro 结构不变

上游变化导致 basis fingerprint 变化，但重新确认后 Macro 结构实际不变。

验证：

```text
更新 basis fingerprint
不无谓重建 Stay Block / Day
只让真正相关区域 Detail 需更新
```

用户体验应是类似：

```text
路线和天数无需调整，只需要更新蒂阿瑙的每日安排
```

## F8. Macro 天数变化

```text
Te Anau 2 → 3
Queenstown 4 → 3
```

验证：

```text
Day / stayBlock identity 尽量复用
只把真实 affectedDayIds 标记需更新
未受影响 Detailed Day 保持
```

## F9. unresolved readiness

验证：

```text
Planning Area unresolved
→ Step 3 可做语义 Skeleton
→ Macro Route pending
→ Step 5 真正使用为 Anchor 时局部阻塞

must_go Core unresolved
→ 阻塞相关 Detail

must_go Detail unresolved
→ 阻塞相关 Detail

want / optional unresolved
→ 不进入 Stop
→ 不阻塞无关 Day
```

UI：

```text
非阻塞 → 轻量提示
真正阻塞 → 明确行动卡
```

## F10. Step 4 完全可跳过

```text
Step 3 Ready
Detail Interest = 0
→ 进入 Step 4
→ 不运行 discovery
→ 直接 Step 5
```

验证：

```text
不自动 interest discovery
不自动 detail generate
Step 5 显式“生成每日行程”
已有 Core / Candidate 足够时可成功生成
Detailed Generate / Update 不接受旧 requires_stage: interests 强制 gate
```

## F11. Update Card 渐进披露

20 天中 2 天需更新：

默认类似：

```text
2 天需要更新，其他 18 天保持不变
[查看原因]
```

原因默认折叠。

不能直接显示：

```text
affectedDayIds
macroDirty
fingerprint
```

## F12. 跨步骤自动上下文

在 Step 5 说：

```text
蒂阿瑙再加一天
```

验证：

```text
自动切 Step 3
不静默 mutation
Action 如需确认仍 pending_confirmation
```

Step 2 / Step 3 共用 `destinations` ConversationStage 时，`destination.*` 与 `itinerary.generate/replan` ownership 不能混。

历史旧 generation action 不能反复劫持当前 UI。

## F13. 旧数据兼容

无以下 optional 字段的旧 canonical JSON：

```text
planningRole
stayBlockId
planningState
```

必须正常读取。

普通 load 不得因为缺字段自动 rewrite。

## F14. 90 天 Skeleton

构造 90 天大范围 Skeleton 更新。

验证：

```text
使用专用 applySkeletonPlanV3 / skeleton save 原子边界
不因通用 100 PlanCommand 上限失败
CAS / invariant 仍生效
```

---

# G. 额外 Detailed Itinerary 核心回归

必须确认：

```text
resolved Core must_go → 必须安排
resolved Detail must_go → 必须安排
resolved Core want_to_go → 优先；未安排时有理由
unresolved want/optional → unavailable，不阻塞
Update output affectedDayIds 必须与请求 scope 完全一致
sticky existing Detailed Day
Stop ID reuse
reorder 优先 move_day_stop
字段变化优先 update_day_stop
无变化不制造 remove/add churn
Macro 问题返回 requiresWorkflowStep=skeleton
Step 5 不修改 Anchor / Stay Block / Macro Day identity
```

---

# H. Provider / Map 事实边界

验证：

```text
AI 不产生可信坐标
AI 不产生 Provider Place ID
AI 不产生 geometry
AI 不产生 Provider distance / duration
```

Candidate：

```text
先保存
→ best-effort resolve
失败保留 Candidate
不整批回滚
```

地图：

```text
marker click 只 selection
popup 无业务编辑器
定位必须从右侧卡片先发起
map 不创建 Action / Candidate / Day / Stop mutation
```

候选地图长期标记：

```text
must_go → ★
want_to_go → ♡
optional → 无长期 mark
excluded → 不显示 marker
footer 只强调“必去 / 想去”
```

Dirty route：

```text
可显示旧 geometry 参考
不得把 stale distance / duration 当当前事实
```

---

# I. Browser E2E

必须使用安全隔离方案。

禁止：

```text
读取真实 private_data
启动真实 repo v3 backend 并对真实数据库写入
使用真实旅行
删除/移动真实 SQLite
调用真实 AI 来完成 Browser fixture
```

Phase 6 已证明可行的一种安全方式：

```text
从真实 repo root 仅启动前端 Vite
不启动真实 v3 backend
Browser 层使用内存 API fixture / request fulfill
```

这也能让 MapLibre worker 位于正常 Vite filesystem allow-list 内。

Browser 至少覆盖：

```text
1 五步导航在右侧
2 Step 1 下一步只进入 Step 2，不自动推荐
3 Step 2 显示停留地点 / 重要游览地 / 必去 / 想去
4 Step 3 19/20 显示“还剩 1 天需要安排”
5 两个 Auckland Stay Block 独立展示与选择
6 Step 4 明确可选，Detail=0 可直接进入 Step 5
7 Step 5 显式生成，不自动生成
8 20 天仅 2 天 affected 时显示“2 天需要更新，其他 18 天保持不变”
9 must-go unresolved 阻塞、want unresolved 轻量
10 跨步骤 Action 只切 UI、保持 pending
11 Proposal / task / error 不泄漏工程术语
12 marker click 只 selection，无 mutation
13 map popup 无第二套 business editor
14 candidate map footer 只显示必去 / 想去
```

对主要用户可见 DOM 做工程词扫描，不应出现：

```text
planningRole
stayBlockId
fingerprint
macroDirty
affectedDayIds
WorkflowStep
ConversationStage
CAS
Resolution
generation
Candidate ID
Stop ID
targetIds
executor
scope
Candidate Pool
Anchor
Macro
```

注意：

- 源码变量 / network payload / DevTools 不算 UI 泄漏；
- `补充景点（可选）` 中“可选”是合法用户文案，不要与候选地图 optional preference 图例混淆。

如果 Browser 环境无法安全隔离，Browser 单项标记 `BLOCKED`，不要伪造 PASS。

---

# J. 真实 AI Smoke

当前 `package.json` **没有专门的 smoke script**，不要发明 `npm run smoke`。

先只读检查：

- 当前环境是否已有合法 AI 配置；
- 项目是否已有可安全调用的现有运行路径；
- 是否可以使用全新临时 v3 数据库 / 临时旅行，不触碰真实 `private_data`。

只有全部满足时才做最小真实 AI smoke：

```text
Step 2 destination.generate
→ 能返回 Planning Area + Core Visit

Step 3 itinerary.generate
→ 能返回合法 Skeleton

Step 4 interest discovery
→ 只生成 detail_interest，允许 0

Step 5 detail generate
→ 固定 Macro 生成 Detailed Itinerary
```

同时验证 AI 不伪造 Provider 路线事实。

如果：

```text
缺 AI 凭据
没有安全隔离方法
现有项目没有适合的 smoke 调用路径
```

则：

```text
AI Smoke = BLOCKED
```

并明确原因，不要为了得到 PASS 临时加入脚本、修改配置或使用真实私人数据库。

---

# K. 文档一致性

检查：

```text
README.md
docs/README.md
docs/IMPLEMENTATION_STATUS.md
AGENTS.md
docs/PRODUCT_PLAN.md
docs/TravelPlanner 五步规划流程重构实施方案.md
docs/五步 UI 交互规范.md
```

实时状态必须理解为：

```text
Phase 1–6 已实施并 Gate PASS
Phase 7 最终综合回归待当前测试结果
```

`PRODUCT_PLAN` / 施工图 / UI 规范中如果仍存在 2026-09-02 设计冻结时的“尚未实施”历史状态行，以 `docs/IMPLEMENTATION_STATUS.md` 的实时状态为准；把这种历史头部状态记录为文档 P2，而不要误判为代码未实施。

同时检查文档不能反过来声称最终回归已经 PASS，除非当前这次测试真的得到 PASS。

---

# L. 最终报告格式

第一行使用：

```text
FINAL FIVE-STEP REGRESSION: PASS
```

或：

```text
FINAL FIVE-STEP REGRESSION: FAIL
```

或：

```text
FINAL FIVE-STEP REGRESSION: PARTIAL
```

其中：

- `PASS`：所有强制静态 / targeted / typecheck / full test / build / 核心业务 / Browser 项目通过；AI smoke 如可合法执行也通过。
- `FAIL`：存在真实产品、合同、测试、typecheck、full test、build 或可执行 Browser 场景失败。
- `PARTIAL`：强制可执行项通过，但仍有无法安全执行的环境阻塞项，例如没有合法条件执行真实 AI smoke 或 Browser。

然后按以下章节报告：

```text
1. Commands Run
2. Branch / HEAD / Working Tree
3. Full Diff Review
4. git diff --check
5. Targeted Tests
6. Typecheck
7. Full Test
8. Build
9. Core Scenarios F1–F14
10. Detailed Itinerary Regression
11. Provider / Map Boundaries
12. Browser E2E
13. Real AI Smoke
14. Documentation Consistency
15. Security / Private Data Audit
16. Issues by P0 / P1 / P2
17. Blocked Items
18. Conclusion
```

每个核心场景必须给：

```text
PASS / FAIL / BLOCKED
证据
对应测试 / Browser 行为 / 文件
```

失败项必须给：

```text
文件 / 行号或行为位置
复现步骤
actual
expected
分类：production / contract / test / fixture / typecheck / build / browser / environment
```

不要自动修代码。

如果总体 `PASS`，最后明确写：

```text
五步规划流程重构最终综合回归通过，可以由用户决定合并 main / 发布。
```

如果 `FAIL`：

```text
不要宣称专项完成；指出应回到哪个 Phase 修复。
```

如果 `PARTIAL`：

```text
明确剩余 BLOCKED 项及其风险，由用户决定是否接受这些环境未验证项。
```
