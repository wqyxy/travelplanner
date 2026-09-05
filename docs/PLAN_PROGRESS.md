# TravelPlanner PLAN Progress

## Overall Status

当前阶段：本轮 PLAN 已完成  
总体状态：completed  
最后更新时间：2026-09-06

---

## 最终产品决定

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
- 右侧最终线路是唯一业务入口；地图只负责展示、选择、聚焦和从右侧发起的定位选点。
- 普通 AI 生成只能新增节点，不能修改已有节点。
- “完善这一天”只能修改授权节点的详细安排。
- 只有用户显式点击优化时，AI 才能重排服务端授权范围内的已有 normal 节点。
- Provider 坐标、真实距离、真实时长、geometry、verified 事实不能由 UI / AI / API 调用方伪造。

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
- `PRODUCT.md` / `TECHNICAL.md` 已同步为当前两工作区现状。

---

## 测试历史

Phase 3 R1 和 R2 都按 Gate 判 FAIL 后修复并重新冻结，没有用旧 PASS 覆盖新代码：

- R1：TypeScript / refine 测试夹具 / Prompt 字面问题。
- R2：两个正式测试契约仍停留在旧实现。
- R3：全部正式 Gate PASS。

施工 Agent 全程没有运行 test / typecheck / build / app / Provider / migration / CI；正式结果来自用户本地 Codex 的冻结基线测试。

---

## 本轮 PLAN 结论

本轮 `PLAN.md` 对应施工已经完成。

当前代码仍保留少量旧 Runtime / Action / UI 源码作为内部兼容、测试或过渡桥，但它们不再从正常生产入口形成第二套用户规划流程，也不能成为 finalRoute 之外的第二份用户线路来源。

后续新需求应基于当前 `PRODUCT.md`、`TECHNICAL.md` 和 finalRoute 两工作区继续演进，不再以旧五步产品为当前设计基线。
