# TravelPlanner 五步规划流程重构实施方案

## 1. 最终目标

将当前流程调整为真正分层的五步规划：

```text
1 旅行需求
      ↓
2 旅行骨干
   ├─ Planning Area / 规划区域
   └─ Core Visit / 核心游览地
      ↓
3 行程骨架
   ├─ 目的地顺序
   ├─ 各区域停留天数
   ├─ 每日 Macro 起终点
   └─ 跨区域语义交通方式
      ↓
4 兴趣点补充
   └─ Detail Interest / 普通兴趣点
      ↓
5 每日详细行程
   ├─ Core Visit 实际落入某一天
   ├─ Detail Interest 选择与排序
   ├─ 时间安排
   └─ Detail Route
```

核心思想：

> 先确定什么地方真正决定这趟旅行，再分配时间；先有时间预算，再寻找普通兴趣点；最后才将地点落到具体日期和路线。

禁止继续出现：

```text
先给每座城市生成大量景点
→ 再发现只有很少时间
→ 最后大量景点无法安排
```

同时保留增量规划原则：

> 用户修改哪里，只重新计算真正受影响的部分；无关部分继续保持可用。

---

# 2. 用户可见的五步名称

内部仍使用：

```text
requirements
backbone
skeleton
interests
detail
```

但用户导航不要暴露工程术语。

建议导航显示：

```text
1 旅行需求
2 去哪些地方
3 安排路线和天数
4 补充景点
5 每日行程
```

面板内部可保留较完整标题：

```text
1 旅行需求
2 旅行骨干
3 行程骨架
4 兴趣点补充
5 每日详细行程
```

原则：

> 内部模型可以专业，但用户不需要理解 Planning Area、Core Visit、Macro、Detail 等工程概念后才能使用产品。

用户看到的文案优先回答“我现在要做什么”。

---

# 3. 三个必须长期保持独立的概念

## 3.1 Place.kind

回答：

> 这个现实世界实体是什么？

继续保留现有：

```ts
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

禁止为了表达规划重要性继续扩展 PlaceKind。

例如：

```text
蒂阿瑙
kind = city

Milford Sound
kind = attraction

某餐厅
kind = meal
```

## 3.2 planningRole

回答：

> 这个地点在哪一层参与旅行规划？

新增：

```ts
type PlanningRole =
  | "planning_area"
  | "core_visit"
  | "detail_interest";
```

### planning_area

规划区域、住宿基地、路线城市。

它进入第三步“行程骨架”，决定：

- 顺序；
- 停留天数；
- Macro Day Anchor；
- 跨区域移动。

canonical 约束：

```text
planningRole = planning_area
Place.kind = city
planningAreaCandidateId = null
```

### core_visit

不作为住宿基地，但其存在会明显影响旅行时间分配的重要地点。

例如：

```text
Milford Sound
Hobbiton
Tongariro Alpine Crossing
某需要独立半天或全天的国家公园线路
```

它不会成为 Macro Anchor。

它只会：

```text
影响第三步停留天数分配
+
第五步成为真实 Stop
```

canonical 约束：

```text
planningRole = core_visit
Place.kind != city
planningAreaCandidateId = 某 planning_area Candidate
```

### detail_interest

普通景点、餐厅、观景点、短时间活动等。

原则上不影响第三步行程骨架，而是在第四、第五步参与：

```text
候选发现
→ 每日安排
```

canonical 约束：

```text
planningRole = detail_interest
Place.kind != city
planningAreaCandidateId = 某 planning_area Candidate
```

## 3.3 preference

继续保留：

```ts
must_go
want_to_go
optional
excluded
```

它回答：

> 用户有多想去？

planningRole 与 preference 必须完全独立。

允许：

```text
core_visit + must_go
core_visit + want_to_go
core_visit + optional

