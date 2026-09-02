# TravelPlanner Implementation Status

> 更新时间：2026-09-03
> 当前状态：**五步重构 Phase 1–6 已逐阶段通过；Final Regression 已执行两次且均发现收尾集成问题。第二次失败项已按原 Phase 修复，当前等待第三次 Final Regression Rerun。**

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

第一次 Final Regression HEAD：

```text
eb8ea96e54805284633fd429fc5f1d071ff5309b
```

第二次 Final Regression HEAD：

```text
bed89c96b2bad6b456a924d45c35150f232fced4
```

两次最终回归结论均为：

```text
FINAL FIVE-STEP REGRESSION: FAIL
```

第二次失败后的 repair 已实施，但尚未重新验收。因此当前仍不能宣称专项最终完成，也不能据此直接合并 `main`。

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
Phase 7 Repair #1                             IMPLEMENTED
Phase 7 Final Regression #2                   FAIL
Phase 7 Repair #2                             IMPLEMENTED / AWAITING RERUN
```

Phase 1–6 的逐阶段 PASS 仍然是历史事实，但 Final Regression 是更高一层的综合 Gate；只有最终综合回归通过后才算专项完成。

---

# 3. Final Regression #1 的问题与修复

## 3.1 OpenAI structured output / stayBlockId

canonical `Day.stayBlockId` 必须保持 optional，兼容已有 v3 文档；OpenAI structured output 不允许同一个 object 混合 required / optional 字段。

Repair #1 保持 canonical schema 不变，只在 Structured AI transport 层把 `stayBlockId` 表达为 required + nullable，模型返回 `null` 后再归一为字段缺省。

## 3.2 Detail → Core

用户在 Step 4 / Step 5 对当前普通景点说：

```text
这个地方很重要，要单独留一天
```

受控链路为：

```text
自动路由到 Step 2 destinations 上下文
→ 保留当前普通景点 selection
→ destination.edit
→ 内部 request = promote_to_core
→ pending_confirmation
→ 用户确认
→ detail_interest → core_visit
→ 保留原 planningAreaCandidateId
→ Macro dependency 变 dirty
→ 所属区域 Detailed Day 进入 needs_review
```

CTA、generic command、普通 destination.edit 都不能绕过这条确认路径，也不开放任意 planningRole/reparent。

## 3.3 Step 4 stop-after-save regression fixture

生产 readiness 没有放宽。旧测试 fixture 被更新为真实 adopted/current Skeleton，使测试继续验证并发 Stop 后 late success 不得写 canonical。

## 3.4 Proposal / error / task 工程词泄漏

新增共享 public-text 边界，Proposal、Action error、顶层 error、Task failure/progress 均经过同一安全过滤。普通用户不应看到 planningRole、stayBlockId、fingerprint、affectedDayIds、WorkflowStep、CAS、raw action namespace 等内部词。

## 3.5 Picton Resolver baseline blocker

城市 country-scope query 继续优先 provider-friendly English name：

```text
Picton, Marlborough, NZ
Picton, NZ
```

只修 city query alias 选择，不改变评分、AI 消歧或 Provider 事实边界。

## 3.6 diff hygiene

清理 Phase 7 Markdown trailing whitespace，使 `git diff --check` 恢复为 0。

---

# 4. Final Regression #2 的问题与 Repair #2

第二次 Final Regression 在 Repair Targeted Tests 即停止，发现两个硬问题。

## 4.1 Phase 1：TripCandidate 仍直接形成 mixed required/optional AI transport

失败路径来自 `TripCandidateSchema.planningRole?`。该 optional 是 canonical 旧数据兼容需求，不应通过新增 nullable bridge 解决。

Repair #2：

```text
stayBlockId 仍然是唯一 nullable transport bridge
planningRole 不允许 null
只有 object 完整匹配 TripCandidate canonical shape
且唯一 optional 字段正好是 planningRole 时
OpenAI transport 才把 planningRole 强制列为 required enum
其他任意 mixed required/optional object 继续 fail closed
```

这样旧 v3 canonical 兼容逻辑不变，同时 AI 输出必须明确给出 planningRole。

重点文件：

```text
apps/server/structured-ai-v2.ts
apps/server/openai-output-schema-v2.test.ts
```

## 4.2 Phase 3 / 6：Detail → Core 测试 fixture 外键非法

第二次回归发现 `core-promotion-v3.test.ts` 伪造 `sourceMessageId = message-1`，但没有真实 messages row，导致 `ai_actions.source_message_id` 外键失败，业务确认链根本没有执行。

Repair #2：

```text
conversation 测试先通过 TravelStoreV3.createUserMessage() 创建真实消息
Action 使用真实 message ID
确认前仍断言无 mutation
确认后继续验证 Detail → Core / parent / dirty / needs_review / Stop ID reuse
三个测试全部用 try/finally 关闭 SQLite
失败路径也不会再留下开放 DB handle / EPERM teardown 噪音
```

重点文件：

```text
apps/server/core-promotion-v3.test.ts
```

本次没有再次修改 F6 production promotion 实现。

---

# 5. 当前五步合同

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

# 6. UI / Map 合同

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

地图 / 时间轴只负责展示、选择、聚焦。右侧控制台仍是唯一业务入口。

Step 4 明确可选；进入或离开 Step 4 都不会自动运行 discovery。

---

# 7. Private Data / Security

本专项继续保持：

```text
private_data/ 不进入 Git
不复制真实旅行到 fixture
不新增凭据
不扩大 AI / Codex 权限
不让 AI 产生可信 Provider facts
```

Final Regression 必须继续使用 isolated Browser / temp data，不得读写真实旅行数据库。

---

# 8. Current Next Step

现在唯一下一步是第三次：

```text
Final Five-Step Regression Rerun
```

首先重跑 Repair Targeted Tests；若通过，再继续：

```text
Phase 1–6 targeted regression
npm run typecheck
npm test
npm run build
F1–F14
Detailed Itinerary regression
Provider / Map boundary
isolated Browser E2E
Real AI smoke（只有存在安全临时 v3 路径时执行，否则单项 BLOCKED）
```

如果第三次 Final Regression 仍 FAIL，不宣称完成，继续回到对应 Phase 做最小修复。

如果所有可执行硬 Gate PASS，仅 Real AI smoke 因环境无法安全执行，则按最终 Gate 规则报告 PARTIAL，由用户决定是否接受该环境未验证项。
