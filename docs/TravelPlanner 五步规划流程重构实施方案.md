# TravelPlanner 五步规划流程重构实施方案

> 状态：**已确认的文档设计，尚未实施**  
> 更新日期：2026-09-02  
> 适用范围：TravelPlanner v3 产品流程、Candidate 角色、Macro / Detail 规划、Prompt / Action / Context、增量更新、兼容边界与实施顺序  
> 配套 UI 规范：[`五步 UI 交互规范.md`](./五步%20UI%20交互规范.md)

---

# 1. 目标与最终流程

产品统一为：

```text
1 旅行需求
      ↓
2 去哪些地方
   ├─ Planning Area / 规划区域
   └─ Core Visit / 重要游览地
      ↓
3 安排路线和天数
   ├─ Stay Block / 停留段
   ├─ 顺序
   ├─ 停留天数
   └─ 跨区域语义交通方式
      ↓
4 补充景点
   └─ Detail Interest / 普通兴趣点
      ↓
5 每日行程
   ├─ Core Visit 落入具体日期
   ├─ Detail Interest 选择与排序
   ├─ 时间安排
   └─ Detail Route
```

核心原则：

> 先确定哪些地点决定旅行结构，再分配时间；先有时间容量，再发现普通兴趣点；最后才安排具体日期和真实路线。

增量原则：

> 用户修改哪里，只重新计算真正受影响的部分；未受影响结果继续有效。

---

# 2. 用户 Workflow 与 ConversationStage

内部 WorkflowStep：

```ts
type WorkflowStepV3 =
  | "requirements"
  | "backbone"
  | "skeleton"
  | "interests"
  | "detail";
```

用户显示：

```text
1 旅行需求
2 去哪些地方
3 安排路线和天数
4 补充景点
5 每日行程
```

数据库仍只保留四个 ConversationStage：

```ts
type ConversationStage =
  | "requirements"
  | "destinations"
  | "interests"
  | "itinerary";
```

映射：

```text
requirements → requirements
backbone     → destinations
skeleton     → destinations
interests    → interests
detail       → itinerary
```

ConversationStage 只负责消息 / Thread / Dialogue / Action 命名空间，不替换 canonical TripStage。

所有需要“返回上游”的 AI 输出必须使用 WorkflowStep，而不是仅使用 ConversationStage：

```ts
type RequiresWorkflowStep =
  | "requirements"
  | "backbone"
  | "skeleton"
  | "interests";
```

推荐统一结果：

```ts
{
  type: "requires_workflow_step";
  requiresWorkflowStep: RequiresWorkflowStep;
  reason: string;
  assistantMessage: string;
}
```

这样 Step 5 可以明确要求回 Step 3，而不会因为 Step 2 / Step 3 共用 `destinations` ConversationStage 产生歧义。

---

# 3. 页面结构与动作唯一归属

产品保持：

```text
地图 / 时间轴 / 路线
+
右侧唯一控制台
```

五步导航也位于右侧顶部，不新增独立左侧步骤栏。

地图 / 时间轴只负责：

```text
展示
选择
聚焦
```

所有业务修改、AI 生成、定位修复、流程推进都从右侧控制台发起。

动作唯一归属：

```text
Step 1 → requirements update
Step 2 → destination.* / Planning Area / Core Visit
Step 3 → skeleton generate / replan / edit / apply
Step 4 → interest.* / Detail Interest
Step 5 → detail generate / update / Stop / Day
```

跨步骤 CTA 只导航，不替目标步骤执行 Action。

---

# 4. Place.kind、planningRole、preference 必须独立

## 4.1 Place.kind

现实实体类型：

```text
city
attraction
lodging
meal
airport
station
port
stop
waypoint
```

## 4.2 planningRole

规划层级：

```ts
type PlanningRole =
  | "planning_area"
  | "core_visit"
  | "detail_interest";
```

Canonical 规则：

```text
planning_area:
  Place.kind = city
  planningAreaCandidateId = null

core_visit:
  Place.kind != city
  planningAreaCandidateId = parent planning_area

detail_interest:
  Place.kind != city
  planningAreaCandidateId = parent planning_area
```

Core Visit 影响 Step 3 时间预算，在 Step 5 成为 Stop，但绝不成为 Macro Anchor。

