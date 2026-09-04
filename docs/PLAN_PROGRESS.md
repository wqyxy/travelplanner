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

## 数据策略

用户已确认当前所有旅行数据都是测试数据，可以从头开始。

因此：

- 不迁移旧旅行 JSON；
- 不转换旧 Candidate / Day 到最终线路；
- 不兼容旧 Revision；
- 不维护新旧双写；
- 旧本地数据库可直接清空 / 删除后重建；
- Revision / Undo 只保证新结构的数据。

此前 Phase 1 中为了旧数据兼容加入的逻辑已不再属于目标，需要在本轮 Phase 1 清理。

---

## 测试规则

- 施工 Agent 不运行任何测试、typecheck、build、迁移、应用启动或 CI。
- 每个 Phase 由用户本地 Codex 独立测试。
- 测试必须绑定唯一 `Test Branch + Test HEAD`。
- 用户未返回匹配该 Branch + HEAD 的 PASS 前，不进入下一 Phase。

---

## Phase 1：最终线路底层与自动 Day / Route 基础

状态：awaiting_local_test

### 已完成

- 已增加最终线路节点、三状态、住宿分界和节点交通字段。
- 已支持同一 Place 多线路节点。
- 已有最终线路 → Day 的生成逻辑。
- 已有住 / 不住 / 多一晚 / 状态 / 拖动 / 删除 / 交通修改底层操作。
- Route 已能读取 Day 终点到达交通方式。
- PlanCommand / Revision / generation 基础已接入最终线路变化。
- 用户已取消旧数据兼容要求。

### 本轮已完成调整

- 已删除旧 Candidate / Day → 最终线路的内容转换逻辑。
- 已取消旧 Revision 的兼容要求；Revision / restore 只保证新结构。
- Store 读取非空旧格式计划时直接拒绝，不做迁移。
- Store 保存时直接根据最终线路重建 Day，不信任独立提交的 `days[]`。
- 完全空白的新建计划仍保留一个内部 `finalRoute.version = 0` 启动占位，仅用于兼容现有 `emptyTravelPlan()` 创建路径：
  - 不能包含 Place、Candidate、Day 或线路节点；
  - 第一次进入 Store / 最终线路逻辑时立即提升为 `version = 1`；
  - 一旦含有任何实际规划内容仍为 `version = 0`，直接报 `OLD_TEST_PLAN_UNSUPPORTED`；
  - 不会从 Candidate / Day 猜测或转换线路。
- 已重写 Phase 1 测试目标，不再测试旧数据迁移。
- 已同步实施文档。

### 尚未完成

- 尚未由用户本地测试。
- Phase 1 不能在收到与指定 Branch + HEAD 完全一致的 PASS 之前标记 completed。

### 本地测试

状态：尚未由用户本地验证。

Test Branch：`test/plan-phase1-final-route-20260905`  
Test HEAD：`b751f0dff0c475419c54bf657a8cc541343443ac`

测试分支已冻结，不再修改。`main` 后续只写入测试基线元数据，不改变上述待测提交。

---

## Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：pending

只有 Phase 1 对指定 Branch + HEAD 本地测试 PASS 后才开始。

---

## Phase 3：AI 生成 / 局部补充 / 显式优化 + 旧流程清理

状态：pending

只有 Phase 2 本地测试 PASS 后才开始。

---

## 当前已知问题

- 当前 UI 仍是旧五步，这是 Phase 2 的工作。
- 当前 AI Action / Scope 仍主要按 Candidate / Day 组织，这是 Phase 3 的工作。
- 如果本地现有测试库保存的是旧计划 JSON，测试前直接清空 / 删除后重建。

---

## 与原实施方案的变化

原 Phase 1 曾包含旧旅行和旧 Revision 兼容。

用户已明确取消该要求，因此现在改为：

```text
旧测试数据直接丢弃
→ 新结构从空数据开始
→ 删除迁移 / 转换 / 双写
```

这不是产品目标变化，而是施工范围简化。

技术上暂时保留完全空白的 `version = 0` 启动占位，是为了避免在 Phase 1 扩大到大量无关合同和旧测试夹具修改。它不保存任何旅行内容，也不承担旧数据兼容；因此不构成新旧结构双写。Phase 2 / 3 在更大范围重构创建流程时可再决定是否彻底移除这个内部占位。

---

## 下一步

1. 使用本文件记录的 Test Branch + Test HEAD 在用户本地 Codex 独立测试；
2. 用户返回 PASS / FAIL；
3. PASS 后才把 Phase 1 标记 completed 并进入 Phase 2；
4. FAIL 则只修复报告中的问题，生成新的 Branch + HEAD 测试基线后重新测试。