detail_interest + must_go
detail_interest + want_to_go
detail_interest + optional
```

禁止形成：

```text
core_visit ≈ must_go
detail_interest ≈ optional
```

---

# 4. Core Visit 的严格判定标准

AI 不得因为“一个地方很有名”就自动设为 core_visit，也不得因为用户提到过就自动升级。

Core Visit 必须首先满足：

> 这个地点会显著改变宏观时间安排。

至少具有以下一种特征：

```text
通常需要独立半天或全天
明显绕行
需要特殊交通方式
存在强时间窗口
必须围绕它安排某一天
活动本身会明显占用该区域可用旅行时间
```

并同时满足：

```text
用户明确重视
或
实时研究确认其对当前旅行主题具有显著代表性
```

反例：

```text
用户说“我一定要吃 XX 汉堡”
```

应该是：

```text
detail_interest + must_go
```

而不是 core_visit。

---

# 5. WorkflowStep 与 ConversationStage

增加独立 UI Workflow：

```ts
type WorkflowStepV3 =
  | "requirements"
  | "backbone"
  | "skeleton"
  | "interests"
  | "detail";
```

数据库继续只保留现有四个 ConversationStage：

```text
requirements
destinations
interests
itinerary
```

映射：

```text
Workflow Step            ConversationStage
------------------------------------------------
requirements             requirements
backbone                 destinations
skeleton                 destinations
interests                interests
detail                   itinerary
```

第三步“行程骨架”归属 destinations ConversationStage。

原因：第二步和第三步本质上都属于 Macro Planning；第五步 itinerary 只负责真正的每日详细行程。

Conversation 请求增加：

```ts
workflowStep
```

服务端必须校验合法映射。

`workflowStep` 只用于本轮：

- Prompt 选择；
- Context 构造；
- Action 识别。

不要求增加数据库字段，旧 Message 不迁移。

---

# 6. TripCandidate 与角色兼容

在 `TripCandidate` 增加：

```ts
planningRole?: "planning_area" | "core_visit" | "detail_interest"
```

旧 Candidate 允许缺字段。

统一 helper：

```ts
effectivePlanningRole(candidate, place)
```

逻辑：

```ts
if (candidate.planningRole) return candidate.planningRole;
if (place.kind === "city") return "planning_area";
return "detail_interest";
```

旧数据只在运行时解释，不自动回写。

今后只要创建或真正修改相关 Candidate，应显式写 `planningRole`。

统一新增 `planning-roles-v3.ts`：

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

不得再用 `kind === city` 同时承担实体类型和规划层级两个语义。

---

# 7. Canonical Role Invariants

## planning_area

```text
Place.kind = city
planningAreaCandidateId = null
```

## core_visit

```text
Place.kind != city
planningAreaCandidateId != null
parent effectivePlanningRole = planning_area
```

禁止 core_visit/detail_interest 作为 core_visit 的父级。

## detail_interest

新数据必须：

```text
Place.kind != city
planningAreaCandidateId != null
parent = planning_area
```

旧数据继续按现有兼容边界读取。

---

# 8. Macro Dependency Fingerprint

为支持真正的增量更新，增加可选：

```ts
planningState?: {
  macroBasisVersion: 1;
  macroBasisFingerprint: string | null;
  macroDirty: boolean;
}
```

旧旅行不自动增加字段。

首次生成骨架后：

```text
macroBasisFingerprint = 当前 Macro Dependency Hash
macroDirty = false
```

以下变化设置 `macroDirty = true`：

```text
新增/删除 planning_area
planning_area excluded / 恢复
新增/删除 core_visit
core_visit preference 变化
detail_interest ↔ core_visit
core_visit parent 显式变化
core_visit suggestedDuration 显著变化
总旅行天数变化
```

Fingerprint 不包含：

```text
显示名称
定位状态
坐标微调
Provider Place ID
普通 detail_interest
```

推荐输入包括：

```text
旅行总天数 / 日期
起点
交通偏好
pace
travelers
重要 constraints / themes / preferences

active planning_area:
  candidateId
  preference
  relevant administrative identity

active core_visit:
  candidateId
  planningAreaCandidateId
  preference
  suggestedDurationMinutes
  planningRole
