# AI 旅行计划网页版产品方案

> 状态：当前产品与代码实现的唯一需求依据  
> 更新日期：2026-08-27  
> 数据策略：V3 直接使用独立新数据库 `private_data/travel-v2.sqlite3`，不迁移、不兼容读取、不双写旧数据库。

## 1. 产品定位

打造一个以 **“地点发现 → preference 标注 → 一键生成行程与路线 → 局部调整”** 为核心流程的 AI 旅行规划网页版。

产品不是“生成旅行攻略的聊天机器人”，而是：

> **AI 驱动的可视化旅行规划工作台。**

用户真正操作的是结构化旅行计划；AI 负责理解需求、推荐地点、根据优先级和整体路线自动取舍并排程；地图服务负责地点解析、坐标、真实路线和交通时间。

城市与具体景点采用两层规划：

- **Macro**：城市 / 区域负责决定跨城顺序、是否进入该城市以及大致停留天数；
- **Micro**：具体景点、住宿和交通点负责每天实际访问与真实路线。

## 2. 核心产品原则

### 2.1 preference 是规划约束，不是生成门槛

用户不需要先把所有地点人工筛选、全部定位完成后才能生成。

```text
旅行需求
  ↓
AI 推荐城市 + 城市内具体地点
  ↓
用户可选调整 preference
★ 必去 / ✓ 想去 / ○ 可选 / × 不去
  ↓
[✨ 生成行程与路线]
  ↓
系统自动解析仍未定位的参与规划地点
  ↓
Macro：规划城市顺序和城市停留
  ↓
Micro：选择 / 分组城市内具体景点
  ↓
系统优化同区域景点初始顺序
  ↓
地图服务自动生成真实路线
  ↓
用户拖拽 / 添加 / 删除 / AI 调整
```

地点列表是一个可编辑的候选池，而不是必须完成的向导步骤。

### 2.2 AI 不直接负责坐标和路线

AI 可以生成地点名称、描述、推荐理由、推荐等级、建议游玩时间、搜索关键词、行程安排和调整建议。

AI **不直接生成可信坐标、路线距离或交通时间**。

```text
AI Candidate
   ↓
Place Resolver
   ↓
地图服务搜索
   ↓
Place ID / 坐标 / 地址
   ↓
确定性地理排序 / Routing Service
   ↓
真实路线 / 距离 / 交通时间
```

### 2.3 AI 负责语义规划，系统负责确定性执行

| 操作 | 实现方式 |
|---|---|
| 推荐城市和景点 | AI |
| 决定城市是否进入行程 | AI + preference + 服务端硬规则 |
| 决定城市顺序 / 停留天数 | AI + 城市地理信息 |
| 判断景点适合哪一天 | AI + 城市内地理分组 |
| 根据 preference 取舍地点 | AI，受服务端硬规则约束 |
| 景点坐标 | 地图服务 |
| 同区域景点初始顺序 | 服务端确定性地理算法 |
| 两点真实交通时间 / geometry | Routing API |
| 拖拽排序 | 前端程序逻辑 |
| 跨天移动地点 | 前端程序逻辑 |
| 路线重新计算 | Routing API |
| 判断一天太赶 | 规则 + AI |
| 修改某一天 | AI Proposal / PlanCommand |
| 撤销修改 | 系统 Revision |

核心边界：

```text
AI
↓
受限结构化输出
↓
服务端业务校验 / 地理排序
↓
Structured Plan
↓
Map / Route / UI
```

## 3. 创建旅行

首页只要求最低限度信息。用户可以直接输入：

> 国庆从上海去日本关西 7 天，夫妻带一个 3 岁孩子，不想太累，东京已经去过了，想玩大阪、京都和奈良。

可以附加：

- 日期；
- 出发地；
- 旅行天数；
- 成人 / 儿童人数。

第一步不要求填写大量偏好问卷。

## 4. AI 生成地点池

AI 根据旅行需求生成 Candidate Places，而不是立即生成日程。

地点池同时包含两类对象：

```text
京都                         ← kind=city，Macro 城市节点
├─ 清水寺                    ← attraction，真实路线节点
├─ 伏见稻荷大社              ← attraction，真实路线节点
├─ 岚山                       ← attraction / waypoint
└─ 京都站                     ← station

大阪                         ← Macro 城市节点
├─ 大阪城
├─ 海游馆
└─ 道顿堀
```

