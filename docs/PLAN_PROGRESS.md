# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 3 — AI 直接写最终线路 + 显式优化 + 旧流程收敛  
总体状态：awaiting_local_test  
最后更新时间：2026-09-05

---

## 已确认的产品决定

- 用户只维护一份最终线路。
- 同一 Place 可以在线路中出现多次，每次拥有独立 route node ID。
- tentative / no_go 保留原顺序、endsDay、到达交通和地图点，但暂时退出当前 Day / Route。
- 交通属于“到达当前节点”。
- 住 / 不住只控制 endsDay；多一晚新增同 Place 独立 route node。
- Day 根据 finalRoute 自动派生；最后一天不要求住宿分界。
- 右侧最终线路是唯一业务入口；地图不提供第二套业务按钮。
- 普通 AI 生成只能新增节点，不能修改已有节点。
- 只有用户显式点击优化时，AI 才能重排服务端授权范围内的已有 normal 节点。
- 详细安排继续属于 finalRoute：活动、时间、停留、备注能力保留，不恢复旧 Step 5。
- Provider 坐标、真实距离、真实时长、geometry、verified 事实不能由 UI / AI / API 调用方伪造。

---

## 测试规则

- 施工 Agent 不运行 test / typecheck / build / app / Provider / migration / CI。
- 用户本地 Codex 独立测试。
- 测试绑定唯一 Test Branch + 40 位 Test HEAD。
- 任意待测代码变化都会使旧测试结果失效。
- 匹配基线 PASS 前，不把 Phase 3 标记 completed。

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

---

# Phase 2

状态：completed

最终验收：

```text
Test Branch: test/plan-phase2-final-route-ui-20260905-r2
Test HEAD: aa55a6d616902d1c436b8f796c8e1be3c0a7f354
Phase 2: PASS
Test Files: 86 passed / 0 failed / 86 total
Tests: 489 passed / 0 failed / 489 total
```

---

# Phase 3

状态：awaiting_local_test

## 已完成施工

### AI 主要地点

- `destination.generate` 用户语义改为“生成主要地点”。
- 只允许 finalRoute 为空时第一次生成，不能覆盖已有用户线路。
- AI output candidate 顺序直接成为新 route node 顺序。
- 新节点可带 `routeSuggestion.endsDay / transportMode`；没有“每个地点默认住一晚”。
- transport 仍只保存 mode，不制造 Provider 事实。
- 同一现实 Place 可在 AI 主线路出现多次，每次创建独立 route node。

### AI 详细地点

- `interest.discover / supplement` 用户语义改为“生成 / 补充详细地点”。
- 复用原并行研究、0–9 数量、正式化、去重、定位和任务进度。
- Store 写入前只为本轮真正新增的 detail candidates 创建 route nodes。
- 所有已有 route nodes 的相对顺序和字段必须保持不变。
- 支持 trip / day / segment scope。
- Day / segment scope 找不到范围内合法锚点时 fail closed，不回退范围外位置。

### 手工线路地点作为研究锚点

- 手工从最终线路新增 Place 会同步创建隐藏 `planning_area` Candidate。
- 这只是 AI 详细地点研究锚点，不改变 Place.kind，不自动住宿。
- 有 parent candidate 的地点在未显式 role 时固定推导为 `detail_interest`，即使 Place.kind=city。

### 详细安排

- 旧 Step 5 页面没有恢复。
- 最终线路右侧直接编辑 activity / period / startTime / endTime / durationMinutes / notes。
- `scheduleText` 已存在时直接展示。
- 当前内部写入复用已验证的 deterministic `itinerary.edit` + Day→finalRoute 桥。
- 每个有 Stop 的 Day 可点击“完善这一天”（内部 `itinerary.refine`）。
- AI refine 只能更新授权 Day 的既有 Stop 详细字段。
- AI 返回的 transportFromPrevious / scheduleVerification / costVerification 会被服务端恢复为当前值，不能借 refine 改路线事实或伪造 verified。
- refine 结果走 Proposal，由用户 apply / reject。

### 显式优化

- “优化这一天”：只授权目标 Day 当前 Stop route-node IDs，Day end boundary 固定。
- “优化这一段”：只授权选定连续 route span 内 normal nodes。
- “优化全程”：只授权整条 finalRoute 的 normal nodes。
- AI 必须恰好返回授权 ID 集合的新顺序；新增 / 删除 / 重复 / unknown ID 全部拒绝。
- tentative / no_go 不在授权集合，原槽位固定。
- 优化只生成 `move_final_route_node` Proposal；用户决定 apply / reject / undo。
- 优化 Proposal apply / undo 后自动启动 Route batch 更新地图路线。

### 右侧唯一入口

`FinalRoutePanelV3` 当前包含：

- 生成主要地点；
- 生成详细地点；
- 某 Day / 某段补充详细地点；
- 完善这一天；
- 优化这一天 / 这一段 / 全程；
- AI Proposal apply / reject / undo；
- 原有人工线路操作、详细安排、地点编辑、定位修复。

Map Popup 不增加 AI / 业务修改入口。

### Prompt / 文档

已重写主要 AI Prompt 为最终线路语言：

- 生成主要地点；
- 生成详细地点；
- 补充详细地点；
- 完善这一天；
- 优化这一天；
- 优化这一段或全程。

已同步 `PRODUCT.md` / `TECHNICAL.md` 为当前两工作区产品和技术现状。

### 仍保留的内部旧代码

旧 `AppWorkflowV3`、Candidate/Skeleton/Daily Itinerary 组件和部分旧 Action contract 仍有源码存在，用于内部兼容、测试或当前写入桥；它们不再由生产入口挂载，也不能成为 finalRoute 之外的第二份用户线路来源。

本 Phase 没有 DB Schema 迁移，也没有恢复旧测试数据兼容。

## 施工侧验证

只做了：

- GitHub 静态读取 / 写入；
- 调用链审查；
- Scope / Schema / Prompt 对照；
- diff / 入口审查；
- 新增测试代码。

没有运行任何测试、typecheck、build、应用或 CI。

## 本地测试基线

```text
Test Branch: test/plan-phase3-final-route-ai-20260905
Test HEAD: b736706424aa00aa1f3fd2db18a1ae915dc84afc
```

测试分支已冻结；该分支内文档可能仍显示占位符，本次测试以这里记录的 Branch + HEAD 和用户拿到的测试 Prompt 顶部为准。

---

## 下一步

1. 用户本地 Codex 执行 `PLAN_EXECUTION.md` 的 Phase 3 Gate；
2. 返回匹配基线 PASS / FAIL；
3. PASS → Phase 3 completed，本轮 PLAN 完成；
4. FAIL → 只修 Phase 3 报告问题，生成新的测试基线。
