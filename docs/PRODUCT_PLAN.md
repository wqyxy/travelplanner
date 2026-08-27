# AI 旅行计划网页版产品方案

> 状态：当前产品与代码实现的唯一需求依据  
> 更新日期：2026-08-27  
> 数据策略：V3 直接使用独立新数据库 `private_data/travel-v2.sqlite3`，不迁移、不兼容读取、不双写旧数据库。

## 1. 产品定位

打造一个以 **“需求沟通 → Macro 目的地发现与选择 → Micro 具体地点展开与选择 → 生成行程与真实路线 → 局部调整”** 为核心流程的 AI 旅行规划网页版。

产品不是“生成旅行攻略的聊天机器人”，而是：

> **AI 驱动的可视化旅行规划工作台。**

用户真正操作的是结构化旅行计划；AI 负责理解需求、推荐目的地区域与具体地点、根据优先级和整体路线自动取舍并排程；地图服务负责地点解析、坐标、真实路线和交通时间。

城市 / 区域与具体景点采用两层规划：

- **Macro**：城市 / 区域 / 景区等目的地区域负责决定全程是否进入、跨区域顺序以及大致停留天数；
- **Micro**：景点、住宿、交通点、明确 waypoint 等可路线化具体地点负责每天实际访问与真实路线。

两层候选不再要求在同一次 AI Candidate Discovery 中完整产生。P0 默认先得到 Macro 候选，用户确认或保留有效 Macro 范围后，再按这些范围展开 Micro 候选，以避免“有城市、无具体路线节点”的半成品地点池进入排程。

## 2. 核心产品原则

### 2.1 preference 是规划约束，覆盖完整性才是硬门槛

用户不需要把所有地点人工筛选、全部定位完成后才能生成，但系统必须保证参与硬约束规划的 Macro 区域具有可用于真实路线的具体地点。

```text
旅行需求沟通
  ↓
AI 生成 Macro 目的地候选
  城市 / 区域 / 景区 / 关键目的地
  ↓
用户可选调整 Macro preference
★ 必去 / ✓ 想去 / ○ 可选 / × 不去
  ↓
系统针对有效 Macro 区域展开 Micro 具体地点
  景点 / 住宿区 / 车站 / 机场 / 港口 / waypoint
  ↓
Place Resolver 自动解析 + Coverage Check
  ↓
用户可选调整 Micro preference
★ 必去 / ✓ 想去 / ○ 可选 / × 不去
  ↓
[✨ 生成行程与路线]
  ↓
Macro：规划目的地区域顺序和停留
  ↓
Micro：选择 / 分组具体地点并分配到 Day
  ↓
系统优化同区域景点初始顺序
  ↓
地图服务自动生成真实路线
  ↓
用户拖拽 / 添加 / 删除 / AI 调整
```

Macro 选择和 Micro 选择都不是要求用户“处理干净所有候选”的强制向导关卡。用户可以接受 AI 默认 preference 直接继续；真正阻塞生成的是无法满足的硬约束，例如：

- 具体 `must_go` 仍无法定位；
- Macro `must_go` 下没有任何可参与真实路线且已定位的 Micro 具体地点；
- 城市 / 子地点 preference 存在明确冲突。

