# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)  
> 当前产品：[`PRODUCT.md`](./PRODUCT.md)  
> 当前技术：[`TECHNICAL.md`](./TECHNICAL.md)  
> 施工进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 当前目标

旧五步产品已经收敛为：

```text
规划 · 旅行需求
行程 · 最终线路
```

唯一用户线路是 `finalRoute`。

Phase 1 已完成 finalRoute / Day / Route 底层；Phase 2 已完成右侧人工规划 + 地图；Phase 3 负责把 AI 生成、详细安排、显式优化都切到最终线路语义。

核心权限：

```text
普通 AI 生成 = 只能新增
完善这一天 = 只能改授权节点详细安排
显式优化 = 只能重排授权现有节点
```

地图不是第二业务入口，Provider 事实不能伪造。

---

# 2. 已完成阶段

## Phase 1

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
Phase 1: PASS
```

## Phase 2

```text
Test Branch: test/plan-phase2-final-route-ui-20260905-r2
Test HEAD: aa55a6d616902d1c436b8f796c8e1be3c0a7f354
Phase 2: PASS
```

---

# 3. Phase 3 实现摘要

## 3.1 主要地点

- `destination.generate` → 用户看到“生成主要地点”。
- 只允许空 finalRoute 第一次生成。
- AI candidate 顺序直接形成 route node 顺序。
- `routeSuggestion` 只对本轮新节点表达 `endsDay / transportMode`。
- 无默认一晚，无 stayDays。
- 同一 Place 可多次出现，每次独立 route node。

## 3.2 详细地点

- `interest.discover / supplement` → “生成 / 补充详细地点”。
- 复用已有 AI 研究、0–9、正式化、去重、定位和任务基础设施。
- 只插入本轮新增 route nodes。
- 所有旧 route node 的顺序和字段保持不变。
- 支持 trip / day / segment scope。
- 局部 scope 找不到合法锚点时 fail closed。

## 3.3 详细安排

- 详细时间 / 活动 / 备注直接属于 route node。
- 右侧可以编辑 activity / period / startTime / endTime / durationMinutes / notes。
- Day 可点击“完善这一天”（内部 `itinerary.refine`）。
- refine 不能增删 / 重排地点、改 status / endsDay。
- transport 和 verification 字段被服务器强制保持当前值。
- refine 结果先形成 Proposal。

## 3.4 显式优化

- `优化这一天`：只重排目标 Day stops，Day end boundary 固定。
- `优化这一段`：只重排指定 route span 内 normal nodes。
- `优化全程`：只重排所有 normal nodes。
- AI 必须返回授权 ID 完整集合，不能新增 / 删除 / 重复 / unknown。
- inactive 节点固定原槽位。
- 只产生 `move_final_route_node` Proposal。
- apply / undo 后自动重算路线。

## 3.5 当前技术过渡

部分旧 Day / Action contract 仍作为内部实现被复用，例如手工详细安排和 refine 会经过 Day→finalRoute 写入桥。

它们不是用户可见 Step，也不能成为第二份路线。

旧持久化数据仍不迁移。

---

# 4. Phase 3 R1 结果与 R2 修复

R1：

```text
Test Branch: test/plan-phase3-final-route-ai-20260905
Test HEAD: b736706424aa00aa1f3fd2db18a1ae915dc84afc
Phase 3: FAIL
Typecheck: FAIL
Phase 3 专项: 8 files passed / 2 failed；52 / 54 tests passed
AI / Prompt / Runtime 回归: PASS
npm test: 86 files passed / 2 failed；503 / 505 tests passed
build: FAIL（Server TypeScript）
独立临时审计: 12 / 12 PASS
```

R1 的失败不是新的产品权限缺口，集中在三个工程验收点：

1. Runtime 重复实现 refine sanitize，Map value 类型被推断成 `{}`。
2. sanitizer clone 整个联合类型后丢失 `success` 判别收窄。
3. 正式 refine 测试没有构造中途 Day Stop；单日优化 Prompt 与测试断言只有字面差异。

R2 修复：

- `persistRefine` 统一调用 `sanitizeFinalRouteRefineOutputV3`，删除 Runtime 里的重复 sanitize 代码。
- sanitizer 在已收窄 success result 上 clone 和遍历，再组装返回值。
- refine 测试使用 `A → B → C`，明确以 B 作为中途 Stop 验证权限。
- 单日优化 Prompt 统一成“只有用户明确启动本动作后”。
- 产品权限、Provider 事实边界、最终线路数据规则均未改变。

施工 Agent 仍然不运行 test / typecheck / build / app / Provider / migration / CI。

---

# 5. Phase 3 R2 本地 Codex 测试 Prompt

> Test Branch: `__TEST_BRANCH_R2__`  
> Test HEAD: `__TEST_HEAD_R2__`

你是 TravelPlanner Phase 3 R2 独立测试 Agent。

不要相信施工 Agent 的完成声明。只根据指定 Git 基线、实际代码和本地执行结果判断。

不要施工或修复生产代码。

## 5.1 Git 基线

测试前只能先执行：

```bash
git branch --show-current
git rev-parse HEAD
git status --short
```

必须严格等于本 Prompt 顶部 Test Branch / Test HEAD。

Branch 或 HEAD 不一致：

```text
TEST_BASE_MISMATCH
```

不要自行 checkout / switch / pull / merge / rebase / reset / cherry-pick。

如果工作树存在影响待测代码的修改：

```text
TEST_WORKTREE_DIRTY
```

冻结分支里的本文件可能仍显示 `__TEST_BRANCH_R2__ / __TEST_HEAD_R2__`；本地测试时以用户拿到的测试 Prompt 顶部精确 Branch + HEAD 为准。

## 5.2 第一优先：复测 R1 三个失败点

### TypeScript / Server build

先执行：

```bash
npm run typecheck
```

Windows 执行策略阻止 `npm.ps1` 时可用：

```bash
npm.cmd run typecheck
```

重点确认不再出现：

```text
TS2339 current.transportFromPrevious
TS2339 current.scheduleVerification
TS2339 current.costVerification
TS2339 sanitized.result.dayUpdates
```

### refine 正式权限测试

确认 `apps/server/final-route-ai-v3.test.ts` 的 refine case 真实形成：

```text
A → B → C
```

其中 B 必须是 `day.stops[0]`，再验证：

- activity / scheduleText / startTime / endTime / duration / notes 可以更新；
- transportFromPrevious 必须恢复当前值；
- scheduleVerification / costVerification 必须恢复当前值。

测试不能在调用 sanitizer 前因为 `currentStop=undefined` 自己崩溃。

### Prompt 字面锁定

确认：

```text
prompts/actions/itinerary/优化单日游览顺序.md
```

包含：

```text
只有用户明确启动本动作
```

并且权限语义仍然是：没有用户显式调用就不能优化已有顺序。

## 5.3 Phase 3 专项

```bash
npx vitest run --config vitest.config.ts \
  apps/server/final-route-ai-v3.test.ts \
  apps/server/planning-roles-v3.test.ts \
  apps/web/src/phase3-final-route-ai-cutover.test.ts \
  apps/web/src/final-route-ui-v3.test.ts \
  apps/web/src/final-route-map-v3.test.ts \
  apps/web/src/phase2-final-route-cutover.test.ts \
  apps/server/final-route-v3.test.ts \
  apps/server/final-route-plan-commands-v3.test.ts \
  apps/server/travel-store-final-route-v3.test.ts \
  apps/server/day-route-v2.test.ts
