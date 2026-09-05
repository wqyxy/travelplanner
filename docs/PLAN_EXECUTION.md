# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)  
> 当前产品：[`PRODUCT.md`](./PRODUCT.md)  
> 当前技术：[`TECHNICAL.md`](./TECHNICAL.md)  
> 最终进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 最终结果

本轮 PLAN 已完成。

产品已经从旧五步收敛为两个工作区：

```text
规划 · 旅行需求
行程 · 最终线路
```

唯一用户线路是 `finalRoute`。

核心权限已经落实为：

```text
普通 AI 生成 = 只能新增
完善这一天 = 只能改授权节点详细安排
显式优化 = 只能重排授权现有节点
```

地图不是第二业务入口，Provider 事实不能伪造。

---

# 2. Phase 1 — completed

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
Phase 1: PASS
Test Files: 83 / 83 passed
Tests: 479 / 479 passed
```

完成：

- finalRoute 数据基础；
- Day 根据 finalRoute 自动派生；
- Route 与 Day 关系收敛；
- 新旅行数据策略；
- 当前 Runtime 过渡写入桥。

---

# 3. Phase 2 — completed

```text
Test Branch: test/plan-phase2-final-route-ui-20260905-r2
Test HEAD: aa55a6d616902d1c436b8f796c8e1be3c0a7f354
Phase 2: PASS
Test Files: 86 / 86 passed
Tests: 489 / 489 passed
```

完成：

- 右侧最终线路成为人工规划唯一业务入口；
- 重排、状态、住 / 不住、多一晚、到达交通；
- 同 Place 多 route node；
- 详细地点 / 定位修复；
- 地图展示所有已定位状态点；
- 地图路线只基于当前有效 Day；
- Provider 事实边界在服务端受控 mutation 层强制执行。

---

# 4. Phase 3 — completed

最终冻结验收：

```text
Test Branch: test/plan-phase3-final-route-ai-20260905-r3
Test HEAD: 8b17dde239484e79a98b7900766442d1b8836ea2

Phase 3: PASS
Typecheck: PASS
R2 唯一失败点复测: PASS
Phase 3 专项: PASS（10 files / 54 tests）
AI / Prompt / Runtime 回归: PASS（7 files / 63 tests）
npm test: PASS（88 files / 505 tests）
npm run build: PASS
独立临时审计: PASS
浏览器 / UI 验证: 未覆盖
真实外部 Route Provider: 未覆盖（非强制 Gate）
```

Phase 3 完成：

## 4.1 生成主要地点

- `destination.generate` 直接形成 finalRoute。
- 已有 finalRoute 时不能通过普通生成覆盖。
- AI 输出顺序直接形成新 route node 顺序。
- `routeSuggestion` 只作用于本轮新节点。
- 同一现实 Place 可以多次出现，每次拥有独立 route node。
- 正式回归已覆盖 `A → B → A`。

## 4.2 生成 / 补充详细地点

- `interest.discover / supplement` 继续复用原研究、正式化、定位和任务基础设施。
- 持久化到最终线路时只能插入本轮新增 route nodes。
- 已有 route node 的 ID、相对顺序、status、endsDay、transport 和 detail fields 均不能被普通生成改写。
- trip / day / segment scope 都由服务端校验。
- 局部 scope 找不到范围内合法锚点时 fail closed。

## 4.3 详细安排

- activity / period / startTime / endTime / durationMinutes / notes 属于 finalRoute node。
- 右侧可以直接人工编辑。
- “完善这一天”通过 `itinerary.refine` 产生 Proposal。
- Runtime 统一调用共享 `sanitizeFinalRouteRefineOutputV3`。
- AI 可以完善活动 / 时间 / 备注，但 transport / scheduleVerification / costVerification 强制保持当前事实。
- 不恢复旧 Step 5 页面。

## 4.4 显式优化

- 优化这一天：只授权目标 Day 当前可移动 Stop route-node IDs。
- 优化这一段：只授权连续线路范围内 normal nodes。
- 优化全程：只授权整条线路 normal nodes。
- AI 必须恰好返回授权 ID 集合，新增 / 删除 / 重复 / unknown ID 全部拒绝。
- tentative / no_go 不在授权集合，原槽位固定。
- 优化只产生 move Proposal，用户决定 apply / reject / undo。
- Proposal stale generation / CAS 路径已回归。
- apply / undo 后自动启动 Route batch。

## 4.5 唯一用户入口

正常生产 UI 只有：

```text
规划 · 旅行需求
行程 · 最终线路
```

最终线路右侧包含 AI 和人工业务操作；地图只展示、选择、聚焦和响应从右侧启动的选点，不提供第二套同类 mutation。

---

# 5. 测试历史

Phase 3 没有跳过失败 Gate：

- R1 FAIL：TypeScript、refine 测试夹具、Prompt/断言问题。
- R2 FAIL：两个正式测试仍绑定旧实现合同。
- R3 PASS：全部正式 Gate 通过。

施工 Agent 没有自行运行 test / typecheck / build / app / Provider / migration / CI；所有正式 PASS / FAIL 均来自用户本地 Codex 对冻结 Branch + HEAD 的测试。

---

# 6. 后续开发基线

后续需求应以以下文件作为当前事实：

- `docs/PRODUCT.md`：当前产品现状；
- `docs/TECHNICAL.md`：当前技术现状；
- `docs/PLAN.md`：本轮目标与产品规则背景；
- `docs/PLAN_PROGRESS.md`：本轮完成记录与冻结测试结果。

旧 `AppWorkflowV3`、Candidate / Skeleton / Daily Itinerary 组件和部分旧 Action contract 仍可能作为内部兼容、测试或过渡桥存在，但它们不是当前用户流程，也不得重新形成 finalRoute 之外的第二份用户线路来源。