地点列表仍是可编辑候选池，但候选池必须具备结构完整性，不能把“Macro 节点已生成”误认为“该区域已具备真实路线输入”。

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
| 推荐 Macro 目的地 | AI |
| 为指定 Macro 区域展开 Micro 具体地点 | AI |
| 决定 Macro 是否进入行程 | AI + preference + 服务端硬规则 |
| 决定 Macro 顺序 / 停留天数 | AI + 地理信息 |
| 判断具体地点适合哪一天 | AI + Micro 地理分组 |
| 根据 preference 取舍地点 | AI，受服务端硬规则约束 |
| 检查每个 Macro 是否具备可路线化具体地点 | 服务端确定性 Coverage Check |
| 具体地点坐标 | 地图服务 |
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
服务端业务校验 / 层级归属 / Coverage Check / 地理排序
↓
Structured Plan
↓
Map / Route / UI
```

### 2.4 每一步都可以返回修改，也可以按 Scope 重新生成

产品不是只能单向前进的向导。用户在任意时刻都可以回到更早的规划层修改，但重新生成必须是 **scope-aware**，不能无条件清空整趟旅行。

规则：

- 需求沟通可再次补充；更新 TripFacts 后只让受影响的候选、计划或路线进入待更新状态；
- Macro 候选可以再次生成，默认采用 merge / dedupe，不静默覆盖用户已经明确设置的 preference；
- 单个 Macro 区域可以单独“补充 / 重新生成具体地点”，不要求重新发现其他区域；
- Micro 再生成不得静默删除用户手动添加、已标记 `must_go` 或已经明确编辑过的地点；
- 用户改变某个 Macro 的参与状态时，只使相关 Micro 候选、Day 和 Route 进入失效 / 待重算范围；
- 重新生成 Day 不重新生成坐标；重新计算 Route 不调用 AI；
- 用户返回早期步骤不需要把顶层 `TripStage` 强制回退，UI 根据当前数据完整度展示对应工作流 checkpoint。

## 3. 创建旅行 / 需求沟通

首页只要求最低限度信息。用户可以直接输入：

> 国庆从上海去日本关西 7 天，夫妻带一个 3 岁孩子，不想太累，东京已经去过了，想玩大阪、京都和奈良。

可以附加：

- 日期；
- 出发地；
- 旅行天数；
- 成人 / 儿童人数。

第一步不要求填写大量偏好问卷。

需求沟通的目标是形成可供后续规划使用的 TripFacts 与约束，而不是在聊天阶段直接产生最终路线。用户可以继续补充节奏、交通方式、明确必去地点、明确不去地点等信息，然后再次生成 Macro 候选。

## 4. 分层生成地点池

AI 根据旅行需求先生成 Macro Candidate，再针对有效 Macro 区域生成 Micro Candidate，而不是立即生成日程，也不再要求一次 Candidate Discovery 同时把所有城市和所有具体地点生成完整。

### 4.1 Macro 目的地发现

Macro Candidate 表达“这趟旅行是否进入并停留这个目的地区域”，可以是：

- 城市；
- 明确区域；
- 景区 / 国家公园；
- 岛屿；
- road trip 中有独立停留意义的目的地；
- 用户明确要求、但更适合作为 Macro 目的地而不是普通 Day Stop 的区域型地点。

例如：

```text
奥克兰                  ← Macro
陶波                    ← Macro
惠灵顿                  ← Macro
弗朗茨·约瑟夫冰川地区    ← Macro 区域
特卡波湖                ← Macro 区域
皇后镇                  ← Macro
```

Macro 节点本身可以有地图 Resolution，用于大尺度地理位置、viewport 和跨区域规划，但**不默认成为真实 Day Route 端点**。

### 4.2 Macro preference 选择

用户可以对 Macro Candidate 标记：

```text
★ 必去   must_go
✓ 想去   want_to_go
○ 可选   optional
× 不去   excluded
```

这一步可以接受 AI 默认值直接继续，也可以多次返回修改或再次生成 Macro 候选。

系统只需要为“有效参与规划”的 Macro 区域展开 Micro 候选；`excluded` Macro 默认不继续消耗 AI 与地图解析资源。

### 4.3 Micro 具体地点展开

完成 Macro 发现后，系统针对有效 Macro 区域逐区生成可用于实际 Day 与 Route 的具体地点，例如：

```text
京都                         ← Macro
├─ 清水寺                    ← attraction，真实路线节点
├─ 伏见稻荷大社              ← attraction，真实路线节点
├─ 岚山竹林                  ← attraction / waypoint
└─ 京都站                    ← station

