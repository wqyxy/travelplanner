# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)  
> 施工规则：[`PLAN_IMPLEMENTATION_PROMPT.md`](./PLAN_IMPLEMENTATION_PROMPT.md)  
> 当前产品：[`PRODUCT.md`](./PRODUCT.md)  
> 当前技术：[`TECHNICAL.md`](./TECHNICAL.md)  
> 施工进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 最终目标

把当前五步流程收敛成两个核心工作区：

```text
规划：旅行需求
行程：最终线路
```

用户只维护一份最终线路。

```text
填写旅行需求
→ AI / 用户把主要地点加入最终线路
→ 用户排序、待定、不去、住 / 不住 / 多一晚、设置交通
→ AI / 用户继续把详细地点插入最终线路
→ Day、地图和交通路线自动变化
→ 只有显式“优化”才允许 AI 重排已有节点
```

---

# 2. 已确认的数据与交互规则

## 最终线路

每个线路节点表示某个 Place 在线路中的一次出现。同一 Place 可以出现多次，每次有独立节点 ID。

节点核心字段：

```text
id
placeId
status: normal / tentative / no_go
endsDay
transportFromPrevious
```

活动、时间、费用、备注等详细信息也可以保存在节点上。

## 状态

`tentative / no_go`：

- 保留原顺序；
- 保留地图展示；
- 保存的 `endsDay` 不删除；
- 暂时不参与有效 Day 和交通路线；
- 恢复 normal 后原位置和住宿分界恢复。

## 交通

交通属于“到达当前节点”。

```text
A —drive→ X —walk→ B
```

X 不参与当前线路时：

```text
A —walk→ B
```

## 住 / 不住 / 多一晚

- 住：当前 normal 节点 `endsDay=true`。
- 不住：只取消分界，不删除、不移动地点。
- 多一晚：在当前节点后新增一个引用同 Place 的 normal 节点并形成新的日界线。

## Day

Day 不作为第二份线路维护。

```text
旅行起点
+ normal 最终线路节点
+ 当前生效的 endsDay
→ 自动得到 Day
```

最后一个 normal 节点即使 `endsDay=false`，也必须形成合法最后一天。

## AI 权限

普通“生成”只能新增 / 插入节点，不能偷偷重排、删除或改变用户已有节点。

只有用户明确触发“优化一天 / 一段 / 全程”时，AI 才能在授权范围重排。

## 入口

```text
地图 = 展示 / 选择 / 定位辅助
右侧 = 唯一业务修改入口
```

---

# 3. 数据策略

当前数据库和旅行内容全部视为测试数据，可以从头开始。

因此：

- 不迁移旧旅行 JSON；
- 不从旧 Candidate / Day 推断最终线路；
- 不兼容施工前旧 Revision；
- 旧测试数据库必要时直接删除 / 清空；
- 新结构自己的 Revision / Undo / generation / CAS 必须继续工作。

已经落盘的非空旧格式计划直接拒绝，例如：

```text
OLD_TEST_PLAN_UNSUPPORTED
```

## Phase 1 施工中间态例外

Phase 2 / 3 还没拆除 Skeleton、Day、Detailed Day 等旧代码入口。

所以 Phase 1 临时允许：

```text
当前运行中的新 Day 写入
→ Store 边界翻译成最终线路节点
→ 再从最终线路生成 Day
```

这只保证当前代码在施工中间态能运行，**不用于迁移数据库中的旧旅行**。

Phase 2 / 3 完成后应删除或显著缩小这层翻译。

---

# 4. 测试规则

施工 Agent：

- 不运行测试；
- 不运行 typecheck；
- 不运行 build；
- 不启动应用验证；
- 不使用 GitHub CI / Actions 做验收。

每个 Phase：

1. 完成代码；
2. 只做静态 Review；
3. 更新 Progress 为 `awaiting_local_test`；
4. 冻结唯一 Test Branch + 40 位 Test HEAD；
5. 保存并输出本地 Codex 测试 Prompt；
6. 停止施工；
7. 等用户返回匹配 Branch + HEAD 的 PASS / FAIL。

PASS 只对指定 Branch + HEAD 有效。

---

# 5. 实施阶段

# Phase 1：最终线路底层与自动 Day / Route 基础

状态：`awaiting_local_test`

## 目标

让底层真正以最终线路为中心，同时在 Phase 2 / 3 尚未完成时保证当前旧入口的新操作仍能安全落到最终线路。

## 已实施

1. 最终线路节点模型和三状态。
2. 同一 Place 多节点。
3. 住 / 不住 / 多一晚。
4. 节点拖动、删除、交通修改。
5. 最终线路 → Day 自动推导。
6. Day Number / 日期随线路重算。
7. Day 终点到达交通进入 Route 输入和 dirty 判断。
8. 最终线路变化进入 Revision / generation / Proposal 冲突识别。
9. 已落盘旧格式旅行直接拒绝，不迁移。
10. 完全空白 `version=0` 只作为启动占位，不能携带实际规划内容。
11. Store 明确最终线路变化时，独立提交的 `days[]` 不能覆盖最终线路。
12. Phase 1 当前写入桥：旧 Skeleton / Day / detail 新操作可先形成 Day 视图，再翻译为最终线路并重新生成 Day。

