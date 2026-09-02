# TravelPlanner 五步规划流程重构实施方案

> 状态：**已确认的文档设计，尚未实施**  
> 更新日期：2026-09-02  
> 适用范围：TravelPlanner v3 产品流程、Candidate 角色、Macro/Detail 规划、Prompt / Action / Context、增量更新与 UI 责任边界  
> 配套 UI 规范：[`五步 UI 交互规范.md`](./五步%20UI%20交互规范.md)

---

# 1. 最终目标

将产品流程统一为：

```text
1 旅行需求
      ↓
2 旅行骨干
   ├─ Planning Area / 规划区域
   └─ Core Visit / 核心游览地
      ↓
3 行程骨架
   ├─ Planning Area 顺序
   ├─ Stay Block / 停留段
   ├─ 各停留段天数
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

> 先确定什么地方真正决定这趟旅行，再分配时间；先有时间预算，再寻找普通兴趣点；最后才把地点落到具体日期和路线。

不能再出现：

```text
先给每座城市生成大量景点
→ 再发现只有很少时间
→ 最后大量景点无法安排
```

同时坚持增量原则：

> 用户修改哪里，只重新计算真正受影响的部分；无关部分继续保持可用。

---

# 2. 用户可见五步名称

内部 WorkflowStep：

```ts
type WorkflowStepV3 =
  | "requirements"
  | "backbone"
  | "skeleton"
  | "interests"
  | "detail";
```

用户导航统一显示：

```text
1 旅行需求
2 去哪些地方
3 安排路线和天数
4 补充景点
5 每日行程
```

不要要求用户理解以下工程术语才能使用产品：

```text
Planning Area
Core Visit
Backbone
Skeleton
Macro
Detail
```

这些术语可以存在于代码、Prompt、Schema 和开发文档中。

---

# 3. 页面结构：地图 + 右侧唯一控制台

产品继续采用两区结构，不新增独立左侧步骤栏：

```text
┌──────────────────────────────┬───────────────────────────┐
│                              │ 1需求 2去哪 3路线天数     │
│                              │ 4景点 5每日行程           │
│        地图 / 时间轴         │───────────────────────────│
│        结果与选择            │ 当前步骤内容              │
│                              │ 当前对象详情              │
│                              │ AI 对话 / Action / 状态   │
│                              │ [唯一 Primary CTA]       │
└──────────────────────────────┴───────────────────────────┘
```

强规则：

- 五步导航属于右侧控制台顶部；
- 地图 / 时间轴负责展示、选择、聚焦；
- 所有会修改 canonical 数据、触发 AI、推进流程、修复定位、更新路线的业务动作只在右侧控制台执行；
- 同一业务动作只能有一个 canonical UI 入口。

详细交互见《五步 UI 交互规范》。

---

# 4. 动作归属：生成某一步，只能在该步骤执行

这是本次 review 后新增的 P0 规则。

```text
Step 1 旅行需求
→ 只修改需求

Step 2 去哪些地方
→ destination.generate / add / remove / replace / edit / preference

Step 3 安排路线和天数
→ itinerary.generate / itinerary.replan
→ 确定性修改顺序、stayDays、transferMode

Step 4 补充景点
→ interest.discover / supplement / add / remove / replace / edit / preference

Step 5 每日行程
→ itinerary.detail.generate / itinerary.detail.update
→ stop.* / day.optimize / repair / verify / refine
```

跨步骤 CTA **只负责导航**，不得替目标步骤执行生成动作。

例如：

```text
Step 2 [下一步：安排路线和天数]
→ 只进入 Step 3
→ Step 3 内 [生成路线和天数]
```

如果用户在 Step 5 发现 Step 3 已过期：

```text
[前往更新路线和天数]
→ 切换到 Step 3
→ 在 Step 3 执行唯一的 itinerary.replan
```

这样才能真正满足“同一个功能只有一个入口”。

---

# 5. 三个必须长期保持独立的概念

## 5.1 Place.kind

回答：

> 现实世界实体是什么？

继续保留：

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

禁止为了表达规划重要性扩展 PlaceKind。

## 5.2 planningRole

回答：

> 这个地点在哪一层参与旅行规划？

```ts
type PlanningRole =
  | "planning_area"
  | "core_visit"
  | "detail_interest";
