# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 1 — 最终线路底层与自动 Day / Route 基础  
总体状态：awaiting_local_test  
最后更新时间：2026-09-05

---

## 已确认的产品决定

- 用户只维护一份最终线路。
- 同一现实地点可以在线路中出现多次，每次拥有独立线路节点 ID。
- 节点状态为 normal / tentative / no_go。
- tentative / no_go 保留顺序和保存的住宿分界，但退出当前有效 Day 和交通路线；恢复 normal 后重新生效。
- 交通方式属于“到达当前节点”。
- 不住只取消日程分界。
- 多一晚新增同 Place 的线路节点，不移动其他地点。
- Day 根据最终线路自动生成，最后一天允许没有住宿分界。
- 普通 AI 生成只能插入新地点；只有显式优化才能重排已有地点。
- 地图显示全部状态，交通路线只使用 normal。
- 业务修改入口最终统一在右侧。
- Provider 坐标、真实距离、时长和 geometry 的事实边界继续保留。

---

## 数据策略

用户已确认当前全部旅行数据都是测试数据，可以从头开始。

因此：

- 不迁移已经落盘的旧旅行 JSON；
- 不从旧 Candidate / Day 猜测最终线路；
- 不兼容施工前旧 Revision；
- 旧本地数据库可以直接清空 / 删除后重建；
- Revision / Undo 只保证新结构。

Phase 2 / 3 尚未拆掉旧 Skeleton、Day 和 detailed itinerary 入口。Phase 1 只保留一个施工中间态的**当前写入翻译层**：

```text
当前代码入口产生新的 Day 视图
→ Store 保存边界翻译成最终线路节点
→ 再由最终线路生成 Day
→ 数据库最终只有一份线路
```

这层逻辑不能用于读取或迁移已经落盘的旧格式旅行。

---

## 测试规则

- 施工 Agent 不运行测试、typecheck、build、应用启动或 CI。
- 每个 Phase 由用户本地 Codex 独立验证。
- 测试必须绑定唯一 `Test Branch + Test HEAD`。
- Branch / HEAD 不一致或工作树影响待测代码时不能给 PASS。
- 任意业务代码新提交都会使旧 PASS / FAIL 基线失效。
- 用户未返回匹配基线的 PASS 前，不进入下一 Phase。

---

# Phase 1：最终线路底层与自动 Day / Route 基础

状态：awaiting_local_test

## 已完成能力

- 最终线路节点、三状态、住宿分界、到达交通字段。
- 同一 Place 多线路节点。
- 最终线路 → Day 自动生成。
- 新增 / 删除 / 拖动 / 状态 / 住 / 不住 / 多一晚 / 交通修改。
- 最终线路变化进入 generation / Revision / Proposal 冲突判断。
- Route 能读取 Day 终点的到达交通方式。
- 完全空白 `finalRoute.version = 0` 只作为启动占位，进入最终线路逻辑后提升到 version 1。
- 已经落盘的非空旧格式旅行直接报 `OLD_TEST_PLAN_UNSUPPORTED`，不迁移。

## 第一次本地验收

```text
Test Branch: test/plan-phase1-final-route-20260905
Test HEAD: b751f0dff0c475419c54bf657a8cc541343443ac
```

结果：**FAIL**

- typecheck：PASS
- Phase 1 专项：22/22 PASS
- 独立补充：9/9 PASS
- build：PASS
- 完整 npm test：452 passed / 21 failed
- 7 个测试文件失败

根因：当前旧 Skeleton / Day / detail 生产路径仍只修改 `days[]`，而 Store 已经只从最终线路生成 Day。

## R1 → R2 修复

增加施工中间态的当前写入翻译：

- 最终线路显式变化时，最终线路优先，独立 Day 修改不能覆盖它。
- 最终线路未变化、当前旧入口修改 Day 时，保存前把 Day 视图翻译成最终线路节点，再重建 Day。
- 已落盘旧格式数据仍然直接拒绝。
- 保留当前运行需要的 Day 起终点、顺序、`stayBlockId`、详细活动 / 时间 / 备注、第一天起点、交通及 inactive 节点。

