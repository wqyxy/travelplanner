# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 4 — P0 最终线路主交互闭环
总体状态：blocked_ui_validation
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

状态：blocked_ui_validation

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

抽屉包含行程安排、地点信息、定位状态 / 地址、重新识别、地图选点、Google Maps 链接、删除当前 route node。

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

并处理 tentative / no_go 跳过、跨 Day 连接、Day Anchor 使用不同 node ID、route dirty、attention / pending / same_place，以及跳过 inactive 地点提示。

### 5. 非卡片式交通条

最终线路主视图直接显示：

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

---

## 冻结测试基线

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2
```

该测试分支 HEAD 继续保持冻结，不因为本进度文档或文档空白修复而移动。

---

## 2026-09-06 本地 Codex 验收结果

最终结论：

```text
Phase 4: FAIL
原因：强制浏览器 UI Gate 无可用浏览器实例，无法执行。
```

### 静态 Review

PASS。

确认：

- selected / hovered / editing / focusRequest / map-pick 状态解耦；
- 显式 `focusRequest` 才 flyTo；
- 抽屉替代 inline 编辑；
- 有效交通 ViewModel 使用 active route + Day + RouteLeg；
- dirty 时隐藏旧指标；
- 无 finalRoute / Day / Route 服务端核心重构；
- UI / AI 未写入 Provider 距离、时长或 geometry。

### 自动测试

```text
Phase 4 + UI helper + Phase 2/3 + map/route 回归：9 files / 52 tests PASS
npm run typecheck：PASS
npm run build：PASS（仅 bundle 体积警告）
完整 npm test：89 files / 514 tests PASS
```

因此当前没有已知的自动测试或类型 / 构建失败。

### 强制浏览器 UI Gate

未执行，原因：Codex 测试环境浏览器列表为空，无可用浏览器实例。

以下 10 项均记为 **NOT VERIFIED / Gate FAIL**，不能记为产品行为失败：

```text
A Hover
B Click
C 编辑抽屉
D 交通条
E tentative / no_go
F Day / 住宿
G 地图选点
H 未定位
I 排序
J 响应式
```

仍需真实浏览器验证：

1. Hover 时地图中心和 zoom 确实完全不变；
2. Click 地点才 flyTo；
3. 编辑抽屉视觉上覆盖地图且不撑开列表；
4. A → X(inactive) → B 时实际显示 A → B；
5. 多一晚 / 不住的真实 Day 交互；
6. map-pick 保存和取消后抽屉恢复；
7. 真正的拖放行为；
8. <=900px 响应式 Sheet；
9. 未定位地点真实运行时行为；
10. 实际地图 Marker hover / selected 视觉。

### 其他发现

`git diff --check` 报告 `docs/PLAN.md` 与 `docs/PLAN_PROGRESS.md` 存在已提交行尾空白。

该问题属于文档卫生问题，不影响运行时。当前不为了清理文档空白移动已经冻结的 Phase 4 测试 Branch + HEAD；后续文档提交统一去除新增 trailing whitespace。

真实外部 Route Provider 场景本轮仍未覆盖。

---

## Phase 4 Gate 结论

当前状态不是“代码测试失败”，而是：

> **自动化、类型和构建全部通过，但强制真实浏览器 UI 验收尚未完成。**

因此 Phase 4 不能标记 `completed`，也不能进入 Phase 5。

不需要因为当前结果创建 r2 或修改生产代码；除非真实浏览器验收发现具体交互 Bug，才针对 Bug 修复并冻结新的测试 Branch + HEAD。

---

# Phase 5

状态：pending

前置条件：Phase 4 必须完成真实浏览器 UI Gate 并返回 PASS。

计划：

- Day / 全程 AI 操作折叠；
- Pending Proposal 紧凑化；
- 添加地点插入位置显式化；
- 桌面排序入口进一步简化；
- 删除产品内确认 / Undo；
- 桌面与窄屏响应式细节。

---

## 下一步

保持以下代码基线不变：

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2
```

下一次只需要在**有真实浏览器的环境**补做 Phase 4 的 10 项 UI 人工验收。

- 如果 10 项全部 PASS：Phase 4 可直接完成，不需要重跑一遍已经通过的完整自动测试。
- 如果发现 UI Bug：记录具体场景，修复后新建 r2 冻结基线，并只重跑受影响测试 + typecheck/build + UI Gate，再决定是否进入 Phase 5。