```

### planning_area

规划区域、住宿基地、路线城市。

```text
planningRole = planning_area
Place.kind = city
planningAreaCandidateId = null
```

它决定：

```text
Stay Block
顺序
停留天数
Macro Anchor
跨区域移动
```

### core_visit

不作为住宿基地，但会显著影响宏观时间分配的重要非城市地点。

```text
planningRole = core_visit
Place.kind != city
planningAreaCandidateId = 某 planning_area Candidate
```

它：

```text
影响 Step 3 时间预算
+
在 Step 5 成为真实 Stop
```

它绝不成为 Macro Anchor。

### detail_interest

普通景点、餐厅、观景点、短活动。

```text
planningRole = detail_interest
Place.kind != city
planningAreaCandidateId = 某 planning_area Candidate
```

原则上不改变 Step 3 Skeleton，只参与 Step 4 / Step 5。

## 5.3 preference

继续：

```ts
must_go
want_to_go
optional
excluded
```

它回答：

> 用户有多想去？

`planningRole` 与 `preference` 必须完全独立。

---

# 6. Core Visit 严格判定

AI 不得因为“有名”或“用户提到过”就自动设为 Core Visit。

Core Visit 必须首先满足：

> 会显著改变宏观时间安排。

至少具有以下一种特征：

```text
通常需要独立半天或全天
明显绕行
需要特殊交通方式
存在强时间窗口
必须围绕它安排某一天
活动本身明显占用该区域时间容量
```

并同时满足：

```text
用户明确重视
或
实时研究确认其对当前旅行主题具有显著代表性
```

例如用户说“一定要吃某家汉堡”：

```text
detail_interest + must_go
```

不是 core_visit。

---

# 7. WorkflowStep 与 ConversationStage

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
WorkflowStep       ConversationStage
------------------------------------
requirements       requirements
backbone           destinations
skeleton           destinations
interests          interests
detail             itinerary
```

重要含义：

```text
destinations ConversationStage
= Step 2 + Step 3 的 Macro Planning 对话空间

itinerary ConversationStage
= Step 5 的 Detailed Planning 对话空间
```

Conversation 请求增加本轮 `workflowStep`，服务端必须校验合法映射。

不增加第五种数据库 ConversationStage，不迁移旧 Message。

---

# 8. TripCandidate 兼容与 Canonical Role Invariants

`TripCandidate` 增加：

```ts
planningRole?: "planning_area" | "core_visit" | "detail_interest";
```

旧 Candidate 允许缺失。

统一：

```ts
effectivePlanningRole(candidate, place)
```

```ts
if (candidate.planningRole) return candidate.planningRole;
if (place.kind === "city") return "planning_area";
return "detail_interest";
```

旧数据只在运行时解释，不自动回写。

新创建或真正修改角色相关 Candidate 必须显式写 `planningRole`。

新增纯函数模块：

```text
apps/server/planning-roles-v3.ts
```

至少提供：

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

Canonical 约束：

```text
planning_area:
  Place.kind = city
  planningAreaCandidateId = null

core_visit:
  Place.kind != city
  planningAreaCandidateId != null
  parent role = planning_area

detail_interest:
  新数据 Place.kind != city
  planningAreaCandidateId != null
  parent role = planning_area
```

不得机械把仓库所有 `kind === city` 替换掉；必须判断代码是在表达实体类型还是规划层级。

---

# 9. Macro Dependency Fingerprint

建议在 `TravelPlanDocument` 增加可选：

```ts
planningState?: {
  macroBasisVersion: 1;
  macroBasisFingerprint: string | null;
  macroDirty: boolean;
};
```

旧旅行不设置 default，不因普通保存被隐式迁移。

首次成功生成 / 更新 Skeleton 后：

```text
macroBasisFingerprint = currentMacroDependencyFingerprint
macroDirty = false
```

以下变化使 `macroDirty = true`：

```text
总旅行天数 / 日期结构变化
起点或重要交通约束变化
新增 / 删除 / excluded / 恢复 planning_area
新增 / 删除 / excluded / 恢复 core_visit
core_visit preference 变化
detail_interest ↔ core_visit
core_visit parent 变化
core_visit suggestedDuration 显著变化
```

Fingerprint 不包含：

```text
纯显示名称
Resolution 状态
坐标微调
Provider Place ID
普通 detail_interest
AI score
```

推荐包含：

```text
旅行总天数 / 日期
起点
交通偏好
pace
travelers
重要 constraints / themes / preferences
active planning_area identity + preference
active core_visit parent + preference + suggestedDuration + role
```

---

# 10. 旧旅行没有 planningState 的规则

这是兼容边界，必须定死。

如果旧旅行已经存在 Macro Day，但没有 `planningState.macroBasisFingerprint`：

```text
不自动改写
不自动重新规划
不假装 fingerprint current
```

UI Step 3 显示：

```text
需要确认路线和天数
```

用户下一次主动在 Step 3 执行“更新路线和天数”后，才建立新的 fingerprint。

旧数据读取本身继续正常。

---

# 11. Step 2：去哪些地方 / 旅行骨干

Step 2 目标不是“找城市”，而是：

> 找出真正构成这趟旅行宏观结构的地点。

AI 只生成：

```text
planning_area
core_visit
```

禁止生成 `detail_interest`。

用户文案：

```text
停留城市 / 区域
重要游览地
```

说明：

```text
重要游览地 = 会占用较多时间、明显绕行，或需要单独安排半天 / 一天的地方
```

Step 2 是 **Core Visit 结构管理的唯一主步骤**。

这里负责：

```text
新增 / 删除 Core Visit
Core Visit parent
Core Visit role 降级
由 Detail Interest 提升为 Core Visit 的最终确认
```

