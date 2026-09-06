# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 5 — 最终线路 UI 收尾
总体状态：code_complete_static_review_complete
最后更新时间：2026-09-06

> 2026-09-06 用户明确调整验收方式：**不再要求浏览器人工测试 Gate。先完成全部代码，再做静态 code review。**
>
> 本轮施工 Agent 仍不运行 test / typecheck / build / app / Provider / CI；浏览器测试不再作为 Phase 4 / Phase 5 完成前置条件。

---

## 当前产品结论

- 用户只维护一份 `finalRoute`。
- 产品只有 `规划 · 旅行需求` / `行程 · 最终线路` 两个主工作区。
- 地点永远只是地点，主标题只来自 Place 名称。
- 线路主体不再存在 Day 大卡片 / Day Header。
- 当前有效住宿分界只显示为地点后的 `第 N 晚` 分隔线。
- 多一晚使用同 Place 的独立 route node，不使用 `stayDays`。
- 地点之间显示当前有效交通；tentative / no_go 自动跳过。
- Provider distance / duration / geometry 仍然不能由前端或 AI 伪造。
- Hover / map selection / editing 继续保持三套独立 UI 状态。

---

# Phase 1

状态：completed

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
Phase 1: PASS
```

完成：finalRoute 基础、Day / Route 自动派生、新数据策略。

---

# Phase 2

状态：completed

```text
Test Branch: test/plan-phase2-final-route-ui-20260905-r2
Test HEAD: aa55a6d616902d1c436b8f796c8e1be3c0a7f354
Phase 2: PASS
```

完成：右侧最终线路人工规划、住宿、状态、交通、定位和地图交互。

---

# Phase 3

状态：completed

```text
Test Branch: test/plan-phase3-final-route-ai-20260905-r3
Test HEAD: 8b17dde239484e79a98b7900766442d1b8836ea2
Phase 3: PASS
```

完成：AI 主要地点 / 详细地点、详细安排、显式优化、Proposal / Undo、Provider 边界。

---

# Phase 4 r1

状态：superseded_by_product_correction

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2
```

自动测试曾通过，但产品 Review 后确认 Day 大卡片 / Day Header 模型错误，因此被 r2 取代。

---

# Phase 4 r2

状态：completed_by_code_and_static_review

