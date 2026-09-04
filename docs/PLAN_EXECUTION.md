# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)  
> 当前产品：[`PRODUCT.md`](./PRODUCT.md)  
> 当前技术：[`TECHNICAL.md`](./TECHNICAL.md)  
> 施工进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 目标

把当前五步流程收敛为两个核心工作区：

```text
规划：旅行需求
行程：最终线路
```

用户只维护一份最终线路。地点顺序、正常 / 待定 / 不去、住宿分界、交通方式都直接记录在线路节点上；Day、地图和路线根据最终线路自动得到。

完整目标体验：

```text
填写旅行需求
→ 进入最终线路
→ AI 生成主要地点并直接加入最终线路
→ 用户排序、待定、不去、住 / 不住 / 多一晚
→ AI 生成详细地点并直接插入最终线路
→ Day、地图、交通路线自动变化
→ 只有用户明确要求优化时，AI 才能重排已有地点
```

---

# 2. 已确认的产品决定

## 2.1 最终线路

最终线路是系统保存并由用户维护的唯一线路。

每个线路节点表示某个现实地点在线路中的一次出现，同一个 Place 可以出现多次，每次拥有独立节点 ID。

节点至少保存：

```text
id
placeId
status: normal / tentative / no_go
endsDay
transportFromPrevious
```

已有活动、时间、费用、备注等详细信息可以继续保存在线路节点上。

## 2.2 正常 / 待定 / 不去

待定和不去：

- 保留原排序；
- 保留地图展示；
- 暂时不参与当前有效 Day；
- 暂时不参与交通路线；
- 原住宿分界继续保存但暂时失效；
- 恢复 normal 后原位置和住宿分界恢复。

只有“移除”才真正删除节点。

## 2.3 交通方式

交通方式属于“到达当前节点”。

例如：

```text
A —drive→ X —walk→ B
```

X 不参与当前线路后，A → B 使用 B 自己保存的 walk。

## 2.4 住 / 不住 / 多一晚

- 住：给当前 normal 节点增加 `endsDay`。
- 不住：取消 `endsDay`，不删除、不移动其他节点。
- 多一晚：在当前住宿节点后新增一个引用同一 Place 的 normal 节点，并形成新的 `endsDay`。

多一晚不能自动搬动前后景点。

## 2.5 Day

Day 不再独立维护。

系统根据：

```text
旅行起点
+ normal 最终线路节点
+ 当前生效的 endsDay
```

自动生成 Day。

最后一天允许没有住宿分界，Day 编号和日期随线路变化自动重算。

## 2.6 AI 权限

“生成”只能新增并插入节点，不能改变已有节点的相对顺序、状态、住宿分界或删除已有节点。

只有用户明确触发：

```text
优化这一天
优化这一段
优化全程
```

AI 才能在授权范围内重排已有节点。

## 2.7 地图和业务入口

```text
地图 = 展示 / 选择 / 定位辅助
右侧 = 唯一业务操作入口
```

地图显示 normal / tentative / no_go 全部地点，但交通路线只使用 normal 节点。

地图 Provider 返回的坐标、真实距离、时长和 geometry 继续作为外部事实，不允许 AI 伪造。

---

# 3. 数据策略：从头开始，不兼容旧测试数据

用户已明确确认：当前项目中的旅行数据全部是测试数据，可以从头开始。

因此本轮施工：

- 不做旧旅行 JSON 迁移；
- 不做旧 Candidate / Day → 最终线路转换；
- 不做旧 Revision 恢复兼容；
- 不维护新旧数据双写；
- 不因为旧测试数据库增加兼容分支；
- 必要时直接删除 / 清空本地测试数据库重新创建旅行。

新结构自己的 Revision / Undo / generation / CAS 继续保留并必须正常工作。

数据库表结构本身不需要为了这次改造强行变更版本；旧计划 JSON 因缺少新结构而被拒绝读取时，直接清空测试数据即可。

---

# 4. 测试规则

施工 Agent 不运行任何测试、类型检查、构建、迁移、应用启动或 CI。

每个 Phase 代码完成后：

1. 静态 Review；
2. 更新 `PLAN_PROGRESS.md` 为 `awaiting_local_test`；
3. 建立明确的测试分支和 HEAD；
4. 把 `Test Branch` 和完整 `Test HEAD` 写入 Progress 和测试 Prompt；
5. 输出本地 Codex 测试 Prompt；
6. 停止施工，等待用户本地测试结果。

测试结果只对对应的 `branch + HEAD SHA` 有效。

---

# 5. 实施阶段

本轮保持 3 个 Phase。

---

# Phase 1：最终线路底层与自动 Day / Route 基础

## 目标

从全新数据开始，让系统底层真正以最终线路为中心工作。

不再承担任何旧旅行数据迁移职责。

## 修改范围

- 最终线路数据结构
- TravelPlanDocument
- 数据库版本边界
- Day 自动生成
- Route 输入 / dirty 判断
- PlanCommand / Revision 基础
- 并发冲突识别
- 本地测试用例

## 主要修改

