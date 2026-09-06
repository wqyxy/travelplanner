# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 4 — P0 最终线路主交互闭环  
总体状态：awaiting_local_test  
最后更新时间：2026-09-06

---

## 已确认的产品决定

- 用户只维护一份最终线路：`finalRoute`。
- 正常产品只有两个工作区：`规划 · 旅行需求` / `行程 · 最终线路`。
- 本次 UI 改造不重新设计 finalRoute / Day / Route 服务端核心模型。
- 地点 Hover、地图选择、地点编辑是三套独立 UI 状态。
- Hover 地点只高亮地点块和地图 Marker，不移动 / 缩放地图。
- Click 地点才触发地图 flyTo，不打开编辑。
- Click 独立“编辑”按钮才打开地点编辑抽屉，并且不触发 flyTo。
- 编辑抽屉从最终线路列表左侧向地图方向覆盖，不再在地点下面 inline 展开。
- 交通显示在两个当前有效地点之间，使用非卡片式连接条。
- 交通距离 / 时间只来自现有 Route Provider / RouteLeg，Route dirty 时不能把旧事实显示成当前事实。
- 住 / 不住 / 多一晚移到地点块主界面。
- Day 提升为明确日程块，但仍然只展示派生 Day，不维护第二份 Day 数据。
- 正常 / 已定位等常态不长期显示，主要展示异常状态。
- 只有拖动手柄作为桌面拖动起点，地点块主体不再整体 draggable。

---

# Phase 1

状态：completed

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
Phase 1: PASS
```

完成内容：finalRoute 基础、Day / Route 自动派生、新数据策略、过渡写入桥。

---

# Phase 2

状态：completed

```text
Test Branch: test/plan-phase2-final-route-ui-20260905-r2
Test HEAD: aa55a6d616902d1c436b8f796c8e1be3c0a7f354
Phase 2: PASS
```

完成内容：右侧最终线路人工规划、住宿边界、多一晚、状态、交通、定位修复、地图与唯一业务入口。

---

# Phase 3

状态：completed

```text
Test Branch: test/plan-phase3-final-route-ai-20260905-r3
Test HEAD: 8b17dde239484e79a98b7900766442d1b8836ea2
Phase 3: PASS
```

完成内容：AI 主要地点 / 详细地点、详细安排、显式优化、Proposal / Undo、Provider 事实边界。

---

# Phase 4

状态：awaiting_local_test

目标：P0 最终线路主交互闭环。

## 已完成施工

### 1. UI 状态解耦

`AppFinalRouteV3.tsx` 已把原来单一 `selectedNodeId` 的多重职责拆开为：

```text
selectedNodeId      = 地图当前选中
hoveredNodeId       = 地点 Hover 联动
editingNodeId       = 编辑抽屉当前节点
mapFocusRequest     = 显式地图 flyTo 请求
mapPickReturnNodeId = 地图选点返回编辑上下文
```

### 2. Hover / Click / Edit

- Hover 地点：只改变地点块和地图 Marker 高亮。
- 地点 Click：创建 `mapFocusRequest`，地图才 flyTo。
- 地图不再因为 `selectedNodeId` 本身变化自动 flyTo。
- 编辑按钮独立打开 / 关闭编辑抽屉。
- Marker Click 只改变地图选择，不自动打开业务编辑。

### 3. 独立地点编辑抽屉

新增：

```text
apps/web/src/FinalRouteEditorDrawerV4.tsx
```

抽屉包含：

- 行程安排；
- 地点信息；
- 定位状态 / 地址；
- 重新识别；
- 地图选点；
- Google Maps 链接；
- 删除当前 route node。

地点列表中的旧 inline `final-route-editor-v3` 已移除。

地图选点时抽屉暂时关闭；保存 / 取消后恢复原 `editingNodeId`。

### 4. 有效交通连接 ViewModel

`final-route-ui-v3.ts` 新增：

```text
finalRouteTransportConnectionsV4
finalRouteDayViewsV4
```

交通连接基于：

```text
finalRoute normal nodes
派生 plan.days
routeStates.route.legs
```

并处理：

- tentative / no_go 跳过；
- 跨 Day 连接；
- Day Anchor 使用不同 node ID 的情况；
- route dirty 不暴露旧 distance / duration；
- attention / pending / same_place；
- 中间跳过 inactive 地点提示。

### 5. 非卡片式交通条

最终线路主视图现在直接显示：

```text
交通方式 · Provider 距离 · Provider 时间
```

点击交通条可修改“到达当前节点”的交通方式，仍走现有 `set_final_route_transport`。

### 6. Day 日程块与住宿主操作

- Day 顶部显示 Day、日期、标题、Route 总距离 / 时间或 dirty / attention 状态。
- 多一晚形成的同地点空 Day 显示“这一天还没有详细安排”。
- `+ 住` 直接在地点块主界面。
- 已住宿分界显示 `住 ▾ → 多一晚 / 不住`。
- tentative / no_go 上保存的住宿分界显示“暂不生效”。

### 7. 状态与排序减法

- 正常状态不显示“正常” badge。
- resolved 不显示“已定位” badge。
- 只突出待定 / 不去 / 未定位 / 定位中等异常状态。
- 地点主体不再整体 draggable；只允许拖动手柄开始排序。

### 8. 样式与回归测试

新增：

```text
apps/web/src/phase4-final-route-interaction.css
apps/web/src/phase4-final-route-interaction.test.ts
```

并扩充 / 更新：

```text
apps/web/src/final-route-ui-v3.test.ts
apps/web/src/phase3-final-route-ai-cutover.test.ts
```

旧 Phase 3 “详细安排必须写在 FinalRoutePanelV3 文件本身”测试契约已改为验证最终线路 + 独立编辑抽屉，避免把正确 UI 重构误判成回归。

## 静态 Review

已完成静态检查：

- diff 仅涉及最终线路前端及相关测试；
- 未修改 server finalRoute / Day / Route 核心模型；
- Hover 路径不创建 flyTo 请求；
- flyTo 只由显式 `focusRequest` 触发；
- Route dirty 时交通 ViewModel 不返回旧距离 / 时间；
- 交通 ViewModel 有 tentative 跳过和跨 Day Anchor 的测试用例；
- 编辑抽屉不再处于地点文档流中；
- map-pick 保存 / 取消路径保留编辑返回上下文。

**施工 Agent 未运行 test / typecheck / build / app / Provider / CI。**

## 测试基线

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2
```