## 4.3 preference

```ts
must_go
want_to_go
optional
excluded
```

它回答“用户有多想去”，不能与 planningRole 隐式绑定。

---

# 5. preference 在 Step 3 的最终语义

这是施工前必须固定的规则。

## 5.1 Planning Area

```text
must_go
→ 必须至少进入一个 Stay Block

want_to_go
→ 优先进入；若总天数 / 路线确实不允许，可以不进入，但必须输出 omitted reason

optional
→ AI 可以不选；不能为了覆盖 optional 而强行挤压旅行

excluded
→ 禁止进入 Skeleton
```

因此旧规则：

```text
每个 active planning_area 都必须覆盖一次
```

废止。

新规则：

```text
所有 must_go planning_area 必须覆盖
want_to_go 优先覆盖
optional 由 Step 3 AI 决定是否采用
excluded 禁止采用
```

Step 3 输出必须把未采用的非 excluded Planning Area 显式列出，便于审计：

```ts
type OmittedPlanningArea = {
  candidateId: string;
  reason: string;
};
```

服务端验证：

```text
represented Stay Blocks
+
omittedPlanningAreas
=
全部 non-excluded Planning Areas
```

`must_go` 不允许出现在 omitted 中；`want_to_go` 被 omitted 必须有明确理由。

## 5.2 Core Visit

```text
must_go
→ Step 3 必须为它预留合理时间容量；Step 5 必须安排

want_to_go
→ Step 3 优先考虑；放不下时必须解释

optional
→ 不得仅为了它额外增加 stayDays；若既有容量足够可安排

excluded
→ 不参与容量，也不排入 Day
```

---

# 6. Core Visit 严格判定

Core Visit 必须首先满足：

> 会显著改变宏观时间安排。

至少符合一种：

```text
通常独立占用半天或全天
明显绕行
特殊交通
强时间窗口
需要围绕它安排某一天
显著消耗某区域容量
```

并且：

```text
用户明确重视
或
研究确认其对当前旅行主题具有显著代表性
```

“用户点名”或“地点很有名”本身不等于 Core Visit。

---

# 7. TripCandidate 兼容策略

新增可选字段：

```ts
planningRole?: PlanningRole;
```

统一运行时解释：

```ts
if (candidate.planningRole) return candidate.planningRole;
if (place.kind === "city") return "planning_area";
return "detail_interest";
```

旧 Candidate 可读，不自动回写；新创建或真正发生角色变化的 Candidate 显式写 `planningRole`。

建议新增纯函数模块：

```text
apps/server/planning-roles-v3.ts
```

至少包含：

```ts
effectivePlanningRole()
isPlanningAreaCandidate()
isCoreVisitCandidate()
isDetailInterestCandidate()
planningAreaParent()
activePlanningAreas()
activeCoreVisits()
activeDetailInterests()
```

---

# 8. Stay Block 是稳定业务对象，但不新增第二套 MacroDay 表

Step 3 的一级编辑对象是 Stay Block。

环线必须允许：

```text
Auckland #1
...
Auckland #2
```

同一 Planning Area 可出现多个 Stay Block。

为了保证 selection、Diff、Day ID reuse 和局部编辑稳定，canonical Day 增加可选：

```ts
stayBlockId?: string;
```

同一 Stay Block 展开的所有 Day 使用同一个 `stayBlockId`。

不新增独立 StayBlock 数据表，不维护第二套天数事实。

Stay Block 仍由 canonical Day 派生：

```text
stayBlockId
→ 连续 Day 集合
→ endAnchor / Planning Area
→ Day 数量 = stayDays
→ 第一日 transferMode = 进入该 Block 的交通方式
```

AI Skeleton Draft 不生成 canonical UUID：

```ts
type SkeletonStayDraft = {
  planningAreaCandidateId: string;
  stayDays: number;
  transferModeFromPrevious: TransportMode;
};
```

服务端 formalization 时：

```text
优先匹配现有稳定 Stay Block 并复用 stayBlockId
匹配不到才生成新的 UUID
```

旧 Day 没有 `stayBlockId` 时：

```text
正常读取
不因普通加载自动写回
下一次用户主动在 Step 3 Apply Skeleton 时再建立稳定 stayBlockId
```

---

