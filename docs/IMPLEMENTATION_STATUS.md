# TravelPlanner Implementation Status

> 更新时间：2026-09-03
> 当前状态：**五步重构 Phase 1–6 已逐阶段通过；第一次 Final Regression 为 FAIL，已按归属 Phase 完成修复，正在等待最终综合回归重新验收。**

---

# 1. Current Gate

当前分支：

```text
feature/five-step-workflow-refactor
```

实施前 `main` / merge-base：

```text
b048c1980247443b5d6568ddd4302c41c9ce832b
```

Phase 6 PASS HEAD：

```text
0f8cdd2bdb58b248cc39aefbd05c8cdfd0ce2ae7
```

第一次 Phase 7 Final Regression 被验证的 HEAD：

```text
eb8ea96e54805284633fd429fc5f1d071ff5309b
```

该次最终回归结论：

```text
FINAL FIVE-STEP REGRESSION: FAIL
```

因此当前仍然不能宣称专项最终完成，也不能据此直接合并 `main`。

---

# 2. Phase History

```text
Phase 0 Read-only Gap Review                  DONE
Phase 1 Role + Contract Foundation            PASS
Phase 2 Skeleton + Impact Consumer Foundation PASS
Phase 3 Backbone Producer                     PASS
Phase 4 Capacity-Aware Interests              PASS
Phase 5 Detailed Itinerary                    PASS
Phase 6 UI / Map + Complexity Downshift       PASS
Phase 7 Final Regression #1                   FAIL
Phase 7 Repair                                IMPLEMENTED / AWAITING RERUN
```

Phase 1–6 的 PASS 仍然有效，但 Final Regression 发现了跨 Phase 的集成缺口，因此必须修复后重新做最终综合回归。

---

# 3. Final Regression #1 发现的问题与修复

## 3.1 Phase 1：OpenAI structured output 与 optional stayBlockId

问题：

```text
canonical Day.stayBlockId 必须保持 optional，兼容已有 v3 文档；
OpenAI structured output 又不接受同一 object 混合 required / optional 字段。
```

修复：

```text
canonical schema 不变；
只在 Structured AI transport 层把 stayBlockId 临时表达为 required + nullable；
模型返回 null 后再归一为字段缺省；
其他混合 required/optional object 仍然 fail closed。
```

这避免为了通过 OpenAI schema gate 而破坏旧数据兼容。

## 3.2 Phase 3 + Phase 6：普通景点 → 重要游览地

用户自然语言：

```text
这个地方很重要，要单独留一天
```

当前修复后的受控链路：

```text
Step 4 / Step 5 明确识别结构升级意图
→ 自动把对话路由到 Step 2 destinations 上下文
→ 保留当前普通景点 selection
→ destinations Dialogue 返回 destination.edit
→ Action 保持 pending_confirmation
→ 用户确认
→ 专用服务仅允许 detail_interest → core_visit
→ 保留原 planningAreaCandidateId
→ 不开放任意 role 编辑 / reparent
→ Macro dependency fingerprint 自动变 dirty
→ 相关 Detailed Day 标记 needs_review
```

CTA 和 generic command 不能使用这条升级捷径。

## 3.3 Phase 4：interest stop-after-save regression fixture

生产 readiness 合同保持不变：

```text
Step 4 discovery 只允许在已确认、current 的 Skeleton 容量上运行。
```

原 full-suite fixture 只有 candidates，没有 adopted/current Skeleton。

修复只更新 fixture：

```text
6 个 Planning Area
+ 6 个已采用 Stay Block / Day
+ current macroBasisFingerprint
```

原测试要验证的并发 Stop / late-success 不再写 canonical 语义不变。

## 3.4 Phase 6：Proposal / error / task 工程词泄漏

新增共享 public-text 边界。

Proposal 标题 / explanation、Action error、顶层 error、Task failure / map progress 都使用同一过滤规则。

过滤内部词包括但不限于：