皇后镇                       ← Macro
├─ Skyline Queenstown        ← attraction
├─ Queenstown Gardens        ← attraction
├─ Arrowtown                 ← waypoint / attraction
└─ Queenstown Airport        ← airport
```

Micro Candidate 至少包括：

- 明确可搜索、可解析的真实地点名称；
- 所属 Macro 区域的显式关联；
- AI 推荐理由；
- 0–100 AI 推荐度；
- 建议游玩时长；
- 标签；
- 定位状态；
- 用户 preference。

AI 推荐度不能伪装为地图平台用户评分。

系统应支持：

- 为全部有效 Macro 区域一次展开；
- 只为某个 Macro 区域“补充推荐”；
- 只重新生成某个 Macro 下的 Micro 候选；
- 当 Coverage Check 发现缺口时自动触发该区域的补充发现，而不是等到最终路线生成时才报错。

### 4.4 Macro / Micro 归属必须显式

**P0 不再允许仅依赖 `Place.city / region` 自由文本作为 Macro → Micro 的唯一归属依据。**

具体 TripCandidate 应保存一个显式的 Macro 归属引用，例如：

```ts
type TripCandidate = {
  // ...existing fields
  planningAreaCandidateId: string | null;
};
```

语义：

- Macro Candidate：`planningAreaCandidateId = null`；
- Micro Candidate：指向所属的 Macro Candidate；
- `Place.city / region / country` 继续用于显示、地图搜索、去重与归属修复，但不是 canonical 层级关系；
- AI 在 Micro discovery 输出中必须明确指出它属于哪个已注入的 Macro Candidate；
- 服务端只能接受已存在且允许作为 Macro 的父 Candidate；
- 如果 AI 没有给出明确父关系，可用名称 / city / region 做兼容推断，但推断结果必须唯一才能落库；歧义时进入 `association_attention` 或等价待修复状态，不得静默归入错误区域。

这样即使“弗朗茨·约瑟夫冰川地区”的具体地点 Provider 地址写成 Westland / Franz Josef / West Coast，也不会因为自由文本不完全相同而丢失 Macro 归属。

不需要为 P0 新增独立 `PlanningArea` 数据库表；PlanningArea 仍可作为运行时规划视图，但其核心层级关系应优先来自显式 Candidate 引用，而不是字符串猜测。

### 4.5 地点推荐等级

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

### 4.6 Macro preference 与具体地点 preference

Macro Candidate 是宏观约束：

- `★ 京都`：行程必须进入京都并安排京都内具体地点；不要求生成“京都市中心” Stop；
- `✓ 京都`：优先进入京都，但整体跨城路线明显不合理时可以整座城市舍弃并解释；
- `○ 京都`：AI 可以根据全程效率决定是否进入；
- `× 京都`：京都及其普通子地点不参与规划。

具体地点 Candidate 是 Micro 约束：

- `★ 清水寺`：清水寺必须成为实际 Day Stop；
- `✓ 清水寺`：强优先，但可以有明确原因地舍弃；
- `○ 清水寺`：AI 自动取舍；
- `× 清水寺`：不得进入 Day。

冲突规则：如果 Macro 已经标记 `× 不去`，但其 Micro 中仍有 `★ 必去` 或 `✓ 想去` 的具体地点，生成前必须明确报 preference 冲突，而不是静默覆盖其中一方。

## 5. 地点定位、覆盖校验与异常处理

### 5.1 自动解析

Micro 地点推荐后系统可以后台自动解析；用户点击“生成行程与路线”时，服务端还会对所有实际参与规划且尚未可靠定位的具体地点再自动尝试解析。

```text
Micro Candidate
    ↓
标准名称 / 本地名 / 英文名 / Macro 归属 / 地址线索
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

Macro 节点也可以有 Resolution，但 Macro 坐标只用于宏观地理位置、地图 viewport 和辅助跨区域判断，**不会因为 Macro 被采用就自动把其中心点放进真实路线**。

### 5.2 Coverage Check：缺少具体地点应在 Micro 阶段暴露

系统必须在 Micro discovery / resolve 完成后立即计算每个有效 Macro 区域的覆盖状态，不能把“是否有真实路线节点”的首次检查推迟到最终 Plan / Route Generation。

至少显示：

```text
Macro Area
├─ microCandidateCount
├─ resolvedMicroCount
├─ participatingResolvedMicroCount
└─ coverageStatus: ready | supplementing | attention | blocked
```

硬规则：