城市 Place 代表“这趟旅行是否进入并停留该城市”，**不是默认去城市中心打卡**。

地点卡片至少展示：

- 名称和城市 / 区域；
- AI 推荐理由；
- 0–100 AI 推荐度；
- 建议游玩时长；
- 标签；
- 定位状态；
- 用户 preference。

AI 推荐度不能伪装为地图平台用户评分。

### 4.1 地点推荐等级

```text
★ 必去   must_go
✓ 想去   want_to_go
○ 可选   optional
× 不去   excluded
```

排程语义：

1. `must_go`：硬约束，必须满足；不能被 AI 舍弃；
2. `want_to_go`：高优先级软约束，应尽量满足；如果加入会造成明显折返、严重超时、节奏冲突或明显降低整体路线质量，可以不采用，但必须明确说明原因；
3. `optional`：AI 根据地理位置、推荐度、时长、节奏和路线效率自动取舍；
4. `excluded`：不得进入行程，也不需要参与自动定位和排程。

**`want_to_go` 不等于 `must_go`。** “不能静默省略”表示必须解释，而不是禁止 AI 做合理取舍。

### 4.2 城市 preference 与具体地点 preference

城市 Candidate 是 Macro 约束：

- `★ 京都`：行程必须进入京都并安排京都内具体地点；不要求生成“京都市中心” Stop；
- `✓ 京都`：优先进入京都，但整体跨城路线明显不合理时可以整座城市舍弃并解释；
- `○ 京都`：AI 可以根据全程效率决定是否进入；
- `× 京都`：京都及其普通子地点不参与规划。

具体地点 Candidate 是 Micro 约束：

- `★ 清水寺`：清水寺必须成为实际 Day Stop；
- `✓ 清水寺`：强优先，但可以有明确原因地舍弃；
- `○ 清水寺`：AI 自动取舍；
- `× 清水寺`：不得进入 Day。

冲突规则：如果城市已经标记 `× 不去`，但城市内仍有 `★ 必去` 或 `✓ 想去` 的具体地点，生成前必须明确报 preference 冲突，而不是静默覆盖其中一方。

## 5. 地点定位与异常处理

### 5.1 自动解析

地点推荐后系统可以后台自动解析；用户点击“生成行程与路线”时，服务端还会对所有实际参与规划且尚未可靠定位的地点再自动尝试解析。

```text
Candidate
    ↓
标准名称 / 本地名 / 英文名 / 城市 / 地址线索
    ↓
地图服务搜索
    ↓
Provider Candidate
    ↓
自动匹配或 unresolved
```

状态：

```text
resolving
resolved
unresolved
```

城市也可以有 Resolution，但城市坐标只用于 Macro 地理位置、地图 viewport 和辅助跨城判断，**不会因为城市被采用就自动把城市中心放进真实路线**。

### 5.2 未定位地点

未定位不再统一阻塞生成：

- 具体 `must_go` 未定位：自动重试后仍失败则阻塞生成，因为无法保证硬约束地点进入真实线路；
- 城市级 `must_go`：城市自身坐标不是路线硬条件，但该城市至少需要一个参与规划且已定位的具体地点，否则无法形成真实城市内线路；
- `want_to_go` 未定位：不阻塞整趟行程，可以继续规划；AI 必须看到该 Candidate，不得静默消失；
- `optional` 未定位：不阻塞整趟行程，由 AI 自动取舍；
- `excluded` 或因城市 `excluded` 被抑制的子地点：不参与生成前定位。

如果未定位的软约束具体地点仍被排入 Day，路线服务必须明确显示 `attention` / “路线端点尚未正确定位”，不得伪造路线。

用户仍可手动修复：

- 重新识别；
- AI 补充搜索提示后重新匹配；
- 选择地图 Provider 候选；
- 从地图点选；
- 手动输入坐标。

P1：粘贴 Google Maps 链接解析。

AI 重试只能补充名称、城市、区域或搜索关键词，不能“重新生成一个坐标”。

## 6. 地点偏好调整

支持：

- 按城市 / 区域折叠展示具体地点；
- 城市级 Macro preference；
- 具体地点 Micro preference；
- 单选；
- 多选；
- 全选当前筛选结果；
- 批量标记必去 / 想去 / 可选 / 不去；
- 批量重新定位；
- 用户手动新增地点。

这一步是**可选的偏好调整**，不是必须完成的确认关卡。

底部直接提供：

```text
[✨ 生成行程与路线]
```