Step 4 可以发起“设为重要游览地”的意图，但只导航到 Step 2 并打开对应影响确认，不在 Step 4 直接改 role。

---

# 12. destination.generate Mixed Backbone Output

AI 输出允许同一轮同时返回 Planning Area 和 Core Visit。

建议：

```ts
type ParentCandidateRef =
  | { type: "existing"; candidateId: string }
  | { type: "generated"; temporaryCandidateId: string };
```

Candidate Draft：

```ts
{
  temporaryId,
  placeTemporaryId,
  planningRole: "planning_area" | "core_visit",
  planningAreaRef: ParentCandidateRef | null,
  aiReason,
  aiScore,
  suggestedDurationMinutes,
  tags,
  defaultPreference
}
```

`planningAreaRef` 只存在于 AI 输出 / formalization 过程，不进入 canonical。

Canonical 永远只保存正式：

```ts
planningAreaCandidateId: string
```

---

# 13. Destination Formalization 两阶段

Phase A：

```text
正式化 Place
正式化 planning_area Candidate
建立 temporary planning_area candidate ID → canonical Candidate ID 映射
```

Phase B：

```text
正式化 core_visit
将 generated planningAreaRef 转换为 Phase A 的 canonical Candidate ID
```

不能让 canonical parent ID 同时混用 temporary / formal ID。

---

# 14. Duplicate Merge

同一现实 Place 仍只能有一个 Candidate。

```text
existing detail_interest + incoming core_visit
→ 可升级为 core_visit
```

前提：

```text
父 Planning Area 一致
或
原来没有父级
```

```text
existing core_visit + incoming detail_interest
→ 保持 core_visit
```

Parent 不一致不得静默 reparent，必须返回用户冲突确认。

Discovery 永远不覆盖已有用户 preference。

`defaultPreference` 只用于真正新增 Candidate。

普通 AI 推荐默认：

```text
optional
```

只有用户明确表达“想去 / 一定要去”时提升 preference。

---

# 15. destination.add / replace

Step 2 手动 / AI 新增支持：

```text
添加停留城市 / 区域
添加重要游览地
```

新增 planning_area：

```text
kind=city
parent=null
```

新增 core_visit：

```text
kind!=city
必须选择 parent planning_area
```

`destination.replace` 默认保持原 planningRole。

只有用户明确要求改变角色时才可改变。

---

# 16. Step 2 地图

显示：

```text
Planning Area
Core Visit
```

不显示大量 Detail Interest。

Core Visit marker 可与 Planning Area 区分，但不能进入 Macro Route。

地图点击只选中对象，编辑仍回右侧 Step 2。

---

# 17. Step 3：行程骨架 / 安排路线和天数

输入只包括：

```text
TripFacts
Planning Areas
每个 Planning Area 下的 Core Visits
Core preference / suggestedDuration / 精简 reason/tags
当前已有 Skeleton（replan）
```

禁止输入大量普通兴趣点。

AI 只解决：

```text
Stay Block 顺序
每个 Stay Block 的 stayDays
进入该 Stay Block 的语义 transfer mode
Macro Day Anchor 展开所需最小决策
```

Core Visit 只影响容量，不能成为 destination / Anchor。

---

# 18. Stay Block：允许同一 Planning Area 多次出现

这是 review 后新增的 P0 规则。

不能要求“每个 Planning Area 只能出现一次”。

环线旅行必须支持：

```text
Auckland
→ South Island
→ Auckland
```

建议 Skeleton AI 输出概念为：

```ts
type SkeletonStayDraft = {
  planningAreaCandidateId: string;
  stayDays: number;
  transferModeFromPrevious: string | null;
};
```

同一个 `planningAreaCandidateId` 可以在 `stays[]` 中出现多次。

约束改为：

```text
每个 active planning_area 至少被某个 Stay Block 覆盖一次
同一 planning_area 可以出现多个 Stay Block
```

若确实因旅行天数不足无法覆盖全部 active planning_area，AI 不得静默忽略，必须返回 `requires_stage`。

服务端按顺序派生：

```text
planningAreaCandidateId + occurrenceIndex
```

用于 Macro signature / Day ID 复用匹配。

---

# 19. stayDays 与移动日的唯一语义

必须统一采用：

> **转移日计入到达目的地 / 到达 Stay Block。**

例如：

```text
A 2 天
B 3 天
```

展开：

```text
Day 1  A
Day 2  A
Day 3  A → B   // B 第 1 天
Day 4  B
Day 5  B
```

因此：

```text
所有 Stay Block 的 stayDays 总和
= 旅行总天数
```

Interest Discovery 判断容量时必须知道该区域 / Stay Block 是否包含 arrival transfer day。

禁止不同模块各自解释 stayDays。

---

# 20. Step 3 用户可以手工修改什么

Step 3 不只是“看 AI 结果”，右侧必须提供确定性编辑：