```

---

# 9. 第二步：去哪些地方 / 旅行骨干

第二步不再是“找城市”，而是：

> 找出真正构成这趟旅行宏观结构的地点。

输出：

```text
planning_area
core_visit
```

禁止输出普通 `detail_interest`。

## 9.1 用户可见 UI

用户不直接看到工程术语作为主要表单选项。

推荐文案：

```text
添加停留城市 / 区域
添加重要游览地
```

“重要游览地”旁提供短说明：

> 会占用较多时间、明显绕行或需要单独安排半天/一天的地点。

列表可表现为：

```text
蒂阿瑙
  └ Milford Sound   [核心]

皇后镇
  └ Routeburn Track [核心]
```

Step 2 的用户任务只有一个：

> 确认这趟旅行到底围绕哪些地方展开。

不要在这里要求用户决定具体某一天去 Core Visit。

## 9.2 Destination Generation

`destination.generate` 改为 Mixed Backbone Output。

AI 可返回 `planning_area` 和 `core_visit`，不可返回 `detail_interest`。

使用 temporary ID + two-pass formalization：

- Phase A：正式化 Place + planning_area Candidate；
- Phase B：正式化 core_visit，并把 temporary parent 解析为 canonical Candidate ID。

canonical `planningAreaCandidateId` 永远只保存正式 Candidate ID。

## 9.3 Duplicate Merge

同一现实 Place 仍只能有一个 Candidate。

```text
existing detail_interest + incoming core_visit
→ 可升级 core_visit
```

前提父 Planning Area 一致或原来无父级。

```text
existing core_visit + incoming detail_interest
→ 保持 core_visit
```

Parent 不一致不得静默修改，必须提示用户选择。

Discovery 不覆盖已有 preference。

AI 普通研究推荐的新 Candidate 默认 `optional`；只有用户明确表达“想去 / 一定要去”时才提升 preference。

---

# 10. 第三步：安排路线和天数 / 行程骨架

第三步解决：

```text
Planning Area 顺序
每个 Planning Area stayDays
进入每个区域的语义 transport mode
Day Macro Anchor 展开
```

Core Visit 只影响时间预算，不能成为 Macro destination / Anchor。

例如：

```text
Te Anau
core: Milford Sound
suggestedDuration ≈ 1 day
```

AI 应理解 Te Anau 的时间预算必须为 Milford 留容量，但不能在第三步决定 Milford 到底 Day 14 还是 Day 15。

## 10.1 第三步是最重要的确认步骤

UI 不应只显示简单城市列表。

必须把“20 天是怎么被切开的”视觉化，推荐使用时间轴 / Day Range 卡片：

```text
Day 1–2   奥克兰 · 2 天
    ↓ 自驾
Day 3–4   罗托鲁瓦 · 2 天
    ↓ 自驾
Day 5     陶波 · 1 天
```

用户应能直接理解：

> 现在是在确认去哪、什么顺序、每个地方几天。

第三步应成为整个产品的核心 Macro 视图之一，而不是普通列表页。

## 10.2 无法满足必须条件

如果总天数无法容纳当前 planning_area 与 must_go core visit，不应硬生成明显不可行骨架。

返回：

```text
requires_stage: requirements | destinations
```

并解释是需要增加旅行天数还是调整核心地点。

## 10.3 Day 与 Macro Route

不新增 MacroDay 表。

第三步 AI 输出：

```text
destinationCandidateId
stayDays
transferMode
```

服务端确定性展开 canonical Day。

更新骨架时优先复用已有 Day ID：

```text
1 相同 Macro signature
2 相同 end Planning Area
3 最后才重新映射
```

Macro Route 只连接：

```text
Day.startAnchor → Day.endAnchor
```

只有起终点不同才生成。

Core Visit 不进入 Macro Route。

---

# 11. 第四步：补充景点 / 兴趣点补充

第三步完成后才开始普通兴趣点研究。

Interest Discovery 每个 Planning Area 输入必须知道：

```text
Planning Area
stayDays
Macro Day
arrival transfer burden
已有 Core Visits
已有 Detail Interests
TripFacts
```

AI 根据 stayDays、transfer burden、core visit duration、pace 做语义判断，不由代码制造“剩余 372 分钟”之类虚假精度。

`interest.discover / supplement` 只能生成 `detail_interest`。

AI 自主返回 0–9 个，允许 0，不得为了凑数量生成。

## 11.1 第一次进入 Step 4 不自动大量生成

原方案“首次进入可自动启动 interest.discover”调整为：

> 第一次进入 Step 4，只展示当前已有 Core Visit、已有普通兴趣点和区域停留天数；由用户点击主操作按钮后再执行 capacity-aware discovery。

推荐主按钮：

```text
根据当前行程补充兴趣点
```

原因：一次发现可能产生大量 Candidate，不应因为用户只是切换步骤就自动修改大量内容。

## 11.2 Step 4 必须继续显示 Core Visit

例如：

```text
蒂阿瑙 · 2 天

