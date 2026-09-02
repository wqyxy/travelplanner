# TravelPlanner 文档索引

> 更新日期：2026-09-02

## 当前文档优先级

涉及五步产品流程、规划角色、Macro / Detail 依赖或 UI 入口时，按以下顺序处理：

```text
当前用户明确决定
→ TravelPlanner 五步规划流程重构实施方案.md
→ 五步 UI 交互规范.md
→ PRODUCT_PLAN.md
→ AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md（Dialogue / Action 非冲突部分）
→ AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md（非冲突部分）
→ ITINERARY_MACRO_DETAIL_INCREMENTAL_DESIGN.md
→ IMPLEMENTATION_STATUS.md（只描述实际实施事实）
→ 历史文档
```

注意：

> **2026-09-02 五步设计目前只完成文档确认，没有在本次操作中实施代码。**

实际代码状态必须以 `IMPLEMENTATION_STATUS.md` 为准，不能因为设计文档已更新就宣称功能已经存在。

---

## 当前有效文档

1. [`TravelPlanner 五步规划流程重构实施方案.md`](./TravelPlanner%20五步规划流程重构实施方案.md)  
   当前五步重构正式施工图。定义 PlanningRole、Core Visit、Stay Block、Macro Fingerprint、Step / ConversationStage 映射、Prompt / Action、增量更新、兼容边界与实施 Phase。

2. [`五步 UI 交互规范.md`](./五步%20UI%20交互规范.md)  
   当前五步产品交互规范。P0 规则：地图 / 时间轴只展示和选择；右侧控制台是唯一业务入口；五步导航也位于右侧；同一个业务动作只能有一个归属步骤；跨步骤 CTA 只导航。

3. [`PRODUCT_PLAN.md`](./PRODUCT_PLAN.md)  
   产品总体需求依据。已经同步五步 Workflow、Planning Area / Core Visit / Detail Interest、Stay Block、右侧唯一入口和局部更新原则。

4. [`AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`](./AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md)  
   staged-v3 Dialogue / Action 架构基线。ConversationStage 仍保持四个，但已经明确用户 Workflow 是五步，并通过 `workflowStep` 区分 Step 2 Backbone 与 Step 3 Skeleton。

5. [`ITINERARY_MACRO_DETAIL_INCREMENTAL_DESIGN.md`](./ITINERARY_MACRO_DETAIL_INCREMENTAL_DESIGN.md)  
   五步流程下的 Macro / Detail 依赖传播与局部更新专项设计。

6. [`AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md`](./AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md)  
   Candidate-first、save-first、地图 best-effort 定位专项基线。若旧流程编号、旧 Macro/Micro 表述与五步文档冲突，以五步文档为准。

7. [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)  
   **实际代码实施状态**。任何跨模型 / Thread 交接都必须读取。设计文档描述“应该怎么做”，本文件描述“现在代码实际上做到哪”。

8. [`IMPROVEMENT_STEPS.md`](./IMPROVEMENT_STEPS.md)  
   历史代码改进与后续项。与当前五步设计冲突时不作为需求源。

9. [`LOCAL_TEST_PROMPT.md`](./LOCAL_TEST_PROMPT.md)  
   历史本地验收提示词。五步重构实施后必须结合新施工图重新更新验收步骤，不能直接把旧结果当作五步验收。

---

## 当前五步架构基线

```text
右侧控制台唯一业务入口
→ 1 旅行需求
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
- Planning Area 当前 canonical 规则仍要求 `Place.kind=city`；
- 重要非城市地点使用 `core_visit` 表达，不作为 Macro Anchor；
- 同一 Planning Area 可以形成多个 Stay Block；
- 移动日计入到达 Stay Block；
- Step 3 的 `itinerary.generate / replan` 归 `destinations + skeleton`；
- Step 5 才使用 itinerary ConversationStage 生成 Detailed Itinerary；
- 地图 Provider 继续是可信坐标、Provider ID、路线 geometry、Provider 距离和时长的来源；
- 普通 Detail Interest 变化不能默认使整趟行程失效。

---

## 数据库决策

当前 staged v3 使用：

```text
private_data/travel-v2.sqlite3
PRAGMA user_version = 3
```

五步重构设计不要求增加第五 ConversationStage，因此本专项明确不因为 Workflow 五步而 bump 数据库版本。

继续禁止：

```text
静默迁移私人数据库
双写
启动时自动 DROP / DELETE / 覆盖旧数据
```

`planningRole / planningState` 按五步施工图使用 optional backward-compatible 读取。

---

## 历史文档

以下文档保留用于理解历史架构，但不再作为当前五步产品需求源：

```text
AI-architecture-refactor.md
TRAVEL_WORKBENCH_V3.md
```

如果历史文档仍写：

```text
四个用户可见步骤
Macro 可以直接是任意非城市景区
第四步才是 Macro Skeleton
Step 3 / Step 5 共用 itinerary 对话空间
```

均以当前五步文档为准。
