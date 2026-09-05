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
- 不做旧 Candidate / Day → 最终线路的数据迁移；
- 不做旧 Revision 恢复兼容；
- 不因为旧数据库保留兼容分支；
- 必要时直接删除 / 清空本地测试数据库重新创建旅行。

新结构自己的 Revision / Undo / generation / CAS 继续保留并必须正常工作。

这里要区分两件事：

### 不允许：旧数据迁移

已经保存到数据库中的旧格式旅行，如果没有新的最终线路结构，直接拒绝读取；不根据旧 Candidate、旧 Day 或旧 Revision 猜出一条新线路。

### Phase 1 临时允许：当前代码入口的写入翻译

Phase 2 / Phase 3 尚未移除旧 Skeleton、旧 Day 编辑和旧详细行程 Action。为了让当前程序在施工中间态仍然可运行，这些**当前代码入口产生的新写入**可以在 Store 保存边界被翻译成最终线路节点，然后立即重新生成 Day。

这不是旧数据迁移，因为：

- 输入来自当前运行中的一次新操作；
- 最终保存的仍然只有最终线路；
- `days[]` 不会成为第二份独立线路；
- 已经落盘的旧旅行仍然直接拒绝；
- Phase 2 / Phase 3 移除旧入口后，这层临时翻译应继续缩小或删除。

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

不承担旧旅行数据迁移职责，同时保证 Phase 2 / 3 尚未拆除的当前旧入口不会把 Day 再保存成另一份线路。

## 修改范围

- 最终线路数据结构
- TravelPlanDocument
- Day 自动生成
- Route 输入 / dirty 判断
- PlanCommand / Revision 基础
- Store 写入边界
- 当前 Skeleton / Day / detail 写入的临时翻译
- 并发冲突识别
- 本地测试用例

## 主要修改

1. 现有 `emptyTravelPlan()` 的 `finalRoute.version = 0` 只允许作为完全空白启动占位。
2. 完全空白占位第一次进入 Store / 最终线路逻辑后立即提升为 `version = 1`。
3. 已经落盘且含实际旅行内容的旧格式计划直接报 `OLD_TEST_PLAN_UNSUPPORTED`，不迁移。
4. 同一 Place 可被多个线路节点引用。
5. 支持新增、移除、拖动、三状态、住 / 不住、多一晚、修改交通方式。
6. Day 始终根据最终线路重新生成。
7. 最终线路明确变化时，即使调用方同时提交了过期 `days[]`，也以最终线路为准重新生成 Day。
8. Phase 1 过渡期，如果当前旧代码只修改了 Day / Skeleton / detailed Day、没有直接修改最终线路，Store 在保存前把该 Day 视图翻译成最终线路节点，再重新生成 Day。
9. 上述临时翻译需要保留：
   - Day 顺序；
   - Day 起点 / 终点；
   - `stayBlockId` 等仍被当前旧运行时读取的过渡信息；
   - 当前详细行程的时间、活动、备注等信息；
   - 到达第一站 / 终点的交通方式；
   - 已经存在的 tentative / no_go 节点及其原排序。
10. 临时翻译不能读取数据库中的旧格式旅行来做迁移。
11. Route 能正确读取 Day 终点的到达交通方式。
12. 最终线路变化参与 generation / Revision / Proposal 冲突判断。
13. Revision / restore 只保证新结构。

## 第一次本地验收结果

测试基线：

```text
Test Branch: test/plan-phase1-final-route-20260905
Test HEAD: b751f0dff0c475419c54bf657a8cc541343443ac
```

用户本地测试结果：`FAIL`。

已通过：

- typecheck；
- Phase 1 专项测试 22/22；
- 用户独立补充测试 9/9；
- build。

失败：

- 完整 `npm test` 有 7 个测试文件、21 个测试失败。

共同根因：

> Phase 1 已经要求 Store 只从最终线路生成 Day，但 Phase 2 / 3 尚未拆除的当前 Skeleton、DayStop 和运行时 Action 仍然会先生成 / 修改 `days[]`。这些写入进入 Store 后被当成无效派生数据丢弃，导致当前程序中间态和旧回归测试一起失效。

本轮修复没有恢复旧数据迁移，而是在 Store 保存边界增加“当前 Day 视图 → 最终线路 → Day”的临时翻译。

## Phase 1 代码施工完成条件

