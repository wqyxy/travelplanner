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

## 产品施工已完成

- `destination.generate` 直接形成 finalRoute；已有线路时不能普通生成覆盖。
- 同一现实 Place 可多次成为独立 route node。
- `interest.discover / supplement` 只插入本轮新增详细地点，不得修改旧 route node。
- trip / day / segment 局部详细生成都有服务器范围限制；找不到范围内锚点时 fail closed。
- 手工加入最终线路的地点可作为内部 planning area 研究锚点，不改变 Place.kind、不自动住宿。
- 详细安排直接属于 route node；手工可编辑 activity / period / startTime / endTime / durationMinutes / notes。
- “完善这一天”只能修改授权 Day 的详细安排；transport / scheduleVerification / costVerification 强制保持当前值。
- “优化这一天 / 这一段 / 全程”只产生授权范围内的 move Proposal；inactive 节点固定槽位。
- Proposal apply / undo 后自动启动 Route batch。
- 右侧最终线路仍是唯一业务入口，Map Popup 没有第二套业务 mutation。
- `PRODUCT.md` / `TECHNICAL.md` 已同步为两工作区现状。

## R1 本地测试

```text
Test Branch: test/plan-phase3-final-route-ai-20260905
Test HEAD: b736706424aa00aa1f3fd2db18a1ae915dc84afc
Phase 3: FAIL
Typecheck: FAIL
Phase 3 专项: 52 / 54 tests passed
AI / Prompt / Runtime 回归: PASS
npm test: 503 / 505 tests passed
Build: FAIL（Server TypeScript）
独立临时审计: 12 / 12 PASS
```

R1 修复：

- Runtime refine 改为复用唯一 `sanitizeFinalRouteRefineOutputV3`。
- 修复 success 联合类型的 TypeScript 收窄。
- refine 正式测试改为 A → B → C，中途 B 是真实 Day Stop。
- 单日优化 Prompt 与正式字面断言同步。

## R2 本地测试

```text
Test Branch: test/plan-phase3-final-route-ai-20260905-r2
Test HEAD: 635f2b8bcaa805f3dacf12e3134ae6b175a71a19
Phase 3: FAIL
Typecheck: PASS
R1 三个失败点复测: PASS
Phase 3 专项: 53 / 54 tests passed
AI / Prompt / Runtime 回归: PASS（7 files / 63 tests）
npm test: 504 / 505 tests passed
Build: PASS
独立临时审计: PASS
```

R2 仅剩两个测试契约问题，没有发现新的产品逻辑问题：

1. `phase3-final-route-ai-cutover.test.ts` 仍断言旧的 Runtime 内联 refine 清洗代码，与 R2 已确定的“共享 sanitizer 单一实现”冲突。
2. 正式重复 Place 测试写成 B → A → A，没有精确锁定非相邻回访 A → B → A；独立探针已经确认实现支持 A → B → A。

## R3 修复

- cutover 源码审计测试改为验证 `sanitizeFinalRouteRefineOutputV3` 的导入与调用，并明确禁止恢复第二套内联 transport / verification 清洗。
- 重复 Place 正式测试改为真实 A → B → A：两个不同临时 A 正式化后复用同一 Place，最终保留三个独立 route node ID。
- 没有修改任何生产代码、产品权限、Provider 边界或 UI 行为。

## 施工侧验证

只做 GitHub 静态读取 / 写入、类型配置审查、测试合同对照和 diff 审查。  
没有运行任何 test、typecheck、build、应用或 CI。

## R3 本地测试基线

```text
Test Branch: test/plan-phase3-final-route-ai-20260905-r3
Test HEAD: 8b17dde239484e79a98b7900766442d1b8836ea2
```

测试分支已冻结；冻结后不再修改该分支。

---

## 下一步

1. 用户本地 Codex 重跑 Phase 3 强制 Gate；
2. 返回匹配 R3 Branch + HEAD 的 PASS / FAIL；
3. PASS → Phase 3 completed，本轮 PLAN 完成；
4. FAIL → 仅修新的报告问题，再冻结新基线。
