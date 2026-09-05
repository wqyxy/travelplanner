# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)  
> 施工规则：[`PLAN_IMPLEMENTATION_PROMPT.md`](./PLAN_IMPLEMENTATION_PROMPT.md)  
> 当前产品：[`PRODUCT.md`](./PRODUCT.md)  
> 当前技术：[`TECHNICAL.md`](./TECHNICAL.md)  
> 施工进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 最终目标

把旧五步流程：

```text
旅行需求
→ 候选地点
→ 路线和天数
→ 补充景点
→ 每日详细行程
```

收敛为两个核心工作区：

```text
规划 · 旅行需求
行程 · 最终线路
```

用户只维护一份最终线路。地点顺序、状态、住宿分界和到达交通都记录在线路节点上；Day、地图和交通路线只从这份线路得到。

核心产品原则：

- 用户是唯一决策者，AI 只辅助；
- 不因为路线“不合理”而自动修改用户结果；
- 不完整、冲突、暂未定位的方案允许保存；
- 代码只阻止数据损坏、越权和伪造事实；
- 地图只负责展示 / 选择 / 定位辅助；
- 业务修改统一从右侧进入；
- Provider 坐标、真实距离、时长和 geometry 不能由 AI 或 UI 伪造。

---

# 2. 最终线路规则

每个最终线路节点表示某个现实 Place 在线路中的一次出现：

```text
id
placeId
status: normal / tentative / no_go
endsDay
transportFromPrevious
```

同一个 Place 可以出现多次，每次有独立节点 ID。

## 2.1 状态

- `normal`：参与当前 Day 和交通路线；
- `tentative`：保留原顺序、地图点和原住宿分界，但暂时不参与 Day / 路线；
- `no_go`：同样保留原顺序、地图点和原住宿分界，但暂时不参与 Day / 路线；
- 恢复 `normal` 时，原位置、住宿分界和到达交通一起恢复；
- 只有“移除”才真正删除线路节点。

## 2.2 住宿分界

`endsDay=true` 表示当天在这个 normal 节点结束。

- 住：设置 `endsDay=true`；
- 不住：设置 `endsDay=false`，不删除、不移动其他地点；
- 多一晚：在当前住宿节点后新增一个引用相同 Place 的独立 normal 节点，并形成新的 Day；
- 多一晚本身不能移动任何前后景点；
- 最后一个 normal 节点即使 `endsDay=false` 也必须形成合法最后一天。

## 2.3 到达交通

交通属于“到达当前节点”。

```text
A —drive→ X —walk→ B
```

X inactive 后：

```text
A —walk→ B
```

恢复 X 后仍是：

```text
A —drive→ X —walk→ B
```

## 2.4 Day

Day 不作为第二份独立线路维护。

```text
旅行起点
+ normal 最终线路节点
+ 当前生效的 endsDay
→ 自动得到 Day
```

Day 编号和日期随最终线路自动重新计算。

---

# 3. 数据策略

当前旅行数据全部是测试数据，可以从头开始。

因此本轮不承担：

- 施工前旧旅行 JSON 迁移；
- 旧 Candidate / Day → 最终线路迁移；
- 施工前旧 Revision 恢复。

已经落盘的非空旧格式计划直接拒绝，不猜测新线路。

Phase 1–3 施工中间态仍有少量旧 Skeleton / Day / Detailed 内部调用。Phase 1 保留一个边界明确的当前写入翻译层：

```text
当前旧代码路径产生新的 Day 视图
→ Store 保存边界翻译成最终线路
→ 再由最终线路生成 Day
→ 最终数据库仍只有一份线路
```

这层逻辑不能用来迁移已经落盘的旧计划，并应在 Phase 3 随旧入口清理继续缩小或删除。

---

# 4. 测试规则

施工 Agent **不得执行任何测试、typecheck、build、应用启动、迁移、Provider 运行验证或 CI**。

每个 Phase：

1. 修改代码；
2. 只做静态 Review；
3. 状态改为 `awaiting_local_test`；
4. 冻结唯一 Test Branch + 40 位 HEAD；
5. 把完整本地 Codex 测试 Prompt 写在本文件；
6. 用户本地测试；
7. 用户返回匹配 Branch + HEAD 的 PASS / FAIL；
8. PASS 才进入下一 Phase；FAIL 只修当前 Phase。

测试状态只使用：

```text
pending
in_progress
awaiting_local_test
completed
blocked
```

---

# 5. Phase 1 — 最终线路底层与自动 Day / Route 基础

状态：completed

Phase 1 已完成：