```text
调整 Stay Block 顺序
调整 Stay Block stayDays
调整跨区域语义交通方式
```

中间地图 / 时间轴只负责选择和展示，不通过拖拽地图对象直接修改 canonical Skeleton。

手工修改同样必须经过：

```text
impact analysis
→ Day 重映射
→ affectedDayIds
→ 局部 detail needs_review
```

若天数总和不等于旅行总天数，不能保存非法 Skeleton。

---

# 21. Step 3 无法满足条件

如果旅行总天数不足以容纳：

```text
active Planning Areas
+
must_go / 高优先级 Core Visit
```

不得生成明显不可行 Skeleton。

返回：

```text
requires_stage: requirements | destinations
```

并说明：

```text
需要增加旅行天数
或
调整要去的地方 / 重要游览地
```

不要求回 Step 4，因为普通兴趣点尚不应参与 Macro 决策。

---

# 22. Canonical Day 与 Day ID 稳定

不新增重复的 MacroDay 表。

AI 输出最小 Skeleton 决策，服务端确定性展开 canonical Day。

Step 5 继续复用相同 Day ID。

Replan 时 Day ID 复用优先级建议：

```text
1 相同 planningAreaCandidateId + occurrenceIndex + block 内相对日
2 相同 Macro signature / 起终点
3 相同 end Planning Area
4 最后才重新映射
```

只有真正受到 Macro Diff 影响的 Day：

```text
detailStatus = needs_review
```

未受影响 Day 的 Stop、Detail Route、detailStatus 保持原样。

---

# 23. Macro Route

只连接：

```text
Day.startAnchor → Day.endAnchor
```

当两者不同才生成。

Core Visit 不进入 Macro Route。

Provider 才能产生真实 geometry / distance / duration。

Skeleton 保存成功后：

```text
macroBasisFingerprint = current
macroDirty = false
```

---

# 24. Step 4：补充景点

只有 Skeleton Ready 后才能进行 capacity-aware discovery。

首次进入 Step 4：

```text
只展示已有内容
不自动批量生成
```

用户点击 Step 4 唯一生成入口：

```text
[根据当前行程补充兴趣点]
```

才启动 `interest.discover`。

每个 Planning Area / Stay Context 输入必须知道：

```text
Planning Area
当前 stayDays / Stay Blocks
Macro Days
arrival transfer burden
已有 Core Visits
已有 Detail Interests
TripFacts
pace
```

不由代码制造“还剩 372 分钟”之类虚假精度。

AI 自主返回 0–9 个 `detail_interest`，允许 0，不凑数。

---

# 25. Step 4 与 Core Visit 的唯一管理边界

Step 4 必须显示 Core Visit，作为时间容量背景：

```text
蒂阿瑙 · 2 天

重要游览地
★ Milford Sound

普通兴趣点
○ Glowworm Caves
○ Lake Te Anau
```

但 Step 4 **不是 Core Visit 结构管理入口**。

- 点击已有 Core Visit：查看摘要；需要修改则“前往 Step 2 管理”；
- 普通兴趣点想升级为 Core Visit：Step 4 只能发起导航 / Intent，跳到 Step 2 打开角色变更 Impact Card；
- 真正 `planningRole` 修改在 Step 2 确认并执行。

这样避免 Step 2 / Step 4 两套 Core 管理 UI。

---

# 26. Step 4 普通 Candidate 增量规则

新增普通 `optional / want_to_go`：

```text
Skeleton 不变
Detail 不立即失效
只是新增候选
```

新增 / 升级为 `must_go`：

```text
Skeleton 通常不变
对应 Planning Area 可承载 Day → detail needs_review
```

删除未使用普通兴趣点：

```text
不影响现有行程
```

删除已排入 Day 的兴趣点：

```text
只影响实际使用它的 Day
```

普通兴趣点定位变化：

```text
规划不变
只刷新使用该地点的 Detail Route
```

---

# 27. Skeleton Dirty 时 Step 4

仍允许：

```text
浏览
手工新增普通兴趣点
编辑普通兴趣点
定位
修改普通兴趣点 preference
```

禁止：

```text
基于旧 stayDays 的 AI capacity-aware discovery
```

右侧只显示一个主动作：

```text
[前往更新路线和天数]
```

按钮只导航 Step 3，不直接从 Step 4 调用 `itinerary.replan`。

---

# 28. Step 5：每日详细行程

Step 5 才解决：

```text
每天去哪里
几点开始 / 结束
Core Visit 放哪一天
Detail Interest 选哪些
访问顺序
Detail Route
```

输入必须分角色：

```text
coreVisits
detailInterests
```

Core Visit 永远是 Stop，绝不能成为 Macro Anchor。

---

# 29. Core / Detail 排程规则

### core_visit + must_go

已定位：必须排入。

未定位：不得假装成功。

### core_visit + want_to_go

优先安排；若不能安排，进入 `unscheduledCandidates` 并说明原因。

### core_visit + optional

允许不安排；建议保留未采用说明。

### detail_interest + must_go