按钮不因为普通 `want_to_go` / `optional` 未定位而禁用。

“参与规划”数量按**有效规划约束**统计：城市为 `excluded` 时，其普通子地点即使自身仍显示 `optional`，也不计入参与规划。

## 7. 一键生成行程与路线

一次点击的服务端流程：

```text
从 Place.city / region + kind=city 派生 PlanningArea
↓
检查城市 / 子地点 preference 冲突
↓
读取所有有效参与规划 Candidate
↓
自动解析尚未可靠定位的地点
↓
检查具体 must_go 和必去城市的真实路线可用性
↓
构造 PlanningAreas + Candidate + Resolution + Micro GeoClusters
↓
Macro：AI 决定城市顺序和大致停留天数
↓
Micro：AI 决定每一天采用哪些具体地点
↓
服务端对同一天同区域的连续景点块做地理顺序优化
↓
保存完整合法 Day
↓
Routing Service 自动计算每天真实路线
↓
返回最终行程
```

AI 输入至少包括：

```text
Trip Constraints
+
Planning Areas
+
All Effectively Participating Candidates
+
City / Place Preference
+
Current Place Resolutions（允许部分为 null）
+
Micro Geo Clusters
+
Suggested Duration
+
User Preferences
+
Travel Days
```

硬规则：

- Day 数量必须与完整日期范围或 `requestedDurationDays` 一致；
- 具体 `must_go` 全部成为 Day Stop；
- 城市级 `must_go` 必须由该城市内具体 Stop 满足，城市中心本身不得作为替代 Stop；
- `want_to_go` 尽量满足，未满足必须给出具体原因；
- `optional` 可自动取舍，未排入必须给出原因；
- `excluded` 及其被抑制子地点不得进入 Day；
- 每个有效参与规划的具体 Candidate 必须“已排程”或“明确未排程并说明原因”，不得静默消失；
- 城市级 Candidate 已由该城市具体 Stop 满足后，不需要再单独加入未排程说明；
- Anchor 未知时允许为空，不伪造酒店；
- AI 不输出坐标、路线 geometry、Provider 距离或时间；
- 保存完整合法计划后才切换到 `itinerary_planning`；
- 首次 Plan 保存成功后自动计算每天路线。

## 8. Macro / Micro 地理算法辅助排程

排程不完全依赖 LLM。

### 8.1 PlanningArea：派生城市层，不新增持久化业务实体

当前 P0 **不在 `Place` 上新增 `areaPlaceId`**，也不增加数据库迁移。

服务端根据已有数据派生 PlanningArea：

```text
kind=city 的 Place 名称 / 本地名 / 英文名
+
具体 Place.city / region / country
↓
Derived PlanningArea
```

PlanningArea 是运行时规划视图，不是新的 canonical 业务实体。这样保留现有：

```text
Place → TripCandidate → DayStop
```

同时获得城市 → 景点的层级规划能力。

### 8.2 Macro 城市层

PlanningArea 提供：

- 城市级 Candidate；
- 该城市的具体 Candidate；
- 有效 preference；
- 是否因城市 `excluded` 而整体抑制；
- 城市级硬约束是否已由具体地点满足。

AI 根据这些数据决定：

```text
奥克兰
↓
罗托鲁瓦
↓
惠灵顿
↓
基督城
↓
蒂卡波
↓
皇后镇
↓
但尼丁？
```

### 8.3 Micro 城市内地理分组

服务端对已定位的**具体地点**按 PlanningArea + 更细地理网格形成 Micro GeoCluster：

```text
京都
├─ 东山附近
│  ├─ 清水寺
│  ├─ 八坂神社
│  └─ 祇园
├─ 伏见附近
│  └─ 伏见稻荷
└─ 岚山附近
   ├─ 竹林
   └─ 天龙寺
```

AI 负责判断“哪些地点应该同一天”；不让 LLM 猜真实路线距离。

### 8.4 初始景点顺序优化

AI 返回 Day 后、正式保存前，服务端只对**同一天、同 PlanningArea、连续且已定位的 attraction / waypoint 块**做确定性地理顺序优化：

- P0 使用坐标近邻顺序，减少明显折返；
- 不跨越餐饮、住宿、机场、车站等语义节点；
- 不跨城市重排；
- 路线 Provider 时间由后续真实 Route API 重新计算，不采用 AI 交通时长。

这一步不是完整 VRP，也不冒充 Route Matrix。