说明：测试代码基线冻结在上述独立 Branch + HEAD。本进度记录写在 `main`，不会推进测试分支 HEAD。

本地测试：**尚未由用户本地验证。**

## 必测风险

1. 浏览器实际 Hover 地点时地图中心和 zoom 必须完全不动。
2. 点击地点后才 flyTo；点击编辑 / 住 / 状态 / 交通不能误触发 flyTo。
3. 抽屉应覆盖地图一部分，不能把最终线路列表往下撑。
4. tentative / no_go 夹在 A/B 中间时，有效交通必须显示 A → B。
5. 跨 Day 住宿边界后的交通必须读到目标 Day 的 Provider RouteLeg。
6. Route dirty 时不能出现旧距离 / 时间伪装成当前事实。
7. 地图选点成功和取消后都要恢复原地点编辑抽屉。
8. 多一晚产生的空 Day 必须能被用户理解。
9. 响应式 / 窄屏抽屉不能退化成 inline 展开。

---

# Phase 5

状态：pending

前置条件：Phase 4 必须由用户本地 Codex 对上述冻结 Branch + HEAD 返回 PASS。

计划：

- Day / 全程 AI 操作折叠；
- Pending Proposal 紧凑化；
- 添加地点插入位置显式化；
- 桌面排序入口进一步简化；
- 删除产品内确认 / Undo；
- 桌面与窄屏响应式细节。

---

## 当前已知问题

Phase 4 尚未经过执行测试与浏览器人工验收，因此当前不能声明可用性 PASS。

Phase 5 的 AI 界面减法、Proposal 紧凑化、删除 Undo 等仍未施工。

---

## 与原计划的偏差

无产品方向偏差。

实施时根据当前代码增加了一个独立 `FinalRouteEditorDrawerV4.tsx` 和 Phase 4 独立 CSS，而没有继续膨胀 `FinalRoutePanelV3.tsx` / `phase2-final-route.css`；这是为隔离抽屉职责和降低样式回归范围，不改变 PLAN 行为。

---

## 下一步

等待用户本地 Codex 对以下冻结基线验收：

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2
```

只有该基线返回 PASS 后，Phase 4 才能改为 `completed`，并开始 Phase 5。