必须安排。

### detail_interest + want_to_go / optional

根据：

```text
时间
路线
节奏
Core Visit 占用
```

自主选择。

普通未采用兴趣点不要求全部进入 unscheduledCandidates。

---

# 30. 未定位地点

保持：

```text
未定位地点不得成为真实 Stop
```

但：

```text
未定位 Core Visit 仍可参与 Step 3 Macro 时间分配
```

Step 2 / Step 4 就应显示 unresolved 状态，不等 Step 5 才报错。

`must_go core + unresolved` 会阻止 Step 5 生成 / 更新相关 Detail。

修复定位的唯一入口仍在右侧对应地点工作区。

---

# 31. Detailed Planner 固定 Macro Skeleton

Step 5 不得修改：

```text
Planning Area / Stay Block 顺序
stayDays
Day.startAnchor
Day.endAnchor
transfer day 结构
Day identity
```

如果 AI 认为 Skeleton 不合理：

```text
返回需要更新 Step 3
```

不能偷偷调整 Macro。

---

# 32. Detail Update 必须最小化 Diff

这是 review 后新增的 P1 规则。

`itinerary.detail.update` 必须采用 patch-only / affectedDayIds 思路：

```text
只修改真正受新约束影响的 Day
优先保留现有 Stop
优先保留现有顺序
优先保留现有时间
优先保留用户已经确认的手工调整
```

如果当前数据没有可靠字段区分“AI 原始值 / 用户手改值”，本次重构不要为此随意新增复杂迁移字段；安全默认是：

> **把当前已存在并保存的 Detailed Day 当作 sticky baseline，只做满足新约束所需的最小改动。**

若必须大范围改某一天，Proposal / Update Card 必须明确展示差异。

---

# 33. Role-Aware Impact Analyzer

重构：

```ts
analyzeItineraryImpactV3()
```

先计算：

```text
effectivePlanningRole(before)
effectivePlanningRole(after)
```

Planning Area 结构变化：

```text
macroDirty = true
```

纯显示名变化：

```text
不重新规划
```

Resolution / coordinate：

```text
只刷新相关 Route
```

Core Visit 以下变化：

```text
新增
删除
excluded / 恢复
preference 变化
detail ↔ core
parent 改变
suggestedDuration 显著变化
```

→ `macroDirty = true`

同时先只把相关 Planning Area 的 Detail Days 标记 `needs_review`。

---

# 34. Skeleton Replan 后二次 Diff

Core Change 不直接让整趟 Detailed Itinerary 失效。

```text
Core Change
↓
Macro Dirty
↓
Step 3 用户主动 Replan
↓
Compare old/new Stay Blocks + Macro Days
↓
affectedDayIds
↓
只扩展这些 Detail needs_review
```

如果 Replan 后 Macro 完全相同：

```text
macroDirty = false
Skeleton 保持原结构
只更新 Core 所属区域的 Detail
```

---

# 35. “需更新”必须解释原因和影响范围

任何 `macroDirty / needs_review / needs_update` 不得只显示一个状态词。

至少显示：

```text
为什么需要更新
可能 / 已确定影响哪些区域或 Day
哪些内容保持不变
下一步唯一该做什么
```

例如：

```text
Milford Sound 已设为重要游览地。
原来的蒂阿瑙停留天数没有考虑这个全天活动。

需要重新检查：蒂阿瑙及相邻移动日。
其他 18 天保持不变。

[前往更新路线和天数]
```

实际 Replan 完成后必须显示真实 Diff，不再用“可能影响”。

---

# 36. Step 状态

```text
Step 1
有基本 TripFacts → ready

Step 2
至少一个 active planning_area → 可进入 Step 3

Step 3
有 Macro Day
+ macroDirty=false
+ fingerprint current
→ ready

旧 Skeleton 无 fingerprint
→ needs_confirmation / UI 显示“需要确认路线和天数”

Step 4
没有 Ready Skeleton → 禁止 AI discovery
Skeleton Dirty → 只允许人工编辑，不允许 capacity-aware discovery

Step 5
Macro Dirty → 禁止新的 Detailed Generate / Update
```

继续复用：

```ts
Day.detailStatus = "ready" | "needs_review";
```

用户显示：

```text
已完成
需更新
未开始
处理中
需要处理
```

---

# 37. 默认打开步骤

建议：

```ts
if (存在 detailed Day) return "detail";
if (存在 Macro Day) return "interests";
if (存在 backbone Candidate) return "backbone";
return "requirements";
```

不要重新打开 Trip 后自动强制跳到 Skeleton，也不要因进入某一步自动触发生成。

---

# 38. 地图 Selection 与 Primary Management Step

整个 App 维护一个主要 `selection`。

地图、列表、时间轴只更新同一 selection。

管理归属：

```text
planning_area → Step 2
core_visit → Step 2
detail_interest → Step 4
Stay Block / Macro Day → Step 3
Day / Stop → Step 5
```

地图 marker popup 最多提供：