核心游览地
★ Milford Sound [核心]

普通兴趣点
○ Glowworm Caves
○ Lake Te Anau
```

这样用户能够理解：

> 为什么这里只有这么少的剩余可安排空间？

## 11.3 Role Promotion

允许用户显式：

```text
普通兴趣点 → 设为重要游览地
```

对应确定性 Action：

```text
interest.role
```

Detail → Core 或 Core → Detail：

```text
保留 preference
保留 parent
macroDirty = true
```

并先只把对应 Planning Area 的详细 Day 标记为 `needs_review`。

## 11.4 Skeleton Dirty 时

如果 `macroDirty = true`：

仍允许：

```text
浏览兴趣点
编辑 preference
手动新增
定位
```

但禁止新的 capacity-aware AI discovery。

用户可见文案不要只写“需更新”，而应说明：

```text
行程的路线或停留天数可能已经变化。
请先更新“安排路线和天数”，再根据新的时间容量补充景点。
```

并提供唯一主按钮：

```text
更新路线和天数
```

---

# 12. 第五步：每日行程 / 每日详细行程

第五步才真正解决：

```text
每天去哪里
几点开始 / 结束
Core Visit 放哪一天
普通兴趣点选哪些
访问顺序
Detail Route
```

输入必须区分：

```text
coreVisits
detailInterests
```

Core Visit 永远是 Stop，不能成为 Macro Anchor。

### core_visit + must_go

已定位：必须排入。

未定位：不能假装成功。

### core_visit + want_to_go

优先尝试安排；不能安排必须进入 `unscheduledCandidates` 并说明原因。

### core_visit + optional

允许不安排，但建议保留未采用说明。

### detail_interest + must_go

必须安排。

### detail_interest + want_to_go / optional

根据时间、路线、节奏和 Core Visit 占用自主选择。

普通未采用兴趣点无需全部进入 unscheduledCandidates。

Detailed Planner 不得修改：

```text
Planning Area 顺序
stayDays
Day.startAnchor
Day.endAnchor
transfer day
Day identity
```

若认为 Skeleton 不合理，必须要求回第三步更新，不能偷偷修改。

---

# 13. 未定位地点的用户体验

保持安全边界：

```text
未定位地点不得成为真实 Stop
```

但未定位 `core_visit` 仍可以影响第三步 Macro 时间分配。

不要等用户到了第五步生成失败才第一次提示。

从 Step 2 / Step 4 起即可显示：

```text
⚠ Milford Sound 尚未定位
不会影响当前路线和天数规划，
但生成每日详细路线前需要完成定位。