# 9. stayDays 与移动日唯一语义

统一：

> 转移日计入到达 Stay Block。

例如：

```text
A 2 天
B 3 天
```

展开：

```text
Day 1 A
Day 2 A
Day 3 A → B   // B 第 1 天
Day 4 B
Day 5 B
```

因此：

```text
所有实际采用 Stay Block 的 stayDays 总和
= 旅行总天数
```

Interest Discovery 必须知道各 Block 是否包含 arrival transfer day。

---

# 10. Step 2：Backbone / 去哪些地方

Step 2 只管理：

```text
Planning Area
Core Visit
```

禁止批量产生普通 Detail Interest。

Step 2 是 Core Visit 结构管理唯一主入口：

```text
新增 / 删除
parent
角色升级 / 降级
preference
```

Step 4 只能发起“设为重要游览地”的 intent，然后导航 Step 2 完成 Impact Confirmation。

## 10.1 Mixed Destination Output

`destination.generate` 同一轮允许返回：

```text
Planning Area
Core Visit
```

建议 AI Draft 使用：

```ts
type ParentCandidateRef =
  | { type: "existing"; candidateId: string }
  | { type: "generated"; temporaryCandidateId: string };
```

两阶段 formalization：

```text
Phase A：Place + Planning Area Candidate
Phase B：Core Visit，generated parent ref → canonical Candidate ID
```

canonical 永远只保存正式 `planningAreaCandidateId`。

## 10.2 Duplicate Merge

```text
existing detail + incoming core
→ 可升级 core（parent 一致或原无 parent）

existing core + incoming detail
→ 保持 core
```

parent 冲突不得静默 reparent。

Discovery 不覆盖已有用户 preference。

---

# 11. Step 3：Skeleton / 安排路线和天数

输入只包括：

```text
TripFacts
Planning Areas + preference
Core Visits + preference + suggestedDuration
当前已有 Skeleton / Stay Blocks
```

禁止输入大量普通兴趣点。

AI 负责：

```text
选择最终采用的 Planning Areas
Stay Block 顺序
每个 Stay Block stayDays
进入 Block 的语义 transport
omitted Planning Areas + reasons
```

Core Visit 只影响容量，不成为 destination / Anchor。

如果 `must_go Planning Area` 或 `must_go Core Visit` 无法容纳，应返回：

```text
requiresWorkflowStep = requirements | backbone
```

而不是生成明显不可行 Skeleton。

---

# 12. Step 3 手工修改必须使用“草稿 + 原子 Apply”

用户不能逐字段直接把 canonical Skeleton 写成临时非法状态。

右侧维护 UI-only `SkeletonEditDraft`：

```text
顺序草稿
stayDays 草稿
transferMode 草稿
```

用户可以连续修改：

```text
Queenstown 4 → 3
Te Anau 2 → 3
```

实时显示：

```text
总旅行：20 天
当前分配：20 天
✓ 可以应用
```

如果：

```text
总旅行：20 天
当前分配：19 天
```

则：

```text
还需要分配 1 天
[应用修改] disabled
```

只有整个 Draft 满足全部 Skeleton invariant 后，才允许一次原子 Apply。

自然语言同样遵守：

```text
“皇后镇少一天”
```

如果用户没有说明这一天如何重新分配，系统不能偷偷决定；应形成未完成 Draft / 澄清 / 建议，而不是直接写 canonical。

---

# 13. Skeleton Apply 使用专用原子服务，不受通用 100 PlanCommand 上限约束

现有通用 Proposal / PlanCommand 适合局部编辑，但 90 天大范围 Skeleton Replan 可能超过 100 command 上限。

因此新增服务端专用原子边界：

```text
applySkeletonPlanV3()
```

职责：

```text
校验 Skeleton Draft
校验 must / want / optional coverage
formalize / reuse stayBlockId
展开 canonical Days
复用 Day ID
计算 old/new Macro Diff
计算 affectedDayIds
原子 CAS 写入
更新 macroBasisFingerprint
```

UI / AI 仍可以生成 Proposal / Diff 给用户确认，但 Apply 不必机械展开为数百条通用 PlanCommand。

这不是新增第二事实源；最终事实仍是 canonical Day。

---

# 14. Day ID 与 Stay Block ID 复用

