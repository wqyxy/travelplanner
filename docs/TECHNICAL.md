# TravelPlanner 技术文档

> 状态：**当前 main 技术现状**  
> 更新日期：2026-09-05  
> 本文件只描述当前代码实际上如何工作。

---

# 1. 当前前端入口

当前 Web 挂载入口是：

```text
apps/web/src/main.tsx
→ AppFinalRouteV3.tsx
```

正常产品导航只有两个工作区：

```text
规划 · 旅行需求
行程 · 最终线路
```

旧 `AppWorkflowV3.tsx`、Candidate / Skeleton / Daily Itinerary 等组件仍有部分源码和测试保留，但不再由 `main.tsx` 挂载，也不是正常产品导航入口。

---

# 2. 当前核心数据模型

`TravelPlanDocument` 仍包含：

```text
trip
places[]
candidates[]
finalRoute
days[]
planningState?
warnings[]
```

其中线路的唯一用户维护来源是：

```text
finalRoute.version = 1
finalRoute.nodes[]
```

`days[]` 仍然保存，是因为大量 Route、AI context 和已有接口依赖 Day 结构；但 Day 的线路顺序由 finalRoute 机械派生，不能作为第二份独立线路覆盖 finalRoute。

---

# 3. Place / Candidate / FinalRoute 的职责

## Place

`Place` 是现实地点实体：

```text
id
nameZh / nameLocal / nameEn
kind
city / region / country / countryCode
approximate
```

`Place` 本身不决定住宿、不决定 Day，也不决定 AI 权限。

## Candidate

`TripCandidate` 当前仍保留，主要服务于：

```text
AI 地点研究上下文
planning_area / core_visit / detail_interest 内部分组
AI score / reason / tags
旧 Action contract 兼容
```

Candidate 已经不是用户维护的第二条路线，也没有独立正常页面。

手工从最终线路面板新增地点时，会同步创建一个内部 `planning_area` Candidate，使该用户地点可以继续作为“生成详细地点”的研究锚点；这个内部角色不改变 Place.kind。

## FinalRouteNode

`FinalRouteNode` 表示一个 Place 在线路中的一次出现：

```text
id
placeId
status: normal | tentative | no_go
endsDay
transportFromPrevious
activity / period / schedule...
```

同一个 Place 可以被多个 route node 引用。

---

# 4. finalRoute → Day

主要实现：

```text
apps/server/final-route-v3.ts
```

核心函数：

```text
activeFinalRouteNodesV3
deriveFinalRouteDaysV3
rebuildFinalRouteDaysV3
setFinalRouteNodeStatusV3
setFinalRouteDayBoundaryV3
updateFinalRouteTransportV3
moveFinalRouteNodeV3
removeFinalRouteNodeV3
insertFinalRouteNodeV3
addNightAfterFinalRouteNodeV3
```

派生规则：

```text
trip.originPlaceId
+ status=normal 的 route nodes
+ endsDay=true
→ segments
→ Day 1 / Day 2 / ...
```

`tentative / no_go` 不进入当前 Day，但节点本身、顺序、`endsDay` 和到达交通仍保存在 finalRoute 中。

最后一段即使没有 `endsDay=true` 也会形成最后一个 Day。

---

# 5. 交通数据边界

`transportFromPrevious` 属于“到达当前 route node”。

FinalRoute mutation 会把用户 / AI 输入的交通对象正规化：

```text
只保留 mode

durationMinutes = null
note = null
verification.status = unverified
verification.checkedAt = null
```

`mode=none` 会保存为：

```text
transportFromPrevious = null
```

因此 `set_final_route_transport` 和 `add_final_route_node` 都不能借调用参数写入伪造的 Provider 事实。

真实：

```text
distance
duration
geometry
```

只保存在 Route Provider 结果中。

---

# 6. PlanCommand

现有通用命令仍保留 Candidate / Day 命令，同时已经增加最终线路命令：

```text
add_final_route_node
remove_final_route_node
move_final_route_node
set_final_route_status
set_final_route_boundary
set_final_route_transport
add_final_route_night
```

前端人工规划直接调用 `/api/trips/:id/commands` 执行这些命令。

