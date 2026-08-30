# TravelPlanner 文档索引

## 当前有效文档

1. [`PRODUCT_PLAN.md`](./PRODUCT_PLAN.md)  
   产品总体需求依据。功能范围、Candidate-first、地图事实边界和产品安全边界仍以此为准。

2. [`AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`](./AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md)  
   2026-08-30 已确认的 staged AI Dialogue / Action 重构目标。对于 AI 入口、四个 `ConversationStage`、Prompt Registry、Action Registry、阶段 Thread、消息持久化、reasoning/web 策略、Proposal 和数据库 v3 cutover，本文件是当前专项最高优先级依据。

3. [`AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md`](./AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md)  
   兴趣点发现与地图定位专项基线。它继续约束 Candidate-first、AI 主导兴趣点数量、save-first、地图 best-effort 定位等行为；若其中关于旧 00–03 Prompt、旧全局 Planner Runtime 或旧对话入口的描述与 staged AI 目标冲突，以 staged AI 目标为准。

4. [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)  
   当前 staged AI 实施分支的实际完成状态、决策、风险和下一步；跨模型/Thread 交接必须先读本文件。

5. [`IMPROVEMENT_STEPS.md`](./IMPROVEMENT_STEPS.md)  
   此前代码改进与历史后续项。与上述当前专项文档冲突时，不作为 staged AI 架构依据。

6. [`LOCAL_TEST_PROMPT.md`](./LOCAL_TEST_PROMPT.md)  
   历史本地验收提示词；staged v3 完成后的最终验收应结合当前目标文档和 `IMPLEMENTATION_STATUS.md` 更新后再执行。

## 当前 AI 架构基线

```text
右侧工作区唯一 AI 入口
→ requirements / destinations / interests / itinerary
→ Stage Dialogue
→ reply / clarification / web_required / Action
→ Action Registry
→ deterministic executor 或 AI executor
→ save_result 或 Proposal → Apply
```

重要边界：

- `ConversationStage` 不写入 canonical `TravelPlanDocument`；
- canonical `TripStage` 继续保持 `place_selection / itinerary_planning / itinerary_refinement`；
- Macro UI 可表达城市、区域、岛屿或独立停留地，但后台不扩 `PlaceKind`，继续统一 `kind=city`；
- 精确编辑使用 deterministic 代码，不重复调用模型；
- 行程 AI 不能创建 Place/Candidate；需要新地点时返回兴趣点阶段；
- 地图 Provider 继续是坐标、Provider ID、路线 geometry、Provider 距离和时长的事实来源。

## 数据库决策

staged v3 仍使用固定文件路径：

```text
private_data/travel-v2.sqlite3
```

但内部数据库版本为：

```text
PRAGMA user_version = 3
```

明确不实现：

- version 2 → version 3 migration；
- v1/v2 兼容读取；
- 双写；
- 启动时静默 reset、DROP、DELETE、移动、覆盖或重建旧数据库。

因此：如果 `private_data/travel-v2.sqlite3` 仍是旧 version 2，staged v3 Runtime 会 fail closed。真正删除或人工移走旧文件属于最终明确 cutover 操作，不能由普通启动逻辑代替用户执行。

公共地图缓存继续使用：

```text
private_data/public-data-cache.sqlite3
```

## 历史文档

以下文档保留用于理解历史架构或此前实施过程，但不再作为当前 AI 架构需求源：

- `AI-architecture-refactor.md`
- `TRAVEL_WORKBENCH_V3.md`

遇到冲突时，按以下优先级处理：

```text
当前用户明确决定
→ AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md
→ PRODUCT_PLAN.md / AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md（非冲突部分）
→ IMPLEMENTATION_STATUS.md（实施事实）
→ 历史文档
```