- Macro `must_go`：至少需要 1 个“有效参与规划 + 已定位 + 可作为真实路线节点”的 Micro Candidate；
- 如果缺失，系统先自动为该 Macro 执行 scoped Micro discovery / 补充推荐，再自动解析；
- 自动补充后仍为 0，才进入 `blocked`，UI 在该 Macro 卡片上直接给出“补充推荐 / 手动添加 / 修复定位”；
- Macro `want_to_go`：缺少可路线化 Micro 时不必阻塞整趟旅行，但必须先自动补充；仍失败则允许规划器舍弃该 Macro，并明确原因；
- Macro `optional`：缺少 Micro 时可以不采用，但不得伪造城市中心 Stop；
- 具体 Micro `must_go` 未定位：自动重试后仍失败则阻塞生成；
- 用户不需要为了满足 Coverage Check 手动把 Micro 标成 `must_go`；已定位的 `optional` Micro 也可以作为后续 AI 选点池。

对计划停留多天的 Macro，产品可以提示“候选较少”，并建议补充更多 Micro 地点，但 P0 不把固定数量（例如 3/5/8 个）设成统一硬门槛；真正硬门槛仍是能否满足必去约束和形成真实路线。

这意味着本次“9 个必去城市都已定位，但没有同城已定位具体地点”的问题，应该在 **第 4/5 步 Micro 展开与覆盖校验** 被自动修复或明确提示，而不是到第 6 步生成路线时才突然失败。

### 5.3 未定位地点

未定位不再统一阻塞生成：

- 具体 `must_go` 未定位：自动重试后仍失败则阻塞生成，因为无法保证硬约束地点进入真实线路；
- Macro `must_go`：Macro 自身坐标不是路线硬条件，但至少需要一个参与规划且已定位的 Micro 具体地点，否则 Coverage Check 阻塞；
- `want_to_go` Micro 未定位：不阻塞整趟行程，可以继续规划；AI 必须看到该 Candidate，不得静默消失；
- `optional` Micro 未定位：不阻塞整趟行程，由 AI 自动取舍；
- `excluded` 或因 Macro `excluded` 被抑制的子地点：不参与生成前定位。

如果未定位的软约束具体地点仍被排入 Day，路线服务必须明确显示 `attention` / “路线端点尚未正确定位”，不得伪造路线。

用户仍可手动修复：

- 重新识别；
- AI 补充搜索提示后重新匹配；
- 选择地图 Provider 候选；
- 从地图点选；
- 手动输入坐标。

P1：粘贴 Google Maps 链接解析。

AI 重试只能补充名称、城市、区域或搜索关键词，不能“重新生成一个坐标”。

## 6. 两层 preference 调整

地点选择分成两个逻辑 checkpoint，但都允许用户接受默认值直接继续：

### 6.1 Macro 选择

支持：

- 必去 / 想去 / 可选 / 不去；
- 单选 / 多选 / 批量 preference；
- 重新生成 Macro 推荐；
- 手动新增 Macro 目的地；
- 返回需求沟通继续修改约束。

### 6.2 Micro 选择

支持：

- 按 Macro 区域折叠展示具体地点；
- 具体地点 preference；
- 单选；
- 多选；
- 全选当前筛选结果；
- 批量标记必去 / 想去 / 可选 / 不去；
- 批量重新定位；
- 用户手动新增具体地点；
- 对单个 Macro 执行“补充推荐 / 重新生成具体地点”；
- Coverage 状态与缺口修复。

这两次选择是用户控制点，不是要求用户逐项确认所有 Candidate 的强制向导。

底部在 Coverage Check 通过硬约束后提供：

```text
[✨ 生成行程与路线]
```

按钮不因为普通 `want_to_go` / `optional` 未定位而禁用。

“参与规划”数量按**有效规划约束**统计：Macro 为 `excluded` 时，其普通 Micro 子地点即使自身仍显示 `optional`，也不计入参与规划。

## 7. 生成行程与路线

一次点击的服务端流程：

