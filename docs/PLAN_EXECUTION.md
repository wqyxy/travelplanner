# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)  
> 施工规则：[`PLAN_IMPLEMENTATION_PROMPT.md`](./PLAN_IMPLEMENTATION_PROMPT.md)  
> 施工进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 目标

把旧五步流程收敛为两个核心工作区：

```text
规划 · 旅行需求
行程 · 最终线路
```

用户只维护一份最终线路。地点顺序、状态、住宿分界和到达交通保存在 finalRoute；Day、地图和交通路线都从最终线路得到。

核心原则：

- 用户是唯一决策者，AI 只辅助；
- 不因为路线“不合理”自动修改用户结果；
- 地图只负责展示 / 选择 / 定位辅助；
- 业务修改统一从右侧进入；
- Provider 坐标、真实距离、时长、geometry 和验证事实不能由 UI / AI / API 调用方伪造。

---

# 2. 实施阶段

## Phase 1：最终线路底层与自动 Day / Route 基础

状态：completed

最终验收：

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
Phase 1: PASS
Test Files: 83 passed / 0 failed / 83 total
Tests: 479 passed / 0 failed / 479 total
```

## Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：awaiting_local_test

已实现：

- 正常 UI 只有“规划 · 旅行需求”和“行程 · 最终线路”；
- 手工添加地点直接进入 finalRoute；
- 排序、三状态、住 / 不住 / 多一晚、到达交通；
- 地点编辑和定位修复；
- 地图展示全部已定位 finalRoute 节点；
- 地图业务修改入口仍统一在右侧；
- finalRoute 变化自动派生 Day，并触发 dirty Route 刷新。

### Phase 2 R1

```text
Test Branch: test/plan-phase2-final-route-ui-20260905
Test HEAD: 762c8926fedb1b2fd73f113ab2989f2a207bb990
Phase 2: FAIL
```

R1 的 typecheck、专项、完整回归、build 全部通过，但独立审计发现两个 High：

1. inactive 节点退出当前 Day 后，dirty 旧 Provider geometry 仍可能经过该节点。
2. finalRoute 交通命令可以保存调用方伪造的 duration / note / verified 事实。

### Phase 2 R2 修复

修复 1：最终线路地图只接受仍与**当前 Day 节点拓扑**一致的 Provider leg。

校验维度：

```text
fromNodeId
fromPlaceId
toNodeId
toPlaceId
```

因此 tentative / no_go 节点对应的旧 leg 会被隐藏；同时同 Place 多 route node 也不会误判。

修复 2：finalRoute mutation 对交通输入统一正规化，仅保留用户选择的 mode：

```text
mode = selected mode
durationMinutes = null
note = null
verification.status = unverified
verification.checkedAt = null
```

`mode=none` 保存为 null。

该规则覆盖：

- `set_final_route_transport`
- `add_final_route_node.transportFromPrevious`

施工 Agent 没有运行任何测试。

## Phase 3：AI 生成 / 局部补充 / 显式优化 + 旧流程清理

状态：pending

Phase 2 PASS 以前不得开始。

---

# 3. 测试规则

施工 Agent不得执行：

- test
- typecheck
- build
- 应用启动
- Provider 运行验证
- CI / GitHub Actions

每次待测代码变化后都必须冻结新的：

```text
Test Branch
Test HEAD
```

旧 PASS / FAIL 只对应旧 HEAD，不自动适用于新代码。

---

# 4. Phase 2 R2 本地 Codex 测试 Prompt

> Test Branch: `test/plan-phase2-final-route-ui-20260905-r2`  
> Test HEAD: `aa55a6d616902d1c436b8f796c8e1be3c0a7f354`

你是 TravelPlanner Phase 2 R2 的独立测试 Agent。

不要相信施工 Agent 的完成声明，只根据指定 Git 基线、实际代码和本地执行结果判断。

本轮重点是验证 R1 的两个 High 已修复，同时确认没有造成回归。

不要施工 Phase 3，不要为了让测试通过而修改生产代码。

## 4.1 先检查 Git 基线

测试前只能先执行：

```bash
git branch --show-current
git rev-parse HEAD
git status --short
```

必须严格满足：

```text
Branch = test/plan-phase2-final-route-ui-20260905-r2
HEAD   = aa55a6d616902d1c436b8f796c8e1be3c0a7f354
```

不一致立即停止并输出：

```text
TEST_BASE_MISMATCH
```

禁止测试 Agent 为了匹配基线自行执行：

```text
git checkout
git switch
git pull
git merge
git rebase
git reset
git cherry-pick
```

如果工作树存在影响待测代码的修改，立即停止并输出：

```text
TEST_WORKTREE_DIRTY
```

冻结测试分支后，施工 Agent 才会在 `main` 更新最终测试元数据，因此测试分支中的 `PLAN_EXECUTION.md` / `PLAN_PROGRESS.md` 可能仍记录旧测试基线。**本 Prompt 顶部 Branch + HEAD 是唯一有效基线。**

---

## 4.2 重点阅读

阅读：

- `apps/web/src/final-route-map-v3.ts`
- `apps/web/src/FinalRouteMapV3.tsx`
- `apps/web/src/final-route-map-v3.test.ts`
- `apps/server/final-route-v3.ts`
- `apps/server/final-route-plan-commands-v3.test.ts`
- `apps/server/day-route-v2.ts`
- `apps/server/plan-commands-v2.ts`

并对照：

- `docs/PLAN.md`
- 本 Prompt 中的 R1 问题描述。

---

## 4.3 Typecheck

执行：

```bash
npm run typecheck
```

Windows 如果 PowerShell 执行策略阻止 `npm.ps1`，可使用：

```bash
npm.cmd run typecheck
```

记录实际命令。

---

## 4.4 Phase 2 R2 专项测试

执行：

```bash
npx vitest run --config vitest.config.ts \
  apps/web/src/final-route-map-v3.test.ts \
  apps/web/src/final-route-ui-v3.test.ts \
  apps/web/src/phase2-final-route-cutover.test.ts \
  apps/server/final-route-plan-commands-v3.test.ts \
  apps/server/final-route-v3.test.ts \
  apps/server/travel-store-final-route-v3.test.ts \
  apps/server/day-route-v2.test.ts \
  apps/server/plan-route-order-v2.test.ts
