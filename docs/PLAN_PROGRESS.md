# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 4 — P0 最终线路主交互闭环  
总体状态：in_progress  
最后更新时间：2026-09-06

---

## 已确认的产品决定

- 用户只维护一份最终线路：`finalRoute`。
- 正常产品只有两个工作区：

```text
规划 · 旅行需求
行程 · 最终线路
```

- 同一 Place 可以在线路中出现多次，每次拥有独立 route node ID。
- tentative / no_go 保留原顺序、endsDay、到达交通和地图点，但暂时退出当前 Day / Route。
- 交通属于“到达当前节点”。
- 住 / 不住只控制 `endsDay`；多一晚新增同 Place 独立 route node。
- Day 根据 finalRoute 自动派生；最后一天不要求住宿分界。
- Provider 坐标、真实距离、真实时长、geometry、verified 事实不能由 UI / AI / API 调用方伪造。
- 本次追加 UI 改造不重新设计 finalRoute / Day / Route 服务端核心模型。
- 地点 Hover、地图选择、地点编辑必须拆成独立 UI 状态。
- Hover 地点只高亮地点块和地图 Marker，不移动 / 缩放地图。
- Click 地点才触发地图 flyTo，不打开编辑。
- Click 独立“编辑”按钮才打开地点编辑抽屉，并且不触发 flyTo。
- 编辑抽屉从最终线路列表左侧向地图方向覆盖，不再在地点下面 inline 展开。
- 交通显示在两个当前有效地点之间，使用非卡片式连接条。
- 交通距离 / 时间来自现有 Route Provider / RouteLeg，不能前端估算。
- 住 / 不住 / 多一晚移到地点块主界面。
- Day 提升为明确日程块，但仍然只展示派生 Day，不维护第二份 Day 数据。
- 正常 / 已定位等常态不长期显示，主要展示异常状态。

---

# Phase 1

