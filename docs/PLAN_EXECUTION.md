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

# 4. 施工规则

施工 Agent 不运行：

```text
test
typecheck
build
app
Provider
migration
CI
```

Phase 3 必须由用户本地 Codex 在冻结基线上验证。

---

# 5. Phase 3 本地 Codex 测试 Prompt

> Test Branch: `test/plan-phase3-final-route-ai-20260905`  
> Test HEAD: `b736706424aa00aa1f3fd2db18a1ae915dc84afc`

你是 TravelPlanner Phase 3 独立测试 Agent。

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

冻结分支里的本文件可能仍显示 `__TEST_BRANCH__ / __TEST_HEAD__`；本地测试时应以用户给你的测试 Prompt 顶部精确 Branch + HEAD 为准。

## 5.2 阅读范围

至少阅读：

```text
docs/PLAN.md
docs/PRODUCT.md
docs/TECHNICAL.md
docs/PLAN_PROGRESS.md
apps/server/final-route-ai-v3.ts
apps/server/final-route-ai-cutover-v3.ts
apps/server/final-route-v3.ts
apps/server/planner-runtime-v3.ts
apps/server/travel-store-v3.ts
apps/server/planning-roles-v3.ts
apps/server/backbone-contracts-v3.ts
apps/web/src/FinalRoutePanelV3.tsx
apps/web/src/FinalRouteMapV3.tsx
apps/web/src/phase3-final-route-ai-cutover.test.ts
prompts/actions/destinations/生成目的地建议.md
prompts/actions/interests/发现兴趣点.md
prompts/actions/interests/补充兴趣点.md
prompts/actions/itinerary/细化每日行程.md
prompts/actions/itinerary/优化单日游览顺序.md
prompts/actions/itinerary/修复行程可行性.md
```

## 5.3 Typecheck

```bash
npm run typecheck
```

Windows 执行策略阻止 `npm.ps1` 时可用：

```bash
npm.cmd run typecheck
```

记录真实命令。

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

Windows 可使用等价 `.cmd` 入口。

## 5.5 AI / Prompt / Runtime 相关回归

至少额外运行：

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

如文件名在该 HEAD 确实不存在，报告实际情况，不要自行改测试范围掩盖问题。

## 5.6 完整回归

```bash
npm test
```

这是强制 Gate。

任何正式测试失败都必须：

```text
Phase 3: FAIL
```

记录：

```text
Test Files: x passed / x failed / x total
Tests: x passed / x failed / x total
```

## 5.7 Build

```bash
npm run build
```

Windows 可以：

```bash
npm.cmd run build
```

bundle 体积 warning 不算失败；真正 build error 才算失败。

---

# 6. 必做独立审计

不要只依赖已有测试。

## A. 主要地点直接进入 finalRoute

从全新旅行开始：

```text
填写旅行需求
→ 生成主要地点
```

确认：

- 生成结果直接成为 finalRoute；
- 不出现独立 Candidate 采用步骤；
- candidate 顺序就是新 route node 顺序；
- Day 自动派生；
- `routeSuggestion.endsDay` 只影响本轮新节点；
- `transportMode` 只保存 mode；
- duration / note / verified / geometry 不得由 AI 写入；
- AI 不确定住宿时允许全部 `endsDay=false`；
- 已有 finalRoute 后再次普通“生成主要地点”必须拒绝，不能覆盖。

## B. 同一 Place 多次出现

构造合法 AI output：

```text
A → B → A
```

两个 A 可以由两个不同临时 Place/Candidate 输出，但正式化后复用同一现实 Place。

最终必须：

- 三个独立 route node ID；
- 第一个 A 和最后一个 A 可以引用同一 Place ID；
- 不得因为 Candidate / Place 去重而丢掉回访节点。

## C. 详细地点只能插入

准备已有：

```text
A
X(tentative + endsDay)
B
C(no_go)
D
```

生成详细地点 Y / Z 后检查所有施工前已有 route nodes：

- ID 不变；
- 相对顺序完全不变；
- status 不变；
- endsDay 不变；
- transport 不变；
- detail fields 不变；
- 只有新 route nodes 被插入。

普通详细地点生成不能发 `move_final_route_node / remove_final_route_node / set_final_route_*` 去改旧节点。

## D. 局部详细地点 fail closed

分别验证：

```text
final-route-detail-scope:day:<dayId>
final-route-detail-scope:segment:<from>:<to>
```

如果目标 Planning Area 在全程存在，但不在这个 Day / segment 内：

必须拒绝：