```

## 5.4 AI / Prompt / Runtime 回归

```bash
npx vitest run --config vitest.config.ts \
  apps/server/ai-registries-v3.test.ts \
  apps/server/prompt-registry-v3.test.ts \
  apps/server/ai-action-contracts-v3.test.ts \
  apps/server/planner-runtime-v3.test.ts \
  apps/server/planner-runtime-v3-ai-actions.test.ts \
  apps/server/interest-discovery-v3.test.ts \
  apps/server/planner-runtime-v3-detail-phase5.test.ts
```

## 5.5 完整回归

```bash
npm test
```

这是强制 Gate。任何正式测试失败都必须：

```text
Phase 3: FAIL
```

记录完整 Test Files / Tests passed / failed / total。

## 5.6 Build

```bash
npm run build
```

Windows 可以：

```bash
npm.cmd run build
```

bundle 体积 warning 不算失败；Server TypeScript error 算失败。

---

# 6. 必做独立审计

R1 已经有 12 / 12 独立行为探针 PASS，但 R2 仍需至少抽查关键权限，不能只因为编译通过就直接 PASS。

至少验证：

1. 主地点直接形成 finalRoute。
2. `A → B → A` 同 Place 多 route node。
3. 详细地点只新增，旧节点所有字段与相对顺序保持。
4. Day / segment scope 找不到合法锚点时 fail closed。
5. 手工地点可作为 planning area 研究锚点。
6. refine 可改活动 / 时间 / 备注，但不能改 transport / verification。
7. 单日 optimize 固定 Day boundary。
8. segment / trip optimize 只移动授权 normal nodes，inactive 原槽位固定。
9. Proposal apply / reject / undo 与 stale generation。
10. Provider transport 只保存 mode。
11. 生产入口仍只有旅行需求 / 最终线路。
12. Map Popup 仍无第二套业务按钮。

优化 apply / undo 后 Route batch 如果无法真实调用 Provider，可以做静态调用链审计并明确标注未执行真实 Provider。

---

# 7. 浏览器 / UI 验证

如果本地环境有浏览器，验证右侧 AI / Proposal / 详细安排和地图单一职责。

如果没有浏览器能力，必须写：

```text
浏览器 / UI 验证：未覆盖
```

不要伪造 E2E PASS。

真实外部 Provider 网络调用不是本阶段强制 Gate。

---

# 8. 独立临时测试

允许创建一次性 Vitest，但：

- 不修改生产代码；
- 测完删除临时文件；
- 最终工作树干净。

本轮建议把重点放在：

- sanitizer 对真实 Day Stop 的字段保护；
- Runtime 确实复用 sanitizer；
- union result 的 success / requires-workflow 分支都保持合法；
- R1 已通过的权限边界没有回归。

---

# 9. 最终输出格式

严格输出：

```text
Test Branch: <actual branch>
Test HEAD: <actual 40-char SHA>

Phase 3: PASS / FAIL

实际执行的测试：
- git branch --show-current: ...
- git rev-parse HEAD: ...
- git status --short: ...
- npm run typecheck: PASS / FAIL
- R1 三个失败点复测: PASS / FAIL
- Phase 3 专项: PASS / FAIL
- AI / Prompt / Runtime 回归: PASS / FAIL
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

是否建议完成本轮 PLAN：是 / 否

原因：
...
```