## R2 本地验收

```text
Test Branch: test/plan-phase1-final-route-20260905-r2
Test HEAD: 5adec91f04d6c74614464f38516626bd15fcc45c
```

结果：**FAIL**

实际：

- typecheck：PASS
- Phase 1 专项：26/26 PASS
- 第一次失败的 7 个文件：48/50 PASS
- 完整 npm test：80 files passed / 2 failed / 82 total
- 完整 npm test：475 tests passed / 2 failed / 477 total
- build：PASS
- 独立审计：6/6 PASS

剩余 2 个 High 问题：

1. Stop-only Day 的 start / end Anchor 都为 null 时，即使 Stops 已经构成 A → B，写入桥接仍要求独立终点，因此保存失败。
2. Day 的 `transferMode=rail` 被桥接落实到首个 Stop 后，Detailed Update 返回 `transportFromPrevious=null` 会把这段 Day 到达交通误认为应清空，产生额外命令并可能丢失 rail。

## R2 → R3 修复

已静态完成以下修改，尚未由用户本地测试：

### 1. Stop-only Day

- 新增 Day 有效起点 / 终点推断：
  - startAnchor 优先；为空时取首个 Stop；再退到 endAnchor。
  - endAnchor 优先；为空时取最后一个 Stop；再退到 startAnchor。
- null Anchor 的 Day 不再因为缺少独立终点而拒绝保存。
- 内部仍使用独立 Day boundary route node 进行分 Day，因此最后一个 Stop 不会被吞掉。
- 如果原 Day 的 start / end Anchor 为 null，重新派生后继续保留 null 视图。
- 修正一个静态 Review 发现的边界：source Day 的 startAnchor 为 null 时，不能把首个 Stop 当成“与起点重复”而删除。
- 目标行为：A、B 两个 Stops 可以保存，之后追加 C，仍得到 A、B、C。

### 2. Detailed 到达交通 sticky

- 如果首个已有 Stop 正在承载 Day 的到达交通，例如 `transferMode=rail` 且首 Stop 的 transport 也是 rail：
  - Detailed draft 返回 `transportFromPrevious=null` 时视为“不改变这段 Day 到达交通”；
  - 保留原 rail；
  - 不生成无意义的 transport 清空命令。
- 非首站交通和新的非空交通仍按原合同处理。
- 这是 Phase 1 过渡桥接语义；Phase 2 / 3 最终由线路节点直接管理交通。

### 3. R3 回归测试代码

新增：

```text
apps/server/final-route-phase1-r3-regression.test.ts
```

静态覆盖：

- null Anchor Stop-only Day 保存 A/B，再追加 C；
- Detailed Update 不清空首站承载的 Day 到达交通。

## R3 本地测试基线

状态：尚未由用户本地验证。

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
```

该测试分支已经冻结，不再修改。冻结后的 `main` 只允许更新本阶段测试基线文档元数据，不得改变 R3 待测业务代码。

## 当前 blocker

唯一 blocker：**R3 尚未由用户本地完整回归确认 PASS。**

Phase 2 尚未开始。

---

# Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：pending

只有 Phase 1 对指定 R3 Branch + HEAD 本地测试 PASS 后才开始。

---

# Phase 3：AI 生成 / 局部补充 / 显式优化 + 旧流程清理

状态：pending

只有 Phase 2 本地测试 PASS 后才开始。

Phase 3 需要删除或显著缩小 Phase 1 为旧 Skeleton / Day / detail 入口保留的当前写入翻译层。

---

## 当前已知中间态

- UI 仍是旧五步：Phase 2 处理。
- AI Action / Scope 仍主要按 Candidate / Day 组织：Phase 3 处理。
- Day 视图写入翻译只是施工中间态，不是最终产品 API。
- 本地旧测试数据库如果含旧计划 JSON，直接清空重建。

---

## 下一步

1. 用户在 R3 Test Branch + Test HEAD 上运行本地 Codex 验收；
2. PASS：Phase 1 → completed，Phase 2 → in_progress；
3. FAIL：只修报告中的 Phase 1 问题，生成新的冻结基线。