`applyPlanCommands` 执行 finalRoute mutation 后会重新派生 Day，并返回：

```text
changedDayIds
routeDirtyDayIds
changedPlaceIds
...
```

---

# 7. 当前 Store 策略

数据库仍是 v3 fresh-data 策略。

已经落盘的非空旧格式旅行不会自动迁移成 finalRoute。

如果旧计划带实际内容但缺少当前 finalRoute：

```text
OLD_TEST_PLAN_UNSUPPORTED
```

全新空白计划内部允许短暂出现：

```text
finalRoute.version = 0
```

Store 读取时只对完全空白计划提升为 v1。

## 当前 Day 写入过渡层

`final-route-v3.ts` 中仍保留：

```text
syncFinalRouteForLegacyWriteV3
```

它只用于当前源码中尚未完全删除的旧 Skeleton / Day / Detailed 内部路径：

```text
当前进程新产生的 Day 视图
→ 保存前翻译成 finalRoute
→ 再由 finalRoute 生成 Day
```

它不能迁移已经落盘的旧旅行。

正常新 UI 不依赖这条路径。

---

# 8. 当前前端最终线路组件

主要组件：

```text
AppFinalRouteV3.tsx
FinalRoutePanelV3.tsx
FinalRouteMapV3.tsx
final-route-ui-v3.ts
final-route-map-v3.ts
phase2-final-route.css
```

`FinalRoutePanelV3` 是线路业务的唯一正常入口，负责：

```text
人工新增
移动 / 拖动
状态
住 / 不住 / 多一晚
到达交通
Place 编辑
定位修复
AI 生成主要地点
AI 生成详细地点
AI 优化 Day / segment / trip
优化 Proposal 的采用 / 拒绝 / 撤销
```

---

# 9. 地图数据

地图点：

```text
finalRoute.nodes
+ PlaceResolution
```

因此 normal / tentative / no_go 的真实已定位节点都可以显示。

地图路线：

```text
finalRoute
→ 当前 normal Day
→ DayRoute Provider result
→ map geometry
```

对于 dirty 的旧 Provider route，前端还会按当前 Day 的真实节点拓扑过滤每条 leg。

一条旧 leg 只有同时匹配：

```text
fromNodeId
fromPlaceId
toNodeId
toPlaceId
```

才允许继续作为“待更新参考线”显示。

因此 inactive 节点不会因为旧 geometry 缓存继续出现在当前交通路线中；同一 Place 的多个独立 route node 也不会混淆。

Map Popup 只有展示信息，没有最终线路业务 mutation。

---

# 10. AI Action 基础设施

底层 Action 类型暂时继续使用现有名称：

```text
destination.generate
interest.discover
interest.supplement
itinerary.day.optimize
itinerary.repair
```

但它们在当前产品中的职责已经收敛为：

```text
destination.generate      → 生成主要地点
interest.discover         → 生成详细地点
interest.supplement       → 补充详细地点
itinerary.day.optimize    → 优化这一天
itinerary.repair          → 优化这一段 / 优化全程
```

这保留了已有：

```text
StagedTravelAiV3
Prompt Registry
AiTaskMonitorV3
generation
Proposal
Revision
Provider resolution
WebSocket progress
```

而不再重新创建一套 AI 任务系统。

---

# 11. Phase 3 AI finalRoute cutover

核心文件：

```text
apps/server/final-route-ai-v3.ts
apps/server/final-route-ai-cutover-v3.ts
```

生产入口：

```text
index-cutover-v3.ts
```

会在 `index-v3.ts` 创建 Runtime 之前加载 final-route AI cutover。

## 11.1 纯权限 / 变换层

`final-route-ai-v3.ts` 负责可独立测试的确定性规则：

```text
applyMainRouteGenerationFromOutputV3
insertNewDetailCandidatesFromPlanV3
finalRouteTargetNodeIdsForOptimizationV3
finalRouteMoveCommandsForOrderedSubsetV3
orderedAuthorizedRouteNodeIdsFromDaysV3
```

普通生成的硬保证：

```text
已有 route node 相对顺序不变
已有 node 所有字段不变
只允许增加新 node
```

显式优化的硬保证：