[重新定位]
```

第五步若存在 `must_go core + unresolved`，主生成按钮应禁用或执行前明确拦截，并把问题直接定位到对应地点。

---

# 14. Role-Aware Impact Analyzer

重构：

```ts
analyzeItineraryImpactV3()
```

先计算：

```text
effectivePlanningRole(before)
effectivePlanningRole(after)
```

## Planning Area Changes

以下情况：

```text
新增
删除
excluded
恢复
会改变是否参与旅行的 preference 修改
```

→ `macroDirty = true`

纯显示名称变化不重新规划。

Resolution / coordinate 只刷新相关 Macro Route。

## Core Visit Changes

以下变化：

```text
新增
删除
excluded / 恢复
preference 改变
detail → core
core → detail
parent 显式改变
建议占用时长改变
```

→ `macroDirty = true`

同时当前 Skeleton 中相关 Planning Area 的详细 Day 先标记 `needs_review`。

Core Change 不直接让整个旅行 Detailed 失效。

流程：

```text
Core Change
↓
Macro Dirty
↓
AI Replan Skeleton
↓
Compare old/new Macro
↓
确定真正 affectedDayIds
↓
扩展 Detail needs_review
```

如果 Skeleton Replan 后结构完全一样：

```text
macroDirty 清除
只更新 Core 所属区域的 Detail
```

---

# 15. “需更新”必须解释原因与影响范围

这是五步体验的强制产品规则。

禁止只显示：

```text
Step 3 需更新
Step 5 需更新
```

必须至少给出：

1. 为什么需要更新；
2. 哪些区域 / 哪些 Day 受影响；
3. 哪些内容保持不变；
4. 一个唯一主操作按钮。

例如：

```text
Milford Sound 已设为重要游览地，
原来的蒂阿瑙停留天数没有考虑这个全天活动。

需要重新检查：蒂阿瑙及相邻移动日。
其他 18 天保持不变。

[更新路线和天数]
```

Skeleton 更新后如果结构完全相同：

```text
路线和停留天数无需调整。
只需要更新蒂阿瑙的每日安排。
```

用户必须清楚感知：

> 系统不是把整趟旅行推翻，而是在局部重新计算。

---

# 16. Step 状态与默认打开步骤

继续复用：

```ts
Day.detailStatus = ready | needs_review
```

UI 映射：

```text
ready
needs_update
```

Step 状态：

```text
Step 1：有基本 TripFacts → ready
Step 2：至少一个 active planning_area → 可进入 Step 3
Step 3：days.length > 0 且 macroDirty=false 且 fingerprint current → ready
Step 4：没有 Skeleton 时不能 AI 自动发现；Skeleton Dirty 时只能编辑不能 capacity-aware discovery
Step 5：Macro Dirty 时不能生成新的详细计划
```

默认打开：

```ts
if (存在 detailed Day) → detail
else if (存在 Macro Day) → interests
else if (存在 backbone Candidate) → backbone
else → requirements
```

重新打开 Trip 时不要强制自动跳到 Skeleton。

---

# 17. 地图与唯一交互入口

地图继续只负责：

```text
展示
选择
聚焦
```

不得形成与右侧主工作区平行的第二套编辑入口。

Primary Management Step：

```text
planning_area → backbone
core_visit → backbone
detail_interest → interests
Day / Stop → detail
```

地图点击地点后，只改变当前 selection，并让右侧对应工作区显示该对象；增删改、角色调整、更新规划等主操作仍在右侧工作区完成。

这一原则必须与独立文档《五步 UI 交互规范》保持一致。

---

# 18. Continue 与主操作行为

每一步只保留一个明确的“继续到下一层”主动作。

```text
Step 1 → Step 2
首次：destination.generate

Step 2 → Step 3
首次：itinerary.generate
已有 Skeleton Dirty：itinerary.replan

Step 3 → Step 4
只切换到 Step 4，不自动批量生成兴趣点

Step 4 内
用户点击“根据当前行程补充兴趣点” → interest.discover

