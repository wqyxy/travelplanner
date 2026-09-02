# TravelPlanner Implementation Status

> 更新时间：2026-09-02  
> 当前状态：**五步重构设计已最终确认，代码尚未按该方案实施**

---

# 1. Current Gate

现有 staged-v3 已经具备可复用基础：

```text
右侧工作区 AI 入口
四个 ConversationStage
Dialogue / Action Registry
确定性 Action 与 AI Action 分离
Proposal / Scope / generation / CAS
Candidate-first / save-first
Resolution 状态
Macro / Detail Route 基础
canonical Day / Stop
detailStatus
Detail patch 基础
```

2026-09-02 已完成五步重构的最终文档设计，但本轮**没有修改代码、没有运行测试**。

因此：

```text
产品设计：已确认
UI 设计：已确认
施工合同：已确认
代码实施：未开始
五步验证：未开始
```

不能因为文档已经完成就宣称功能存在。

---

# 2. 最终确认的五步目标

```text
1 旅行需求
2 去哪些地方
3 安排路线和天数
4 补充景点
5 每日行程
```

核心新增 / 调整：

```text
PlanningRole: planning_area / core_visit / detail_interest
preference 真正影响 Planning Area 是否最终采用
Core Visit 只影响 Macro 时间，不成为 Anchor
稳定 Stay Block identity
Day.stayBlockId? backward-compatible
同一 Planning Area 可多次形成 Stay Block
移动日计入到达 Stay Block
Step 3 SkeletonEditDraft + 原子 Apply
requiresWorkflowStep 取代模糊 requiresStage 导航
planningState 只保存 Macro basis fingerprint
macroDirty 由 fingerprint 派生
Planning Area / Core / Detail unresolved 完整 readiness
Step 4 capacity-aware discovery
Step 5 patch-only affectedDayIds
右侧唯一业务入口
```

---

# 3. 当前代码与目标之间已知的关键差异

现有代码仍需要在实施时处理至少以下差异：

```text
TripCandidate 尚无 planningRole
Day 尚无 stayBlockId
现有 Macro 识别主要依赖 Place.kind=city
现有 Skeleton 强制每个非 excluded Macro 恰好出现一次
现有 Skeleton 禁止重复同一 destinationCandidateId
现有 Itinerary Macro output 仍使用 destinations 单次访问结构
现有 requiresStage 无法精确区分 Step 2 / Step 3
现有 Macro 更新依赖通用 PlanCommand，存在 100 command 上限
现有 Macro dirty / readiness 尚未采用最终 fingerprint 派生合同
现有 Resolution readiness 尚未按 Planning Area / Core / Detail 三类完全区分
Step 3 尚无完整的本地编辑草稿 + 原子 Apply
Step 4 / Step 5 尚未按最终五步 Action ownership 收口
```

这些差异必须以正式施工图为准逐项处理。

---

# 4. Preference 最终合同

Planning Area：

```text
must_go     → 必须进入 Skeleton
want_to_go  → 优先；omitted 必须解释
optional    → 可以 omitted
excluded    → 禁止进入
```

Core Visit：

```text
must_go     → 必须预留容量并最终安排
want_to_go  → 优先
optional    → 不单独强迫增加 stayDays
excluded    → 不参与
```

当前代码“全部 non-excluded Macro 都必须进入一次”的行为属于待修改项。

---

# 5. Stay Block 最终合同

不新增独立 MacroDay / StayBlock 表。

Canonical Day 增加可选：

```ts
stayBlockId?: string;
```

同一 Stay Block 的 Day 共享稳定 ID。

AI Draft 不生成 canonical UUID；服务端 formalization 负责匹配旧 Block、复用 ID 或生成新 ID。

旧 Day 没有 `stayBlockId`：正常读取；普通加载不写回；用户下一次主动 Step 3 Apply 后建立稳定 ID。

---

# 6. Macro Dependency 最终合同

Canonical：

```ts
planningState?: {
  macroBasisVersion: 1;
  macroBasisFingerprint: string | null;
};
```

不持久化 `macroDirty`。