P1 可以在 Provider 支持时升级为真实 Route Matrix / TSP heuristic。

## 9. Day Anchor

每天独立拥有：

```text
startAnchor
endAnchor
```

普通城市旅行不强制：

```text
Day N endAnchor = Day N+1 startAnchor
```

酒店未知时 Anchor 可以为空或只保存用户自定义标签。Road Trip 等场景才按实际需要衔接。

城市 Place 原则上不作为 Day Anchor 的真实路线端点；能使用实际住宿、机场、车站、港口或明确 waypoint 时优先使用具体 Place。

## 10. 主工作区 UI

桌面版使用左侧常驻地图、右侧工作区：

```text
┌─────────────────────────────┬───────────────────────────────┐
│                             │ [地点] [行程]                 │
│            地图             │ 右侧结构化内容                │
│                             │                               │
├─────────────────────────────┴───────────────────────────────┤
│ 当前 Scope · 告诉 AI 你想怎么调整                          │
└─────────────────────────────────────────────────────────────┘
```

地图始终存在。右侧有 `[地点] [行程]` 两个主 Tab。

## 11. 地点模式

地点列表按 PlanningArea 分组，而不是把城市和几十个景点平铺在同一级：

```text
▼ 皇后镇                         ✓ 想去
   城市级规划 · 6 个具体地点

   ✓ 皇后镇                     [宏观规划]
   ★ Skyline Queenstown
   ○ Queenstown Gardens
   ○ Arrowtown
   ○ Onsen Hot Pools

▶ 基督城                         ○ 可选
   城市级规划 · 5 个具体地点
```

必须支持：

- 全部 / 必去 / 想去 / 可选 / 不去 / 未定位；
- 城市 / 区域折叠；
- 城市级 Macro 标识；
- 搜索；
- 单选、多选、全选当前筛选；
- 批量 preference；
- 单个和批量定位修复；
- 手动新增地点；
- 一键“生成行程与路线” CTA。

摘要文案使用“参与规划”，不再把非 `excluded` Candidate 描述成需要用户额外确认的“已选择地点”。

城市标记 `excluded` 后，子地点卡片保留用户原 preference 供以后恢复，但 UI 明确显示“所属城市不去，本次生成不参与规划”。

点击地点卡片，地图定位并高亮 Marker；点击 Marker，右侧自动展开对应城市分组、滚动并选中对应地点。

## 12. 行程模式

必须支持：

- Day；
- start / end Anchor；
- Stop 顺序；
- 距离 / 时间 / route geometry；
- route dirty；
- 更新单日路线；
- 更新全部 dirty 路线；
- 开始或继续细化。

城市 Macro Candidate 不应作为普通 Day Stop 展示。行程内显示的是实际访问的具体地点和真实路线节点。

## 13. 地图与右侧双向联动

### 行程 → 地图

点击 Day 后：

- 自动缩放到当天区域；
- 只突出当天节点；
- 显示当天当前路线；
- dirty 旧路线弱化并标注“旧路线，仅供参考”。

### 地点 / Stop → 地图

点击地点或 Stop 后，Marker 高亮并定位。

城市 Candidate Marker / 定位只表示宏观城市区域，不自动加入 Day Route。

### 地图 → 列表

- Candidate Marker 点击后定位到 Candidate 卡片，并展开对应城市分组；
- Day Marker 点击后定位到对应 DayStop；
- 同一地点允许多次到访，每次对应独立 DayStop。

## 14. 用户确定性调整

以下基础修改不调用 AI：

- 同日拖动；
- 跨 Day 拖动；
- 删除 Stop；
- 从地点池添加 Stop；
- 同一地点重复到访；
- Day 重排；
- 修改 Anchor；
- 修改活动、停留时间和交通方式；
- 用户新增地点。

所有写入通过固定 `PlanCommand` 和 `expectedGeneration` CAS 执行。

城市 preference 与已有 Day 发生冲突时，不能静默让 canonical plan 进入非法状态；必须通过相应 Day 调整 / Trip Scope 修改解决。

## 15. 路线更新机制

首次完整 Plan 生成后自动计算一次路线。

首次生成：

```text
AI 决定 Day 与景点组合
↓
服务端同区域景点近邻排序
↓
保存 Structured Plan
↓
Route Provider 计算真实 geometry / 距离 / 时间
```

后续修改：

```text
结构化计划立即更新
↓
route fingerprint 不匹配
↓
路线显示 dirty
↓
用户点击更新单日或全部 dirty 路线
```