Step 4 → Step 5
没有详细行程：itinerary.detail.generate
Detail Needs Update：itinerary.detail.update
```

如果当前上游 Dirty，下一步主动作必须被替换成“先更新上游”，而不是允许用户继续制造基于旧数据的新结果。

---

# 19. Prompt 与 Context 责任

建议从 `planner-runtime-v3.ts` 抽离：

```text
planning-context-v3.ts
```

提供：

```ts
buildBackboneContextV3()
buildSkeletonContextV3()
buildInterestAreaContextV3()
buildDetailPlanningContextV3()
```

### Backbone Context

```text
TripFacts
Planning Areas
Core Visits
当前 selection
workflowStep=backbone
```

不包含普通 Detail Interests。

### Skeleton Context

```text
TripFacts
Planning Areas
Core Visits
当前 Macro Day 摘要
Macro Update State
Macro Route 摘要
workflowStep=skeleton
```

### Interest Context

```text
Planning Areas
stayDays
Core Visits
Detail Interests
Resolution status
focused area
Skeleton status
```

### Detail Context

当前窗口化 Day + 当前 Day 起终点 Planning Area 下：

```text
Core Visits
must_go Detail Interests
相关 unscheduled 状态
```

继续遵守 64 KB context budget。

---

# 20. Dialogue Action 边界

## backbone

允许：

```text
destination.generate
destination.add
destination.remove
destination.replace
destination.edit
destination.preference
```

## skeleton

允许：

```text
itinerary.generate
itinerary.replan
```

以及 Planning Area preference 的明确调整。

Skeleton Dialogue 不直接创建新地点；缺地点时提示回 Step 2。

## interests

允许：

```text
interest.discover
interest.supplement
interest.add
interest.remove
interest.replace
interest.edit
interest.preference
interest.role
```

## detail

负责：

```text
itinerary.detail.generate
itinerary.detail.update
stop.*
day.optimize
repair
verify
refine
```

---

# 21. 关键 Product Prompt

## 21.1 生成旅行骨干

`prompts/actions/destinations/生成目的地建议.md`

目标：

> 研究并生成构成当前旅行宏观结构的 Planning Area 和 Core Visit，而不是寻找普通景点。

AI 使用实时网页研究，但不得输出坐标、路线距离、Provider facts、URL 或来源列表。

## 21.2 生成行程骨架

`prompts/actions/itinerary/生成行程.md`

核心规则：

```text
只负责宏观时间分配
Planning Area 才是 destination
Core Visit 只能作为时间需求输入
所有 Planning Area 必须出现一次
stayDays 总和严格等于总旅行天数
不得安排具体 Stop
```

## 21.3 发现兴趣点

`prompts/actions/interests/发现兴趣点.md`

输入新增：

```text
stayDays
Core Visits
已有 Detail Interests
Transfer burden
```

只能生成 `detail_interest`，返回 0–9，允许 0，不凑数量，不重复 Core Visit。

## 21.4 生成每日详细行程

`prompts/actions/itinerary/生成每日详细行程.md`

明确：

```text
Macro Skeleton 已固定
Core Visit 是高影响 Stop
must_go core 必须安排
want_to_go core 优先安排且失败要解释
普通 Detail Interest 只在剩余时间内选择
不得为了使用更多 Candidate 把日程塞满
```

Shared Prompt 统一定义 `Place.kind / planningRole / preference` 三个独立概念。

---

# 22. Frontend 核心修改

同步 `apps/web/src/v2-types.ts`：

```ts
planningRole?: PlanningRole
```

新增前端 `effectivePlanningRole(row)`。

`CandidatePanel`：

```ts
view: "backbone" | "interests"
```

Backbone 显示：

```text
planning_area
core_visit
```

Interests 显示：

```text
core_visit
detail_interest
```

Step 2 手动新增用户文案：

```text
添加停留城市 / 区域
添加重要游览地
```

Step 4 默认：

```text
添加普通兴趣点
```

如需要，再显式“设为重要游览地”。

`AppV3` 显示顺序：

```text
requirements
backbone
skeleton
interests
detail
```

用户导航文案使用：

```text
旅行需求
去哪些地方
安排路线和天数
补充景点
每日行程
```

---

# 23. Planning Area 删除保护

删除 planning_area 继续级联其 core_visit 与 detail_interest，但不能静默执行。

确认必须列出：

```text
删除“蒂阿瑙”还会删除：

