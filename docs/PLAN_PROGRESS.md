# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 2 — 右侧最终线路人工规划闭环 + 地图联动  
总体状态：awaiting_local_test  
最后更新时间：2026-09-05

---

## 已确认的产品决定

- 用户只维护一份最终线路。
- 同一 Place 可以在线路中出现多次，每次拥有独立线路节点 ID。
- 节点状态只有 normal / tentative / no_go。
- tentative / no_go 保留顺序、地图点和原住宿分界，但暂时退出当前 Day 和交通路线；恢复 normal 后原位置重新生效。
- 交通方式属于“到达当前节点”。
- 不住只取消日程分界。
- 多一晚新增同 Place 线路节点，不移动其他地点。
- Day 根据最终线路自动生成，最后一天允许没有住宿分界。
- 地图展示全部已定位线路节点，路线只连接 normal 派生 Day。
- 地图只负责展示 / 选择 / 定位辅助，业务修改统一在右侧。
- Provider 坐标、真实距离、时长和 geometry 的事实边界继续保留。
- 普通 AI 生成只能插入新地点；显式优化权限留到 Phase 3 落地。

---

## 测试规则

- 施工 Agent 不运行任何测试、typecheck、build、应用启动、迁移或 CI。
- 每个 Phase 由用户本地 Codex 独立测试。
- 测试绑定唯一 Test Branch + 40 位 Test HEAD。
- 任意待测代码变化都会使旧测试结果失效。
- 用户未返回匹配 Branch + HEAD 的 PASS 前，不进入下一 Phase。

---

# Phase 1：最终线路底层与自动 Day / Route 基础

状态：completed

最终验收：

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
Phase 1: PASS
Test Files: 83 passed / 0 failed / 83 total
Tests: 479 passed / 0 failed / 479 total
```

Phase 1 已建立 finalRoute、三状态、住宿分界、到达交通、Day 自动派生、同 Place 多节点、Revision/generation 基础、当前 Day 写入桥和 Provider 事实边界。

---

# Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：awaiting_local_test

## 已完成施工

### 两工作区入口

- 新增 `AppFinalRouteV3.tsx`。
- `main.tsx` 已改为挂载新的两工作区 App。
- 正常导航只显示：
  - `规划 · 旅行需求`
  - `行程 · 最终线路`
- 旧 `AppWorkflowV3.tsx` 暂留源码供 Phase 3 清理，但不再作为正常挂载入口。
- `RequirementsPanelV3` 的用户文案从旧 Step 1 / “想去哪些地方”改成“规划 / 进入最终线路”。

### 右侧最终线路面板

新增 `FinalRoutePanelV3.tsx`：

- 手工添加地点直接写最终线路；
- 同一批命令创建 Place + 内部 Candidate 关联 + route node；
- 支持上移 / 下移 / drag-drop；
- 支持 normal / tentative / no_go；
- 支持住 / 不住 / 多一晚；
- 支持到达当前节点的交通方式；
- 支持地点名称 / 类型编辑；
- 支持重新识别、Google Maps 链接、地图选点；
- 移除只删除当前 route node，不误删同 Place 的其他出现；
- inactive 节点继续显示原住宿分界；
- Day 只作为派生分组展示，没有独立 Day 编辑入口。

### 地图

新增：

- `FinalRouteMapV3.tsx`
- `final-route-map-v3.ts`

当前行为：

- 地图点直接来自 `finalRoute.nodes`；
- normal / tentative / no_go 的真实已定位节点全部显示；
- tentative / no_go 用不同标记和视觉；
- 路线线条仍来自 normal 节点派生的 Day Route；
- 点击地图点只选择 / 聚焦右侧线路节点；
- Popup 只显示地点、状态、地址；
- 地图没有第二套删除 / 状态 / 住宿 / 优化入口；
- 只有右侧启动“地图选点”以后，地图点击才写入定位；
- 未定位地点保留在线路，不伪造地图坐标。

### Day / Route 跟随

- finalRoute 命令仍由 Phase 1 底层机械重建 Day。
- 前端在最终线路命令保存成功后，如果 route dirty，会自动尝试重新计算路线。
- Route Provider 更新失败不会回滚已保存线路；右侧显示非阻断提示并提供“更新地图路线”重试。

### 提醒

- `PlanningAdvisoryListV3` 支持最终线路工作区合并显示内部多个旧分类的提醒，不恢复旧五步页面。

### 新增纯逻辑测试代码

- `apps/web/src/final-route-ui-v3.test.ts`
- `apps/web/src/final-route-map-v3.test.ts`

施工 Agent 未运行这些测试。

## 静态 Review 结论

已静态确认：

- `main.tsx` 已切换到 `AppFinalRouteV3`；
- 路线人工操作走现有 `/commands`，没有新增旁路写入；
- 添加地点在一个命令批次内完成 Place / Candidate / route node ID 映射；
- 地图路线数据不从全部地图点拼接，而继续读取派生 Day Route，因此 inactive 点不会进入交通路线；
- Map Popup 不包含业务修改按钮；
- Route 失败与 plan 保存失败分离；
- 无施工侧测试结论可声明。

## 本地测试基线

```text
Test Branch: __PHASE2_TEST_BRANCH__
Test HEAD: __PHASE2_TEST_HEAD__
```

完整本地 Codex Prompt 已写入 `docs/PLAN_EXECUTION.md`。

### 当前 blocker

唯一 blocker：**Phase 2 尚未由用户本地测试 PASS。**

---

# Phase 3：AI 生成 / 局部补充 / 显式优化 + 旧流程清理

状态：pending

只有 Phase 2 PASS 后才开始。

Phase 3 将负责：

- 生成主要地点直接插入 finalRoute；
- 生成详细地点直接插入 finalRoute；
- 局部插入；
- 普通 AI 只允许插入，不允许重排已有节点；
- 显式优化才允许在授权范围重排；
- destination / interest / itinerary Action / Prompt 收敛；
- 旧 Candidate / Skeleton / Day 产品职责清理；
- 缩小或删除 Phase 1 的当前 Day 写入翻译；
- 更新 PRODUCT.md / TECHNICAL.md。

---

## 下一步

1. 冻结 Phase 2 Test Branch + HEAD；
2. 用户按 `PLAN_EXECUTION.md` 中的 Phase 2 Prompt 本地测试；
3. 用户返回匹配 Branch + HEAD 的 PASS / FAIL；
4. PASS → Phase 2 completed，进入 Phase 3；
5. FAIL → 只修复 Phase 2 报告问题并生成新的测试基线。