拖拽后不自动调用 Route API。旧路线可以保留，但必须弱化，旧距离和时间不得冒充当前结果。

当前默认 Provider 能力：

- `walk` / `drive` / `bike`：Provider 路线；
- `transit` / `rail` / `ferry` / `flight`：明确 `attention/unsupported`，不伪造真实路线。

## 16. AI 调整 Scope

### Candidate Pool Scope

用于补充、删除或更新候选地点元数据，不替用户修改 preference，不修改 Day。

### Candidate Scope

用于更新或替换当前 Candidate 及其语义 Place，不修改 Day。

### Place Scope

只修改目标 Place 的语义字段，不修改坐标、Candidate preference 或 Day。

### Day Scope

只修改目标 Day 内部。跨日移动或 Day 重排必须提升为 Trip Scope。

### Trip Scope

允许跨 Day 调整、城市天数变化和全程节奏修改。

坐标不属于普通 AI Mutation Scope。

## 17. AI Preview / Diff / Apply / Undo

AI 不能直接悄悄覆盖正式行程。

```text
用户提出调整
↓
AI 返回受限 PlanCommand Proposal
↓
服务端校验 Scope 和 generation
↓
UI 展示 Diff / 原因 / 影响 Day / route dirty 影响
↓
用户 Apply 或 Reject
↓
Apply 原子写入 Revision
↓
必要时 Undo 恢复 Apply 前 Revision
```

Apply 前 canonical plan、地图和路线均不改变。

## 18. 数据模型边界

> **Place 不等于 Candidate，也不等于 DayStop；PlanningArea 是派生规划视图。**

### Place

真实世界地点的语义身份，不保存 AI 坐标。

`kind=city` 的 Place 表达城市身份；具体 attraction / lodging / station 等 Place 仍是独立真实地点。

### TripCandidate

这趟旅行与地点之间的候选关系，保存 preference、AI 理由、推荐度和建议时长。

城市 Candidate 的 preference 作用于 Macro 区域；具体 Candidate 的 preference 作用于实际访问地点。

### PlanningArea（派生）

由 `kind=city`、`Place.city / region / country` 在运行时推导：

- 不持久化；
- 不新增 canonical ID；
- 不要求数据库迁移；
- 用于城市 / 子地点分组、effective preference、冲突检测、Macro AI 输入和 Micro cluster 边界。

### DayStop

一次具体到访。移动 Stop 只修改目标 Day 和数组顺序，Place 本身不变。

**城市 Macro Candidate 不作为普通 DayStop。** 城市级 `must_go` 由城市内具体 DayStop 满足。

### PlaceResolution

保存 Provider / 用户明确输入的坐标、地址、状态和 fingerprint，是可重新解析的派生数据。

### DayRoute

保存当前某一输入 fingerprint 对应的 route geometry、距离、时间和 warning。dirty 由 fingerprint 比较派生。

## 19. 产品状态

只保留：

```text
① place_selection
② itinerary_planning
③ itinerary_refinement
```

`place_selection` 表示行程尚未正式生成，不代表用户必须完成一套选择向导。

阶段不因局部编辑自动回退。细化完成度由 Day 的 `detailLevel/detailStatus` 表示；修改已细化 Day 时，该 Day 进入待复核状态，顶层 Stage 仍保持 refinement。

## 20. MVP / P0

### Trip

- 创建旅行；
- 自然语言需求；
- 日期 / 天数 / 人数。

### Candidate

- AI 同时推荐城市与城市内具体地点；
- 用户手动新增；
- 理由、推荐度、时长、标签；
- 四级 preference；
- 城市 / 区域分组显示；
- 城市级 Macro preference。

### Resolution

- 自动定位；
- 生成前自动补充定位；
- resolving / resolved / unresolved；
- 单个 / 批量重试；
- Provider 候选选择；
- 地图点选；
- 手工坐标。

### Planning

- 一键“生成行程与路线”；
- Derived PlanningArea；
- Macro 城市顺序 / 停留规划；
- Micro 景点按天规划；
- 具体 `must_go` 硬约束；
- 城市 `must_go` 由具体地点满足；
- `want_to_go` 高优先级软约束；
- `optional` 自动取舍；
- 城市内 Micro GeoCluster；
- Day Anchor；
- 同区域景点确定性初始排序；
- 软约束地点 / 城市未排入时明确说明原因。

### Map