```text
名称
类型
状态
查看详情
```

“查看详情”只让右侧切到对象归属步骤 / 详情，不直接修改。

---

# 39. Stage Context

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

Backbone：

```text
TripFacts
Planning Areas
Core Visits
selection
workflowStep=backbone
```

Skeleton：

```text
TripFacts
Planning Areas
Core Visits
当前 Stay Block / Macro Day 摘要
Macro Update State
Macro Route 摘要
workflowStep=skeleton
```

Interests：

```text
Planning Areas
Stay Blocks / stayDays
Core Visits
Detail Interests
Resolution status
focused area
Skeleton status
```

Detail：

```text
窗口化 Day
相关 Planning Area / Stay Block
Core Visits
must_go Detail Interests
现有 sticky Day baseline
unscheduled 状态
```

继续遵守 64 KB context budget。

---

# 40. Dialogue Action 边界

## backbone

```text
destination.generate
destination.add
destination.remove
destination.replace
destination.edit
destination.preference
Core role / parent 管理
```

## skeleton

```text
itinerary.generate
itinerary.replan
确定性 stay order / stayDays / transferMode 编辑
```

Skeleton Dialogue 不创建新地点；缺地点时引导 Step 2。

## interests

```text
interest.discover
interest.supplement
interest.add
interest.remove
interest.replace
interest.edit
interest.preference
```

不直接修改 planningRole；角色升级意图转 Step 2。

## detail

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

# 41. Prompt：生成旅行骨干

`prompts/actions/destinations/生成目的地建议.md`

目标：

> 研究并生成构成当前旅行宏观结构的 Planning Area 和 Core Visit，而不是普通景点。

强调：

```text
Planning Area = 住宿基地 / 路线城市 / 宏观停留区域
Core Visit = 非城市、高时间影响地点
用户点名 ≠ 自动 Core
知名度 ≠ 自动 Core
普通景点禁止在此阶段生成
```

AI 可联网研究，但不得输出：

```text
可信坐标
Provider Place ID
路线距离 / 时长
URL
来源列表
```

---

# 42. Prompt：生成行程骨架

`prompts/actions/itinerary/生成行程.md`

核心要求：

```text
只负责宏观时间分配
Planning Area 才能形成 Stay Block / Macro destination
Core Visit 只作为时间需求输入
同一 Planning Area 可以多次形成 Stay Block
每个 active Planning Area 至少覆盖一次，除非返回 requires_stage
所有 Stay Block stayDays 总和严格等于旅行总天数
移动日计入到达 Stay Block
不得安排任何具体 Stop
```

---

# 43. Prompt：发现兴趣点

`prompts/actions/interests/发现兴趣点.md`

输入新增：

```text
stayDays / Stay Blocks
Core Visits
已有 Detail Interests
Transfer burden
pace
```

规则：

```text
只能生成 detail_interest
0–9
允许 0
不凑数量
不重复 Core Visit
不产生可信地图事实
```

---

# 44. Prompt：生成 / 更新每日详细行程

`生成每日详细行程.md`：

```text
Macro Skeleton 固定
Core Visit 是高影响 Stop
must_go core 必须安排
want_to_go core 优先安排，失败要解释
普通 Detail Interest 只在剩余容量内选择
不得为了使用更多 Candidate 塞满日程
```

`更新每日详细行程.md`：

```text
只处理 affectedDayIds
当前 Detailed Day 是 sticky baseline
最小化变更
不得改变 Macro Anchor / Day identity
尽量保留现有 Stop / 顺序 / 时间
```

---

# 45. Shared Prompt

`prompts/shared/旅行规划共享规则.md` 必须统一定义：

```text
Place.kind
planningRole
preference
Planning Area
Core Visit
Detail Interest
Stay Block
Macro Route
Detail Route
```

避免各 Prompt 自己发明语义。

---

# 46. Frontend Candidate / Workflow 类型

同步：

```text
apps/web/src/v2-types.ts
apps/web/src/v3-types.ts
```

增加：

```ts
planningRole?: PlanningRole
```

和统一 `effectivePlanningRole(row)`。

`CandidatePanel`：

```ts
view: "backbone" | "interests"
```

Backbone：

```text
planning_area
core_visit
```

Interests：

```text
core_visit（只读容量背景）
detail_interest（主编辑对象）
```

---

# 47. Step 3 UI 核心视图

Step 3 是五步流程最重要的结构确认页。

主视觉必须能让用户一眼看到总天数如何分配，推荐时间轴 / Day Range：

```text
Day 1–2   奥克兰 · 2 天
    ↓ 自驾
Day 3–4   罗托鲁瓦 · 2 天
    ↓
Day 5     陶波 · 1 天
```

如果同一城市重复出现：

```text
Day 1–2   奥克兰 · 2 天
...
Day 19–20 奥克兰 · 2 天
```

必须展示为两个不同 Stay Block，而不是错误合并。

---

# 48. Planning Area 删除保护