```text
AI 返回 ID 必须恰好等于授权 ID 集合
范围外 node 不生成 move command
inactive node 不属于授权集合
固定节点槽位保持不动
```

## 11.2 Runtime / Store cutover 扩展

`final-route-ai-cutover-v3.ts` 在现有 Runtime / Store 的稳定写入接点上安装最终线路行为：

### 主要地点

原 `destination.generate` 仍负责：

```text
AI 调用
结构校验
Candidate 正式化
定位
Task 状态
```

在写入 Store 之前，cutover 把本轮 AI 输出顺序和 `routeSuggestion` 转成新的 finalRoute nodes。

仅允许最终线路为空时执行。

### 详细地点

原 `interest.discover / supplement` 仍负责：

```text
并行区域研究
0–9 数量规则
去重
Candidate 正式化
Provider 定位
进度
```

每个区域提交 Store 时，cutover 检测本轮真正新增的 detail candidates，只为这些新实体插入 finalRoute node。

已有 route nodes 不允许被修改或重排。

支持 scope request：

```text
final-route-detail-scope:trip
final-route-detail-scope:day:<dayId>
final-route-detail-scope:segment:<fromNodeId>:<toNodeId>
```

### 显式优化

`itinerary.day.optimize`：

```text
只授权目标 Day 当前 stops 对应 route node IDs
```

Day 的结束边界节点不由这个动作移动。

`itinerary.repair` 当前作为内部“segment / trip 优化执行器”：

```text
targetIds=[]                 → 全程
targetIds=[fromNode,toNode]  → 连续线路段
```

AI 输出中的 Day 结构只是现有合同的承载格式；服务器真正读取的只有授权 route-node ID 的相对顺序。

其他 AI 返回字段不会成为最终线路 mutation。

---

# 12. AI Prompt 约束

当前 Prompt 已切换成最终线路语言：

```text
生成主要地点
生成详细地点
补充详细地点
优化这一天
优化这一段或全程
```

主要地点输出的 `BackboneCandidateDraftSchema` 增加可选：

```text
routeSuggestion: {
  endsDay,
  transportMode
}
```

它只能表达本轮新增节点的建议。

没有 `stayDays`，也没有“AI 生成一个地点就默认住 1 晚”的规则。

详细地点 Prompt 明确禁止：

```text
移动已有节点
删除已有节点
修改状态
修改住宿分界
修改已有交通
```

服务端也有对应的确定性检查，因此不是只依赖 Prompt 自觉。

---

# 13. Proposal / generation / Revision

普通生成属于新增内容，可以直接写入当前计划，但仍受 action `baseGeneration` 控制。

显式优化属于已有线路重排，统一生成 Proposal：

```text
AI 计算顺序
→ 服务端检查授权 node ID 集合
→ move_final_route_node commands
→ Proposal pending
→ 用户采用 / 不采用
```

应用 Proposal 时仍使用现有：

```text
generation CAS
scope validation
Revision
superseded conflict handling
undo
```

所以 AI 不会在用户已经修改线路以后静默覆盖新版本。

---

# 14. Provider 事实边界

Place 与 PlaceResolution 分离保存。

真实坐标只来自：

```text
Provider match / choice
Google Maps link
map pick
用户明确坐标
```

Route Provider 负责：

```text
distanceKm
durationMinutes
geometry
```

finalRoute、AI output、PlanCommand 都不能制造这些事实。

未定位 Place 可以继续保留在线路。

---

# 15. 仍保留但已退出正常产品路径的旧结构

当前源码中仍存在一些旧五步时代模块，例如：

```text
AppWorkflowV3
CandidateWorkflowPanelV3
MacroItineraryPanelV3
DailyItineraryPanelV3
Skeleton contracts / edit API
旧 itinerary.generate / detail.generate 等 Action
```

保留原因主要是：

```text
现有内部合同和测试仍复用部分数据结构
阶段性减少一次性大删除风险
旧 Day/Skeleton 写入桥仍需要覆盖内部调用
```

但这些模块不再决定当前用户工作流，也不是最终线路的第二份真实来源。

后续如果删除这些内部兼容代码，应以“不改变 finalRoute 用户语义”为前提进行纯技术清理，而不是重新引入新的产品步骤。