Replan 优先：

```text
1 相同稳定 stayBlockId + block 内相对日
2 相同 Planning Area + 相邻结构 / occurrence 匹配
3 相同 Macro signature
4 相同 end Planning Area
5 最后才新建 Day ID
```

只有真正受 Macro Diff 影响的 Day 才进入 `needs_review`。

未受影响 Detailed Day 的 Stop / Route / detailStatus 保持不变。

---

# 15. Macro Dependency Fingerprint：macroDirty 必须派生，不双写

canonical 只保存：

```ts
planningState?: {
  macroBasisVersion: 1;
  macroBasisFingerprint: string | null;
};
```

**不持久化 `macroDirty` 布尔值。**

运行时派生：

```ts
macroDirty =
  currentMacroDependencyFingerprint !== macroBasisFingerprint;
```

缺少 fingerprint：

```text
needs_confirmation
```

避免：

```text
fingerprint 已变化
但 macroDirty=false
```

这种双真相。

Fingerprint 包含真正影响宏观规划的输入：

```text
旅行总天数 / 日期
origin
交通偏好
pace
travelers
重要 constraints / themes / preferences
Planning Area identity + preference
Core parent + preference + duration + role
```

不包含：

```text
纯显示名
Resolution 状态
坐标微调
Provider ID
普通 Detail Interest
AI score
```

旧 Skeleton 无 fingerprint：不自动迁移、不自动 replan；Step 3 显示“需要确认路线和天数”，用户主动 Apply 后建立基线。

---

# 16. Resolution / 未定位完整边界

## 16.1 Planning Area unresolved

```text
Step 2：显示未定位
Step 3：允许做语义 Skeleton
Macro Route：标记待定位，不伪造 geometry / distance / duration
Step 5：只要某 Detailed Day 使用到 unresolved Anchor，则阻塞该 Day 的 Detailed Generate / Update
```

因此 Step 3 与地图解析解耦，但 Step 5 的真实日程与路线不能伪造 Anchor。

## 16.2 Core Visit unresolved

```text
Step 3：仍可参与时间预算
must_go：阻塞相关 Detail Generate / Update
want_to_go / optional：不能成为 Stop，可保留 unscheduled reason
```

## 16.3 Detail Interest unresolved

```text
must_go：阻塞相关 Detail Generate / Update
want_to_go / optional：不进入 Stop，不阻塞其他可用地点
```

## 16.4 origin unresolved

若 origin 会成为某 Day 的真实 startAnchor：

```text
Step 3 可先形成语义 Day
Step 5 / Provider Route 前必须 resolved
```

任何 unresolved 都不得用城市中心 / 猜测坐标伪装 resolved。

---

# 17. Step 4：Capacity-Aware Interests

只有 Skeleton Ready 才允许 AI discovery。

第一次进入 Step 4：

```text
只展示已有内容
不自动批量发现
```

唯一生成入口：

```text
[根据当前行程补充兴趣点]
```

输入至少包含：

```text
Planning Area
采用的 Stay Blocks / stayDays
arrival transfer burden
Core Visits
已有 Detail Interests
TripFacts
pace
```

AI 只返回 `detail_interest`，每个 Planning Area 本轮 0–9，允许 0，不凑数量。

未进入 Skeleton 的 optional Planning Area 默认不做 capacity-aware discovery；如用户之后把它纳入 Step 3，再为它发现兴趣点。

Skeleton Dirty 时：

```text
允许浏览 / 手工编辑 / 定位
禁止按旧容量 AI discovery
Primary = 前往 Step 3 更新
```

---

# 18. Step 5：Detailed Itinerary

Step 5 负责：

```text
每天具体地点
Core Visit 放在哪一天
Detail Interest 选择
时间
Stop 顺序
Detail Route
```

不得修改：

```text
Stay Block 顺序
stayDays
Day start/end Anchor
Day identity
transfer-day 结构
```

若发现 Skeleton 不合理：

```text
requiresWorkflowStep = skeleton
```

## 18.1 排程优先级

```text
core + must_go     → resolved 后必须安排
core + want_to_go  → 优先；失败必须解释
core + optional    → 可不安排

detail + must_go   → resolved 后必须安排
detail + want/opt  → 按容量 / 路线 / pace 选择
```

