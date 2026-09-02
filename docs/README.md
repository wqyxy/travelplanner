# TravelPlanner 文档索引

> 更新日期：2026-09-02

`docs/` 只保留仍然会指导当前产品、当前代码或下一轮实施的文档。

已完成且已被新设计取代的实施计划、历史架构稿、旧验收提示词不继续留在 `docs/`，避免 Agent 同时读取新旧规则。

---

## 当前文档优先级

涉及五步产品流程、规划角色、Macro / Detail 依赖或 UI 入口时，按以下顺序处理：

```text
当前用户明确决定
→ TravelPlanner 五步规划流程重构实施方案.md
→ 五步 UI 交互规范.md
→ PRODUCT_PLAN.md
→ AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md（Dialogue / Action 非冲突部分）
→ AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md（地点发现 / 定位非冲突部分）
→ ITINERARY_MACRO_DETAIL_INCREMENTAL_DESIGN.md（增量更新专项）
→ IMPLEMENTATION_STATUS.md（只描述实际实施事实）
```

注意：

> **2026-09-02 五步设计目前只完成文档确认，对应五步代码尚未实施。**

设计文档描述“应该怎么做”；`IMPLEMENTATION_STATUS.md` 描述“现在代码实际上做到哪”。不能因为设计文档已经更新就宣称功能已经存在。

---

# 当前有效文档

## 1. `TravelPlanner 五步规划流程重构实施方案.md`

当前五步重构正式施工图。

主要负责：

```text
PlanningRole
Planning Area / Core Visit / Detail Interest
Stay Block
Macro Dependency Fingerprint
WorkflowStep / ConversationStage 映射
Prompt / Action / Context
增量影响传播
旧数据兼容边界
实施 Phase 与验收场景
```

---

## 2. `五步 UI 交互规范.md`

当前五步产品交互规范。

P0 原则：

```text
地图 / 时间轴只展示和选择
右侧控制台是唯一业务入口
五步导航位于右侧控制台
同一个业务动作只有一个归属步骤
跨步骤 CTA 只导航，不越级执行生成 / 更新
```

---

## 3. `PRODUCT_PLAN.md`

当前产品总体需求依据。

已经统一为：

```text
1 旅行需求
2 去哪些地方
3 安排路线和天数
4 补充景点
5 每日行程
```

负责产品定位、总体边界、右侧唯一控制台、AI 与地图 Provider 的职责划分等长期规则。

---

## 4. `AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

当前 Dialogue / Action 架构基线。

虽然数据库 `ConversationStage` 仍然只有：

```text
requirements
destinations
interests
itinerary
```

但用户 Workflow 已经是五步，并通过 `workflowStep` 区分：

```text
backbone
skeleton
```

本文件只负责 Dialogue、Action Registry、确认、Proposal、线程与 Stage Context 等架构；五步产品语义以五步施工图为准。

---

## 5. `AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md`

当前地点发现与地图定位专项基线。

负责：

```text
Candidate-first
save-first
AI 自主决定兴趣点数量
地图 best-effort resolve
resolved / resolving / unresolved 边界
地图 Provider 事实来源
定位失败不回滚 Candidate
```

其中旧 Macro / Micro 用词若与五步 PlanningRole 冲突，以五步施工图为准。

---

## 6. `ITINERARY_MACRO_DETAIL_INCREMENTAL_DESIGN.md`

当前 Macro / Detail 增量更新专项设计。

负责：

```text
Stay Block
移动日归属
Day ID 稳定
Macro Route / Detail Route
affectedDayIds
最小 Detail Patch
用户手工修改保护
局部 needs_update
```

---

## 7. `IMPLEMENTATION_STATUS.md`

当前代码实施事实与交接状态。

跨模型 / Thread 继续开发前必须先读。

如果它与目标设计不一致：

```text
设计文档 = 目标
IMPLEMENTATION_STATUS = 当前现实
```

下一轮实施应从两者差异开始，而不是把当前代码状态误认为最终需求。

---

# 当前五步架构基线

```text
右侧控制台唯一业务入口

1 旅行需求
→ 2 去哪些地方
→ 3 安排路线和天数
→ 4 补充景点
→ 5 每日行程
```

内部：

```text
WorkflowStep:
requirements / backbone / skeleton / interests / detail

ConversationStage:
requirements / destinations / interests / itinerary
```

映射：

```text
requirements → requirements
backbone     → destinations
skeleton     → destinations
interests    → interests
detail       → itinerary
```

重要边界：

- `ConversationStage` 不写入 canonical `TravelPlanDocument`；
- canonical `TripStage` 继续保持现有模型；
- `PlanningRole` 与 `Place.kind`、`preference` 独立；
- Planning Area canonical 仍使用 `Place.kind=city`；
- 重要非城市地点使用 `core_visit`，不能成为 Macro Anchor；
- 同一 Planning Area 可以形成多个 Stay Block，支持环线再次停留；
- 移动日计入到达 Stay Block；
- Step 3 的 `itinerary.generate / replan` 属于 `destinations + skeleton`；
- Step 5 才在 itinerary ConversationStage 生成 Detailed Itinerary；
- 地图 Provider 是可信坐标、Provider ID、路线 geometry、Provider 距离和时长的来源；
- 普通 Detail Interest 的变化不能默认使整趟行程失效；
- Detail 更新优先做最小 patch，并保护用户已手工调整内容。

---

# 数据库决策

当前 staged v3 使用：

```text
private_data/travel-v2.sqlite3
PRAGMA user_version = 3
```

五步 Workflow 不新增第五个数据库 ConversationStage，因此不因为本次五步设计单独提升数据库版本。

`planningRole / planningState` 按五步施工图采用 optional backward-compatible 读取。

---

# 文档维护规则

以后 `docs/` 遵守以下规则：

1. **完成且被当前文档完全取代的实施计划直接删除，不建立长期历史文档堆。**
2. 当前仍约束运行时行为的专项基线可以保留，即使相关代码已经实现。
3. 新方案取代旧方案时，先把仍有效的长期规则迁入当前文档，再删除旧文档。
4. 临时测试 Prompt、一次性改进清单、旧架构草稿不作为长期 `docs/` 文档。
5. Git 历史本身承担历史追溯职责，不需要为了“以后可能看看”在 `docs/` 中保留过时副本。