```text
FINAL_ROUTE_DETAIL_SCOPE_UNREPRESENTABLE
```

不能偷偷回退到范围外同 Place 节点。

## E. 手工地点也能作为详细研究锚点

从右侧手工新增一个非 city Place。

内部 Candidate 应：

```text
planningRole = planning_area
```

然后它可以成为“生成详细地点”的目标。

这不能改变该 Place.kind，也不能自动住宿。

另验证：带 `planningAreaCandidateId` 但无显式 role 的 child，即使 `Place.kind=city`，有效 role 仍是 `detail_interest`。

## F. 手工详细安排

选择一个当前 Day 的中途 route node，在右侧修改：

```text
activity
period
startTime
endTime
durationMinutes
notes
```

保存后：

- finalRoute 对应 node detail fields 更新；
- 派生 Day 同步反映；
- route node ID / placeId / status / endsDay / 顺序不变；
- Provider route facts 不变。

## G. AI“完善这一天”

让 AI 返回新的 activity / scheduleText / time / duration / notes，同时故意在返回结构里夹带：

```text
不同 transport mode
伪造 duration
伪造 note
verification.status=verified
checkedAt
```

服务端最终用于 Proposal 的内容必须：

- 允许活动 / 时间 / 备注变化；
- transportFromPrevious 强制恢复当前值；
- scheduleVerification 强制恢复当前值；
- costVerification 强制恢复当前值；
- 不新增 / 删除 / 重排 Stop；
- 不改变 status / endsDay。

结果必须先形成 Proposal，不得静默直接覆盖。

## H. 单日优化

目标 Day：

```text
Start → A → B → C → End【boundary】
```

优化只允许 A/B/C 的 route node ID。

检查：

- AI 返回 dayId 必须等于用户授权 Day；
- End boundary 不可移动；
- 不能新增 / 删除 / 重复 ID；
- 只生成 route move Proposal；
- Proposal 未 apply 前 finalRoute 不变。

## I. segment 优化

构造：

```text
A
X(tentative)
B
C
Y(no_go)
D
E
```

授权 B→D 的连续线路段。

确认：

- 只允许范围内 normal IDs；
- X/Y 不在授权集合；
- 范围外 A/E 固定；
- inactive node 原槽位固定；
- AI 返回少一个、多一个、unknown 或重复 ID 均失败。

## J. 全程优化

授权所有 normal route nodes，但 inactive 仍固定槽位。

优化可以改变 normal node 顺序，但不能改变：

- Place identity；
- status；
- endsDay 字段本身；
- transport object；
- detail fields。

## K. Proposal / generation / undo

显式优化：

```text
AI output
→ Proposal pending
→ finalRoute 尚未变化
→ apply
→ finalRoute 变化
→ Revision/generation 增加
→ Route batch 启动
→ undo（无后续冲突时）
→ 原线路恢复
→ Route batch 再启动
```

如果用户在 Proposal 生成后先手工改 finalRoute：

旧 Proposal 不能静默覆盖，应 supersede / generation conflict。

## L. Provider 事实边界

再次确认：

- 未定位地点可保留；
- AI 不写坐标；
- AI 不写实际路线距离 / 时长 / geometry；
- finalRoute transport 只保存 mode；
- refine 不得把 verification 伪造成 verified。

## M. 唯一用户入口

正常 UI 只应看到：

```text
规划 · 旅行需求
行程 · 最终线路
```

最终线路右侧包含：

```text
生成主要地点
生成详细地点 / 补充详细地点
完善这一天
优化这一天 / 这一段 / 全程
人工线路操作
详细安排
地点 / 定位编辑
```

地图不能出现同类业务 mutation 按钮。

旧 `AppWorkflowV3` / Candidate / Skeleton / Daily UI 源码存在本身不算失败，但不能从当前生产入口正常进入。

---

# 7. 浏览器 / UI 验证

如果本地环境有可用浏览器，请实际验证 M 以及：

- AI 控件都在右侧；
- Proposal apply / reject / undo 可见且刷新；
- 详细安排可编辑；
- Map Popup 无业务按钮；
- inactive 节点仍显示点但路线跳过。

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
- 测完删除临时测试；
- 最终工作树干净。

建议至少独立覆盖：

1. A→B→A 重复 Place；
2. detail insert 旧节点完全不变；
3. Day / segment scope fail closed；
4. refine 允许时间备注但保护 transport/verification；
5. inactive 固定槽位的 segment optimize；
6. Proposal stale generation；
7. manual detail edit → finalRoute detail fields。

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