## R1 验收

```text
Branch: test/plan-phase1-final-route-20260905
HEAD: b751f0dff0c475419c54bf657a8cc541343443ac
```

结果：FAIL。完整测试有 21 个失败，集中在旧 Skeleton / Day / detail 当前生产路径。

## R2 验收

```text
Branch: test/plan-phase1-final-route-20260905-r2
HEAD: 5adec91f04d6c74614464f38516626bd15fcc45c
```

结果：FAIL，但已收敛到 2 个问题：

- 80 / 82 test files passed；
- 475 / 477 tests passed；
- typecheck PASS；
- build PASS。

剩余问题：

1. start / end Anchor 都为 null 的 Stop-only Day 无法保存。
2. Detailed Update 的 null transport 会误清首站承载的 Day 到达交通。

## R3 修复

### Stop-only Day

当前 Day 如果没有独立 Anchor，但 Stops 已经构成路线：

```text
A → B
```

允许保存。

内部推断：

```text
有效 start = startAnchor ?? first Stop ?? endAnchor
有效 end   = endAnchor ?? last Stop ?? startAnchor
```

内部仍保留独立 Day boundary route node，因此最后一个 Stop 不会因为承担日界线而消失。

如果源 Day 的 Anchor 是 null，派生 Day 保持 null 视图。

特别规则：源 Day 的 startAnchor 为 null 时，第一个 Stop 不能被“与起点重复”逻辑删除。

### Detailed 到达交通

如果：

```text
Day.transferMode = rail
首个现有 Stop.transportFromPrevious = rail
```

而旧 Detailed draft 返回：

```text
transportFromPrevious = null
```

Phase 1 过渡期解释为“不改变由 Day 落到首站的到达交通”，保留 rail，不生成多余清空命令。

新的非空交通仍正常覆盖；其他 Stop 不套用这个特殊 sticky 规则。

### 新增回归测试代码

```text
apps/server/final-route-phase1-r3-regression.test.ts
```

覆盖：

- null Anchor 的 A/B Stop-only Day 保存后仍有 A/B；追加 C 后为 A/B/C；
- Detailed null transport 不清除首站承载的 Day 到达交通。

## Phase 1 完成 Gate

必须由用户本地确认：

- typecheck PASS；
- Phase 1 专项 PASS；
- R3 新回归 PASS；
- R2 两个失败文件 PASS；
- 历史 7 个失败文件 PASS；
- 完整 `npm test` PASS；
- build PASS；
- 独立检查没有发现最终线路 / Day 双份线路问题。

## Phase 1 R3 Codex 本地测试 Prompt