## 18.2 Detail Update 最小 Diff

只处理 `affectedDayIds`。

当前已保存 Detailed Day 是 sticky baseline：

```text
能保留的 Stop 保留
能保留的顺序保留
能保留的时间保留
用户已确认的手工调整优先保留
```

如果必须大改某一天，Proposal / Update Card 显示真实 Diff。

---

# 19. Role-Aware Impact Analyzer

统一：

```ts
analyzeItineraryImpactV3()
```

先计算 before / after 的 effectivePlanningRole。

Planning Area / Core / 重要 TripFacts 变化：

```text
current fingerprint 改变
→ derived macroDirty=true
```

普通 Detail Interest：

```text
新增 optional / want
→ Skeleton 不变，Detail 不立即失效

新增 / 升级 must_go
→ 只影响可承载的相关 Detail Day

删除未使用
→ 不影响已有 Day

删除已排入
→ 只影响实际使用它的 Day
```

Resolution / 坐标变化只刷新相关 Route，不改变 Macro Fingerprint。

---

# 20. Replan 后二次 Diff

Core Change 不直接让整趟 Detail 失效。

```text
Macro dependency change
↓
derived macroDirty
↓
用户主动 Step 3 Replan / Apply
↓
Compare old/new Stay Blocks + Macro Days
↓
affectedDayIds
↓
只扩展这些 Day needs_review
```

若 Macro 结果完全相同：

```text
macroBasisFingerprint 更新为 current
Skeleton 结构保持
只更新 Core 所属区域 Detail
```

---

# 21. Step 状态

```text
Step 1
基本 TripFacts 存在 → ready

Step 2
至少存在一个 non-excluded Planning Area → 可进入 Step 3

Step 3
存在合法 Skeleton
+ macroBasisFingerprint current
→ ready

旧 Skeleton 无 fingerprint
→ needs_confirmation

Step 4
Step 3 非 ready → 禁止 AI discovery

Step 5
Step 3 非 ready → 禁止 Detailed Generate / Update
使用到 unresolved Anchor / must_go Stop → 局部阻塞
```

`macroDirty` 是运行时派生状态，不是持久化字段。

Day 继续：

```ts
detailStatus = "ready" | "needs_review";
```

---

# 22. Context Builder

建议新增：

```text
apps/server/planning-context-v3.ts
```

纯函数：

```ts
buildBackboneContextV3()
buildSkeletonContextV3()
buildInterestAreaContextV3()
buildDetailPlanningContextV3()
```

Skeleton Context 需包含：

```text
Planning Areas + preference
Core Visits + preference / duration
当前 Stay Blocks
omitted Planning Areas
current vs basis fingerprint state
```

Detail Context 只窗口化相关 Day / Block，并带 sticky baseline。

继续遵守 Context budget。

---

# 23. Prompt / Action 合同

## 23.1 destination.generate

只生成 Planning Area + Core Visit；允许 mixed parent ref；禁止普通兴趣点。

## 23.2 skeleton generate / replan

建议成功输出：

```ts
{
  type: "success";
  stays: SkeletonStayDraft[];
  omittedPlanningAreas: OmittedPlanningArea[];
}
```

校验：

```text
must_go Planning Area 全覆盖
non-excluded Planning Area = represented + omitted
同一 Planning Area 可出现多个 Stay Block
stayDays 总和 = trip day count
Core 不得作为 stay destination
```

失败 / 上游不足：

```ts
{
  type: "requires_workflow_step";
  requiresWorkflowStep: "requirements" | "backbone";
  reason: string;
}
```

## 23.3 interest.discover

只返回 detail_interest，0–9，允许 0。

## 23.4 detail generate / update

固定 Macro；update 只返回 affectedDayIds；遇到 Macro 问题：

```text
requiresWorkflowStep = skeleton
```

---

# 24. Provider / Map 边界

所有 Candidate：

```text
先保存
再 best-effort resolve
```

失败：

```text
保留 Candidate
不自动补位
不回滚其他区域
```

AI 不生产可信：

```text
坐标
Provider Place ID
geometry
distance
duration
```

Macro Route：Day Anchor → Anchor。  
Detail Route：真实 Stop Sequence。  
两种 Route 互不覆盖。

---

# 25. 数据库与兼容策略

