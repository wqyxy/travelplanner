# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)  
> 当前产品：[`PRODUCT.md`](./PRODUCT.md)  
> 当前技术：[`TECHNICAL.md`](./TECHNICAL.md)  
> 施工进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 当前目标

产品已经收敛为两个工作区：

```text
规划 · 旅行需求
行程 · 最终线路
```

唯一用户线路是 `finalRoute`。

Phase 1 已完成 finalRoute / Day / Route 底层；Phase 2 已完成右侧人工规划 + 地图；Phase 3 负责 AI 生成、详细安排和显式优化全部使用最终线路语义。

核心权限：

```text
普通 AI 生成 = 只能新增
完善这一天 = 只能改授权节点详细安排
显式优化 = 只能重排授权现有节点
```

地图不是第二业务入口，Provider 事实不能伪造。

---

# 2. 已通过阶段

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

# 3. Phase 3 当前实现

- `destination.generate` 直接生成 finalRoute，不经过用户维护的 Candidate 页面。
- 同一 Place 可在线路中出现多次，每次独立 route node。
- `interest.discover / supplement` 只插入本轮新增详细地点，旧节点顺序和字段保持不变。
- trip / day / segment scope 在服务端硬限制；局部找不到合法锚点时 fail closed。
- 手工加入最终线路的地点可作为隐藏 planning area 研究锚点，但不改变 Place.kind、不自动住宿。
- 详细时间 / 活动 / 备注直接属于 route node；右侧可人工编辑。
- `itinerary.refine` 只完善授权 Day 的详细安排，并通过共享 `sanitizeFinalRouteRefineOutputV3` 强制保护 transport / verification。
- `优化这一天 / 这一段 / 全程` 只产生授权节点的 move Proposal。
- inactive 节点不进入优化授权集合，原槽位固定。
- Proposal apply / undo 后自动启动 Route batch。
- 正常 UI 仍只有旅行需求 / 最终线路，地图没有第二套业务按钮。

---

# 4. Phase 3 测试历史

## R1

```text
Test Branch: test/plan-phase3-final-route-ai-20260905
Test HEAD: b736706424aa00aa1f3fd2db18a1ae915dc84afc
Phase 3: FAIL
```

修复：Runtime refine 复用共享 sanitizer；修复 TypeScript 联合类型收窄；refine 测试改为真实中途 Stop；单日优化 Prompt 与测试字面一致。

## R2

```text
Test Branch: test/plan-phase3-final-route-ai-20260905-r2
Test HEAD: 635f2b8bcaa805f3dacf12e3134ae6b175a71a19
Phase 3: FAIL
Typecheck: PASS
R1 三个失败点复测: PASS
Phase 3 专项: 53 / 54 tests passed
AI / Prompt / Runtime 回归: PASS
npm test: 504 / 505 tests passed
Build: PASS
```

R2 没有新的产品逻辑缺口，只剩两个测试契约问题：cutover 测试仍要求旧内联 sanitize；重复 Place 正式测试没有精确覆盖 A → B → A。

## R3 修复

- cutover 正式测试改为验证共享 sanitizer 的导入与调用，并禁止第二套内联清洗。
- 重复 Place 正式测试改为真实 A → B → A，两个 A 正式化后复用同一 Place，但 route node ID 独立。
- 没有修改生产代码或产品行为。

施工 Agent 没有运行 test / typecheck / build / app / Provider / migration / CI。

---

# 5. Phase 3 R3 本地 Codex 测试 Prompt

> Test Branch: `test/plan-phase3-final-route-ai-20260905-r3`  
> Test HEAD: `8b17dde239484e79a98b7900766442d1b8836ea2`

你是 TravelPlanner Phase 3 R3 独立测试 Agent。

不要相信施工 Agent 的完成声明，只根据指定 Git 基线、实际代码和本地执行结果判断。

不要修改或修复生产代码。

## 5.1 Git 基线

测试前只能执行：

```bash
git branch --show-current
git rev-parse HEAD
git status --short
```

必须严格满足：

```text
Branch = test/plan-phase3-final-route-ai-20260905-r3
HEAD = 8b17dde239484e79a98b7900766442d1b8836ea2
工作树干净
```

Branch / HEAD 不一致：

```text
TEST_BASE_MISMATCH
```

工作树存在影响待测代码的修改：

```text
TEST_WORKTREE_DIRTY
```

不要自行 checkout / switch / pull / merge / rebase / reset / cherry-pick。

## 5.2 R2 唯一失败点复测

### A. 共享 sanitizer 测试合同

`apps/web/src/phase3-final-route-ai-cutover.test.ts` 必须验证：

- `final-route-ai-cutover-v3.ts` 导入 `sanitizeFinalRouteRefineOutputV3`；
- `persistFinalRouteDayDetails` 直接调用共享 sanitizer；
- Runtime 不存在第二套：

```text
stop.transportFromPrevious = structuredClone(...)
stop.scheduleVerification = structuredClone(...)
```

### B. A → B → A 正式回归

`apps/server/final-route-ai-v3.test.ts` 的重复 Place 测试必须真实形成：

```text
A → B → A
```

要求：

- 两个 A 来自不同临时 Place；
- 正式化后两个 A 引用同一现实 Place ID；
- 三个 route node ID 全部独立；
- 不得因为 Place / Candidate 去重而丢失回访 A；
- 必须是非相邻重复。

## 5.3 Typecheck

```bash
npm run typecheck
```

Windows 可使用：

```bash
npm.cmd run typecheck
```

## 5.4 Phase 3 专项

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

## 5.5 AI / Prompt / Runtime 回归

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

## 5.6 完整回归

```bash
npm test
```

这是强制 Gate。任何正式测试失败都必须判：

```text
Phase 3: FAIL
```

## 5.7 Build

```bash
npm run build
```

Windows 可使用：

```bash
npm.cmd run build
```

bundle warning 不算失败，真正 build error 算失败。

---

# 6. 独立审计

至少抽查：

1. A → B → A：同 Place、三个独立 route node。
2. 共享 sanitizer success 分支保护 transport / verification。
3. sanitizer 非 success union 分支仍合法返回。
4. Runtime refine 只调用共享 sanitizer。
5. 详细地点只新增，旧节点全字段不变。
6. Day / segment 局部生成 fail closed。
7. 单日 optimize 固定 Day boundary。
8. segment / trip optimize 只移动授权 normal 节点，inactive 固定槽位。
9. Proposal apply / reject / undo 与 stale generation。
10. Provider transport 只保存 mode。
11. 生产入口仍只有旅行需求 / 最终线路。
12. Map Popup 无第二套业务按钮。

允许创建一次性测试文件，但不得修改生产代码；测试后删除，最终工作树必须干净。

---

# 7. 浏览器 / Provider

有浏览器能力则验证右侧 AI / Proposal / 详细安排和地图单一职责。

没有浏览器能力写：

```text
浏览器 / UI 验证：未覆盖
```

不得伪造 E2E PASS。

真实外部 Route Provider 不是本阶段强制 Gate。

---

# 8. 最终输出

```text
Test Branch: test/plan-phase3-final-route-ai-20260905-r3
Test HEAD: 8b17dde239484e79a98b7900766442d1b8836ea2

Phase 3: PASS / FAIL

实际执行的测试：
- git branch --show-current: ...
- git rev-parse HEAD: ...
- git status --short: ...
- npm run typecheck: PASS / FAIL
- R2 唯一失败点复测: PASS / FAIL
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