```text
Test Branch: __R3_TEST_BRANCH__
Test HEAD: __R3_TEST_HEAD__

你是独立测试 Agent。不要相信施工 Agent 的完成声明，只根据指定 Git 基线、实际代码和本地执行结果判断 Phase 1。

本次只验收 Phase 1 R3，不施工 Phase 2 / Phase 3，也不要直接替施工 Agent 修改生产代码。

第一步只能执行：

git branch --show-current
git rev-parse HEAD
git status --short

必须严格匹配本 Prompt 顶部 Test Branch / Test HEAD，且工作树没有影响待测代码的修改。

Branch 或 HEAD 不一致：立即停止，输出 TEST_BASE_MISMATCH。
不要自行 checkout、switch、pull、merge、rebase、reset、cherry-pick。

工作树有影响生产代码的修改：立即停止，输出 TEST_WORKTREE_DIRTY。

基线正确后阅读：
- docs/PLAN.md
- docs/PLAN_EXECUTION.md
- docs/PLAN_PROGRESS.md
- apps/server/final-route-v3.ts
- apps/server/detail-itinerary-v3.ts
- apps/server/travel-store-v3.ts
- apps/server/plan-commands-v2.ts
- apps/server/day-route-v2.ts
- apps/server/final-route-phase1-r3-regression.test.ts

数据原则：
- 不测试施工前旧旅行迁移；
- 已经落盘的非空旧格式旅行必须继续拒绝；
- Phase 1 当前 Day 写入翻译只针对当前新操作。

依次执行：

npm run typecheck

npx vitest run --config vitest.config.ts \
  apps/server/final-route-v3.test.ts \
  apps/server/final-route-plan-commands-v3.test.ts \
  apps/server/travel-store-final-route-v3.test.ts \
  apps/server/day-route-v2.test.ts \
  apps/server/plan-route-order-v2.test.ts \
  apps/server/final-route-phase1-r3-regression.test.ts

专门重跑 R2 最后两个失败文件：

npx vitest run --config vitest.config.ts \
  apps/server/planner-runtime-v3.test.ts \
  apps/server/planner-runtime-v3-detail-phase5.test.ts

再重跑历史 7 个失败文件：

npx vitest run --config vitest.config.ts \
  apps/server/core-promotion-v3.test.ts \
  apps/server/planner-runtime-v3.test.ts \
  apps/server/interest-discovery-v3.test.ts \
  apps/server/planner-runtime-v3-detail-unavailable-phase5.test.ts \
  apps/server/skeleton-edit-api-v3.test.ts \
  apps/server/planner-runtime-v3-ai-actions.test.ts \
  apps/server/planner-runtime-v3-detail-phase5.test.ts

完整回归：

npm test

生产构建：

npm run build

独立检查：

1. Stop-only Day：startAnchor=null、endAnchor=null、Stops=A/B 可以保存；最终线路中 A/B 都存在；派生 Day 仍有 A/B；追加 C 后严格是 A/B/C。
2. Stop-only Day 的内部日界线不得吞掉最后一个 Stop，也不得为了内部表示把 null Anchor 强行暴露成非 null。
3. Detailed sticky：Day.transferMode=rail 且首 Stop 已承载 rail，Detailed draft 返回 transportFromPrevious=null 时不能生成 rail 清空命令，保存后 rail 仍存在。
4. 新的非空 transport 仍能正常修改交通；sticky 规则不能扩散到普通后续 Stop。
5. 最终线路显式修改必须永远优先于同时提交的独立 days[]。
6. tentative / no_go 节点在 Day 视图更新时不能丢失，保存的 endsDay 仍在，恢复 normal 后重新生效。
7. A —drive→ X —walk→ B 中 X inactive 后 A→B 使用 B 的 walk；恢复 X 后两段恢复。
8. 不住只取消分界；多一晚只新增同 Place 节点；最后一天 endsDay=false 仍合法。
9. Day Number / 日期连续重算。
10. Route 终点到达交通仍参与 fingerprint 和实际 leg。
11. 新结构 Revision / restore / generation / Proposal 冲突保护正常。
12. 已落盘旧格式 JSON 仍报 OLD_TEST_PLAN_UNSUPPORTED，不能因为当前写入桥重新获得迁移能力。
13. Provider 事实边界不变：不能伪造真实坐标、距离、时长、geometry。

如果任何测试失败，不要直接修改生产代码。报告：文件、位置/逻辑、复现、实际、预期、原因判断。

最终固定输出：

Test Branch: ...
Test HEAD: ...

Phase 1: PASS / FAIL

实际执行的测试：
- git branch --show-current: ...
- git rev-parse HEAD: ...
- git status --short: ...
- npm run typecheck: PASS / FAIL
- Phase 1 + R3 专项: PASS / FAIL
- R2 两个失败文件: PASS / FAIL
- 历史 7 个失败文件: PASS / FAIL
- npm test: PASS / FAIL
- npm run build: PASS / FAIL

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

是否建议进入 Phase 2：是 / 否
原因：...
```

---

# Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：`pending`

只有 Phase 1 R3 对指定 Branch + HEAD 本地 PASS 后开始。

## 主要工作

1. 导航收敛为“规划：旅行需求 / 行程：最终线路”。
2. 右侧建立唯一最终线路业务操作面板。
3. 支持新增、编辑、删除、拖动、三状态、住 / 不住 / 多一晚、交通、定位修复。
4. Day 由线路分界展示。
5. 地图显示全部状态，路线只连接 normal。
6. 旧 Step 2 / 3 / 4 / 5 不再作为正常业务入口。
7. 合理性问题只提醒，不自动修改用户方案。

完成后进入 `awaiting_local_test`，冻结 Phase 2 Branch + HEAD。

---

# Phase 3：AI 生成 / 局部补充 / 显式优化 + 旧流程清理

状态：`pending`

只有 Phase 2 本地 PASS 后开始。

## 主要工作

1. 主要地点生成直接加入最终线路。
2. 详细地点生成直接插入最终线路，不再二次安排到独立 Day。
3. 支持按 Day / 区间 / 住宿点附近局部补充。
4. 普通生成只能插入，不重排已有节点。
5. 显式优化才允许在授权范围重排。
6. 重构 Action / Scope / Prompt。
7. Proposal / Revision / Undo 覆盖最终线路操作。
8. 删除 / 隔离 Skeleton、stayDays、Candidate→DayStop 等旧线路职责。
9. 删除或显著缩小 Phase 1 当前 Day 写入翻译层。
10. 根据最终代码更新 PRODUCT / TECHNICAL。

---

# 6. 高风险点

- 最终线路和 Day 不能再次变成两份可独立编辑的数据。
- tentative / no_go 不能破坏排序和保存的住宿分界。
- 多一晚不能偷偷移动其他地点。
- 生成与优化权限必须严格分开。
- 局部生成 / 优化不得越界。
- Provider 的真实事实不得由 AI 伪造。

---

# 7. 施工原则

- 只做 PLAN 需要的修改。
- 不为旧测试数据增加迁移代码。
- 用户是旅行方案的唯一决策者，AI 只是辅助。
- 不完整 / 有冲突 / 暂未定位的方案允许保存，非数据破坏问题只提醒。
- 每完成一个 Phase 立即更新 Progress。
- 施工 Agent 不运行测试。
- 用户本地 PASS 前不进入下一 Phase。
