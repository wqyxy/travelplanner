# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 1 — 最终线路底层与自动 Day / Route 基础  
总体状态：awaiting_local_test  
最后更新时间：2026-09-05

---

## 已确认的产品决定

- 用户只维护一份最终线路。
- 同一现实地点可以在线路中出现多次，每次拥有独立线路节点 ID。
- 状态为正常 / 待定 / 不去。
- 待定 / 不去保留顺序和地图展示，但退出当前 Day 和交通路线。
- 待定 / 不去原有住宿分界保留但暂时失效，恢复 normal 后恢复。
- 交通方式属于“到达当前节点”。
- 不住只取消日程分界。
- 多一晚新增同 Place 的线路节点，不自动搬动景点。
- Day 根据最终线路自动生成，最后一天允许没有住宿。
- 普通 AI 生成只能插入新地点；只有显式优化才能重排已有地点。
- 地图展示全部地点，路线只使用 normal。
- 业务编辑统一在右侧。
- Provider 事实边界继续保留。

---

## 数据策略

用户已确认当前所有旅行数据都是测试数据，可以从头开始。

因此：

- 不迁移已经落盘的旧旅行 JSON；
- 不从旧 Candidate / Day 猜测最终线路；
- 不兼容施工前旧 Revision；
- 旧本地数据库可直接清空 / 删除后重建；
- Revision / Undo 只保证新结构。

Phase 1 施工中间态仍存在旧 Skeleton、Day 和 detailed itinerary 入口。为了不让这些当前入口在 Phase 2 / 3 尚未改造前直接失效，现在只允许一个**当前写入翻译层**：

```text
当前旧入口产生新的 Day 视图
→ Store 保存边界翻译成最终线路节点
→ 再由最终线路生成 Day
→ 数据库最终只保存一份线路
```

这不用于读取或迁移旧数据库。

---

## 测试规则

- 施工 Agent 不运行任何测试、typecheck、build、迁移、应用启动或 CI。
- 每个 Phase 由用户本地 Codex 独立测试。
- 测试必须绑定唯一 `Test Branch + Test HEAD`。
- 用户未返回匹配该 Branch + HEAD 的 PASS 前，不进入下一 Phase。
- 任意业务代码新提交都会使旧测试结果失效。

---

## Phase 1：最终线路底层与自动 Day / Route 基础

状态：awaiting_local_test

### 已完成的底层能力

- 最终线路节点、三状态、住宿分界和节点交通字段。
- 同一 Place 多线路节点。
- 最终线路 → Day 自动生成。
- 住 / 不住 / 多一晚 / 状态 / 拖动 / 删除 / 交通修改。
- Day 终点到达交通可以进入 Route 输入。
- PlanCommand / Revision / generation / Proposal 冲突识别已覆盖最终线路变化。
- 已落盘的非空旧格式计划直接报 `OLD_TEST_PLAN_UNSUPPORTED`，不做迁移。
- 完全空白的 `finalRoute.version = 0` 仅作为启动占位，并会提升为 `version = 1`。

### 第一次本地验收

Test Branch：`test/plan-phase1-final-route-20260905`  
Test HEAD：`b751f0dff0c475419c54bf657a8cc541343443ac`

用户本地结果：**FAIL**。

实际结果：

- typecheck：PASS；
- Phase 1 专项：22/22 PASS；
- 用户独立补充：9/9 PASS；
- build：PASS；
- 完整 `npm test`：FAIL；
- 75 个文件通过、7 个文件失败；
- 452 tests passed、21 tests failed。

失败文件：

```text
apps/server/core-promotion-v3.test.ts
apps/server/planner-runtime-v3.test.ts
apps/server/interest-discovery-v3.test.ts
apps/server/planner-runtime-v3-detail-unavailable-phase5.test.ts
apps/server/skeleton-edit-api-v3.test.ts
apps/server/planner-runtime-v3-ai-actions.test.ts
apps/server/planner-runtime-v3-detail-phase5.test.ts
```