```

Windows 使用等价 `.cmd` 入口即可。

---

## 4.5 R1 High #1：inactive 节点旧路线 geometry

必须做独立负向审计，不只看已有测试。

构造：

```text
旧 Provider Route: A → X → B
当前 finalRoute:   A → X(tentative) → B
当前派生 Day:      A → B
旧 Route 状态:     dirty
```

要求：

- 地图点仍显示 A、X、B；
- X 仍显示 tentative 状态；
- 地图 route source **不得**输出 A→X 或 X→B；
- 如果 dirty Route 中同时存在仍与当前 Day 完全匹配的 A→B leg，可以作为 dirty 参考线保留；
- 匹配必须同时检查 node identity 和 Place identity，不能只比较 Place ID。

另外增加一个同 Place 多节点探针，确认两个 route node 即使引用相同 Place，也不会因为 placeId 相同而把旧 inactive leg 误保留。

如果仍存在经过 inactive route node 的 geometry：

```text
Phase 2: FAIL
```

---

## 4.6 R1 High #2：finalRoute transport 事实边界

直接通过 `applyPlanCommands` 提交：

```text
type = set_final_route_transport
mode = drive
durationMinutes = 987
note = claimed fact
verification.status = verified
verification.checkedAt = 有效时间
```

命令可以被结构层读取，但最终保存到 finalRoute 的值必须是：

```text
mode = drive
durationMinutes = null
note = null
verification.status = unverified
verification.checkedAt = null
```

再通过 `add_final_route_node` 创建节点，并在 `transportFromPrevious` 中夹带同样伪造事实。

最终新增节点也必须只保存 mode，其余事实被清空。

再验证：

```text
mode = none
```

最终应保存为：

```text
transportFromPrevious = null
```

任何调用方提供的：

- durationMinutes
- note
- verified / estimated 状态
- checkedAt

都不能成为 finalRoute 中的 Provider / 验证事实。

如果任意入口仍可保存这些伪造值：

```text
Phase 2: FAIL
```

---

## 4.7 完整回归

执行：

```bash
npm test
```

这是 Phase 2 R2 的强制 Gate。

记录：

```text
Test Files: x passed / x failed / x total
Tests: x passed / x failed / x total
```

任何正式测试失败都判定 Phase 2 FAIL。

---

## 4.8 Build

执行：

```bash
npm run build
```

Windows 可以使用：

```bash
npm.cmd run build
```

bundle 体积 warning 本身不算失败，但真正 build error 算 FAIL。

---

## 4.9 浏览器 / UI

如果本地环境有可用浏览器，再验证：

1. `A → X → B` 中把 X 改为待定 / 不去后，地图点保留 X，但旧虚线路线不再经过 X；
2. 恢复 X 为 normal 后，重新计算后的路线可再次经过 X；
3. 地图 Popup 仍没有删除 / 状态 / 住宿 / 优化等第二套业务入口。

如果环境没有浏览器，明确写：

```text
浏览器 / UI 验证：未覆盖
```

不要伪造 E2E PASS。

真实外部 Provider 网络调用不是本轮强制 Gate。

---

## 4.10 独立临时审计

允许创建一次性 Vitest 做负向测试。

要求：

- 不修改生产代码；
- 测试结束删除临时文件；
- 最终 `git status --short` 恢复干净；
- 报告临时测试数量和结果。

独立审计至少覆盖：

1. dirty A→X / X→B 在 X inactive 后被地图过滤；
2. 同 Place 不同 route node 不会混淆；
3. set transport 伪造事实被清空；
4. add node 夹带伪造 transport facts 被清空；
5. mode=none 最终为 null。

---

## 4.11 最终输出

严格输出：

```text
Test Branch: test/plan-phase2-final-route-ui-20260905-r2
Test HEAD: aa55a6d616902d1c436b8f796c8e1be3c0a7f354

Phase 2: PASS / FAIL

实际执行的测试：

- git branch --show-current: ...
- git rev-parse HEAD: ...
- git status --short: ...
- npm run typecheck: PASS / FAIL
- Phase 2 R2 专项: PASS / FAIL
- R1 High #1 独立审计: PASS / FAIL
- R1 High #2 独立审计: PASS / FAIL
- npm test: PASS / FAIL
- npm run build: PASS / FAIL
- 浏览器 / UI 验证: PASS / FAIL / 未覆盖
- 独立临时审计: ...

完整测试统计：

- Test Files: ...
- Tests: ...

发现的问题：

1. [Blocker / High / Medium / Low] ...
   - 文件：
   - 复现：
   - 实际：
   - 预期：
   - 原因判断：

未覆盖或无法验证：

- ...

是否建议进入 Phase 3：是 / 否

原因：
...
```

如果 Git 基线错误，只输出：

```text
TEST_BASE_MISMATCH

Expected Branch: test/plan-phase2-final-route-ui-20260905-r2
Actual Branch: ...

Expected HEAD: aa55a6d616902d1c436b8f796c8e1be3c0a7f354
Actual HEAD: ...
```

如果工作树不干净并影响待测代码，只输出：

```text
TEST_WORKTREE_DIRTY
```
