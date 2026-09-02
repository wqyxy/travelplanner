# TravelPlanner 五步重构 Final Regression Rerun Handoff

> 更新日期：2026-09-03
> 用途：第一次 Final Regression FAIL 后的综合重新验收。
> 实施前基线：`b048c1980247443b5d6568ddd4302c41c9ce832b`
> 第一次 Final Regression HEAD：`eb8ea96e54805284633fd429fc5f1d071ff5309b`
> 本次重新验收必须以 `feature/five-step-workflow-refactor` 的实际当前 HEAD 为准。

---

# 1. 测试任务边界

你只负责测试、审查和报告。

不要：

```text
修改代码
修改测试
修改 Prompt
修改配置
修改数据库
自动修复失败
访问真实 private_data
使用真实私人旅行做 E2E
```

发现失败只记录证据，由用户决定是否再次修复。

---

# 2. 必读依据

完整读取：

```text
AGENTS.md
README.md
docs/IMPLEMENTATION_STATUS.md
docs/TravelPlanner 五步规划流程重构实施方案.md
docs/五步 UI 交互规范.md
docs/FIVE_STEP_FINAL_REGRESSION_HANDOFF.md
package.json
vitest.config.ts
tsconfig.json
tsconfig.server.json
```

验收优先级：

```text
用户最新明确决定
→ 五步实施方案
→ 五步 UI 规范
→ PRODUCT_PLAN
→ IMPLEMENTATION_STATUS 只说明实时状态
```

---

# 3. Git / Diff Gate

确认：

```text
branch = feature/five-step-workflow-refactor
working tree clean
merge-base main HEAD = b048c1980247443b5d6568ddd4302c41c9ce832b
```

执行：

```bash
git status --short --branch
git branch --show-current
git rev-parse HEAD
git merge-base main HEAD
git diff --stat b048c1980247443b5d6568ddd4302c41c9ce832b..HEAD
git diff --name-status b048c1980247443b5d6568ddd4302c41c9ce832b..HEAD
git diff --check b048c1980247443b5d6568ddd4302c41c9ce832b..HEAD
```

`git diff --check` 必须 exit code 0。

第一次 Final Regression 报告中的 Markdown trailing whitespace 必须消失。

---

# 4. 本轮 Repair 专项审查

## 4.1 Structured AI / stayBlockId

确认：

```text
canonical Day.stayBlockId 仍是 optional
旧文档仍可读
OpenAI transport 只对 stayBlockId 做 required + nullable bridge
null transport 会归一为字段缺省
普通 mixed required/optional schema 仍拒绝
```

重点：

```text
apps/server/structured-ai-v2.ts
apps/server/openai-output-schema-v2.test.ts
```

## 4.2 Detail → Core

从 Step 4 / Step 5 对当前普通景点输入：

```text
这个地方很重要，要单独留一天
```

必须：

```text
自动归属 Step 2 destinations 对话
保留目标 candidate selection
产生 destination.edit pending_confirmation
确认前 planningRole 不变
用户确认后 detail_interest → core_visit
planningAreaCandidateId 原样保持
不得开放任意 reparent
不得让 CTA 绕过这条受控确认路径
Macro fingerprint 变 dirty
相关 Detailed Day 进入 needs_review
用户不看到 planningRole / ID / fingerprint
```

重点：

```text
apps/web/src/workflow-ui-v3.ts
apps/web/src/WorkflowAssistantV3.tsx
apps/server/stage-context-v3.ts
prompts/dialogues/目的地对话.md
apps/server/core-promotion-v3.ts
apps/server/travel-api-v3.ts
```

## 4.3 Step 4 stop-after-save regression

确认生产 readiness 没有放宽。

测试 fixture 应使用：

```text
adopted Stay Blocks / Days
current macroBasisFingerprint
```

原测试继续验证 Stop 后晚到的 worker success 不得写 canonical。

## 4.4 Public text boundary

Adversarial fixture 至少包括：

```text
Proposal title = Macro fingerprint 已变化
Proposal explanation = affectedDayIds mismatch
Action error = targetIds 超出 scope
Task error = itinerary.detail.generate failed
```

普通用户 DOM 不得原样出现这些工程词。

重点：

```text
apps/web/src/public-text-v3.ts
apps/web/src/WorkflowAssistantV3.tsx
apps/web/src/AiTaskTopbar.tsx
```

## 4.5 Resolver baseline blocker

Picton city query 应保持 provider-friendly primary English name：

```text
Picton, Marlborough, NZ
Picton, NZ
```

不要改成：

```text
皮克顿, NZ
```

只验证 query 选择修复；评分、消歧、Provider 事实边界不得改变。

---

# 5. Repair Targeted Tests

先执行本轮失败和新增测试：

```bash
npx vitest run --config vitest.config.ts apps/server/openai-output-schema-v2.test.ts apps/server/place-resolver-v2.test.ts apps/server/interest-discovery-stop-after-save-v3.test.ts apps/server/core-promotion-v3.test.ts apps/server/stage-context-v3.test.ts apps/web/src/workflow-ui-v3.test.ts apps/web/src/public-text-v3.test.ts apps/web/src/ai-task-topbar.test.ts
```

必须报告：

```text
Test Files
Tests
Errors
Exit code
```

---

# 6. Phase 1–6 Targeted Regression

执行：

