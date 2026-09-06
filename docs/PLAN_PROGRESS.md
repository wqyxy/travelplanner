# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 4 r2 — P0 最终线路视觉模型纠正与主交互闭环
总体状态：awaiting_local_test
最后更新时间：2026-09-06

---

## 已确认的产品决定

- 用户只维护一份最终线路：`finalRoute`。
- 正常产品只有两个工作区：`规划 · 旅行需求` / `行程 · 最终线路`。
- 本次 UI 改造不重新设计 finalRoute / Day / Route 服务端核心模型。
- **地点永远只是地点，地点主标题只能来自 Place 名称。**
- **Day 不再做包住地点的大卡片 / Header；当前有效住宿分界只表现为地点之间的 `第 N 晚` 分隔线。**
- 地点 Hover、地图选择、地点编辑是三套独立 UI 状态。
- Hover 地点只高亮地点块和地图 Marker，不移动 / 缩放地图。
- Click 地点才触发地图 flyTo，不打开编辑。
- Click 独立“编辑”按钮才打开地点编辑抽屉，并且不触发 flyTo。
- 编辑抽屉从最终线路列表左侧向地图方向覆盖，不再在地点下面 inline 展开。
- 交通显示在两个当前有效地点之间，使用非卡片式连接条。
- 交通距离 / 时间只来自 Route Provider / RouteLeg，Route dirty 时不能把旧事实显示成当前事实。
- 住 / 不住 / 多一晚位于地点块主界面。
- 正常 / 已定位等常态不长期显示，主要展示异常状态。
- 桌面排序只能从拖动把手启动，但拖动视觉必须是整张地点卡；松手后自动重排。

详细纠正规格见：

```text
docs/PLAN_PHASE4_R2_CORRECTION.md
```

该文件覆盖 `PLAN.md` 第 31–47 节中与 Day 大卡片 / Day Header 相冲突的旧描述。

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

# Phase 4 r1

状态：superseded_by_product_correction

冻结基线：

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2
```

本地 Codex 已执行：

```text
Phase 4 + UI helper + Phase 2/3 + map/route 回归：9 files / 52 tests PASS
npm run typecheck：PASS
npm run build：PASS（仅 bundle 体积警告）
完整 npm test：89 files / 514 tests PASS
```

当时浏览器列表为空，因此强制 UI Gate 未执行。

随后产品 Review 发现 r1 的 Day 大卡片 / Day Header 视觉模型本身违背“地点只是地点、Day 只是线路分界”的核心原则，因此 r1 即使补做浏览器 Gate 也不再作为最终 Phase 4 验收对象。

这不是自动测试回归，而是产品表达被纠正。

---

# Phase 4 r2

状态：awaiting_local_test

目标：保持 r1 已完成的 Hover / Click / Edit / Drawer / 有效交通能力，同时纠正最终线路的信息模型和拖拽体验。

## r2 已完成施工

### 1. 取消线路主体的 Day 大卡片 / Day Header

最终线路主体不再渲染 Day 容器。

固定视觉语法：

```text
地点卡
交通连接
地点卡
──────── 第 N 晚 ────────
交通连接
地点卡
```

Day 继续作为 finalRoute 的派生数据存在，但只用于日期、AI scope、Route scope 等辅助功能。

### 2. 地点卡完全统一

所有 finalRoute node 使用相同地点卡。

地点名称改为严格使用 Place 名称展示逻辑：

```text
placeNamePresentation(row.place, ..., "未命名地点")
```

删除 `row.node.activity` 作为地点名 fallback 的可能性，避免 `前往 xxx`、Day title 或活动文字冒充地点名。

### 3. 住宿 / Day 改为夜晚分隔线

对于当前有效：

```text
status === normal && endsDay === true
```

在该地点卡之后显示：

```text
──────── 第 N 晚 ────────
```

编号继续使用 finalRoute 当前派生 Day 编号，因此住宿变化、排序变化后自动重新计算。

待定 / 不去节点保存的 `endsDay` 继续保留，但只显示“暂不生效”，不切当前 Day。

### 4. 多一晚继续使用现有同 Place route node

没有新增 `stayDays` 或 StayBlock。

现有服务端 `add_final_route_night` 已经会在同一 Place 后增加独立 route node；r2 只把它显示成相同结构的地点卡 + 下一条 `第 N 晚` 分隔线。

连续同 Place 的 synthetic `same_place` 连接不再显示“交通待定”并允许修改虚假交通；它只表示连续住宿语义。

### 5. 拖动把手启动、整张卡跟手

新增：

```text
apps/web/src/final-route-drag-v4.ts
apps/web/src/final-route-drag-v4.test.ts
```

桌面端只有拖动把手设置 `draggable`。

拖动开始时：

```text
handle = drag source
整个 .final-route-row-v3 = drag image
```

目标地点上半 / 下半区域分别显示 before / after 插入位置线。

松手后调用现有 `move_final_route_node`，不需要第二次“保存顺序”。

新增纯函数 `finalRouteMoveTargetIndexV4` 专门把 before / after 位置转换为服务端“先移除后插入”的 `targetIndex`，并覆盖向上、向下、首位、末位和 no-op 场景。

### 6. Day 级 AI 操作离开线路地点层级

因为线路主体不再有 Day Header，`补充详细地点 / 完善这一天 / 优化这一天` 迁到统一 AI 辅助区，通过派生 Day 选择器指定 scope。

不因此改变 AI 权限边界。

### 7. r1 主交互继续保留

以下能力不回退：

- Hover 只高亮；
- Click 地点显式 flyTo；
- Click 编辑只打开抽屉；
- Marker Click 不自动编辑；
- 抽屉覆盖地图而非 inline；
- map pick 保存 / 取消恢复编辑上下文；
- 有效交通跳过 tentative / no_go；
- 跨 Day RouteLeg 匹配；
- Route dirty 隐藏旧 Provider 数字；
- 住 / 不住 / 多一晚仍在地点主界面；
- 状态常态减法。

## r2 改动范围

相对 r1 冻结 HEAD，只改：

```text
apps/web/src/FinalRoutePanelV3.tsx
apps/web/src/phase4-final-route-interaction.css
apps/web/src/phase4-final-route-interaction.test.ts
apps/web/src/final-route-drag-v4.ts
apps/web/src/final-route-drag-v4.test.ts
```

没有修改 server finalRoute / Day / Route 核心文件。

## r2 静态 Review

已确认：

- r2 分支从 r1 冻结 HEAD 直接创建；
- diff 只有上述 5 个最终线路前端 / 测试文件；
- 地点名不再使用 activity fallback；
- 最终线路 JSX 不再渲染 Day divider / Day title 容器；
- night divider 只由当前有效 `endsDay` 渲染；
- 拖动只由把手启动，drag image 为整张地点卡；
- before / after 索引转换符合服务端 `moveFinalRouteNodeV3` 的移除后插入语义；
- 排序继续使用现有 `onMoveNode` / `move_final_route_node`，服务端会重新派生 Day；
- 没有新增 Provider 距离 / 时间 / geometry 写入；
- 没有重构服务端模型。

**施工 Agent 未运行 test / typecheck / build / app / 浏览器 / Provider / CI。**

## r2 冻结测试基线

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r2
Test HEAD: 99e0974f66f7e1ad189adc9c806cec4d9a85f181
```

