# TravelPlanner 技术文档

> 状态：**当前 main 技术现状**  
> 更新日期：2026-09-05  
> 本文件只描述当前代码实际上如何工作，不描述下一版目标实现。  
> 下一步改造目标见 [`PLAN.md`](./PLAN.md)。

---

# 1. 当前前端入口与五步工作流

当前挂载的主工作台是：

```text
apps/web/src/AppWorkflowV3.tsx
```

工作流定义在：

```text
apps/web/src/workflow-ui-v3.ts
```

当前 `WorkflowStepV3`：

```text
requirements
backbone
skeleton
interests
detail
```

当前 UI 映射：

```text
requirements → Step 1 旅行需求
backbone     → Step 2 想去哪些地方
skeleton     → Step 3 路线和天数
interests    → Step 4 补充景点
 detail      → Step 5 每日行程
```

ConversationStage 仍是四级：

```text
requirements
destinations
interests
itinerary
```

其中 Step 2 / Step 3 共用 destinations stage。

---

# 2. 当前核心文档模型

当前主要数据类型在：

```text
apps/web/src/v2-types.ts
apps/web/src/v3-types.ts
```

`TravelPlanDocument` 当前核心字段：

```text
trip
places[]
candidates[]
days[]
planningState?
warnings[]
```

也就是说当前 canonical 不是单一线性线路，而是至少同时维护：

```text
Place 实体
Candidate 候选
Day 行程
```

并通过附加状态描述规划依赖。

---

# 3. Place / Candidate 模型

当前 `Place` 负责现实地点实体：

```text
id
nameZh / nameLocal / nameEn
kind
city / region / country
approximate
```

`PlaceKind` 当前包括：

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

当前 `TripCandidate` 负责“这个 Place 如何参与规划”：

```text
id
placeId
planningAreaCandidateId
planningRole?
preference
source
aiReason
aiScore
suggestedDurationMinutes
tags
```

`PlanningRole`：

```text
planning_area
core_visit
detail_interest
```

`CandidatePreference`：

```text
must_go
want_to_go
optional
excluded
```

当前代码允许 `planningRole` 缺失，并使用兼容 fallback：

```text
city → planning_area
其他 → detail_interest
```

这是旧数据兼容逻辑之一。

---

# 4. 当前 Step 3 Skeleton 模型

Step 3 不是直接编辑最终 Day Stop，而是编辑独立的 Skeleton Draft。

相关合同：

```text
apps/server/skeleton-contracts-v3.ts
apps/server/skeleton-edit-api-v3.ts
apps/server/itinerary-workflow-v3.ts
```

当前 `SkeletonStayDraft`：

```text
planningAreaCandidateId
stayDays
transferModeFromPrevious
```

完整 Draft：

```text
stays[]
omittedPlanningAreas[]
```

其中：

```text
stayDays >= 1
```

Step 3 保存时：

```text
Skeleton Edit Draft
→ applySkeletonPlanV3
→ 展开 / 更新 canonical days[]
→ writePlan
→ 对跨区域 Day 触发 Macro Route 重算
```

因此当前 `stayDays` 是实际存在的核心宏观规划字段，不是纯 UI 摘要。

---

# 5. 当前 Day / Stop 模型

当前 `Day`：

```text
id
dayNumber
date
title
stayBlockId?
transferMode
detailLevel
detailStatus
startAnchor
stops[]
endAnchor
```

当前 `DayStop`：

```text
id
candidateId?
placeId
activity
period
scheduleText?
startTime / endTime
durationMinutes
transportFromPrevious
verification / cost / notes
```

这意味着当前每天已经天然支持：

```text
起点
→ 多个真实地点 Stop
→ 终点
```

并且每个 Stop 可以记录从前一个节点到这里的交通方式。

这套 Day / Stop 模型是当前 Step 5 的实际详细行程基础。

---

# 6. 当前 Step 2 / Step 4 与 Day 的关系

Step 2 和 Step 4 都主要操作 Candidate。

当前典型关系：

```text
Step 2
Planning Area / Core Visit Candidate

Step 3
根据 Planning Area Candidate 生成 Skeleton / Day Anchor

Step 4
Detail Interest Candidate

Step 5
根据 Candidate 生成 / 更新 Day Stops
```

所以：

> Candidate 被保存 ≠ 已经进入 Day。

尤其 Step 4 新增 `detail_interest` 后，仍需要 Step 5 detailed planner 把它安排成 `DayStop`，才能真正进入当天线路。

---

# 7. 当前路线模型