状态：completed

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
Phase 1: PASS
Test Files: 83 passed / 0 failed / 83 total
Tests: 479 passed / 0 failed / 479 total
```

完成内容：finalRoute 基础、Day / Route 自动派生、新数据策略、过渡写入桥。

---

# Phase 2

状态：completed

```text
Test Branch: test/plan-phase2-final-route-ui-20260905-r2
Test HEAD: aa55a6d616902d1c436b8f796c8e1be3c0a7f354
Phase 2: PASS
Test Files: 86 passed / 0 failed / 86 total
Tests: 489 passed / 0 failed / 489 total
```

完成内容：右侧最终线路人工规划、住宿边界、多一晚、状态、交通、定位修复、地图与唯一业务入口。

---

# Phase 3

状态：completed

最终验收：

```text
Test Branch: test/plan-phase3-final-route-ai-20260905-r3
Test HEAD: 8b17dde239484e79a98b7900766442d1b8836ea2
Phase 3: PASS
Typecheck: PASS
R2 唯一失败点复测: PASS
Phase 3 专项: PASS（10 files / 54 tests）
AI / Prompt / Runtime 回归: PASS（7 files / 63 tests）
完整 npm test: PASS（88 files / 505 tests）
Build: PASS
独立临时审计: PASS
浏览器 / UI E2E: 未覆盖（环境无可用浏览器）
真实外部 Route Provider: 未覆盖（非本阶段强制 Gate）
```

完成内容：

- `destination.generate` 直接形成 finalRoute；已有线路时不能普通生成覆盖。
- 同一现实 Place 可多次成为独立 route node，正式回归覆盖 `A → B → A`。
- `interest.discover / supplement` 只插入本轮新增详细地点，不得修改旧 route node。
- trip / day / segment 局部详细生成都有服务器范围限制；找不到范围内锚点时 fail closed。
- 手工加入最终线路的地点可作为内部 planning area 研究锚点，不改变 Place.kind、不自动住宿。
- 详细安排直接属于 route node；手工可编辑 activity / period / startTime / endTime / durationMinutes / notes。
- “完善这一天”只修改授权 Day 的详细安排，并统一通过 `sanitizeFinalRouteRefineOutputV3` 保护 transport / verification。
- “优化这一天 / 这一段 / 全程”只产生授权范围内的 move Proposal；inactive 节点固定槽位。
- Proposal apply / reject / undo、generation / stale proposal 路径已验证。
- Proposal apply / undo 后自动启动 Route batch。
- 正常生产入口仍只有“旅行需求 / 最终线路”，Map Popup 没有第二套业务 mutation。

---

# Phase 4

状态：in_progress

目标：P0 最终线路主交互闭环。

计划完成：

- Hover 地点只高亮 Marker，不移动 / 缩放地图；
- Click 地点才 flyTo；
- 独立编辑按钮；
- 左侧编辑抽屉；
- 移除地点 inline 大表单；
- 有效交通连接 ViewModel；
- 非卡片式真实交通条；
- Day 日程块；
- 住 / 不住 / 多一晚主界面操作；
- 正常 / 已定位常态标签减法；
- hover / map selection / editing 状态解耦；
- 拖动只从手柄开始。

当前完成：

- 已完成代码 Review；
- 已确认当前 `selectedNodeId` 同时承担地图飞行和 inline 编辑，是主要交互耦合点；
- 已确认 `RouteLeg` 数据包含 Provider distance / duration，可作为交通条事实来源；
- 已确认派生 Day 的结束节点可能使用 `endAnchor.id`，交通 ViewModel 不能简单按视觉相邻 row 或只按 finalRoute node id 匹配；
- `docs/PLAN.md` 已追加第 31–47 节 UI / 交互目标；
- `docs/PLAN_EXECUTION.md` 已生成 Phase 4 / Phase 5 施工与本地测试方案。

未完成：

- Phase 4 业务代码尚未修改；
- Phase 4 测试尚未冻结；
- 尚未由用户本地验证。

测试基线：

```text
Test Branch: 待 Phase 4 代码施工完成后填写
Test HEAD: 待 Phase 4 代码施工完成后填写
```

本地测试：尚未由用户本地验证。

当前重点风险：

1. `RouteLeg` 的 from/to node ID 与 finalRoute route-node ID 并非所有 Day 边界都一一相同，交通条必须基于派生 Day 结构正确映射。
2. Hover 高亮不能误触发已有 `selectedNodeId` 驱动的 flyTo effect。
3. 编辑抽屉的按钮事件必须全部阻止冒泡，避免触发地点 Click。
4. map-pick 完成 / 取消后要恢复 editing 上下文。
5. route dirty 时不得把旧距离 / 时间显示成当前事实。

---

# Phase 5

状态：pending

前置条件：Phase 4 必须由用户本地 Codex 对冻结 Branch + HEAD 返回 PASS。

计划：

- Day AI 操作折叠；
- 全程 AI 操作收敛；
- Pending Proposal 紧凑化；
- 添加地点插入位置显式化；
- 桌面排序入口简化；
- 删除产品内确认 / Undo；
- 桌面与窄屏响应式细节。

测试基线：

```text
Test Branch: 待 Phase 5 代码施工完成后填写
Test HEAD: 待 Phase 5 代码施工完成后填写
```

本地测试：尚未由用户本地验证。

---

## 当前已知问题

- 当前最终线路地点 Click 仍会同时承担地图选中与 inline 编辑。
- 当前地点编辑会把大量表单直接展开在列表中。
- 当前主线路看不到地点之间的真实交通距离 / 时间。
- 当前 Day 视觉层级不足。
- 当前住 / 不住 / 多一晚入口过深。
- 当前 AI 操作和 Proposal 仍然较占空间。

---

## 与原计划的偏差

前 1–30 节原计划已经实现并完成 Phase 1–3。

2026-09-06 根据实际使用 Review，新增 `PLAN.md` 第 31–47 节作为后续 UI / 交互目标。

本次没有推翻 Phase 1–3 的数据结构和 AI 权限设计，而是在其上新增 Phase 4 / Phase 5。

---

## 下一步

开始 Phase 4 代码施工。

施工完成后：

1. 只做静态 Review，不运行 test / typecheck / build / app；
2. 固定实际 Test Branch + 40 位 Test HEAD；
3. 同步更新 `PLAN_PROGRESS.md` 和 `PLAN_EXECUTION.md`；
4. 输出 Phase 4 Codex 本地测试 Prompt；
5. 等待用户本地 PASS 后才进入 Phase 5。