1. 业务读取 / 写入只接受当前最终线路结构。
2. 现有 `emptyTravelPlan()` 的 `finalRoute.version = 0` 只允许作为**完全空白启动占位**：不能包含 Place、Candidate、Day 或线路节点，也不能承担旧数据转换；第一次被 Store / 最终线路逻辑读取时立即提升为 `version = 1`。
3. 一旦旅行出现任何实际规划内容，必须已经使用 `finalRoute.version = 1`。
4. 同一 Place 可被多个线路节点引用。
5. 支持：
   - 新增节点；
   - 移除节点；
   - 拖动；
   - normal / tentative / no_go；
   - 住 / 不住；
   - 多一晚；
   - 修改交通方式。
6. Day 始终根据最终线路重新生成。
7. 保存旅行时不接受 `days[]` 作为另一份独立线路。
8. Route 能正确读取 Day 终点的到达交通方式。
9. 最终线路变化参与 generation / Revision / Proposal 冲突判断。
10. 旧计划 JSON 不迁移；旧测试数据不能按新结构读取时直接清空重建。
11. 删除之前为了旧 Candidate / Day / Revision 内容转换而加入的逻辑和测试；只保留完全空白启动占位的最小提升逻辑。

## 代码施工完成条件

- 含实际规划内容的旅行只接受 `finalRoute.version = 1`；
- 完全空白的 `version = 0` 只作为启动占位，读取后立即提升，不承载旧数据；
- Day 能由最终线路得到；
- 状态、住宿分界、多一晚、交通、拖动和删除都有确定性底层操作；
- Store 保存时由最终线路重建 Day；
- 新格式 Revision / restore 保持可用；
- 旧格式计划 JSON 不会被转换成最终线路；
- 静态 Review 没有发现任何旧 Candidate / Day / Revision 内容转换逻辑仍然存在；
- Phase 状态更新为 `awaiting_local_test`。

## 本地测试要求

用户本地 Codex 至少运行：

```text
npm run typecheck
npm test
npm run build
```

重点验证：

- 完全空白启动占位可以临时为 `version = 0`，但不能携带任何旅行内容，并会立即提升为 `version = 1`；
- 任何含 Place / Candidate / Day 的旧格式计划都直接拒绝，不做转换；
- 同一 Place 多节点；
- normal / tentative / no_go；
- inactive 节点分界暂时失效并可恢复；
- 住 / 不住 / 多一晚；
- 交通继承；
- 最后一天无住宿；
- Day 编号 / 日期重算；
- Route 终点交通；
- Store 不信任独立修改的 days[]；
- 新格式 Revision / restore；
- generation / Proposal 冲突；
- 旧格式计划 JSON 不会被自动转换；
- Provider 事实边界未被破坏。

## 本阶段 Codex 本地测试 Prompt

> Test Branch: `test/plan-phase1-final-route-20260905`
> Test HEAD: `b751f0dff0c475419c54bf657a8cc541343443ac`
>
> 你是独立测试 Agent。不要相信施工 Agent 的完成声明，只根据指定 Git 基线、实际代码和本地执行结果判断 Phase 1。
>
> **第一步只能检查 Git 基线，不要先运行任何测试：**
>
> ```bash
> git branch --show-current
> git rev-parse HEAD
> git status --short
> ```
>
> 必须满足：
>
> - 当前分支严格等于 Test Branch；
> - 当前 HEAD 严格等于 Test HEAD；
> - 工作树没有会影响待测生产代码的本地修改。
>
> 如果 Branch 或 HEAD 不匹配，立即停止，输出 `TEST_BASE_MISMATCH`。不要自行 checkout、switch、pull、merge、rebase、reset 或 cherry-pick。
>
> 如果存在会影响待测代码的本地修改，立即停止，输出 `TEST_WORKTREE_DIRTY`。
>
> 基线确认无误后，阅读：
>
> - `docs/PLAN.md`
> - `docs/PLAN_EXECUTION.md`
> - `docs/PLAN_PROGRESS.md`
> - `apps/server/final-route-v3.ts`
> - `apps/server/contracts-v2.ts`
> - `apps/server/plan-commands-v2.ts`
> - `apps/server/travel-store-v3.ts`
> - `apps/server/day-route-v2.ts`
> - Phase 1 相关测试文件。
>
> 本次只验收 Phase 1，不实现或修改 Phase 2 / Phase 3。不要为了让测试通过而擅自改变产品规则。
>
> 如果本地数据库中有施工前的测试旅行数据，可直接清空 / 删除测试数据库后重新创建；本次**不验收旧旅行迁移或旧 Revision 兼容**。
>
> 运行：
>
> ```bash
> npm run typecheck
> npx vitest run --config vitest.config.ts apps/server/final-route-v3.test.ts apps/server/final-route-plan-commands-v3.test.ts apps/server/travel-store-final-route-v3.test.ts apps/server/day-route-v2.test.ts apps/server/plan-route-order-v2.test.ts
> npm test
> npm run build
> ```
>
> 独立重点检查：
>
> 1. 完全空白的新建计划允许内部 `finalRoute.version = 0` 启动占位，但该占位不能含 Place、Candidate、Day 或线路节点；第一次进入 Store / 最终线路逻辑后应提升为 `version = 1`。
> 2. 任何含实际旅行内容却仍是旧格式 / `version = 0` 的计划必须直接报 `OLD_TEST_PLAN_UNSUPPORTED`，不能从 Candidate / Day 猜测、迁移或补出最终线路。
> 3. 代码中不应继续存在旧 Candidate / Day → 最终线路的内容转换函数；Store 里暂时保留的旧函数名调用只能作为现有调用点适配，实际实现不得迁移旧内容。
> 4. 同一个 Place 可以有多个独立线路节点。
> 5. normal / tentative / no_go：inactive 节点保留顺序和 `endsDay`，但退出当前 Day；恢复 normal 后原分界恢复。
> 6. `A —drive→ X —walk→ B` 中 X 退出当前线路后，A→B 使用 B 自己保存的 walk。
> 7. “不住”只取消分界；“多一晚”只新增同 Place 节点和同地点→同地点 Day，不能移动其他节点。
> 8. 最后一个 normal 节点没有 `endsDay=true` 仍能形成合法最后一天；Day 编号和日期连续重算。
> 9. Store 保存时必须根据最终线路重建 Day，不能信任调用方单独修改后的 `days[]`。
> 10. Route fingerprint 和实际线路输入必须包含 Day 终点自己的到达交通方式。
> 11. 新结构自己的 Revision / restore / generation / Proposal 冲突保护仍然有效；不要求旧 Revision 恢复。
> 12. 重复线路节点 ID、未知 Place 引用继续拒绝。
> 13. Provider 事实边界不变：AI / 计划数据不能伪造真实坐标、距离、时长或 geometry。
>
> 如果发现问题，不要直接替施工 Agent 修代码。请给出文件、复现条件、实际结果、预期结果和原因判断。
>
> 最终固定输出：
>
> ```text
> Test Branch: ...
> Test HEAD: ...
> Phase 1: PASS / FAIL
>
> 实际执行的测试：
> - ...
>
> 发现的问题：
> 1. [Blocker / High / Medium / Low] ...
>    - 文件：
>    - 复现：
>    - 实际：
>    - 预期：
>    - 原因判断：
>
> 未覆盖或无法验证：
> - ...
>
> 是否建议进入 Phase 2：是 / 否
> 原因：...
> ```