```text
读取有效 Macro Candidate
↓
使用显式 planningAreaCandidateId 构造 Macro → Micro 关系
  缺失关系时只允许唯一确定的兼容推断
↓
检查 Macro / Micro preference 冲突
↓
Coverage Check
  对缺少具体地点的有效 Macro 自动补充 Micro Candidate
↓
自动解析尚未可靠定位的参与规划 Micro 地点
↓
再次 Coverage Check
  硬约束仍不可满足才阻塞，并返回具体 Macro 的修复动作
↓
构造 PlanningAreas + Candidate + Resolution + Micro GeoClusters
↓
Macro：AI 决定目的地区域顺序和大致停留天数
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
Explicit Macro → Micro Candidate Relations
+
All Effectively Participating Candidates
+
Macro / Micro Preference
+
Current Place Resolutions（允许部分为 null）
+
Coverage Status
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
- Macro `must_go` 必须由其显式归属的具体 Stop 满足，Macro 中心本身不得作为替代 Stop；
- `want_to_go` 尽量满足，未满足必须给出具体原因；
- `optional` 可自动取舍，未排入必须给出原因；
- `excluded` 及其被抑制子地点不得进入 Day；
- 每个有效参与规划的具体 Candidate 必须“已排程”或“明确未排程并说明原因”，不得静默消失；
- Macro Candidate 已由其具体 Stop 满足后，不需要再单独加入未排程说明；
- Anchor 未知时允许为空，不伪造酒店；
- AI 不输出坐标、路线 geometry、Provider 距离或时间；
- 保存完整合法计划后才切换到 `itinerary_planning`；
- 首次 Plan 保存成功后自动计算每天路线。

## 8. Macro / Micro 地理算法辅助排程

排程不完全依赖 LLM。

### 8.1 PlanningArea：运行时规划视图，层级关系优先来自显式 Candidate 引用

P0 不要求新增独立 `PlanningArea` 数据库表，也不要求把 Macro 关系写进 `Place`。

服务端优先根据 TripCandidate 的显式父关系构造 PlanningArea：

```text
Macro TripCandidate
+
Micro TripCandidate.planningAreaCandidateId
+
Place.city / region / country 作为显示、搜索与兼容修复信息
↓
Derived PlanningArea
```

只有在历史 / 异常数据没有显式父关系时，才允许使用：

```text
kind=city 的 Place 名称 / 本地名 / 英文名
+
具体 Place.city / region / country
```

进行唯一匹配的 fallback。匹配不唯一时不得静默选一个父区域。

PlanningArea 是运行时规划视图，不是新的 canonical 业务实体。这样保留现有主要关系：

```text
Place → TripCandidate → DayStop
```

同时把 Macro → Micro 的归属提升为稳定、可验证的 TripCandidate 层级关系，而不是依赖自由文本。

### 8.2 Macro 层

PlanningArea 提供：

- Macro Candidate；
- 显式归属该 Macro 的具体 Candidate；
- 有效 preference；
- Coverage 状态；
- 是否因 Macro `excluded` 而整体抑制；
- Macro 硬约束是否已由具体地点满足。

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
特卡波湖
↓
皇后镇
↓
但尼丁？
```

### 8.3 Micro 区域内地理分组

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
- 不跨 Macro 区域重排；
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

Macro 节点原则上不作为 Day Anchor 的真实路线端点；能使用实际住宿、机场、车站、港口或明确 waypoint 时优先使用具体 Place。

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

在 `place_selection` 内，地点 Tab 展示可回退的工作流 checkpoint：

```text
需求
→ 目的地（Macro）
→ 具体地点（Micro）
→ 生成行程
```

这只是 UI 进度表达，不新增顶层业务 stage。

## 11. 地点模式

地点列表按 PlanningArea 分组，而不是把 Macro 和几十个景点平铺在同一级：

```text
▼ 皇后镇                         ✓ 想去
   Coverage: ready · 6 个具体地点

   ✓ 皇后镇                     [宏观规划]
   ★ Skyline Queenstown
   ○ Queenstown Gardens
   ○ Arrowtown
   ○ Onsen Hot Pools

▶ 基督城                         ○ 可选
   Coverage: ready · 5 个具体地点
```

必须支持：