运行时派生：

```text
current fingerprint != basis fingerprint
→ macroDirty
```

缺 fingerprint：

```text
needs_confirmation
```

---

# 7. Resolution 最终合同

```text
Planning Area unresolved
→ Step 3 可做语义 Skeleton
→ Macro Route pending
→ Step 5 使用该 Anchor 时阻塞

Core must_go unresolved
→ Step 3 可计算容量
→ 阻塞相关 Detail Generate

Core want / optional unresolved
→ 不成为 Stop，可解释未排

Detail must_go unresolved
→ 阻塞相关 Detail Generate

Detail want / optional unresolved
→ 跳过，不阻塞无关 Day
```

---

# 8. Step 3 Apply 最终合同

用户手工修改 Skeleton 先进入 `SkeletonEditDraft`。

只有：

```text
采用范围合法
must_go coverage 合法
stayDays 总和 = 总旅行天数
顺序 / transport 合法
```

才允许 Apply。

Apply 使用专用服务端原子边界：

```text
applySkeletonPlanV3()
```

它负责：

```text
validate
formalize stayBlockId
expand Days
reuse Day IDs
Macro Diff
affectedDayIds
basis fingerprint
CAS atomic write
```

不要求把 90 天大范围更新拆成不超过 100 条通用 PlanCommand。

---

# 9. 下一步实施顺序

正式施工图采用以下 Phase：

```text
Phase 0 Read-only Gap Review
Phase 1 Role + Contract Foundation
Phase 2 Skeleton + Impact Consumer Foundation
Phase 3 Backbone Producer
Phase 4 Capacity-Aware Interests
Phase 5 Detailed Itinerary
Phase 6 UI / Map Integration
Phase 7 Verification Preparation
```

关键顺序原则：

> **先让下游消费者理解新角色 / Stay Block / Impact，再让 Step 2 开始生产新的 Core Visit。**

Phase 1–6 应在同一 feature branch 连续完成；中间状态不得作为完整产品单独发布。

---

# 10. 下一步真正要做的第一件事

用户之后明确要求“开始实施”时，不应立即改代码。

先执行：

```text
Phase 0：只读 review 当前 main / 实施分支代码
```

输出逐文件差异清单，至少核对：

```text
contracts
candidate workflow
itinerary contracts
itinerary workflow
impact analyzer
stage / workflow mapping
context builder
Action Registry
Resolution readiness
UI ownership
PlanCommand 100 上限
```

确认差异与施工图一致后，再进入 Phase 1。

---

# 11. 未来必须验证的场景

```text
must / want / optional / excluded Planning Area
Auckland → ... → Auckland 两个稳定 Stay Block
20 天 Step 3 草稿 19/20 不可 Apply、20/20 可 Apply
90 天 Skeleton 原子 Apply
Milford = Core，不成为 Macro Anchor
Planning Area unresolved 可 Step 3、不可真实 Step 5 Anchor
must_go Core / Detail unresolved 阻塞相关 Detail
Detail → Core 只传播到相关 Macro / Detail
Replan Macro 不变时只更新相关区域 Detail
Macro 天数变化只更新 affectedDayIds
地图不承担业务 mutation
Step 2 / 3、Step 4 / 5 无重复生成入口
```

---

# 12. Verification Gate

只有代码真正实施完后，才准备：

```text
git diff --check
targeted Vitest
typecheck
全量 Vitest
build
真实 AI smoke
isolated Browser E2E
```

完整验收继续需要用户明确确认。

本轮只改文档，所以没有运行任何上述验证。

---

# 13. Current Handoff

当前最准确的交接描述：

> TravelPlanner 已有 staged-v3 基础代码；五步产品、UI 与实施合同已经最终确认，但尚未实施。下一次开始开发时，先按施工图执行 Phase 0 只读差异审查，再进入 Phase 1–6。

实施依据优先级：

```text
TravelPlanner 五步规划流程重构实施方案.md
→ 五步 UI 交互规范.md
→ PRODUCT_PLAN.md
→ 本文件仅用于判断当前实际状态
```