当前路线至少有两个层次：

```text
Macro Route
Day / Detail Route
```

`WorkspaceV3` 同时包含：

```text
routes
routeStates
macroRouteStates
```

日内真实路线按照：

```text
startAnchor
→ stops[]
→ endAnchor
```

形成 route legs。

Provider 结果通过 `PlaceResolution` 与 Place 分离保存。

`PlaceResolution` 当前包含：

```text
status
method
provider
providerPlaceId
latitude / longitude
address
confidence
errorMessage
```

路线只能基于真实 resolved 坐标和 Provider 返回结果计算；未定位允许继续存在，但不能伪造 geometry、距离和时长。

---

# 8. 当前 WorkspaceV3 状态

`WorkspaceV3` 当前除了 Trip，还聚合：

```text
resolutions
routes
proposals
actions
routeStates
macroRouteStates
itineraryUpdateState
messages
tasks
revisions
coverage
advisories
```

其中 `itineraryUpdateState`：

```text
macro.status = ready | needs_update

detail.status = ready | needs_update
detail.affectedDayIds[]
```

这套机制负责在上游内容变化后，标记宏观路线或局部 Day 是否需要更新。

---

# 9. 当前 AI Action / Proposal 机制

当前 `AiActionType` 分成多类：

```text
requirements.*
destination.*
interest.*
itinerary.*
map.*
```

例如：

```text
destination.generate
interest.discover
itinerary.generate
itinerary.replan
itinerary.detail.generate
itinerary.detail.update
itinerary.stop.*
itinerary.day.optimize
map.disambiguate
```

Action 有：

```text
stage
executor
origin
parameters
targetIds
scope
baseGeneration
status
proposalId
```

高影响 AI 变更通常通过 Proposal / Scope / generation 边界控制。

普通确定性编辑则可以通过 PlanCommand / 专用 API 直接执行。

---

# 10. 当前 PlanCommand 能力

当前通用 PlanCommand 包括：

```text
set_candidate_preference
add_candidate
remove_candidate
update_candidate
update_place
set_day_anchor
add_day_stop
update_day_stop
move_day_stop
remove_day_stop
move_day
update_day
```

说明当前代码已经具备：

```text
Candidate 编辑
Place 编辑
Day Anchor 编辑
Stop 增删改移动
Day 顺序调整
```

但是这些命令仍围绕“Candidate + Day / Stop”双层结构设计。

---

# 11. 当前 Advisory 与用户控制边界

当前代码已经把大量旅行规划问题从硬校验改成 Advisory。

`WorkspaceV3` 暴露：

```text
advisories[]
```

Advisory 主要表达：

```text
日期问题
Day 数量问题
规划角色问题
未定位
excluded / must-go 冲突
时间 / duration / overlap 问题
```

这些通常不直接阻止 canonical 保存。

仍然需要硬保证的主要是：

```text
schema / type
实体引用完整性
稳定 ID 唯一性
Candidate parent 无循环
generation / revision / transaction
Scope 权限
安全和 private_data
Provider 事实边界
```

这部分“用户优先、规划问题提醒化”的原则是当前已经存在的基础能力。

---

# 12. 当前前端主要组件分工

当前主工作台根据 Step 挂载不同面板：

```text
RequirementsPanelV3
CandidateWorkflowPanelV3
MacroItineraryPanelV3
DailyItineraryPanelV3
WorkspaceMapV2
WorkflowAssistantV3
PlanningAdvisoryListV3
```

大致对应：

```text
Step 1 → RequirementsPanelV3
Step 2 → CandidateWorkflowPanelV3(backbone)
Step 3 → MacroItineraryPanelV3
Step 4 → CandidateWorkflowPanelV3(interests)
Step 5 → DailyItineraryPanelV3
```

Step 2 / Step 4 复用 Candidate UI，但使用不同 planningRole 范围。

---

# 13. 当前技术上的核心复杂度

当前架构的主要复杂度来自多层 canonical / derived 状态之间的同步：

```text
Place
↕
Candidate
↕
Skeleton / Stay Block
↕
Day Anchor / Day
↕
Day Stop
↕
Macro Route / Detail Route
```

因此需要额外维护：

```text
planningState
macro fingerprint / needs_update
itineraryUpdateState
affectedDayIds
coverage
resolution state
route state
```

这套结构能够支持当前五步流程和增量更新，但也是下一版“最终线路统一模型”准备重点简化的地方。

具体下一步修改目标只记录在 [`PLAN.md`](./PLAN.md)，本文件不提前把未来设计写成当前事实。