保持：

```text
PRAGMA user_version = 3
```

本专项不做：

```text
v3 → v4 migration
旧 loader
双写
自动私人数据库 rewrite
```

新增 `planningRole?`、`planningState?`、`Day.stayBlockId?` 使用 optional backward-compatible JSON 读取。

旧数据不因普通加载自动回写；只有用户主动执行对应业务更新时，新字段才随新的 canonical 结果写入。

---

# 26. 建议新增 / 修改代码边界

重点：

```text
apps/server/contracts-v2.ts
apps/server/planning-roles-v3.ts               新增
apps/server/planning-context-v3.ts             新增
apps/server/itinerary-workflow-v3.ts
apps/server/itinerary-impact-v3.ts
apps/server/ai-action-contracts-v3.ts
apps/server/ai-action-input-contracts-v3.ts
apps/server/ai-stage-contracts-v3.ts
apps/server/ai-registries-v3.ts
apps/server/candidate-workflow-v2.ts
apps/server/planner-runtime-v3.ts
```

Skeleton 相关纯逻辑尽量拆出：

```text
normalizeSkeletonDraft()
validateSkeletonCoverage()
formalizeStayBlockIds()
expandSkeletonDays()
diffMacroDays()
applySkeletonPlanV3()
```

避免继续扩大 Runtime。

前端重点：

```text
apps/web/src/v2-types.ts
apps/web/src/v3-types.ts
apps/web/src/AppV3.tsx
apps/web/src/CandidatePanel.tsx
apps/web/src/MacroItineraryPanelV3.tsx
apps/web/src/ItineraryPanelV2.tsx
apps/web/src/WorkspaceMapV2.tsx
```

---

# 27. 实施顺序

正式实施前先做只读差异审查；随后遵循“先让消费者理解新数据，再让上游生产新数据”。

## Phase 0：Read-only Gap Review

不改代码，只列：

```text
当前 schema / contracts 与本文差异
当前 Skeleton 单目的地一次限制
当前 requiresStage 限制
当前 Resolution readiness
当前 100 PlanCommand 限制
当前 UI 入口
```

产出逐文件差异清单。

## Phase 1：Role + Contract Foundation

完成：

```text
PlanningRole optional schema
Day.stayBlockId optional schema
planningState 仅保存 fingerprint
runtime-derived macroDirty
effectivePlanningRole helpers
requiresWorkflowStep contracts
legacy compatibility
frontend types
```

Targeted tests：

```text
contracts-v2.test.ts
planning-roles-v3.test.ts
ai-action-contracts-v3.test.ts
```

必须覆盖：旧 Candidate / Day 可读、非法 role / parent、无 fingerprint needs_confirmation。

## Phase 2：Skeleton + Impact Consumer Foundation

**先改消费者，再让 Step 2 开始生产 Core。**

完成：

```text
preference-aware Skeleton coverage
repeated Planning Area
stable stayBlockId
arrival transfer day
SkeletonEditDraft validation
applySkeletonPlanV3 atomic Apply
Day ID reuse
Macro fingerprint
Impact Analyzer
Planning Area unresolved semantic Skeleton
```

测试：

```text
itinerary-workflow-v3.test.ts
itinerary-impact-v3.test.ts
ai-stage-contracts-v3.test.ts
stage-context-v3.test.ts
```

核心场景：

```text
Auckland → ... → Auckland
must / want / optional coverage
20 天 draft 分配校验
90 天 Apply 不受 100 command 上限阻断
```

## Phase 3：Backbone Producer

完成：

```text
Mixed Planning Area + Core Visit output
ParentCandidateRef
two-pass formalization
duplicate role upgrade
preserve preference
reparent conflict
Step 2 Core management
Resolver
```

只有到本 Phase，新的 `destination.generate` 才开始正式生产 Core Visit。

测试：

```text
candidate-workflow-v2.test.ts
planner-runtime-v3-ai-actions.test.ts
```

## Phase 4：Capacity-Aware Interests

完成：

```text
只针对采用的 Skeleton 容量 discovery
0–9 detail only
Core duplicate prevention
首次进入不自动 discovery
Core Step 4 只读背景
role upgrade 只导航 Step 2
```

测试：