- Macro / Micro 两层查看；
- 全部 / 必去 / 想去 / 可选 / 不去 / 未定位；
- Macro 区域折叠；
- Macro 标识；
- Coverage ready / supplementing / attention / blocked；
- 搜索；
- 单选、多选、全选当前筛选；
- 批量 preference；
- 单个和批量定位修复；
- 单个 Macro 的“补充推荐 / 重新生成具体地点”；
- 手动新增地点；
- Coverage 硬约束通过后的一键“生成行程与路线” CTA。

摘要文案使用“参与规划”，不再把非 `excluded` Candidate 描述成需要用户额外确认的“已选择地点”。

Macro 标记 `excluded` 后，子地点卡片保留用户原 preference 供以后恢复，但 UI 明确显示“所属目的地不去，本次生成不参与规划”。

点击地点卡片，地图定位并高亮 Marker；点击 Marker，右侧自动展开对应 Macro 分组、滚动并选中对应地点。

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

Macro Candidate 不应作为普通 Day Stop 展示。行程内显示的是实际访问的具体地点和真实路线节点。

## 13. 地图与右侧双向联动

### 行程 → 地图

点击 Day 后：

- 自动缩放到当天区域；
- 只突出当天节点；
- 显示当天当前路线；
- dirty 旧路线弱化并标注“旧路线，仅供参考”。

### 地点 / Stop → 地图

点击地点或 Stop 后，Marker 高亮并定位。

Macro Candidate Marker / 定位只表示宏观区域，不自动加入 Day Route。

### 地图 → 列表

- Candidate Marker 点击后定位到 Candidate 卡片，并展开对应 Macro 分组；
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

Macro preference 与已有 Day 发生冲突时，不能静默让 canonical plan 进入非法状态；必须通过相应 Day 调整 / Trip Scope 修改解决。

用户在行程阶段也可以返回 Macro / Micro 视图继续修改：

- 修改 Micro preference：相关 Stop / Day 进入待调整状态；
- 新增 Micro 地点：可加入现有 Day 或触发 AI Proposal；
- 修改 Macro：相关下游 Day / Route 必须明确标记受影响范围，不静默沿用已经失真的旧路线。

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

### Macro Candidate Scope

用于补充 / 重新生成某个目的地区域下的 Micro Candidate，或更新该 Macro 的语义信息；不得静默覆盖其他 Macro。

### Candidate Scope

用于更新或替换当前 Candidate 及其语义 Place，不修改 Day。

### Place Scope

只修改目标 Place 的语义字段，不修改坐标、Candidate preference、Macro 归属或 Day。

### Day Scope

只修改目标 Day 内部。跨日移动或 Day 重排必须提升为 Trip Scope。

### Trip Scope

允许跨 Day 调整、Macro 天数变化和全程节奏修改。

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

对于“重新生成 Macro 候选”或“重新生成某个 Macro 的 Micro 候选”，同样应明确展示新增 / 保留 / 可能移除的 AI Candidate；用户手动地点和用户 preference 不应被静默重置。

## 18. 数据模型边界

> **Place 不等于 Candidate，也不等于 DayStop；PlanningArea 是运行时规划视图；Macro → Micro 归属是 TripCandidate 层的显式关系。**

### Place

真实世界地点的语义身份，不保存 AI 坐标。

`kind=city` 的 Place 可以表达城市身份；具体 attraction / lodging / station 等 Place 仍是独立真实地点。区域型 Macro 在 P0 可以继续使用现有语义字段表达，但不得依赖名称相等来建立 Micro 归属。

### TripCandidate

这趟旅行与地点之间的候选关系，保存 preference、AI 理由、推荐度和建议时长。

Macro Candidate 的 preference 作用于宏观区域；Micro Candidate 的 preference 作用于实际访问地点。

新增 / 明确：

```ts
planningAreaCandidateId: string | null
```

该字段用于把 Micro Candidate 显式归属到某个 Macro Candidate。它是旅行内的规划关系，不污染 Place 的通用语义身份。

### PlanningArea（派生）

优先由 Macro Candidate 与 Micro `planningAreaCandidateId` 在运行时构造：

- 不持久化为独立业务实体；
- 不新增独立 canonical PlanningArea ID；
- 用于 Macro / Micro 分组、Coverage Check、effective preference、冲突检测、Macro AI 输入和 Micro cluster 边界；
- `Place.city / region / country` 只作为兼容 fallback、显示和地图搜索辅助；
- fallback 匹配不唯一时必须显式 attention，不得静默归错区域。

