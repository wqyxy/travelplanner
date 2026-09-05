# TravelPlanner 技术文档

> 状态：**当前 main 技术现状**  
> 更新日期：2026-09-05

---

# 1. 前端入口

当前生产 Web 入口：

```text
apps/web/src/main.tsx
→ AppFinalRouteV3.tsx
```

正常导航只有：

```text
规划 · 旅行需求
行程 · 最终线路
```

旧 `AppWorkflowV3` 和 Candidate / Skeleton / Daily Itinerary 组件仍有部分源码保留，但不再由生产入口挂载。

---

# 2. 核心计划数据

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

唯一用户线路来源是：

```text
finalRoute.version = 1
finalRoute.nodes[]
```

`days[]` 仍持久化，因为 Route、AI context 和部分兼容接口仍依赖 Day 结构；但其线路拓扑由 finalRoute 机械派生，不能反过来成为第二份独立路线。

---

# 3. Place / Candidate / FinalRouteNode

## Place

现实地点实体，只描述名称、类型和行政区等语义信息。

## Candidate

当前主要作为 AI 内部研究结构：

- `planning_area`；
- `core_visit`；
- `detail_interest`；
- AI reason / score / tags；
- 现有 Action contract 兼容。

Candidate 已经没有独立正常用户页面。

手工从最终线路新增 Place 时，会创建隐藏的 `planning_area` Candidate，使该 Place 可以继续作为“生成详细地点”的研究锚点。这个角色不改变 `Place.kind`。

角色推导规则：

```text
显式 planningRole 优先
否则有 planningAreaCandidateId → detail_interest
否则只为旧结构兼容使用 Place.kind fallback
```

因此带父区域的详细地点即使真实 `kind=city`，也不会被误判成新的主要区域。

## FinalRouteNode

表示某个 Place 在线路中的一次出现：

```text
id
placeId
status
endsDay
transportFromPrevious
activity
period
scheduleText
startTime
endTime
durationMinutes
scheduleVerification
costNote
costVerification
notes
```

同一 Place 可以由多个独立 route node 引用。

---

# 4. finalRoute → Day

主要实现：

```text
apps/server/final-route-v3.ts
```

normal 节点 + `endsDay` 机械派生 Day。

`tentative / no_go`：

- 节点本身继续保存；
- 顺序不变；
- `endsDay` 不丢；
- 到达交通不丢；
- 当前 Day / Route 暂时跳过。

最后一段即使无 `endsDay=true` 仍形成最后一天。

---

# 5. PlanCommand 与人工编辑

FinalRoute 命令包括：

```text
add_final_route_node
remove_final_route_node
move_final_route_node
set_final_route_status
set_final_route_boundary
set_final_route_transport
add_final_route_night
```

人工地点 / 顺序 / 状态 / 住宿 / 交通从右侧通过 `/commands` 写入。

详细安排当前复用已经验证过的确定性 `itinerary.edit` Day-stop 写入：

```text
FinalRoutePanelV3
→ itinerary.edit
→ update_day_stop
→ Store 当前写入桥
→ route node detail fields
→ finalRoute 再派生 Day
```

这是内部兼容实现；用户看不到 DayStop / Step 5。

当前右侧手工编辑字段：

```text
activity
period
startTime
endTime
durationMinutes
notes
```

`FinalRouteNode.scheduleText` 如果存在会直接展示；AI refine 可以补充。

---

# 6. 当前 Day 写入桥

`final-route-v3.ts` 仍保留：

```text
syncFinalRouteForLegacyWriteV3
```

它只用于当前进程里仍复用 Day contracts 的内部路径，包括详细安排编辑 / refine。

已经落盘的旧非空旅行仍然不会迁移：

```text
OLD_TEST_PLAN_UNSUPPORTED
```

因此这不是旧数据迁移或双线路模型。

---

# 7. 交通与 Provider 事实边界

FinalRoute transport mutation 只保留：

```text
mode
```

并正规化为：

```text
durationMinutes = null
note = null
verification.status = unverified
verification.checkedAt = null
```

`mode=none` → `transportFromPrevious=null`。

真实：

```text
distance
duration
geometry
```

只来自 Route Provider。

Place 坐标只来自 Place Resolution / Google Maps link / map pick / 用户明确坐标。

---

# 8. 前端最终线路

主要文件：

```text
AppFinalRouteV3.tsx
FinalRoutePanelV3.tsx
FinalRouteMapV3.tsx
final-route-ui-v3.ts
final-route-map-v3.ts
phase2-final-route.css
```

`FinalRoutePanelV3` 是正常产品里的唯一线路业务入口。

当前包含：

- 人工新增 / 删除 / 排序；
- status；
- 住 / 不住 / 多一晚；
- 到达交通；
- 详细安排；
- Place 编辑与定位修复；
- AI 主要地点；
- AI 详细地点；
- AI 完善这一天；
- AI Day / segment / trip 优化；
- AI Proposal apply / reject / undo。

---

# 9. 地图

地图点来自：

```text
finalRoute.nodes + PlaceResolution
```

所以三个状态的已定位节点都能显示。

地图路线来自：

```text
finalRoute
→ normal 派生 Day
→ DayRoute Provider
→ geometry
```

对于 dirty 旧 route，每条 leg 必须同时匹配当前 Day：

```text
fromNodeId
fromPlaceId
toNodeId
toPlaceId
```

才允许显示为待更新参考线。

Map Popup 不包含线路业务 mutation。

