# 第四/第五步行程拆分与增量更新设计

## 目标

将原来的“第四步行程”拆为：

- 第四步：行程骨架（Macro Itinerary）——目的地顺序、停留天数、每天起终点、跨城语义交通方式。
- 第五步：每日详细行程（Detailed Itinerary）——在第四步固定骨架内安排兴趣点、时间、活动顺序和详细路线。

同时，上游第二步/第三步发生修改时，不允许默认让整个下游重新生成。必须先做影响分析，仅让真正受影响的部分进入 `needs_update`。

## 关键规则

### 停留天数

转移日计入到达目的地。例如 A 2 天、B 3 天：

- Day 1 A
- Day 2 A
- Day 3 A → B（B 第 1 天）
- Day 4 B
- Day 5 B

因此所有目的地 `stayDays` 之和严格等于旅行总天数。

### 单一 Day 事实来源

不新增一套与 canonical `Day` 重复的 Macro Day 数据。

第四步 AI 只返回最小宏观决策，服务端确定性展开为稳定 `Day`：

- `startAnchor` / `endAnchor` 指向目的地；
- 无兴趣点 Stop；
- `detailLevel = planned`；
- 跨目的地日记录语义交通方式。

第五步复用同一批稳定 Day ID，只补充 Stop 和详细时间，不得重写第四步 Anchor。

### 两种 Route

- Macro Route：只连接第四步 Day 的起点目的地和终点目的地；仅在两者不同的时候需要。
- Detail Route：连接第五步真实 Stop 序列。

两种 Route 不能互相覆盖。存储层可使用独立 route key（例如 `macro:<dayId>` 与 `<dayId>`），或等价的显式 route kind。

Provider 路线失败只影响对应路线状态，不回滚 AI 规划。

## 增量影响传播

上游修改 != 下游全部失效。

流程：

`Change Set → Impact Analyzer → affected scope → needs_update → Patch AI / Route refresh`

### 第二步目的地变化

- 新增/删除有效目的地：第四步 `needs_update`；第五步只在第四步 Diff 后更新受影响 Day。
- 目的地纯展示名变化：不重新规划。
- 地图定位/坐标变化：规划可保持，只刷新相关 Route。
- 目的地优先级改变且影响是否纳入旅行：第四步 `needs_update`。

### 第三步兴趣点变化

- 新增普通兴趣点：当前详细行程继续 `ready`，记录为新选项。
- 新增/升级为 `must_go`：对应目的地的可承载 Day `needs_update`。
- 删除/排除一个当前已排兴趣点：实际使用它的 Day `needs_update`。
- 删除未使用兴趣点：不影响现有详细行程。
- 地图定位变化：只刷新使用该地点的详细 Route。

## generation 的职责

`contentGeneration` 继续用于并发控制、旧任务取消、写入 CAS；不得再被解释为“任何 generation 变化都使整个第四/第五步过期”。

是否需更新由依赖和结构 Diff 决定。

## Prompt / Action 边界

第四步：

- `生成行程骨架.md`
- `更新行程骨架.md`

第五步：

- `生成每日详细行程.md`
- `更新每日详细行程.md`

首次详细生成可以一次考虑整趟旅行；增量更新只允许返回 `affectedDayIds`。

## 数据库兼容

当前 v3 SQLite 对 Conversation Stage 使用 CHECK 约束并明确不自动迁移旧数据库。因此此次不增加数据库级第五种 Conversation Stage。

产品 UI 可以展示五步；第四、第五步底层复用 `itinerary` 会话通道，但使用不同 Action / Prompt / Schema。这样不会要求现有 v3 私人数据库重建。

## UI

所有编辑和生成入口继续集中在右侧面板，地图只负责展示。

第四步右侧显示目的地顺序、停留天数、跨城日和 Macro Route 状态。

第五步右侧显示按 Day 的 POI、时间、活动和 Detail Route 状态。

阶段汇总状态只聚合子节点：

- `ready`
- `needs_update`

`needs_update` 不代表整阶段数据不可用；未受影响的 Day 保持原结果。