- 完全空白的 `version = 0` 只作为启动占位；
- 已落盘的非空旧格式旅行直接拒绝；
- Day 能由最终线路稳定得到；
- 状态、住宿分界、多一晚、交通、拖动和删除都有确定性底层操作；
- 最终线路显式修改永远优先于同时提交的 `days[]`；
- 当前旧 Skeleton / Day / detail 入口的新操作能够被翻译成最终线路后保存，不产生第二份线路；
- inactive 节点不会在翻译过程中丢失；
- 新结构 Revision / restore 保持可用；
- Route 终点交通继续可用；
- 完整仓库回归由用户本地验证。

## 本地测试要求

用户本地 Codex 至少运行：

```text
npm run typecheck
npm test
npm run build
```

并重点复测第一次失败的 7 个文件：

```text
apps/server/core-promotion-v3.test.ts
apps/server/planner-runtime-v3.test.ts
apps/server/interest-discovery-v3.test.ts
apps/server/planner-runtime-v3-detail-unavailable-phase5.test.ts
apps/server/skeleton-edit-api-v3.test.ts
apps/server/planner-runtime-v3-ai-actions.test.ts
apps/server/planner-runtime-v3-detail-phase5.test.ts
```

还要验证：

- 已落盘旧格式计划仍然拒绝，不因这次修复重新获得迁移能力；
- 当前旧 Skeleton / Day / detailed Day 新写入可以转成最终线路；
- 保存完成后再人为修改一份独立 `days[]`，最终线路显式修改时 Day 仍必须从最终线路重建；
- tentative / no_go 节点在旧 Day 视图更新时不会被删除；
- 第一天起点不等于 `trip.originPlaceId` 时不会丢失；
- planned Day 不会因为过渡 Stop 的占位 activity 自动被误判为 detailed；
- 旧 detail/refine 对时间、period、备注等显式修改可以进入线路节点；
- Day transferMode 能落实到对应到达节点；
- 新结构 Revision / Proposal / generation 冲突保护仍有效。

## 本阶段 Codex 本地测试 Prompt

> 本节中的最终 `Test Branch` / `Test HEAD` 会在本轮 R2 代码冻结后记录到 `PLAN_PROGRESS.md`，并由施工 Agent 在交付给用户的测试 Prompt 顶部明确给出。测试时以交付 Prompt 顶部的精确值为准。
>
> 你是独立测试 Agent。不要相信施工 Agent 的完成声明。
>
> 第一步只能执行：
>
> ```bash
> git branch --show-current
> git rev-parse HEAD
> git status --short
> ```
>
> Branch / HEAD 与交付 Prompt 不一致时立即输出 `TEST_BASE_MISMATCH`，不要自行切分支、pull、merge、rebase、reset 或 cherry-pick。
>
> 工作树存在影响待测代码的修改时输出 `TEST_WORKTREE_DIRTY`。
>
> 基线正确后阅读 `PLAN.md`、`PLAN_EXECUTION.md`、`PLAN_PROGRESS.md` 和 Phase 1 相关代码。
>
> 执行 typecheck、Phase 1 专项测试、第一次失败的 7 个测试文件、完整 `npm test`、build。
>
> 不测试旧旅行迁移；但是必须确认已落盘旧格式旅行仍然失败关闭。
>
> 重点独立验证“当前旧入口的新写入翻译”和“旧数据库迁移”没有混成一件事：前者当前允许，后者明确禁止。
>
> 最终输出 Branch、HEAD、PASS / FAIL、实际执行测试、问题严重程度和是否建议进入 Phase 2。

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
9. 删除 Phase 1 为当前旧入口保留的 Day 视图临时翻译层中已经不再需要的分支。
10. 根据最终代码更新 PRODUCT / TECHNICAL。

## 代码施工完成条件

PLAN 中完整新用户流程落地，旧五步不再承担用户线路职责。

完成后进入 `awaiting_local_test`，生成绑定 Branch + HEAD 的最终端到端验收 Prompt。

---

# 6. 高风险点

1. 最终线路与 Day 不能重新变成两份可编辑数据。
2. 临时 Day 写入翻译不能演变成旧数据库迁移。
3. normal / tentative / no_go 切换不能破坏排序和保存的住宿分界。
4. “多一晚”不能偷偷移动已有地点。
5. 生成与优化权限必须严格分开。
6. 局部生成 / 优化不得越界。
7. Provider 的坐标、距离、时长和 geometry 不得由 AI 伪造。

---

# 7. 施工原则

- 只做 PLAN 需要的修改。
- 不为当前旧测试数据库保留迁移代码。
- 施工中间态允许最小写入翻译，但最终保存的数据必须仍然只有最终线路一份。
- 用户是旅行方案最终决策者。
- 旅行合理性问题只提醒。
- 每完成一个 Phase 立即更新 Progress。
- 施工 Agent 不运行任何测试。
- 用户本地 PASS 前不进入下一 Phase。