---

# 10. AI Action 复用

底层 Action ID 暂时继续使用已有名称：

```text
destination.generate
interest.discover
interest.supplement
itinerary.refine
itinerary.day.optimize
itinerary.repair
```

当前用户语义：

```text
destination.generate    → 生成主要地点
interest.discover       → 生成详细地点
interest.supplement     → 补充详细地点
itinerary.refine        → 完善这一天
itinerary.day.optimize  → 优化这一天
itinerary.repair        → 优化这一段 / 全程
```

这样继续复用：

- StagedTravelAiV3；
- Prompt Registry；
- AiTaskMonitorV3；
- generation / CAS；
- Proposal；
- Revision / Undo；
- Provider resolution；
- WebSocket progress。

---

# 11. Phase 3 AI cutover

核心：

```text
apps/server/final-route-ai-v3.ts
apps/server/final-route-ai-cutover-v3.ts
```

生产入口 `index-cutover-v3.ts` 会在创建 Runtime 前加载 cutover。

## 11.1 主要地点

原 `destination.generate` 继续负责：

```text
AI 调用
输出 Schema
Candidate 正式化 / 去重
Provider 定位
Task / generation
```

Store 写入前，cutover 使用本轮原始 AI output 的 candidate 顺序创建 finalRoute nodes。

`BackboneCandidateDraftSchema` 新增可选：

```text
routeSuggestion: {
  endsDay,
  transportMode
}
```

它只影响本轮新 route node。

仅允许 finalRoute 为空时执行主地点第一次生成。

相同语义 Place 即使在 Candidate 层复用为同一个实体，AI output 中每一次线路出现仍创建独立 route node，因此 `A → B → A` 可表达。

## 11.2 详细地点

原 interest 并行研究管线继续负责 0–9 数量、去重、正式化、定位和任务进度。

每个区域写 Store 前：

```text
检测本轮新增 detail candidates
→ 只创建新的 route nodes
→ 插入指定 route scope
→ 检查所有旧 node 相对顺序和字段完全不变
```

Scope request：

```text
final-route-detail-scope:trip
final-route-detail-scope:day:<dayId>
final-route-detail-scope:segment:<fromNodeId>:<toNodeId>
```

Day / segment scope 没有合法锚点时 fail closed，不回退到范围外节点。

## 11.3 完善这一天

`itinerary.refine` 继续使用现有输出合同，但 cutover 在持久化前做额外权限收紧：

- 必须只返回请求 Day；
- Stop 必须是当前授权 Day 的既有 Stop；
- 可以更新 activity / period / scheduleText / time / duration / notes；
- `transportFromPrevious` 强制恢复当前值；
- `scheduleVerification` 强制恢复当前值；
- `costVerification` 强制恢复当前值。

因此 refine 不能借详细安排修改路线交通或制造 verified 事实。

结果仍走 Proposal，由用户决定是否采用。

## 11.4 显式优化

纯权限函数：

```text
finalRouteTargetNodeIdsForOptimizationV3
finalRouteMoveCommandsForOrderedSubsetV3
orderedAuthorizedRouteNodeIdsFromDaysV3
```

硬规则：

- AI 返回 ID 集合必须恰好等于授权集合；
- 不允许新增 / 删除 / 重复 / unknown ID；
- inactive 节点不进入授权集合；
- 范围外节点不生成 move command；
- 范围外 / inactive 节点保持原槽位。

单日优化只授权当前 Day 的 stops，Day end boundary 固定。

`itinerary.repair` 目前作为 segment / trip 的内部 AI 执行器；其 Day output 只是旧合同承载格式，服务器最终只读取授权 route-node ID 的相对顺序。

优化只生成 `move_final_route_node` Proposal。

---

# 12. Proposal / generation / Revision

普通地点生成属于新增内容，仍受 action `baseGeneration` 控制。

优化 / refine 属于已有内容修改：

```text
AI output
→ server scope validation
→ Proposal pending
→ 用户 apply / reject
```

apply 仍走现有 generation CAS、Revision、supersede / undo。

优化 apply / undo 后，Phase 3 cutover 会自动启动新的 Route batch，避免地图长期停留在 dirty 路线。

---

# 13. Prompt 现状

已改成最终线路语义的主要 Prompt：

```text
生成主要地点
生成详细地点
补充详细地点
完善这一天
优化这一天
优化这一段或全程
```

普通生成 Prompt 明确禁止修改已有节点；服务器也有对应确定性权限检查，不依赖 Prompt 自觉。

---

# 14. Fresh-data 策略

数据库 Schema 本轮没有新增迁移。

施工前测试数据不兼容：

- 不迁移旧旅行 JSON；
- 不从旧 Candidate / Day 猜 finalRoute；
- 不恢复施工前旧 Revision。

完全空白 v0 bootstrap 可以在读取时提升到 finalRoute v1；非空旧格式直接拒绝。

---

# 15. 仍保留的内部旧模块

源码中仍存在部分旧五步时代模块 / Action，例如：

```text
AppWorkflowV3
CandidateWorkflowPanelV3
MacroItineraryPanelV3
DailyItineraryPanelV3
itinerary.generate
itinerary.detail.generate
旧 Skeleton contracts
```

它们当前不是生产用户入口，也不能成为 finalRoute 之外的第二份线路来源。

保留原因是部分内部合同 / 测试 / 写入桥仍被当前稳定能力复用。后续若做纯技术删除，应保持当前 finalRoute 产品语义不变。