- finalRoute v1；
- 同 Place 多节点；
- normal / tentative / no_go；
- endsDay；
- transportFromPrevious；
- Day 自动派生；
- 新增 / 删除 / 移动 / 状态 / 住宿 / 多一晚 / 交通命令；
- Route 终点交通；
- generation / Revision / Proposal 冲突识别；
- 当前 Day 写入的过渡翻译；
- Stop-only null Anchor 兼容；
- Detailed 首站 Day 到达交通 sticky；
- Provider 事实边界保持。

最终验收：

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
Phase 1: PASS
Test Files: 83 passed / 0 failed / 83 total
Tests: 479 passed / 0 failed / 479 total
```

---

# 6. Phase 2 — 右侧最终线路人工规划闭环 + 地图联动

状态：awaiting_local_test

## 6.1 本阶段目标

Phase 2 不改造 AI 生成权限和 Prompt；它先让用户能够只靠新的最终线路工作区完成完整人工规划。

正常用户界面只保留：

```text
规划 · 旅行需求
行程 · 最终线路
```

旧 Step 2 / 3 / 4 / 5 不再作为正常导航入口。

## 6.2 本阶段已施工内容

### 新挂载入口

新增 `AppFinalRouteV3.tsx` 并由 `main.tsx` 直接挂载。

旧 `AppWorkflowV3.tsx` 暂时留在源码供 Phase 3 清理，但不再是正常产品入口。

### 右侧最终线路

新增 `FinalRoutePanelV3.tsx`：

- 手工添加地点后直接进入 finalRoute，不经过候选池页面；
- 新 Place + 内部 Candidate 关联 + finalRoute node 在同一命令批次保存；
- 支持上下移动与拖动排序；
- 支持 normal / tentative / no_go；
- 支持住 / 不住 / 多一晚；
- 支持“到达当前节点”的交通方式；
- 支持 Place 名称 / 类型编辑；
- 支持重新识别、Google Maps 链接、地图选点；
- “移除”只删除当前线路节点，不误删同 Place 的其他线路出现；
- inactive 节点仍显示原住宿分界，并说明恢复 normal 后重新生效；
- Day 只作为最终线路切分后的派生分组展示，不提供独立 Day 编辑入口。

### 地图

新增 `FinalRouteMapV3.tsx` / `final-route-map-v3.ts`：

- 地图点直接来自 `finalRoute.nodes`；
- normal / tentative / no_go 的已定位节点全部显示；
- 待定和不去有不同标记 / 视觉；
- 路线线条仍来自由 normal 节点派生的 Day Route；
- 地图点击只选择 / 聚焦右侧线路节点；
- Popup 只显示地点、状态、地址，不放删除、状态、住宿或优化按钮；
- 只有从右侧先点击“地图选点”后，地图点击才会保存定位；
- 未定位地点继续保留在线路，只是在地图上没有伪造坐标。

### 路线刷新

最终线路命令成功保存后，如果 Day Route 变脏，前端会尝试自动重新计算当前路线。

路线 Provider 更新失败时：

- 已保存的最终线路不回滚；
- 右侧显示非阻断提示；
- 提供“更新地图路线”按钮再次尝试。

### 旅行需求

`RequirementsPanelV3` 不再显示 Step 1 / “下一步：想去哪些地方”，改成：

```text
规划 · 旅行需求
→ 进入最终线路
```

### 提醒

`PlanningAdvisoryListV3` 支持在最终线路工作区合并显示旧内部分类的提醒，但不把旧五步重新暴露成页面导航。

## 6.3 本阶段明确不做

以下留到 Phase 3：

- “生成主要地点”直接写 finalRoute；
- “生成详细地点”直接写 finalRoute；
- AI 局部插入；
- 显式“优化这一天 / 这一段 / 全程”；
- 普通 AI 只能插入、不能重排的最终 Scope / Prompt 权限；
- 旧 destination / interest / itinerary Action 收敛；
- 旧 Prompt / Candidate / Skeleton / Day 编辑内部路径最终删除；
- PRODUCT / TECHNICAL 最终文档切换。

---

# 7. Phase 2 本地 Codex 测试 Prompt

> Test Branch: `__PHASE2_TEST_BRANCH__`  
> Test HEAD: `__PHASE2_TEST_HEAD__`

你是独立测试 Agent。不要相信施工 Agent 的完成声明，只根据指定 Branch + HEAD 的代码和本地执行结果判断 Phase 2。

## 7.1 先验证 Git 基线

只能先运行：

```bash
git branch --show-current
git rev-parse HEAD
git status --short
```

必须严格等于本 Prompt 顶部的 Test Branch / Test HEAD。

如果不一致立即输出：

```text
TEST_BASE_MISMATCH
```

不要自行 checkout / switch / pull / merge / rebase / reset / cherry-pick。

如果工作树存在影响待测代码的修改，立即输出：

```text
TEST_WORKTREE_DIRTY
```

## 7.2 阅读范围

阅读：

- `docs/PLAN.md`
- `docs/PLAN_EXECUTION.md`
- `docs/PLAN_PROGRESS.md`
- `apps/web/src/main.tsx`
- `apps/web/src/AppFinalRouteV3.tsx`
- `apps/web/src/FinalRoutePanelV3.tsx`
- `apps/web/src/FinalRouteMapV3.tsx`
- `apps/web/src/final-route-ui-v3.ts`
- `apps/web/src/final-route-map-v3.ts`
- `apps/web/src/RequirementsPanelV3.tsx`
- `apps/web/src/PlanningAdvisoryListV3.tsx`
- `apps/server/final-route-v3.ts`
- `apps/server/plan-commands-v2.ts`
- `apps/server/day-route-v2.ts`
- `apps/server/travel-api-v3.ts`

确认 `main.tsx` 实际挂载的是新两工作区 App，不是旧五步 App。

## 7.3 Typecheck

执行：

```bash
npm run typecheck
```

Windows 如果 `npm.ps1` 被执行策略阻止，可以使用：

```bash
npm.cmd run typecheck
```

记录实际命令。

## 7.4 Phase 2 专项测试

执行：

```bash
npx vitest run --config vitest.config.ts \
  apps/web/src/final-route-ui-v3.test.ts \
  apps/web/src/final-route-map-v3.test.ts \
  apps/server/final-route-v3.test.ts \
  apps/server/final-route-plan-commands-v3.test.ts \
  apps/server/travel-store-final-route-v3.test.ts \
  apps/server/day-route-v2.test.ts \
  apps/server/plan-route-order-v2.test.ts