---

# Phase 2：右侧最终线路人工规划闭环 + 地图联动

## 目标

用户不依赖 AI，也能只在右侧完成整趟最终线路的人工规划，并立即看到 Day、地图和交通路线变化。

## 主要修改

1. 导航收敛为：
   - 规划：旅行需求
   - 行程：最终线路
2. 新建统一最终线路面板。
3. 支持新增、编辑、删除、拖动、状态、住 / 不住 / 多一晚、交通、定位修复。
4. Day 由线路分界直接展示。
5. 地图显示全部三种状态，路线只连接 normal。
6. 右侧是唯一业务修改入口。
7. 旧 Step 2 / 3 / 4 / 5 不再作为正常用户入口。
8. 旅行合理性问题只提示，不自动修改用户方案。

## 代码施工完成条件

人工规划闭环完整，并且正常用户流程中不再出现第二套线路编辑入口。

完成后进入 `awaiting_local_test`，生成绑定 Branch + HEAD 的本地 UI 测试 Prompt。

---

# Phase 3：AI 生成 / 局部补充 / 显式优化 + 旧流程清理

## 目标

把主要地点生成、详细地点生成和显式优化全部直接接到最终线路，完成 PLAN 的完整目标。

## 主要修改

1. 生成主要地点直接进入最终线路，不默认每个地点住一晚。
2. 生成详细地点直接插入最终线路，不再二次安排进 Day。
3. 支持按 Day / 区间 / 住宿点附近局部生成。
4. 普通生成只能插入，不能重排已有节点。
5. 显式优化才允许在授权范围重排。
6. 重构 Action / Scope / Prompt。
7. Proposal / Revision / Undo 覆盖最终线路操作。
8. 删除或隔离 Skeleton / stayDays / Candidate→DayStop 等已无产品职责的入口。
9. 根据最终代码更新 PRODUCT / TECHNICAL。

## 代码施工完成条件

PLAN 中完整新用户流程落地，旧五步不再承担用户线路职责。

完成后进入 `awaiting_local_test`，生成绑定 Branch + HEAD 的最终端到端验收 Prompt。

---

# 6. 高风险点

1. 最终线路与 Day 不能重新变成两份可编辑数据。
2. normal / tentative / no_go 切换不能破坏排序和保存的住宿分界。
3. “多一晚”不能偷偷移动已有地点。
4. 生成与优化权限必须严格分开。
5. 局部生成 / 优化不得越界。
6. Provider 的坐标、距离、时长和 geometry 不得由 AI 伪造。

---

# 7. 施工原则

- 只做 PLAN 需要的修改。
- 不为当前测试数据保留迁移和兼容代码。
- 用户是旅行方案最终决策者。
- 旅行合理性问题只提醒。
- 每完成一个 Phase 立即更新 Progress。
- 施工 Agent 不运行任何测试。
- 用户本地 PASS 前不进入下一 Phase。