冻结基线：

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r2
Test HEAD: 99e0974f66f7e1ad189adc9c806cec4d9a85f181
```

完成：

1. 取消线路主体 Day 大卡片 / Header。
2. 统一地点卡；地点名只来自 Place。
3. `normal + endsDay` 后显示 `第 N 晚`。
4. 多一晚继续使用同 Place 独立 route node。
5. 同 Place 连续节点不显示虚假交通。
6. 排序只从拖动把手开始，整张地点卡作为 drag image。
7. before / after 插入槽转换为现有 `move_final_route_node`。
8. Hover / Click / Edit / Drawer / map-pick / 有效交通能力继续保留。

r2 后续代码作为 Phase 5 的直接基线继续完善，因此最终交付代码应以 Phase 5 冻结分支为准。

---

# Phase 5

状态：code_complete_static_review_complete

## 冻结代码基线

```text
Test Branch: test/plan-phase5-final-route-polish-20260906-r1
Test HEAD: e3ca7f8849a233d831b432849fc6fc2b9f77bf37
Base: 99e0974f66f7e1ad189adc9c806cec4d9a85f181
```

从现在开始该 Branch + HEAD 作为本轮完整 UI 代码冻结基线。

## Phase 5 已完成

### AI 入口减法

最终线路存在时，AI 操作默认折叠成一个 `AI 操作` 菜单。

展开后再显示：

```text
全程：生成详细地点 / 优化全程
按天：补充详细地点 / 完善这一天 / 优化这一天
按区段：补充这一段 / 优化这一段
```

AI 权限边界没有改变。

### Proposal 紧凑化

- Pending Proposal 默认只显示一行摘要，展开后才显示说明和采用 / 不采用。
- Pending 不受历史数量上限影响，不会被已处理方案挤掉。
- 已采用 / 已拒绝 / 已撤销进入折叠的“最近 AI 历史”。
- stale Proposal 根据 generation 禁止直接采用。

### 添加地点位置显式化

添加面板明确显示并允许选择：

```text
线路最前面
在第 N 个地点“xxx”之后
线路末尾
```

每次打开默认线路末尾，不再由地图 selection / editing 状态暗中决定。

同 Place 多次出现时使用线路序号区分插入目标。

### 删除交互

地点抽屉内不再使用浏览器 `window.confirm`。

改为产品内二次确认：

```text
确认移除“xxx”这一次出现？
```

只调用当前 `route node id`，不会删除同 Place 的其他 occurrence。

恢复能力继续使用现有 Revision / 版本历史，不新增第二套删除基础设施。

### 交通状态完善

- same-place synthetic hop 不显示交通编辑入口。
- Route dirty 不暴露旧 Provider 数字。
- Provider / 定位 / unsupported mode 导致 attention leg 且没有 distance / duration 时，显示 `路线暂不可用`。
- transport editor 如果对应有效连接消失或变成 same-place，会自动关闭，避免旧编辑状态复活。

### RouteLeg 精确匹配

静态 Review 发现仅按 `fromPlaceId / toPlaceId` 匹配会在重复地点线路中拿错 Provider leg。

已改成：

1. 根据派生 Day，把 finalRoute endpoint 映射到真实 `startAnchor.id / stop.id / endAnchor.id`；
2. 优先用 RouteLeg `fromNodeId / toNodeId` 精确匹配；
3. 只有无法得到 endpoint ID 时才回退 Place ID。

因此同一天出现：

```text
A → B → A → B
```

时，两段 A → B 可以分别拿到自己的 Provider 结果。

### 响应式排序

- 桌面仍然只有拖动把手作为排序入口。
- <=900px 增加 `上移 / 下移` fallback，避免触屏浏览器原生 drag 支持不稳定时无法排序。

---

## 本轮静态 Code Review 修复项

Review 过程中发现并已修复：

1. **地点名污染**：Drawer 仍存在 activity 作为地点名 fallback。
2. **同地过夜假交通**：same-place synthetic hop 曾可显示 / 编辑交通。
3. **Provider unavailable 表达错误**：无真实事实的 attention route 不应显示成普通待计算数字。
4. **RouteLeg 重复 Place 错配**：重复 A → B 时不能永远取第一条 leg。
5. **transport editor 残留状态**：连接消失后编辑状态可能在以后意外恢复。
6. **隐藏插入位置**：新增地点打开时不再继承不可见旧 selection。
7. **重复地点插入目标歧义**：增加线路序号。
8. **Pending Proposal 丢失风险**：历史截断不再作用于 pending。
9. **移动端排序可用性**：增加窄屏上移 / 下移 fallback。
10. **旧测试夹具错误**：RouteLeg nodeId 改为与真实 DayRouteService 的 Anchor ID 语义一致。

---

## 最终改动范围

Phase 5 相对 Phase 4 r2 基线只修改 Web / 测试：

```text
apps/web/src/FinalRouteEditorDrawerV4.tsx
apps/web/src/FinalRoutePanelV3.tsx
apps/web/src/final-route-ui-v3.ts
apps/web/src/final-route-ui-v3.test.ts
apps/web/src/final-route-ui-v5-review.test.ts
apps/web/src/final-route-ui-v5-factless.test.ts
apps/web/src/phase4-final-route-interaction.test.ts
apps/web/src/phase5-final-route-polish.css
apps/web/src/phase5-final-route-polish.test.ts
apps/web/src/main.tsx
```

**没有修改任何 server finalRoute / Day / Route 核心文件。**

---

## 验证说明

按当前施工规则和用户最新要求：

```text
本轮未运行 test
未运行 typecheck
未运行 build
未运行 app
未运行 Provider / CI
未运行浏览器测试
```

本轮已完成的是：

```text
全部计划内代码施工
静态数据流 Review
静态边界 Review
针对 Review 发现的问题补充 / 修改测试代码
冻结 Branch + HEAD
```

如后续需要验证，可以单独执行自动测试 / typecheck / build；**不需要浏览器测试作为 Gate**。