```bash
npx vitest run --config vitest.config.ts apps/server/contracts-v2.test.ts apps/server/planning-roles-v3.test.ts apps/server/ai-action-contracts-v3.test.ts apps/server/ai-action-contracts-v3-detail-phase5.test.ts apps/server/ai-stage-contracts-v3.test.ts apps/server/stage-context-v3.test.ts apps/server/candidate-workflow-v2.test.ts apps/server/candidate-discovery-policy-v2.test.ts apps/server/interest-discovery-v3.test.ts apps/server/itinerary-workflow-v3.test.ts apps/server/itinerary-impact-v3.test.ts apps/server/planning-context-v3.test.ts apps/server/detail-itinerary-v3.test.ts apps/server/planner-runtime-v3-ai-actions.test.ts apps/server/planner-runtime-v3-detail-phase5.test.ts apps/server/planner-runtime-v3-detail-unavailable-phase5.test.ts apps/server/requirements-duration-v3.test.ts apps/server/travel-api-v3-phase6.test.ts apps/server/skeleton-edit-api-v3.test.ts apps/server/plan-route-order-v2.test.ts apps/server/core-promotion-v3.test.ts apps/server/openai-output-schema-v2.test.ts apps/server/place-resolver-v2.test.ts apps/server/interest-discovery-stop-after-save-v3.test.ts apps/web/src/editor-actions-v2.test.ts apps/web/src/workflow-ui-v3.test.ts apps/web/src/skeleton-ui-v3.test.ts apps/web/src/workspace-map-presentation-v2.test.ts apps/web/src/workspace-v2.test.ts apps/web/src/ai-task-topbar.test.ts apps/web/src/public-text-v3.test.ts
```

---

# 7. Typecheck / Full Suite / Build

必须依次执行：

```bash
npm run typecheck
npm test
npm run build
```

三项分别记录 exit code。

本轮最终 PASS 要求 full Vitest 不再存在第一次报告中的 4 个失败。

---

# 8. F1–F14 核心场景

逐项输出 `PASS / FAIL / BLOCKED + evidence`。

## F1 用户复杂度

普通用户不理解内部术语也能完整走五步。

Proposal / error / task 的 adversarial 工程词必须被自然语言 fallback 替换。

## F2 Preference

```text
must_go 必入
want_to_go 优先，omitted 有原因
optional 可 omitted
excluded 禁止进入
UI 主操作只突出必去 / 想去
```

## F3 Milford Sound Core Visit

```text
Te Anau = planning_area
Milford Sound = core_visit
parent = Te Anau
不是 Stay Block / Macro Anchor
影响容量
Step 5 resolved 后成为 Stop
```

## F4 Auckland 环线

两个 Auckland Stay Block 独立、稳定，UI 不显示 ID。

## F5 19 / 20 天

19 天不能保存，显示“还剩 1 天需要安排”；20 天一次原子保存。

## F6 Detail → Core

必须重新做完整 pending-confirmation 链路，不允许只做静态检查。

## F7 Replan Macro 不变

复用 Stay Block / Day，只更新真正相关 Detail。

## F8 Macro 天数变化

只有真实 affected Day 需更新。

## F9 unresolved

阻塞 / 非阻塞按 Planning Area、Core、Detail 和 preference 分级正确。

## F10 Step 4 可完全跳过

不自动 discovery，不自动 detail generate。

## F11 Update Card

自然语言显示局部影响，原因默认折叠。

## F12 跨步骤自动上下文

上游意图自动切正确步骤，但不静默 mutation。

## F13 旧数据

缺 planningRole / stayBlockId / planningState 仍可读取，普通 load 不 rewrite。

## F14 90 天 Skeleton

专用原子 Save 不受 generic 100-command 上限限制。

---

# 9. Isolated Browser E2E

不得启动会读取真实 `private_data` 的真实 backend。

优先复用已验证方式：

```text
真实 repo root 只启动 Vite frontend
/api 使用内存 fixture / request fulfill
```

至少覆盖：

```text
五步导航
Step 1 下一步不自动生成地点
Step 2 愿望清单
Step 3 19/20
重复 Auckland
Step 4 可跳过
Step 5 不自动生成
2/20 局部更新
unresolved 分级
跨步骤 pending Action
Detail → Core 自动切 Step 2 + pending confirmation
adversarial Proposal/error/task 工程词过滤
marker click 只 selection
popup 无业务编辑器
map footer 只必去 / 想去
```

---

# 10. Provider / Security

确认：

```text
AI 不生成可信坐标 / Provider ID / geometry / distance / duration
Candidate save-first
Resolver failure 不回滚 Candidate
Map 只展示 / 选择 / 聚焦
private_data 未进入 Git
无真实旅行 fixture
无凭据
PRAGMA user_version = 3
无 v3 → v4 migration
```

---

# 11. Real AI Smoke

`package.json` 没有专用 smoke script，不得发明命令。

只有同时满足以下条件才执行：

```text
已有合法 AI 配置
已有现成项目调用路径
可以保证全新临时 v3 DB
绝不触碰真实 private_data
```

条件不满足：

```text
AI Smoke = BLOCKED
```

如果能够安全执行，最少验证 Step 2 → Step 5 的真实 AI 合同。

---

# 12. 最终结论规则

第一行严格使用：

```text
FINAL FIVE-STEP REGRESSION: PASS
```

或：

```text
FINAL FIVE-STEP REGRESSION: FAIL
```

或：

```text
FINAL FIVE-STEP REGRESSION: PARTIAL
```

规则：

```text
PASS = 所有可执行硬 Gate 通过；可安全执行的 AI smoke 也通过。
FAIL = 存在 production / test / typecheck / full suite / build / Browser 真实失败。
PARTIAL = 所有可执行硬 Gate 通过，但仍有环境原因无法安全执行的项目，例如 AI smoke。
```

报告至少包含：

```text
Commands Run
Branch / HEAD / Working Tree
Diff Review
git diff --check
Repair Targeted Tests
Phase Targeted Tests
Typecheck
Full Test
Build
F1–F14
Browser E2E
Provider / Map
AI Smoke
Documentation
Security
Issues by P0/P1/P2
Blocked Items
Conclusion
```

失败只报告，不自动修复。