重要游览地：
- Milford Sound

普通兴趣点：
- ...
```

如果包含 `must_go core_visit`，使用更明确警告：

```text
其中包含“必去”的重要游览地。
```

服务端也必须计算 descendant core visits、detail interests、affected days，不能只依赖前端 confirm。

自然语言删除同样必须通过 Action Card 展示影响后确认。

---

# 24. Location Resolver 与 Route Provider

所有新 Candidate：

```text
先保存
再 best-effort resolve
```

失败：

```text
保留 Candidate
显示 unresolved
允许重试 / 手工定位
```

Core Visit unresolved 不阻止 Skeleton，但阻止成为 Detail Stop。

AI 不生产可信距离 / 时长。

Skeleton：

```text
AI → 语义 transfer mode
Provider → Macro Route
```

Detail：

```text
AI → Stop semantic transport
Provider → Detail Route
```

Macro Route 与 Detail Route 互不覆盖。

---

# 25. 建议新增 / 修改文件

服务端重点：

```text
apps/server/contracts-v2.ts
apps/server/planning-roles-v3.ts
apps/server/planning-context-v3.ts
apps/server/planning-areas-v2.ts
apps/server/candidate-workflow-v2.ts
apps/server/candidate-discovery-policy-v2.ts
apps/server/ai-led-micro-contract-v2.ts
apps/server/ai-action-contracts-v3.ts
apps/server/ai-action-input-contracts-v3.ts
apps/server/ai-stage-contracts-v3.ts
apps/server/ai-registries-v3.ts
apps/server/stage-context-v3.ts
apps/server/itinerary-workflow-v3.ts
apps/server/itinerary-impact-v3.ts
apps/server/plan-commands-v2.ts
apps/server/planner-runtime-v3.ts
```

前端重点：

```text
apps/web/src/v2-types.ts
apps/web/src/v3-types.ts
apps/web/src/AppV3.tsx
apps/web/src/CandidatePanel.tsx
apps/web/src/workspace-v2.ts
apps/web/src/WorkspaceMapV2.tsx
apps/web/src/MacroItineraryPanelV3.tsx
apps/web/src/ItineraryPanelV2.tsx
相关 CSS
```

Prompt：

```text
prompts/shared/旅行规划共享规则.md
prompts/dialogues/目的地对话.md
prompts/dialogues/兴趣点对话.md
prompts/dialogues/行程对话.md
prompts/actions/destinations/生成目的地建议.md
prompts/actions/destinations/新增目的地.md
prompts/actions/destinations/替换目的地.md
prompts/actions/interests/发现兴趣点.md
prompts/actions/interests/补充兴趣点.md
prompts/actions/interests/新增兴趣点.md
prompts/actions/interests/替换兴趣点.md
prompts/actions/itinerary/生成行程.md
prompts/actions/itinerary/重新规划行程.md
prompts/actions/itinerary/生成每日详细行程.md
prompts/actions/itinerary/更新每日详细行程.md
```

文档至少同步：

```text
README.md
docs/PRODUCT_PLAN.md
docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md
docs/ITINERARY_MACRO_DETAIL_INCREMENTAL_DESIGN.md
docs/IMPLEMENTATION_STATUS.md
docs/README.md
docs/五步 UI 交互规范.md
```

---

# 26. 数据库策略

明确不做：

```text
PRAGMA user_version bump
v3 → v4 migration
旧 loader
双写
private database rewrite
```

继续 `PRAGMA user_version = 3`。

新增数据主要位于现有 canonical JSON，字段 optional backward-compatible。

禁止自动迁移旧 Candidate。

---

# 27. 实施阶段

## Phase 1：Role Foundation

完成：

```text
PlanningRole Schema
TripCandidate optional planningRole
effectivePlanningRole helper
role invariants
PlanningState / macro fingerprint
planning-areas role-aware
frontend types
```

## Phase 2：Backbone Generation

完成：

```text
Mixed Destination Output
ParentCandidateRef
two-pass formalization
duplicate role upgrade
preserve preference
reparent conflict
Destination Add/Replace
Resolver
```

## Phase 3：Workflow + Skeleton

完成：

```text
WorkflowStepV3
五步顺序
ConversationStage mapping
itinerary.generate/replan → destinations stage
Skeleton Core Summary
Macro Fingerprint
Macro Dirty
第三步时间轴 / Day Range 核心 UI
```

## Phase 4：Capacity-Aware Interests

完成：

```text
Skeleton → Interest Context
0–9 detail only
Core duplicate prevention
Step 4 UI
interest.role
macro dirty on promotion
首次进入不自动批量 discovery
```

## Phase 5：Detailed Itinerary

完成：

```text
role-aware Detail Input
Core scheduling priority
unresolved must-go readiness
unscheduled Core reasons
local Detail invalidation
```

## Phase 6：UI / Map

完成：

```text
新的五步导航文案
Backbone Candidate Panel
Interest Candidate Panel
Role Badge
Delete confirmation
Map role filtering
Skeleton / Detail 地图视图
needs_update 原因解释
唯一主操作入口
未定位前置提示
```

## Phase 7：Docs + Final Verification Preparation

先：

```text
git diff --check
```

整理建议 targeted Vitest、typecheck、全量 Vitest、build、真实 AI smoke、Browser E2E 及各自成本。

必须取得用户确认后才能运行最终完整验收。

---

# 28. 核心验收场景

## 新西兰 20 天

输入：

```text
20 天
新西兰
自驾
```

Step 2 至少形成：

```text
Te Anau → planning_area
Milford Sound → core_visit, parent=Te Anau
```

Milford 不得生成为 city。

Step 3：Milford 不出现在 destinations[]，但必须影响 Te Anau stayDays。

Step 4：Milford 不得再次出现为普通兴趣点；Te Anau 剩余容量有限时允许只新增 0–3 个普通兴趣点。

Step 5：Milford 成为 Stop，不是 Anchor。

## Incremental A

```text
detail_interest → core_visit
```

结果：

```text
Step 3 needs_update
当前 parent area Detail Days needs_update
其他无关地区保持 ready
```

UI 必须解释原因及影响范围。

## Incremental B

Skeleton 重新规划后结构完全一样：

```text
Step 3 ready
只更新 Core 所属区域 Detail
```

## Incremental C

```text
Te Anau 2 → 3
Queenstown 4 → 3
```

只标记真正涉及的 Day，其他天明确保持不变。

## Incremental D

新增：

```text
detail_interest + optional
```

结果：

```text
Step 3 ready
Step 5 ready
只是多一个候选
```

## Delete

删除 Te Anau 且其下有 `Milford Sound + must_go`：必须明确确认级联影响，不能静默删除。

## Resolution

`Milford + core_visit + must_go + unresolved`：

```text
Step 3 可正常生成 Skeleton
Step 2 / Step 4 提前显示未定位提示
Step 5 不得完成 Detailed Plan
```

## 旧数据

没有 planningRole 的 Candidate 仍必须正常读取，且不得自动迁移真实私人数据库。

---

# 29. 最终架构与用户体验原则

内部责任：

```text
TripFacts
回答：我想进行什么旅行？

Planning Area
回答：我在哪里停留和组织路线？

Core Visit
回答：哪些重要活动会改变时间分配？

Skeleton
回答：时间到底怎么分？

Detail Interest
回答：在已经确定的时间内还有什么值得去？

Detailed Itinerary
回答：具体哪一天几点去哪里？
```

用户心智应更简单：

```text
我要怎么玩
→ 去哪些地方
→ 这些天怎么分
→ 还有什么值得去
→ 每天具体怎么玩
```

最终产品最重要的能力不是：

> 一次性生成一篇看起来很完整的旅行计划。

而是：

> 将旅行逐层规划正确，并且用户修改一个局部时，只重新计算真正受影响的部分。

用户不应被迫理解内部架构概念，也不应因为任何小修改而担心整趟旅行被重做。