- Candidate Marker；
- 城市 Marker 仅作宏观区域表达；
- Day 节点与路线只使用实际路线节点；
- Candidate / Stop 双向联动；
- dirty 旧路线弱化；
- 未定位路线端点明确 attention。

### Editing

- 同日 / 跨日拖拽；
- 添加 / 删除；
- 重复到访；
- Anchor 和 Day 编辑。

### Route

- 首次 Plan 前进行城市内地理顺序优化；
- 首次 Plan 后自动计算真实路线；
- route dirty；
- 单日更新；
- 全部 dirty 更新。

### AI Adjustment

- Candidate Pool / Candidate / Place / Day / Trip Scope；
- Preview / Apply / Reject / Undo。

### Refinement

- 同线程；
- 每批最多两个 Day；
- 时间、时长、交通语义、费用、核验和提醒；
- 不改变地点、顺序或坐标。

## 21. P1

- Google Maps 链接解析；
- Provider Route Matrix；
- 基于真实路网的 TSP / insertion heuristic；
- 更正式的地理聚类；
- 路线优化建议；
- 时间轴和营业时间聚合；
- 太赶 / 太松检测；
- 酒店自动识别为 Anchor；
- 城市切换；
- AI 自动替换地点；
- 地点详情页；
- 自动路线更新设置；
- 真实公共交通 Provider。

## 22. P2

暂不进入 MVP：

- 实时天气自动改行程；
- 门票库存和购买；
- 酒店 / 航班价格；
- 餐厅预订；
- 多人协作；
- 自动记账；
- 实时公共交通状态；
- 完整移动端旅行助手。

## 23. 明确避免的设计

- 不让 AI 生成坐标；
- 不让纯 AI 负责距离和交通时间；
- 不把城市中心自动当成真实游玩 Stop；
- 不把城市和几十个具体景点平铺成完全同级的规划节点；
- 不为本功能新增 `areaPlaceId` 或数据库迁移；
- 不让用户一开始填写大量问卷；
- 不要求用户把候选池人工处理干净才允许生成；
- 不把 `want_to_go` 当成 `must_go`；
- 不因一个软约束地点未排入而丢弃整份行程；
- 不让 AI 每次修改都重写整个 Trip；
- 不让每次拖动立即请求 Route API；
- 不把 Candidate、Place 和 DayStop 混成一个实体；
- 不使用开放式 JSON Patch；
- 不把旧数据库迁移或兼容层重新加入 V3。

## 24. 最终核心工作流

```text
Discover
  AI 推荐城市 + 城市内具体地点
↓
Prioritize（可选）
  用户按需调整城市 / 景点的 必去 / 想去 / 可选 / 不去
↓
Generate
  一键触发自动定位
↓
Macro Plan
  AI 规划城市是否采用、跨城顺序和停留天数
↓
Micro Plan
  AI 按城市和 GeoCluster 分配具体景点到 Day
↓
Local Order
  服务端对同区域具体景点做确定性地理排序
↓
Route
  地图服务自动生成真实路线、距离和时间
↓
Refine
  用户确定性编辑或使用受控 AI Proposal，并按需刷新 dirty 路线
```

## 25. 产品核心价值

不宣传：

> AI 把所有你点过的地方机械塞进固定天数。

核心体验是：

> **告诉系统哪些城市和地点必须去、想去、可选或不去，然后一键得到跨城顺序和城市内路线都更合理的旅行。**

## 26. Hero Interaction

```text
用户查看 AI 推荐的地点池
↓
展开“京都”
↓
把京都标成想去、清水寺标成必去、几个景点保留可选
↓
直接点击“生成行程与路线”
↓
系统自动补充地点解析
↓
AI 先确定大阪 → 京都 → 奈良的 Macro 顺序和天数
↓
AI 再把京都东山、伏见、岚山的具体景点分配到不同 Day
↓
服务端减少同区域景点的明显折返
↓
地图服务生成每天真实路线
↓
用户发现 Day 4 太绕
↓
选中 Day 4：“清水寺必须保留，帮我重新安排”
↓
AI 返回修改 Proposal
↓
用户 Apply，路线进入 dirty，再按需刷新
```

## 27. 一句话产品定义

> **一个以地图和结构化行程为核心，让用户用四级 preference 表达城市与具体地点意愿，再由 AI 完成 Macro 城市规划和 Micro 景点排程，并由地图服务生成真实路线的旅行规划工作台。**