删除 Planning Area 继续级联其 Core / Detail Candidate，但不能静默执行。

服务端先计算：

```text
descendant core visits
descendant detail interests
affected Stay Blocks
affected Days
```

右侧 Impact Confirmation 必须展示。

若包含 `must_go core_visit`，使用更明确警告。

自然语言删除也遵守同样确认流程。

---

# 49. Location Resolver

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

Core unresolved：

```text
不阻止 Step 3 Skeleton
阻止其成为 Step 5 真实 Stop
```

定位状态改变不应让 Macro Fingerprint 失效。

---

# 50. Route Provider

AI 不产生可信：

```text
坐标
Provider ID
geometry
Provider 距离
Provider 时长
```

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

两种 Route 互不覆盖。

---

# 51. Interest Discovery 并发与 save-first

继续每个 Planning Area 独立、有界并发。

一个区域失败：

```text
不回滚其他区域
```

继续 save-first：

```text
AI Candidate 先保存
地图定位 best-effort
失败不补位、不整批失败
```

---

# 52. 数据库策略

明确不做：

```text
PRAGMA user_version bump
v3 → v4 migration
旧 loader
双写
private database rewrite
```

继续：

```text
PRAGMA user_version = 3
```

新增字段使用 optional backward-compatible JSON 读取。

禁止因为本次文档设计自动迁移真实私人数据库。

---

# 53. 建议新增 / 修改服务端文件

```text
apps/server/contracts-v2.ts
apps/server/planning-roles-v3.ts              新增
apps/server/planning-context-v3.ts            建议新增
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

角色判断、Context、Fingerprint、Stay Block 展开 / Diff 尽量拆为纯函数模块，不继续扩大 `planner-runtime-v3.ts`。

---

# 54. 建议修改前端文件

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

P0：不要为步骤导航新增与现有产品原则冲突的独立左栏。

---

# 55. Prompt 文件

```text
prompts/shared/旅行规划共享规则.md

prompts/dialogues/旅行需求对话.md
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

---

# 56. 文档同步

本方案确认后，以下文档必须保持一致：

```text
README.md
docs/PRODUCT_PLAN.md
docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md
docs/ITINERARY_MACRO_DETAIL_INCREMENTAL_DESIGN.md
docs/IMPLEMENTATION_STATUS.md
docs/README.md
docs/五步 UI 交互规范.md
```

本次只更新文档，不实施代码。

---

# 57. Phase 1：Role Foundation

完成目标：

```text
PlanningRole Schema
TripCandidate optional planningRole
effectivePlanningRole helper
role invariants
PlanningState / macro fingerprint
legacy missing planningState behavior
planning-areas role-aware
frontend types
```

Targeted Test：

```text
contracts-v2.test.ts
planning-areas-v2.test.ts
planning-roles-v3.test.ts
```

必须覆盖：

```text
旧 Candidate 可读
旧 Skeleton 无 fingerprint 不自动迁移
新角色合法
city/core 非法
orphan core 非法
parent 非 planning_area 非法
```

---

# 58. Phase 2：Backbone Generation

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
Core 管理只归 Step 2
```

测试：

```text
ai-action-contracts-v3.test.ts
candidate-workflow-v2.test.ts
planner-runtime-v3-ai-actions.test.ts
```

---

# 59. Phase 3：Workflow + Skeleton

完成：

```text
WorkflowStepV3
五步顺序
ConversationStage mapping
Step 2 / 3 同属 destinations conversation space
itinerary.generate/replan 只在 Step 3 执行
Stay Block 支持重复 Planning Area
arrival transfer day 统一语义
Step 3 确定性顺序 / 天数 / transport 编辑
Macro Fingerprint / Dirty
Day ID occurrence-aware reuse
```

测试：

```text
ai-stage-contracts-v3.test.ts
stage-context-v3.test.ts
ai-registries-v3.test.ts
itinerary-workflow-v3.test.ts
```

增加环线场景：

```text
Auckland → South Island → Auckland
```

---

# 60. Phase 4：Capacity-Aware Interests

完成：

```text
Skeleton → Interest Context
0–9 detail only
Core duplicate prevention
首次进入不自动 discovery
Core 在 Step 4 只读展示
role upgrade 导航到 Step 2 确认
```

测试：

```text
interest-discovery-v3.test.ts
candidate-discovery-policy-v2.test.ts
planner-runtime-v3-ai-actions.test.ts
workspace-v2.test.ts
```

---

# 61. Phase 5：Detailed Itinerary

完成：

```text
role-aware Detail Input
Core scheduling priority
unresolved must-go readiness
unscheduled Core reasons
local Detail invalidation
patch-only affectedDayIds
sticky existing Detail baseline
minimal diff update
```

测试：

```text
itinerary-workflow-v3.test.ts
itinerary-impact-v3.test.ts
planner-runtime-v3-ai-actions.test.ts
```

---

# 62. Phase 6：UI / Map

完成：

```text
右侧顶部五步导航
不新增左侧步骤栏
Backbone Candidate Panel
Step 3 时间轴 / Stay Block UI
Step 3 手工天数 / 顺序 / transport 编辑
Interest Candidate Panel
Role Badge
Delete Confirmation
Map role filtering
Skeleton / Detail 地图视图
Update Card 原因 / 范围 / 不变部分
每个动作唯一入口
未定位前置提示
```

---

# 63. Phase 7：Docs + Final Verification Preparation

实施完成后才进入：

```text
git diff --check
targeted Vitest
typecheck
全量 Vitest
build
真实 AI smoke
Browser E2E
```

仍遵守项目现有规则：最终完整验收需要用户明确确认后再运行。

**本次文档修改不代表上述 Phase 已实施或验证。**

---

# 64. 新西兰 20 天核心验收

输入：

```text
20 天
新西兰
自驾
```

Step 2 至少应形成：

```text
Te Anau
planning_area