```text
planningRole
planningAreaCandidateId
stayBlockId
planningState
fingerprint
macroBasisFingerprint
macroDirty
affectedDayIds
WorkflowStep
ConversationStage
requiresWorkflowStep
CAS
Resolution
generation / baseGeneration
targetIds
executor
scope
resultRef
taskId / proposalId
PlanCommand
Candidate / Place / Stop ID
Anchor / Macro
providerPlaceId / geoFingerprint
raw destination.* / interest.* / itinerary.* action name
```

系统生成文字命中这些词时使用自然语言 fallback；用户自己的输入不经过该过滤器。

## 3.5 Resolver full-suite blocker

第一次 Final Regression 发现 Picton city query 测试期待：

```text
Picton, NZ
```

实现却在第二条 query 使用中文别名：

```text
皮克顿, NZ
```

该问题不属于五步 diff，但源码自身的策略注释明确要求城市查询优先 provider-friendly common English name，因此修复实现而不是放宽测试：

```text
city 第二条 country-scope query 继续使用 primary English/provider-friendly name。
```

评分、AI 消歧和 Provider 事实边界不变。

## 3.6 Phase 7：diff hygiene

第一次 Final Regression 中 Markdown trailing whitespace 导致 `git diff --check` 非零。

本轮重新整理 Phase 7 状态 / handoff 文档，禁止依赖 Markdown 行尾双空格换行。

---

# 4. 当前五步合同

用户流程：

```text
1 旅行需求
2 想去哪些地方
3 路线和天数
4 补充景点（可选）
5 每日行程
```

内部核心：

```text
PlanningRole = planning_area | core_visit | detail_interest
Place.kind / planningRole / preference 独立
Core Visit 不成为 Macro Anchor
同一 Planning Area 可有多个稳定 Stay Block
Day.stayBlockId? backward-compatible
planningState 只持久化 macroBasisFingerprint
macroDirty 运行时派生
requiresWorkflowStep 用于精确回到五步上游
Step 3 使用 Draft + applySkeletonPlanV3 原子保存
Step 4 discovery 0–9 且可完全跳过
Step 5 只更新真实 affectedDayIds
Detailed update 使用 sticky baseline / minimal diff
```

数据库继续：

```text
PRAGMA user_version = 3
```

不做 v3 → v4 migration，不自动 rewrite 私人数据库。

---

# 5. UI / Map 合同

普通用户不需要理解工程术语。

主 UI 使用：

```text
停留地点
重要游览地
普通景点
必去
想去
路线和天数需要重新确认
N 天需要更新，其他 M 天保持不变
```

地图 / 时间轴只负责：

```text
展示
选择
聚焦
```

右侧控制台仍是唯一业务入口。

Step 4 明确可选；进入 Step 4 或离开 Step 4 都不会自动运行 discovery。

---

# 6. Private Data / Security

本专项继续保持：

```text
private_data/ 不进入 Git
不复制真实旅行到 fixture
不新增凭据
不扩大 AI / Codex 权限
不让 AI 产生可信 Provider facts
```

Final Regression 需要继续使用 isolated Browser / temp data；不得读写真实旅行数据库。

---

# 7. Current Next Step

现在唯一下一步是重新执行：

```text
Final Five-Step Regression Rerun
```

必须重新覆盖：

```text
git diff --check
Phase 1–6 targeted tests + 本轮新增 repair tests
npm run typecheck
npm test
npm run build
F1–F14 核心业务场景
adversarial Proposal/error/task 文案泄漏
Detail → Core pending-confirmation 全链路
Provider / Map 边界
isolated Browser E2E
Real AI smoke（仅存在安全临时 v3 路径时；否则单项 BLOCKED）
```

如果最终回归仍 FAIL，不宣称完成；回到对应 Phase 修复。

如果所有可执行硬 Gate PASS，仅 Real AI smoke 因环境无法安全执行，则按最终 Gate 规则报告 PARTIAL，由用户决定是否接受该环境未验证项。