```

Windows 可以使用等价 `.cmd` 入口。

## 7.5 完整回归

执行：

```bash
npm test
```

完整 `npm test` 是强制 Gate。任何测试失败都必须判：

```text
Phase 2: FAIL
```

## 7.6 Build

执行：

```bash
npm run build
```

Windows 可以使用：

```bash
npm.cmd run build
```

## 7.7 独立代码审计

不要只相信现有测试，独立确认：

### A. 两工作区

正常挂载界面只能看到：

```text
规划 · 旅行需求
行程 · 最终线路
```

不能再出现可进入的：

```text
想去哪些地方
路线和天数
补充景点
每日行程
```

旧文件可以仍在源码，但不能继续作为正常产品导航。

### B. 添加地点直接进入最终线路

从右侧添加 A、B、C。

必须直接得到：

```text
A → B → C
```

不能要求用户先进入 Candidate 页面再“采用”。

后台可以保留内部 Candidate 关联，但用户不能维护第二份候选线路。

### C. 排序

验证：

- 上移；
- 下移；
- HTML drag/drop。

例如：

```text
A → B → C → D
```

把 B 拖到 D 的位置后，最终保存顺序必须与 UI 一致。

排序不能偷偷修改节点状态、住宿分界或 Place。

### D. 三状态

准备：

```text
A
X【住】
B
Y【住】
C
```

分别把 X 改成 tentative、Y 改成 no_go。

必须：

- X / Y 仍留在右侧原顺序；
- X / Y 在地图上仍显示（前提是真实坐标已定位）；
- X / Y 有不同视觉；
- X / Y 不参与当前有效 Day；
- X / Y 不参与当前交通路线；
- 原 `endsDay` 仍保存；
- 恢复 normal 后原住宿分界恢复。

### E. 住 / 不住

```text
A → B【住】 → C → D【住】
```

把 B 改成“不住”后，只能机械变成同一个 Day：

```text
A → B → C → D【住】
```

不能自动移动 C / D，不能自动新增其他住宿点。

### F. 多一晚

```text
A → 陶波【住】 → B
```

点击“多一晚”后必须是：

```text
A → 陶波#1【住】 → 陶波#2【住】 → B
```

并派生：

```text
Day 1: A → 陶波
Day 2: 陶波 → 陶波
Day 3: 陶波 → B
```

B 不能被移动。

### G. 到达交通

设置：

```text
A —drive→ X —walk→ B
```

X inactive 后：

```text
A —walk→ B
```

恢复 X 后仍是原来的两段交通。

交通修改不得保存伪造的真实距离、时长或 geometry。

### H. 同 Place 多节点

验证“多一晚”或其他重复 Place 后：

- 两个线路节点 ID 独立；
- 编辑 Place 名称会同时反映到同一 Place 的多个线路出现；
- 删除其中一个线路节点不能把另一个一起删除。

### I. 地图职责

确认地图：

- 点直接来自 finalRoute；
- 显示 normal / tentative / no_go 已定位节点；
- 路线线条只来自 normal 派生 Day；
- 点击点只选择 / 聚焦右侧节点；
- Popup 没有删除 / 状态 / 住 / 不住 / 多一晚 / 优化按钮；
- 只有右侧先启动“地图选点”后，地图点击才写定位。

### J. 未定位地点

手工添加一个 Provider 暂时无法识别的地点。

必须：

- 仍保留在线路；
- 不自动删除；
- 不自动补位；
- 右侧显示待定位 / 未定位；
- 可以重新识别、Google Maps 链接或地图选点；
- 地图不能为了“显示它”伪造坐标。

### K. 最终线路变化后的 Day / Route

对以下操作逐一检查：

- 添加；
- 删除；
- 移动；
- 状态变化；
- 住 / 不住；
- 多一晚；
- 交通方式变化。

必须立即得到新的派生 Day。

前端应自动尝试刷新 dirty Day Route。

如果 Route Provider 更新失败：

- 最终线路修改仍然保存；
- 不能因为地图路线失败而回滚用户线路；
- UI 应给非阻断提示并允许再次“更新地图路线”。

### L. 右侧唯一业务入口

确认没有第二套地图业务按钮，也没有隐藏 Day / Candidate 编辑入口让用户修改同一事实。

旅行列表、版本历史、主题、密码等全局管理不属于线路业务重复入口。

### M. 手工结果优先

手工制造明显绕路、一天很多地点等不合理结果。

系统可以提醒，但不能自动：

- 改顺序；
- 改状态；
- 改住宿分界；
- 删除地点。

### N. Revision / generation

通过新最终线路 UI 连续做若干修改：

- 新 Revision 能记录；
- 恢复新 Revision 后 finalRoute / Day 一致；
- 旧 generation 的冲突修改不能静默覆盖新线路。

只测试新结构，不测试施工前旧 Revision。

### O. Provider 事实边界

确认：

- 坐标来自 Resolution / 人工地图选点；
- 实际距离 / 时长 / geometry 来自 Route Provider；
- finalRoute / UI 命令只保存用户选择的交通方式，不伪造 Provider 事实。

## 7.8 浏览器 / UI 验证

如果本地测试环境支持启动应用并通过浏览器检查 UI，可以运行开发环境并执行上述 A–M 的实际 UI 操作。

如果当前 Codex 环境没有浏览器能力，不要伪造 E2E PASS；把无法完成的浏览器项写进“未覆盖或无法验证”。

真实外部地图 Provider 网络调用不是本 Phase 必须 Gate；不要为了调用真实 Provider 修改代码或凭证。

## 7.9 允许独立补充临时测试

可以添加临时 Vitest 进行独立审计，但：

- 不能修改生产代码来迁就测试；
- 最终必须删除临时测试；
- 保持工作树干净；
- 报告临时测试数量和结果。

## 7.10 输出格式

严格输出：

```text
Test Branch: __PHASE2_TEST_BRANCH__
Test HEAD: __PHASE2_TEST_HEAD__