### DayStop

一次具体到访。移动 Stop 只修改目标 Day 和数组顺序，Place 本身不变。

**Macro Candidate 不作为普通 DayStop。** Macro `must_go` 由其显式归属的具体 DayStop 满足。

### PlaceResolution

保存 Provider / 用户明确输入的坐标、地址、状态和 fingerprint，是可重新解析的派生数据。

### DayRoute

保存当前某一输入 fingerprint 对应的 route geometry、距离、时间和 warning。dirty 由 fingerprint 比较派生。

## 19. 产品状态与工作流 checkpoint

顶层 canonical stage 只保留：

```text
① place_selection
② itinerary_planning
③ itinerary_refinement
```

用户看到的 7 步逻辑不等于 7 个持久化业务 stage。

在 `place_selection` 内可存在这些可回退 checkpoint：

```text
1. 需求沟通
2. Macro 目的地发现
3. Macro 选择
4. Micro 具体地点展开
5. Micro 选择 + Coverage Check
```

首次合法 Day 保存成功后进入：

```text
6. 生成行程与路线 → itinerary_planning
7. 调整路线 / 行程 → itinerary_planning / itinerary_refinement
```

用户可以从第 6/7 步重新打开 Macro 或 Micro 视图修改；这不要求把顶层 stage 机械回退到 `place_selection`。系统通过 generation、coverage、route fingerprint 和受影响范围来表达哪些下游结果需要更新。

细化完成度由 Day 的 `detailLevel/detailStatus` 表示；修改已细化 Day 时，该 Day 进入待复核状态，顶层 Stage 仍保持 refinement。

## 20. MVP / P0

### Trip

- 创建旅行；
- 自然语言需求；
- 日期 / 天数 / 人数；
- 需求可继续补充并重新生成 Macro 候选。

### Candidate

- AI 先推荐 Macro 目的地；
- 用户可选调整 Macro preference；
- AI 针对有效 Macro 展开 Micro 具体地点；
- Macro / Micro 均支持再次生成；
- 用户手动新增；
- 理由、推荐度、时长、标签；
- 四级 preference；
- Macro / Micro 分组显示；
- Micro Candidate 显式保存 `planningAreaCandidateId`。

### Resolution / Coverage

- 自动定位；
- Micro discovery 后立即 Coverage Check；
- 缺少可路线化 Micro 的 Macro 自动补充推荐并解析；
- 生成前再次校验；
- resolving / resolved / unresolved；
- 单个 / 批量重试；
- Provider 候选选择；
- 地图点选；
- 手工坐标。

### Planning

- Coverage 硬约束通过后“一键生成行程与路线”；
- Derived PlanningArea；
- 显式 Macro → Micro 关系；
- Macro 顺序 / 停留规划；
- Micro 景点按天规划；
- 具体 `must_go` 硬约束；
- Macro `must_go` 由其具体地点满足；
- `want_to_go` 高优先级软约束；
- `optional` 自动取舍；
- Micro GeoCluster；
- Day Anchor；
- 同区域景点确定性初始排序；
- 软约束地点 / Macro 未排入时明确说明原因。

### Map

- Candidate Marker；
- Macro Marker 仅作宏观区域表达；
- Day 节点与路线只使用实际路线节点；
- Candidate / Stop 双向联动；
- dirty 旧路线弱化；
- 未定位路线端点明确 attention。

### Editing

- 同日 / 跨日拖拽；
- 添加 / 删除；
- 重复到访；
- Anchor 和 Day 编辑；
- 从行程阶段返回 Macro / Micro 修改并明确受影响范围。

### Route

- 首次 Plan 前进行同区域地理顺序优化；
- 首次 Plan 后自动计算真实路线；
- route dirty；
- 单日更新；
- 全部 dirty 更新。

### AI Adjustment