Milford Sound
core_visit
parent = Te Anau
```

Milford 不得生成为 city。

Step 3：

```text
Milford 不进入 Stay Block / Macro Anchor
但影响 Te Anau 时间预算
```

Step 4：

```text
Milford 不再次生成为普通兴趣点
Te Anau 剩余容量有限时允许只返回 0–3 个普通兴趣点
```

Step 5：

```text
Milford 成为 Stop
不是 Anchor
```

---

# 65. 环线验收

输入包含：

```text
Auckland 入境
南北岛旅行
最后 Auckland 离境
```

允许：

```text
Stay Block 1: Auckland
...
Stay Block N: Auckland
```

不得因为 Candidate 相同而把两段错误合并。

`stayDays` 总和仍严格等于总旅行天数。

---

# 66. Incremental 场景 A：Detail → Core

用户在 Step 4 对普通兴趣点提出“设为重要游览地”：

```text
Step 4 不直接修改角色
→ 导航 Step 2
→ 展示 Impact Card
→ 用户确认
→ planningRole = core_visit
→ Step 3 needs_update
→ 当前 parent area Detail Days needs_review
→ 其他地区保持 ready
```

---

# 67. Incremental 场景 B：Replan 结构不变

加入 Core 后 Step 3 重新规划，结果 Macro 完全相同：

```text
Step 3 ready
macroDirty=false
只更新 Core 所属区域 Detail
```

---

# 68. Incremental 场景 C：Macro 天数变化

```text
Te Anau 2 → 3
Queenstown 4 → 3
```

只把真正涉及的 Day 标记 `needs_update`。

UI 明确：

```text
其他未受影响 Day 保持不变
```

---

# 69. Incremental 场景 D：新增普通 optional

```text
新增 detail_interest + optional
```

结果：

```text
Step 3 ready
Step 5 ready
只是出现一个新候选
```

---

# 70. Detail Update 最小变更验收

已有某 Day 用户手工调整过 Stop / 时间。

后来仅新增一个该区域 `must_go detail_interest`。

更新时：

```text
只更新必要 Day
保留可兼容的原 Stop
保留可兼容的顺序 / 时间
不重写其他 Day
```

如果必须大改该 Day，必须展示 Diff。

---

# 71. Delete 场景

删除 Te Anau，其下存在：

```text
Milford Sound
core_visit + must_go
```

必须显示级联影响并明确确认，不能静默删除。

---

# 72. Resolution 场景

```text
Milford
core_visit + must_go
unresolved
```

Step 3：

```text
可以生成 Skeleton
```

Step 2 / 4：

```text
提前显示未定位
```

Step 5：

```text
不得把 Milford 作为真实 Stop 完成排程
```

---

# 73. 旧数据场景

已有 Candidate：

```json
{
  "placeId": "...",
  "preference": "optional"
}
```

没有 `planningRole`：仍正常读取。

已有 Macro Day 但没有 `planningState`：

```text
不自动迁移
Step 3 显示“需要确认路线和天数”
用户主动更新后建立 fingerprint
```

---

# 74. 最终架构原则

内部责任：

```text
TripFacts
回答：我想进行什么旅行？

Planning Area
回答：我在哪里停留和组织路线？

Core Visit
回答：哪些重要活动会改变时间分配？

Stay Block / Skeleton
回答：我按什么顺序停留、每一段分多少天？

Detail Interest
回答：在已确定的时间内还有什么值得去？

Detailed Itinerary
回答：具体哪一天几点去哪里？
```

用户心智：

```text
我要怎么玩
→ 去哪些地方
→ 这些天怎么分
→ 还有什么值得去
→ 每天具体怎么玩
```

系统体验必须始终表现为：

```text
上游决定结构
下游补充细节
局部修改只局部失效
地图 / 时间轴只展示与选择
右侧工作区是唯一主业务入口
生成某一步只在该步骤执行
任何“需更新”都解释原因与影响范围
```

最终产品的核心能力不是一次性生成一篇完整攻略，而是：

> **逐层把旅行规划正确，并在用户修改局部时，只重新计算真正受影响的部分。**