Phase 2: PASS / FAIL

实际执行的测试：
- git branch --show-current: ...
- git rev-parse HEAD: ...
- git status --short: ...
- npm run typecheck: PASS / FAIL
- Phase 2 专项: PASS / FAIL
- npm test: PASS / FAIL
- npm run build: PASS / FAIL
- 浏览器 / UI 验证: PASS / FAIL / 未覆盖
- 独立临时审计: ...

完整测试统计：
- Test Files: ...
- Tests: ...

发现的问题：
1. [Blocker / High / Medium / Low] ...
   - 文件：
   - 复现：
   - 实际：
   - 预期：
   - 原因判断：

未覆盖或无法验证：
- ...

是否建议进入 Phase 3：是 / 否

原因：
...
```

---

# 8. Phase 3 — AI 生成 / 局部补充 / 显式优化 + 旧流程清理

状态：pending

Phase 2 本地 PASS 后才开始。

Phase 3 负责：

- 生成主要地点直接插入 finalRoute；
- 生成详细地点直接插入 finalRoute；
- 局部范围生成；
- 普通 AI 只能插入新节点，不能改变已有节点相对顺序、状态、住宿分界或删除；
- 用户显式触发“优化这一天 / 这一段 / 全程”后，AI 才能在授权范围重排；
- destination / interest / itinerary Action 和 Prompt 收敛到新产品语义；
- 清理旧五步 UI、Skeleton / Candidate / Day 的产品职责；
- 缩小或删除 Phase 1 的旧 Day 写入翻译；
- 更新 PRODUCT.md / TECHNICAL.md。