该 Branch + HEAD 从现在开始冻结；main 上的文档提交不会推进测试分支。

## r2 必测风险

1. 所有地点主标题始终是 Place 名，不出现 `Day N 前往 xxx` / Day title / activity 冒充地点名。
2. 线路主体不存在 Day 大卡片 / Header。
3. `endsDay` 后实际显示 `第 N 晚` 分隔线，并在住 / 不住 / 排序后正确重新编号。
4. 多一晚后同 Place 新 route node 仍是普通地点卡，并出现下一条夜晚分隔；不能出现假的“交通待定”。
5. 只有把手能开始拖动，整张卡作为 drag image 跟手。
6. before / after 插入位置明显，向上 / 向下 / 跨住宿边界松手自动排序。
7. 排序后有效交通、Day、夜晚分隔同步更新。
8. Hover 不移动地图；Click 地点才 flyTo；编辑 / 住宿 / 状态 / 交通操作不能误触 flyTo。
9. A → X【待定/不去】→ B 时有效交通仍是 A → B。
10. 抽屉 / map pick / 未定位 / 响应式继续通过 r1 的 UI Gate。

---

# Phase 5

状态：pending

前置条件：Phase 4 r2 必须对上述冻结 Branch + HEAD 完成自动回归和真实浏览器 Gate，并返回 PASS。

计划仍然包括：

- AI 操作进一步折叠；
- Pending Proposal 紧凑化；
- 添加地点插入位置进一步显式化；
- 删除产品内确认 / Undo；
- 桌面与窄屏响应式细节。

Phase 5 不得重新引入 Day 大卡片或第二套线路层级。

---

## 下一步

只验收以下冻结基线：

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r2
Test HEAD: 99e0974f66f7e1ad189adc9c806cec4d9a85f181
```

先由本地 Codex 做自动回归；随后必须在有真实浏览器的环境完成 r2 UI Gate。

只有 r2 全部 PASS 才把 Phase 4 标记 `completed` 并进入 Phase 5。
