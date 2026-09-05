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
- 地图展示全部已定位线路节点，路线只连接当前 normal 派生 Day。
- 地图只负责展示 / 选择 / 定位辅助，业务修改统一在右侧。
- finalRoute 只保存用户选择的交通方式；真实距离、时长、geometry 和 Provider 验证事实不能由 UI / AI / API 调用方伪造。
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

---

# Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：awaiting_local_test

## 已完成施工

### 两工作区入口

正常导航只有：

- `规划 · 旅行需求`
- `行程 · 最终线路`

`main.tsx` 已挂载 `AppFinalRouteV3`。旧五步 App 暂留源码供 Phase 3 清理，但不再作为正常产品入口。

### 右侧最终线路

- 手工添加地点直接进入 finalRoute；
- Place + 内部 Candidate 关联 + route node 可同批保存；
- 支持上移 / 下移 / drag-drop；
- 支持 normal / tentative / no_go；
- 支持住 / 不住 / 多一晚；
- 支持“到达当前节点”的交通方式；
- 支持地点编辑、重新定位、Google Maps 链接、地图选点；
- 移除只删除当前线路节点；
- Day 只作为派生结果展示，不提供第二套 Day 编辑入口。

### 地图

- 地图点直接来自 finalRoute.nodes；
- normal / tentative / no_go 的真实已定位节点全部显示；
- 路线来自当前 normal 节点派生的 Day Route；
- Popup 不提供删除 / 状态 / 住宿 / 优化等第二套业务入口；
- 只有右侧先进入“地图选点”模式，地图点击才允许保存定位；
- 未定位地点仍保留在线路，不伪造坐标。

### Day / Route 跟随

- finalRoute 变化由底层机械重建 Day；
- route dirty 后前端尝试自动重新计算；
- Provider 路线更新失败不会回滚已经保存的 finalRoute。

---

## Phase 2 R1 本地验收

```text
Test Branch: test/plan-phase2-final-route-ui-20260905
Test HEAD: 762c8926fedb1b2fd73f113ab2989f2a207bb990
Phase 2: FAIL
```

R1 自动测试本身全部通过：

```text
Test Files: 86 passed / 0 failed / 86 total
Tests: 487 passed / 0 failed / 487 total
```

但独立负向审计发现两个 High：

1. inactive 节点退出当前 Day 后，地图仍可能显示经过该节点的 dirty 旧 Provider geometry。
2. `set_final_route_transport` 可接受并持久化调用方伪造的 duration / note / verified 事实。

因此 R1 FAIL 有效，没有进入 Phase 3。

---

## Phase 2 R2 修复

### 修复 1：旧 dirty geometry 不得穿过 inactive 节点

修改：

- `apps/web/src/final-route-map-v3.ts`
- `apps/web/src/FinalRouteMapV3.tsx`
- `apps/web/src/final-route-map-v3.test.ts`

处理方式：

- 地图线条仍可以展示与**当前 Day 拓扑一致**的 dirty 路线作为待更新参考；
- 但每条 Provider leg 必须同时匹配当前 Day 的：
  - fromNodeId
  - fromPlaceId
  - toNodeId
  - toPlaceId
- 不再只按 Place 判断，因此同 Place 多次出现也不会混淆；
- 任何经过已经 tentative / no_go 节点的旧 leg 都不会进入最终线路地图 source。

### 修复 2：finalRoute 交通只能保存 mode

修改：

- `apps/server/final-route-v3.ts`
- `apps/server/final-route-plan-commands-v3.test.ts`

处理方式：

最终线路受控 mutation 对传入交通统一正规化：

```text
mode = 调用方选择的 mode
durationMinutes = null
note = null
verification.status = unverified
verification.checkedAt = null
```

`mode=none` 保存为 null。

该规则同时覆盖：

- `set_final_route_transport`
- `add_final_route_node` 中夹带的 transportFromPrevious

因此正常 UI、直接 `/commands` 调用以及直接 `applyPlanCommands` 都不能把调用方伪造的交通时长或 verified 事实保存到 finalRoute。

### 静态 Review

施工 Agent 已静态确认：

- 地图过滤节点构造规则与 `day-route-v2.ts` 的 start → stops → end、连续同 Place 去重规则一致；
- 路线过滤使用 node ID + Place ID，不会被同 Place 重复节点绕过；
- finalRoute transport 正规化发生在服务端最终线路 mutation 边界，不依赖前端 helper；
- 新增节点和修改交通两个写入口都受同一事实边界保护；
- 没有修改 Phase 3 AI 生成 / 优化权限；
- 施工 Agent 没有运行任何测试。

---

## Phase 2 R2 本地测试基线

```text
Test Branch: test/plan-phase2-final-route-ui-20260905-r2
Test HEAD: aa55a6d616902d1c436b8f796c8e1be3c0a7f354
```

该分支已冻结，不再修改。

完整 R2 本地 Codex Prompt 写在 `docs/PLAN_EXECUTION.md`。

### 当前 blocker

唯一 blocker：**Phase 2 R2 尚未由用户本地测试 PASS。**

---

# Phase 3：AI 生成 / 局部补充 / 显式优化 + 旧流程清理

状态：pending

只有 Phase 2 R2 PASS 后才开始。

Phase 3 将负责：

- 生成主要地点直接插入 finalRoute；
- 生成详细地点直接插入 finalRoute；
- 局部插入；
- 普通 AI 只允许插入，不允许重排已有节点；
- 显式优化才允许在授权范围重排；
- destination / interest / itinerary Action / Prompt 收敛；
- 旧 Candidate / Skeleton / Day 产品职责清理；
- 更新 PRODUCT.md / TECHNICAL.md。

---

## 下一步

1. 用户切到 `test/plan-phase2-final-route-ui-20260905-r2`；
2. 确认 HEAD 为 `aa55a6d616902d1c436b8f796c8e1be3c0a7f354`；
3. 按 `PLAN_EXECUTION.md` 中的 Phase 2 R2 Prompt 本地测试；
4. 返回匹配 Branch + HEAD 的 PASS / FAIL；
5. PASS → Phase 2 completed，进入 Phase 3；
6. FAIL → 只修复 Phase 2 新报告的问题，并冻结新的测试基线。