- Candidate Pool / Macro Candidate / Candidate / Place / Day / Trip Scope；
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
- Macro 切换；
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
- 不把 Macro 中心自动当成真实游玩 Stop；
- 不把 Macro 和几十个具体景点平铺成完全同级的规划节点；
- **不依赖 `Place.city / region` 自由文本作为 Macro → Micro 的唯一归属依据；**
- 不让用户一开始填写大量问卷；
- 不要求用户把候选池人工处理干净才允许生成；
- 不把两次“选择”做成必须逐项确认的僵硬向导；
- 不把 `want_to_go` 当成 `must_go`；
- 不因一个软约束地点未排入而丢弃整份行程；
- 不等到 Route Generation 才第一次发现 Macro 下没有真实路线节点；
- 不让 AI 每次修改都重写整个 Trip；
- 不让每次拖动立即请求 Route API；
- 不把 Candidate、Place 和 DayStop 混成一个实体；
- 不使用开放式 JSON Patch；
- 不把旧数据库迁移或兼容层重新加入 V3。

## 24. 最终核心工作流

```text
1. 需求沟通
   收集 TripFacts、节奏、交通方式和明确约束
↓
2. 生成 Macro 目的地候选
   城市 / 区域 / 景区 / road-trip 目的地
↓
3. 选择 Macro 目的地
   必去 / 想去 / 可选 / 不去
   可返回需求沟通，也可再次生成
↓
4. 生成 Micro 详细兴趣点
   只围绕有效 Macro 展开可路线化具体地点
   建立显式 Macro → Micro 关系并自动定位
↓
5. 选择 Micro 具体地点 + Coverage Check
   用户可调整 preference，也可接受 AI 默认
   缺少具体地点的 Macro 自动补充推荐 / 修复定位
↓
6. 生成行程与路线
   Macro 排序与停留 → Micro 分日 → 确定性局部排序 → Route Provider
↓
7. 调整行程与路线
   拖拽 / 增删 / 回到 Macro 或 Micro 修改 / AI Proposal / route dirty 刷新
```

**每一步都允许返回修改，每个 AI 生成步骤都允许按 Scope 再次生成。**

关键不是“7 个必须点下一步的页面”，而是让系统的数据完整度与用户决策顺序符合旅行规划的真实过程：先决定去哪，再决定每个地方具体玩什么，最后才把具体地点排成真实路线。

## 25. 产品核心价值

不宣传：

> AI 把所有你点过的地方机械塞进固定天数。

核心体验是：

> **先和 AI 明确旅行需求与目的地，再让系统为每个有效目的地补全可路线化具体地点；用户只需要表达哪些必须去、想去、可选或不去，就能得到跨区域顺序和区域内路线都更合理的旅行。**

## 26. Hero Interaction

```text
用户描述“新西兰 20 天自驾，南北岛都想去，不想每天开太久”
↓
AI 先推荐奥克兰、陶波、惠灵顿、基督城、特卡波湖、皇后镇等 Macro 目的地
↓
用户把其中 9 个标成必去，删除一个不感兴趣的区域
↓
系统只围绕这 9 个 Macro 展开具体景点、车站 / 机场、waypoint 等 Micro 候选
↓
发现“弗朗茨·约瑟夫冰川地区”还没有已定位具体地点
↓
系统在 Micro 阶段自动补充并解析，例如冰川步道入口、游客中心或可用 waypoint
↓
用户把少数具体景点标成必去，其余保持可选
↓
Coverage Check 通过
↓
用户点击“生成行程与路线”
↓
AI 先确定全程 Macro 顺序和停留天数
↓
AI 再把每个 Macro 下的具体地点分配到不同 Day
↓
服务端减少同区域景点的明显折返
↓
地图服务生成每天真实路线
↓
用户发现 Day 12 太绕
↓
拖拽调整，或选中 Day 12：“这个冰川步道必须保留，帮我重新安排”
↓
AI 返回修改 Proposal
↓
用户 Apply，相关路线进入 dirty，再按需刷新
```

## 27. 一句话产品定义

> **一个以地图和结构化行程为核心，先用 Macro 目的地确定“去哪”，再展开并选择 Micro 具体地点确定“玩什么”，由 AI 完成跨区域与分日规划、由地图服务生成真实路线，并允许用户在任意规划层返回修改和按 Scope 重新生成的旅行规划工作台。**