共同根因：

> Store 已经只信最终线路，但当前旧 Skeleton / DayStop / detail Action 仍会在内存里先生成或修改 Day。Phase 2 / 3 尚未拆掉这些生产路径，因此写入时 Day 被丢弃，导致当前程序中间态和完整回归一起失败。

### 第一次 FAIL 后的修复

本轮没有恢复旧数据迁移，而是增加最小的当前写入翻译：

- 如果调用方明确修改了最终线路：最终线路优先，提交的 Day 只作为派生结果丢弃并重建。
- 如果最终线路没有改变、但当前旧入口修改了 Day：保存前把 Day 视图转换为最终线路节点，再重新生成 Day。
- 已经落盘的旧计划仍然直接拒绝，不使用这层翻译。
- 翻译时保留当前运行所需的：
  - Day 起点 / 终点；
  - Day 顺序；
  - `stayBlockId`；
  - 明确的详细活动、时间、period、备注等；
  - 第一天起点；
  - 到达第一站 / 终点的交通；
  - 已存在的 tentative / no_go 节点及顺序。
- planned Day 中只有占位 activity 的 Stop 不会因此被误判成 detailed。
- 新增了针对 Store 写入翻译和 final-route 写入翻译的回归测试代码。

主要修复提交：

```text
3e2ad8e779126a30e34fa2e58454454892284b28
78d8016048ef6c764e2e69bf0b575c626abb262c
de5f61173fa7d84dda8b66e1ad542cd109e5ed82
8b2d251b64c2953c4077881a49e3c657d3a85190
62eaa716df2a77008469bee1f2a2a23faa99fcd0
dd6ed5fc63dd0b553131c7faa2f4422270205082
```

### 当前本地测试状态

第一次测试结果不能用于当前代码，因为修复后 HEAD 已变化。

R2 测试基线正在冻结。冻结完成后只接受新的 Test Branch + Test HEAD 结果。

### 当前 blocker

唯一 blocker：**R2 尚未由用户本地完整回归确认 PASS。**

Phase 2 尚未开始。

---

## Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：pending

只有 Phase 1 对新的指定 Branch + HEAD 本地测试 PASS 后才开始。

---

## Phase 3：AI 生成 / 局部补充 / 显式优化 + 旧流程清理

状态：pending

只有 Phase 2 本地测试 PASS 后才开始。

Phase 3 需要移除 / 缩小 Phase 1 为当前旧入口保留的 Day 视图写入翻译层，因为最终产品不再让旧 Skeleton / DayStop 作为用户线路入口。

---

## 当前已知问题

- 当前 UI 仍是旧五步，这是 Phase 2 的工作。
- 当前 AI Action / Scope 仍主要按 Candidate / Day 组织，这是 Phase 3 的工作。
- 当前 Day 视图写入翻译只是施工中间态兼容当前代码路径，不是最终产品结构。
- 如果本地现有测试库保存的是旧计划 JSON，测试前直接清空 / 删除后重建。

---

## 与原实施方案的变化

原 Phase 1 曾包含旧旅行和旧 Revision 迁移兼容，已根据用户决定删除。

第一次完整回归又证明：完全取消所有旧 Day 写入路径会让 Phase 2 / 3 尚未施工前的当前程序直接失效。因此 Phase 1 新增一个边界明确的临时写入翻译层，只保证**当前新操作**在施工中间态可继续保存成最终线路。

这不改变“最终只保存一份线路”的产品目标，也不恢复旧数据库迁移。

---

## 下一步

1. 冻结 Phase 1 R2 Test Branch + Test HEAD；
2. 用户本地重新执行 typecheck、专项测试、第一次失败的 7 个测试文件、完整 `npm test`、build；
3. 用户返回匹配新 Branch + HEAD 的 PASS / FAIL；
4. PASS 后 Phase 1 才标记 completed 并进入 Phase 2；
5. FAIL 则继续只修复报告中的 Phase 1 问题。