```text
interest-discovery-v3.test.ts
candidate-discovery-policy-v2.test.ts
workspace-v2.test.ts
planner-runtime-v3-ai-actions.test.ts
```

## Phase 5：Detailed Itinerary

完成：

```text
role-aware Detail Context
Anchor / Core / Detail unresolved readiness
Core scheduling priority
unscheduled reasons
patch-only affectedDayIds
sticky baseline
minimal diff
requiresWorkflowStep=skeleton
```

测试：

```text
itinerary-workflow-v3.test.ts
itinerary-impact-v3.test.ts
planner-runtime-v3-ai-actions.test.ts
```

## Phase 6：UI / Map Integration

完成：

```text
右侧五步导航
Backbone Candidate Panel
Step 3 时间轴 / Stay Block
Skeleton Edit Draft + 分配计数
原子 Apply
Preference omitted 状态
Update Card
未定位前置提示
唯一业务入口
Map role filtering
```

## Phase 7：Docs + Verification Preparation

实施完成后才准备：

```text
git diff --check
targeted Vitest
typecheck
全量 Vitest
build
真实 AI smoke
Browser E2E
```

完整验收仍需用户明确确认。

**Phase 1–6 是同一 feature branch 的连续施工阶段，中间状态不得作为可发布产品单独合并。**

---

# 28. 必须验收的核心场景

## 28.1 Preference 选择

Planning Areas：

```text
A must_go
B want_to_go
C optional
D excluded
```

Step 3：

```text
A 必须进入
B 优先；若 omitted 必须解释
C 可 omitted
D 绝不能进入
```

## 28.2 新西兰 20 天

```text
Te Anau = planning_area
Milford Sound = core_visit
parent = Te Anau
```

Milford：

```text
不成为 city
不成为 Stay Block / Macro Anchor
影响 Te Anau 时间预算
Step 5 成为 Stop
```

## 28.3 环线

```text
Auckland #1
...
Auckland #2
```

两个 Block 有不同稳定 `stayBlockId`，修改其中一个不默认改另一个。

## 28.4 Step 3 手工分配

```text
Queenstown 4 → 3
```

若总分配变 19 / 20 天：不能 Apply。

再：

```text
Te Anau 2 → 3
```

总分配恢复 20 天后，才能一次原子 Apply。

## 28.5 Detail → Core

```text
Step 4 发起 intent
→ Step 2 Impact Card
→ 用户确认 role=core
→ fingerprint 改变 / derived macroDirty
→ Step 3 Replan
```

## 28.6 Replan Macro 不变

更新 basis fingerprint，只使 Core 所属区域 Detail 需更新。

## 28.7 Macro 天数变化

```text
Te Anau 2 → 3
Queenstown 4 → 3
```

只影响真实 changed Day。

## 28.8 unresolved

```text
Planning Area unresolved
→ Step 3 可规划
→ Macro Route pending
→ Step 5 使用该 Anchor 时阻塞

must_go Core / Detail unresolved
→ 阻塞相关 Detail Generate

want / optional unresolved
→ 不排入 Stop，不阻塞无关 Day
```

## 28.9 旧数据

无 `planningRole` / `stayBlockId` / `planningState`：正常读取，不自动写回。

## 28.10 长行程

90 天大范围 Skeleton Replan 使用 `applySkeletonPlanV3` 原子事务，不因通用 100 PlanCommand 上限失败。

---

# 29. 最终架构原则

```text
TripFacts          → 我想进行什么旅行？
Planning Area      → 我在哪里停留和组织路线？
Core Visit         → 哪些重要活动会改变时间预算？
Stay Block         → 以什么顺序停留、每段几天？
Detail Interest    → 固定容量内还有什么值得去？
Detailed Itinerary → 哪一天几点去哪里？
```

系统必须始终表现为：

```text
上游决定结构
下游补充细节
preference 真正影响是否采用
Stay Block 有稳定身份
宏观 dirty 由 fingerprint 派生
跨步骤返回使用 WorkflowStep
Step 3 编辑先草稿后原子 Apply
局部修改只局部失效
地图 / 时间轴只展示与选择
右侧控制台是唯一业务入口
```

本方案完成文档确认后即可作为下一步代码实施的正式施工图；在用户明确要求实施前，不执行任何代码修改或测试。