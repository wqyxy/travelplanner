# AI 旅行计划网页版产品方案

> 状态：当前产品与代码实现的唯一需求依据  
> 更新日期：2026-08-27  
> 数据策略：V3 直接使用独立新数据库 `private_data/travel-v2.sqlite3`，不迁移、不兼容读取、不双写旧数据库。

## 1. 产品定位

TravelPlanner 是一个以 **地图展示 + 右侧唯一控制台** 为核心的 AI 旅行规划工作台。

核心规划逻辑：

```text
需求沟通
→ Macro 目的地发现与选择
→ Micro 具体兴趣点展开与选择
→ Coverage / 定位校验
→ 生成按天行程
→ 地图服务生成真实路线
→ 用户调整
```

产品不是“生成一篇旅行攻略的聊天机器人”。

用户操作的是结构化旅行计划；AI 负责理解需求、推荐目的地和兴趣点、做语义排程和受控调整；地图服务负责地点解析、坐标、距离、时间和真实路线。

城市 / 区域与具体地点采用两层规划：

- **Macro**：城市、区域、景区、岛屿、road-trip 目的地，决定“去哪”；
- **Micro**：景点、住宿、机场、车站、港口、明确 waypoint，决定“具体玩什么、路线经过哪里”。

---

## 2. 最高优先级 UX 原则：右侧是唯一业务交互入口

这是 P0 级产品约束，优先级高于现有页面结构。

> **所有会改变旅行计划、触发 AI、触发地点解析、触发路线计算、推进或返回规划流程的业务操作，都只能从右侧工作区发起。**

### 2.1 页面只有两个职责区

```text
┌──────────────────────────────┬────────────────────────────────┐
│                              │ 右侧唯一控制台                 │
│                              │                                │
│                              │ ① 需求 ② 目的地 ③ 兴趣点 ④ 行程 │
│            地图              │ ────────────────────────────── │
│         只展示结果           │ 当前步骤内容                   │
│                              │                                │
│                              │                                │
│                              │ ────────────────────────────── │
│                              │ 当前步骤操作区                 │
│                              │ AI 输入 / 主按钮 / 状态         │
└──────────────────────────────┴────────────────────────────────┘
```

左侧地图：

- 展示 Macro 区域；
- 展示 Micro Marker；
- 展示 Day Stop；
- 展示路线；
- 展示选中 / 高亮结果；
- 允许地图本身的平移、缩放；
- Marker 点击最多只做“选中并让右侧滚动到对应对象”。

**左侧地图不得提供业务操作入口。**

禁止：

- 地图 Popup 内“加入行程”；
- 地图 Popup 内“必去 / 不去”；
- 地图 Popup 内“重新定位”；
- 地图 Popup 内“AI 调整”；
- 地图上浮动“生成路线”；
- 地图右键菜单修改计划；
- 从地图直接创建 canonical Place / Candidate / Stop。

### 2.2 同一个功能只能有一个 canonical UI 入口

不仅要求“都在右边”，还要求 **同一业务动作不能在右侧不同位置重复出现**。

例如：

| 操作 | 唯一入口 |
|---|---|
| 修改旅行需求 | 右侧 `需求` 步骤 |
| 重新生成 Macro | 右侧 `目的地` 步骤操作区 |
| Macro preference | 右侧 `目的地` Candidate 卡片 |
| 生成 / 补充 Micro | 右侧 `兴趣点` 步骤操作区 |
| Micro preference | 右侧 `兴趣点` Candidate 卡片 |
| 修复定位 | 右侧 `兴趣点` 对应地点卡片 |
| 生成行程与路线 | 右侧 `兴趣点` 底部主 CTA |
| Day 拖拽 / 增删 | 右侧 `行程` Day 列表 |
| 更新路线 | 右侧 `行程` 当前 Day / dirty route 操作区 |
| AI 调整 | 右侧控制台底部 AI Composer |
| Apply / Reject Proposal | 右侧 Proposal 区 |

禁止同一功能同时出现在：

- 页面 Header；
- 地图；
- 地图 Popup；
- 浮动按钮；
- 右侧卡片；
- 页面底部；
- AI Composer 旁边另一套工具栏；

中的多个位置。

### 2.3 AI Composer 也必须属于右侧控制台

取消横跨整页底部的独立 AI 输入区。

AI Composer 固定在右侧工作区底部，与当前步骤绑定 Scope：

```text
需求      → Trip / requirement scope
目的地    → Macro scope
兴趣点    → Micro / Candidate scope
行程      → Day / Trip scope
```

用户不需要先理解 Scope 类型。

UI 根据当前步骤和当前选中对象自动确定默认 Scope；需要扩大范围时在右侧明确提示。

### 2.4 用户始终知道“现在该做什么”

右侧顶部固定显示：

```text
① 需求  →  ② 目的地  →  ③ 兴趣点  →  ④ 行程
```

规则：

- 当前步骤明显高亮；
- 已完成步骤显示完成状态；
- 有异常的步骤显示 attention；
- 用户只能通过这一组步骤导航返回前面修改；
- 不再额外提供第二套 `[地点] [行程]` 主导航；
- 不再通过隐藏按钮、聊天指令或地图操作切换规划阶段。

右侧底部始终只突出 **一个主 CTA**。

例如：

```text
需求      → [生成目的地建议]
目的地    → [生成详细兴趣点]
兴趣点    → [生成行程与路线]
行程      → [更新需要刷新的路线]  // 只有存在 dirty route 时
```

辅助操作可以存在，但不能与主 CTA 抢层级。

---

## 3. 7 个逻辑 checkpoint，4 个用户可见步骤

底层规划仍然是：

```text
1. 需求沟通
2. 生成 Macro 目的地
3. 选择 Macro 目的地
4. 生成 Micro 具体兴趣点
5. 选择 Micro + Coverage Check
6. 生成行程与路线
7. 调整行程与路线
```

但 UI **不要显示成 7 个复杂页面**。

用户只看到 4 个明确步骤：

```text
① 需求
   = checkpoint 1

② 目的地
   = checkpoint 2 + 3

③ 兴趣点
   = checkpoint 4 + 5

④ 行程
   = checkpoint 6 + 7
```

这样既保留正确的数据流程，又避免让用户面对七层导航。

每一步都可以通过右侧顶部步骤导航返回修改；每个 AI 生成步骤都允许在当前右侧步骤中再次生成。

---

## 4. 第一步：需求

用户进入新旅行后，右侧默认就是 `① 需求`。

右侧显示：

- 自然语言需求输入；
- 日期；
- 天数；
- 出发地；
- 人数；
- 已识别的明确约束摘要。

例如：

> 新西兰 20 天自驾，南北岛都去，不想每天开太久，皇后镇和特卡波湖必须去。

第一步不要求填写大量问卷。

底部唯一主 CTA：

```text
[生成目的地建议]
```

AI 输出 TripFacts / constraints + Macro Candidate。

用户之后若要修改需求，只通过顶部 `① 需求` 返回这里修改。

不在行程页、地图 Popup 或其它地方再放“编辑旅行需求”。

---

## 5. 第二步：目的地（Macro）

`② 目的地` 解决一个问题：

> **这趟旅行到底去哪些主要地方？**

Macro Candidate 可以是：

- 城市；
- 明确区域；
- 景区 / 国家公园；
- 岛屿；
- road-trip 中有独立停留意义的目的地；
- 用户明确要求的区域型目的地。

例如：

```text
★ 奥克兰
○ 罗托鲁瓦
✓ 陶波
★ 惠灵顿
★ 基督城
★ 特卡波湖
★ 瓦纳卡
★ 皇后镇
★ 弗朗茨·约瑟夫冰川地区
```

Macro 只代表“是否进入这个区域以及大致停留”，不自动成为 Day Stop。

### 5.1 preference

```text
★ 必去   must_go
✓ 想去   want_to_go
○ 可选   optional
× 不去   excluded
```

语义：

- `must_go`：硬约束，必须进入行程；
- `want_to_go`：高优先级软约束，尽量进入；不采用必须说明原因；
- `optional`：由 AI 根据路线与时间自动取舍；
- `excluded`：不得进入规划。

### 5.2 右侧唯一操作

Macro preference 直接在右侧 Candidate 卡片修改。

右侧步骤操作区可以有辅助操作：

```text
重新生成目的地
手动添加目的地
```

这些功能不得再出现在地图、Header 或其他位置。

底部唯一主 CTA：

```text
[生成详细兴趣点]
```

用户可以不逐项人工确认，接受 AI 默认 preference 后直接继续。

---

## 6. 第三步：兴趣点（Micro）

`③ 兴趣点` 解决：

> **到了每个目的地，具体去哪些可路线化地点？**

系统针对有效 Macro 展开 Micro Candidate：

```text
皇后镇                         ★ 必去
├─ Skyline Queenstown         ✓ 想去
├─ Queenstown Gardens         ○ 可选
├─ Arrowtown                  ○ 可选
└─ Queenstown Airport         ○ 可选

特卡波湖                       ★ 必去
├─ Church of the Good Shepherd ★ 必去
├─ Mt John Observatory        ○ 可选
└─ Lake Tekapo viewpoint      ○ 可选
```

Micro Candidate 至少包含：

- 明确真实地点名称；
- 所属 Macro；
- AI 推荐理由；
- AI 推荐度；
- 建议停留时间；
- 标签；
- 定位状态；
- preference。

### 6.1 Macro → Micro 必须显式关联

P0 不允许继续只依赖 `Place.city / region` 自由文本猜父区域。

TripCandidate 增加 / 明确：

```ts
type TripCandidate = {
  // existing fields
  planningAreaCandidateId: string | null;
};
```

规则：

- Macro Candidate：`planningAreaCandidateId = null`；
- Micro Candidate：指向所属 Macro Candidate；
- `Place.city / region / country` 仅用于显示、地图搜索、去重和 fallback；
- AI 生成 Micro 时必须引用已注入 Macro Candidate；
- fallback 只有在结果唯一时才能自动归属；
- 歧义进入 attention，不静默归错区域。

这样 `Franz Josef / Westland / West Coast / 弗朗茨·约瑟夫冰川地区` 等名称差异不会破坏父子关系。

### 6.2 单个 Macro 的补充 / 重生成

用户在右侧展开某个 Macro 后，可以看到该区域的 Micro 列表和 Coverage 状态。

单区域补充属于 `兴趣点` 步骤内的操作：

```text
皇后镇
6 个兴趣点 · Coverage ready
[补充推荐]
```

禁止再提供：

- 地图上的“附近推荐”；
- Marker Popup 的“AI 找景点”；
- 行程页另一套“补充地点”入口。

所有这些需求都回到 `③ 兴趣点` 处理。

---

## 7. 地点解析与 Coverage Check

AI 不生成可信坐标。

```text
AI Micro Candidate
↓
Place Resolver
↓
地图 Provider 搜索
↓
Provider Place ID / 坐标 / 地址
↓
resolved / unresolved
```

### 7.1 状态

```text
resolving
resolved
unresolved
```

Macro 可以有 Resolution，用于地图展示和 Macro 地理判断，但 Macro 中心点不能自动变成真实路线 Stop。

### 7.2 Coverage Check

系统在 Micro discovery / resolve 后立即计算：

```text
Macro Area
├─ microCandidateCount
├─ resolvedMicroCount
├─ participatingResolvedMicroCount
└─ coverageStatus
   ready | supplementing | attention | blocked
```

硬规则：

- Macro `must_go` 至少需要 1 个有效参与规划、已定位、可作为路线节点的 Micro；
- 如果没有，系统先自动执行该 Macro 的 scoped Micro 补充 + 解析；
- 自动补充仍为 0 才 `blocked`；
- Macro `want_to_go` 缺少 Micro 时先自动补充，仍失败可被规划器舍弃，但必须说明原因；
- Macro `optional` 缺少 Micro 可以不采用；
- Micro `must_go` 未定位，自动重试仍失败则阻塞生成；
- `want_to_go / optional` Micro 未定位不统一阻塞。

### 7.3 异常修复入口仍只有右侧

在 `③ 兴趣点` 对应卡片中提供：

```text
重新识别
选择 Provider 候选
地图点选定位
手工坐标
补充搜索信息后重试
```

即使使用“地图点选定位”，操作也必须由右侧点击“地图点选”进入一个明确模式，然后用户在地图点一下位置，完成后回到右侧确认。

也就是说：

> 地图可以作为右侧某个明确操作的输入设备，但地图本身不能自行成为业务入口。

P1：Google Maps 链接解析。

### 7.4 生成行程前的唯一 CTA

Coverage 硬约束通过后，`③ 兴趣点` 底部主 CTA：

```text
[生成行程与路线]
```

如果 blocked：

- 主 CTA 禁用；
- 在右侧清楚列出哪些 Macro / Micro 阻塞；
- 每个问题给出右侧修复动作；
- 不等到用户点击后才用日志错误告诉用户。

---

## 8. 第四步：行程

`④ 行程` 是唯一的 Day / Route 编辑入口。

显示：

```text
Day 1
  startAnchor
  Stop 1
  Stop 2
  Stop 3
  endAnchor
  route summary

Day 2
  ...
```

必须支持：

- Day；
- start / end Anchor；
- Stop 顺序；
- route geometry 对应摘要；
- 距离 / 时间；
- route dirty；
- 同日拖拽；
- 跨日拖拽；
- 添加 / 删除 Stop；
- 重复到访；
- Day 重排；
- 修改 Anchor；
- 修改活动、停留时间、交通方式；
- AI 调整 Proposal。

### 8.1 Macro 不作为普通 Day Stop

Macro `must_go` 必须由其归属的具体 Micro Stop 满足。

禁止：

```text
皇后镇市中心   // 仅因为 Macro=皇后镇而伪造的 Stop
```

除非用户或 Provider 明确存在这个具体 waypoint。

### 8.2 返回前面修改只有一个方式

用户如果觉得“皇后镇兴趣点不够”或“其实不想去陶波”，不要在行程中再放第二套地点管理工具。

用户通过右侧顶部唯一步骤导航：

```text
④ 行程 → ③ 兴趣点
④ 行程 → ② 目的地
④ 行程 → ① 需求
```

修改后，系统明确标记受影响的 Day / Route。

不静默保留已经失真的行程。

---

## 9. 行程生成流程

用户在右侧 `③ 兴趣点` 点击唯一 CTA：

```text
[生成行程与路线]
```

服务端：

```text
读取有效 Macro Candidate
↓
根据 planningAreaCandidateId 构造 Macro → Micro
↓
检查 Macro / Micro preference 冲突
↓
Coverage Check
↓
自动解析需要参与规划但尚未可靠定位的 Micro
↓
再次 Coverage Check
↓
构造 PlanningArea + Resolution + Micro GeoCluster
↓
AI Macro Plan
  决定目的地顺序 / 停留天数
↓
AI Micro Plan
  把具体地点分配到 Day
↓
服务端确定性局部排序
↓
保存完整合法 Day
↓
Routing Provider 计算真实路线
↓
切换右侧到 ④ 行程
```

AI 不输出：

- 坐标；
- Provider Place ID；
- route geometry；
- 伪造距离；
- 伪造交通时间。

硬规则：

- Day 数量符合日期范围或 requestedDurationDays；
- Micro `must_go` 全部成为 Stop；
- Macro `must_go` 由其 Micro Stop 满足；
- `want_to_go` 未采用必须说明；
- `optional` 可自动取舍；
- `excluded` 不进入 Day；
- 有效参与规划的具体 Candidate 要么已排程，要么有未排程原因；
- Anchor 未知时允许为空，不伪造酒店。

---

## 10. PlanningArea 与 Micro GeoCluster

PlanningArea 仍然是运行时派生规划视图，不新增独立业务表。

优先依据：

```text
Macro TripCandidate
+
Micro TripCandidate.planningAreaCandidateId
↓
PlanningArea
```

`Place.city / region / country` 仅作为：

- 地图搜索；
- UI 显示；
- 去重辅助；
- 历史 / 异常数据 fallback。

Micro GeoCluster：

```text
京都
├─ 东山
│  ├─ 清水寺
│  ├─ 八坂神社
│  └─ 祇园
├─ 伏见
│  └─ 伏见稻荷
└─ 岚山
   ├─ 竹林
   └─ 天龙寺
```

AI 决定哪些地点适合同一天；服务端使用真实坐标做局部地理辅助。

AI 返回 Day 后、保存前，服务端只对同一天、同 PlanningArea、连续且已定位的 attraction / waypoint 块做初始近邻排序。

不跨餐饮、住宿、机场、车站等语义节点乱排。

P1 可升级 Route Matrix / TSP heuristic。

---

## 11. Day Anchor

每天独立拥有：

```text
startAnchor
endAnchor
```

普通城市旅行不强制：

```text
Day N endAnchor = Day N+1 startAnchor
```

Road Trip 按实际需要衔接。

酒店未知时 Anchor 可以为空，不伪造酒店。

Macro 节点原则上不作为真实 Anchor；优先使用实际住宿、机场、车站、港口或明确 waypoint。

---

## 12. 地图是输出视图，不是第二套工作台

### 12.1 右侧 → 地图

用户在右侧选择：

- Macro；
- Micro Candidate；
- Day；
- Stop；

地图自动定位 / 高亮 / fit bounds。

### 12.2 地图 → 右侧

用户点击 Marker：

- 只改变 selection；
- 右侧滚动到对应对象；
- 不产生 canonical mutation；
- 不显示业务操作按钮。

### 12.3 特殊输入模式

只有用户先从右侧明确进入：

```text
[地图点选定位]
```

地图才临时接受地点坐标输入。

完成或取消后立即退出该模式。

不允许用户随便点击地图就创建地点。

---

## 13. 路线更新机制

首次 Plan 保存成功后自动计算真实路线。

后续修改：

```text
结构化计划变化
↓
route fingerprint 不匹配
↓
routeDirty = true
↓
地图旧路线弱化
↓
右侧 ④ 行程 显示“路线需要更新”
```

更新入口只有 `④ 行程`。

允许：

- 更新当前 Day；
- 更新全部 dirty Day。

不允许地图上再出现刷新路线按钮。

拖拽 Stop 不立即请求 Route API。

当前默认 Provider 能力：

- `walk / drive / bike`：Provider 路线；
- `transit / rail / ferry / flight`：没有真实 Provider 时明确 attention / unsupported，不伪造。

---

## 14. AI 调整与 Proposal

AI 入口只有右侧底部 Composer。

默认 Scope 自动取自当前步骤 / 当前选中对象：

- `① 需求`：Trip requirement；
- `② 目的地`：Macro / Candidate Pool；
- `③ 兴趣点`：Macro-specific Micro / Candidate；
- `④ 行程`：Day；必要时提升 Trip。

AI 不能直接静默覆盖 canonical plan。

```text
用户在右侧输入调整要求
↓
AI 返回受限 Proposal / Candidate Change
↓
服务端校验 generation / Scope
↓
右侧展示 Diff / 原因 / 影响范围
↓
Apply / Reject
↓
Apply 写 Revision
↓
需要时 Undo
```

坐标不属于普通 AI mutation。

重新生成 Candidate 时：

- merge / dedupe；
- 不静默重置用户 preference；
- 不静默删除用户手动地点；
- 不静默删除 `must_go`；
- 展示新增 / 保留 / 可能移除内容。

---

## 15. 用户确定性操作

以下操作不调用 AI：

- preference 修改；
- 同日拖拽；
- 跨日拖拽；
- 删除 Stop；
- 从已有 Micro Candidate 添加 Stop；
- 重复到访；
- Day 重排；
- Anchor 修改；
- route refresh；
- Provider Candidate 选择；
- 手工坐标；
- Revision Undo（满足条件时）。

canonical 写入使用固定 `PlanCommand` + `expectedGeneration` CAS。

不使用开放式 JSON Patch。

---

## 16. 数据模型边界

> **Place 不等于 Candidate，不等于 DayStop；Macro → Micro 是 TripCandidate 层关系；PlanningArea 是派生视图。**

### Place

真实世界地点语义身份。

不保存 AI 生成坐标。

### TripCandidate

保存：

- placeId；
- preference；
- source；
- aiReason；
- aiScore；
- suggestedDurationMinutes；
- tags；
- `planningAreaCandidateId`。

Macro Candidate：

```text
planningAreaCandidateId = null
```

Micro Candidate：

```text
planningAreaCandidateId = <Macro Candidate ID>
```

### PlanningArea

运行时从 Macro → Micro 关系派生。

不建立独立 canonical 业务实体。

### DayStop

一次具体到访。

Macro Candidate 不能作为普通 DayStop。

### PlaceResolution

Provider / 用户输入的：

- 坐标；
- 地址；
- providerPlaceId；
- confidence；
- status；
- fingerprint。

是派生数据。

### DayRoute

保存某个输入 fingerprint 对应的：

- geometry；
- distance；
- duration；
- legs；
- warnings。

`routeDirty` 由 fingerprint 比较派生，不持久化布尔真相。

---

## 17. 产品 Stage 与 UI 步骤

顶层 canonical stage 继续只保留：

```text
place_selection
itinerary_planning
itinerary_refinement
```

不要为了 UI 导航增加 4 或 7 个业务 stage。

映射：

```text
① 需求
② 目的地
③ 兴趣点
    → place_selection

④ 行程
    → itinerary_planning

④ 行程中的细化状态
    → itinerary_refinement
```

用户从行程返回 ②/③ 修改，不需要机械回退顶层 stage。

系统根据 generation、coverage、candidate relations、Day 和 route fingerprint 判断哪些下游结果已经失效或需要刷新。

---

## 18. P0 Definition of Done

### UX

- 页面只有左地图 + 右唯一控制台；
- 所有业务操作从右侧发起；
- 顶部只有一套 `需求 → 目的地 → 兴趣点 → 行程` 步骤导航；
- AI Composer 位于右侧；
- 每个步骤底部最多一个主 CTA；
- 同一业务功能不存在第二套按钮 / Popup / 浮动入口；
- 地图 Marker 点击只做 selection，不改变计划；
- 地图点选必须由右侧明确进入模式。

### Trip / Macro / Micro

- 自然语言需求；
- AI Macro 推荐；
- Macro 四级 preference；
- AI 按有效 Macro 展开 Micro；
- Micro 四级 preference；
- Macro / Micro 均可 scoped 再生成；
- Micro 显式 `planningAreaCandidateId`；
- 用户手动新增。

### Coverage / Resolution

- 自动定位；
- Micro discovery 后 Coverage Check；
- 缺少 Micro 的 must-go Macro 自动补充；
- unresolved 有右侧修复路径；
- 生成前再次 Coverage Check。

### Planning / Route

- Macro 顺序 / 停留规划；
- Micro 分日；
- must-go 硬约束；
- want-to-go 未采用有原因；
- Micro GeoCluster；
- 确定性初始局部排序；
- 首次生成后真实路线；
- routeDirty；
- 更新入口只在右侧行程步骤。

### Editing / AI

- Day / Stop / Anchor 确定性编辑；
- AI 只有右侧 Composer；
- Preview / Apply / Reject / Undo；
- generation CAS；
- Revision。

---

## 19. P1

- Google Maps 链接解析；
- Provider Route Matrix；
- 基于真实路网 TSP / insertion heuristic；
- 更正式的地理聚类；
- 时间轴；
- 营业时间聚合；
- 太赶 / 太松检测；
- 酒店自动识别 Anchor；
- AI 自动替换地点；
- 地点详情；
- 自动路线更新设置；
- 真实公共交通 Provider。

---

## 20. P2

暂不进入 MVP：

- 实时天气自动改行程；
- 门票库存和购买；
- 酒店 / 航班价格；
- 餐厅预订；
- 多人协作；
- 自动记账；
- 实时公共交通状态；
- 完整移动端旅行助手。

---

## 21. 明确禁止的设计

### 交互

- 不在地图提供业务操作；
- 不在 Header 再放一套生成 / AI / 路线入口；
- 不使用横跨全页的第二个 AI Composer；
- 不同时保留步骤导航和 `[地点] [行程]` 两套主导航；
- 不让同一个功能出现在多个位置；
- 不让用户猜“下一步要点哪里”；
- 不让地图 Popup 变成第二个地点编辑器；
- 不通过隐藏右键菜单承担核心功能。

### 规划

- 不让 AI 生成坐标；
- 不让 AI 冒充 Route Provider；
- 不把 Macro 中心自动当路线 Stop；
- 不依赖 `Place.city / region` 作为 Macro → Micro 唯一归属；
- 不把 Macro 与几十个 Micro 完全平铺；
- 不把 `want_to_go` 当 `must_go`；
- 不等到生成路线才第一次发现 Macro 没有具体地点；
- 不要求用户逐项确认所有 Candidate 才能继续；
- 不因一个软约束地点无法采用而丢弃整份计划。

### 架构

- 不把 Candidate / Place / DayStop 混成一个实体；
- 不使用开放式 JSON Patch；
- 不把旧数据库迁移 / 兼容 / 双写重新加入 V3；
- 不为了 UI 流程新增一堆持久化 stage。

---

## 22. 最终用户流程

```text
进入旅行
↓
右侧自动打开 ① 需求
  输入“新西兰 20 天自驾……”
  [生成目的地建议]
↓
右侧自动进入 ② 目的地
  看奥克兰 / 惠灵顿 / 皇后镇……
  修改 必去 / 想去 / 可选 / 不去
  [生成详细兴趣点]
↓
右侧自动进入 ③ 兴趣点
  按目的地展开景点
  系统后台定位 + Coverage Check
  有缺口直接在对应区域提示并自动补充
  用户按需调整兴趣点
  [生成行程与路线]
↓
右侧自动进入 ④ 行程
  Day 1 / Day 2 / ...
  地图同步显示路线
  用户在右侧拖拽、增删、AI 调整
↓
需要改目的地？
  点击右侧顶部 ② 目的地
↓
需要补景点？
  点击右侧顶部 ③ 兴趣点
↓
再回 ④ 行程
```

用户从头到尾只需要理解一件事：

> **所有事情都在右边做，左边地图只负责告诉我结果在哪里。**

---

## 23. Hero Interaction

```text
用户新建旅行
↓
右侧显示 ① 需求
“新西兰 20 天自驾，南北岛都去，不想每天开太久”
↓
点击右侧唯一主按钮“生成目的地建议”
↓
右侧切换 ② 目的地
AI 推荐奥克兰、陶波、惠灵顿、基督城、特卡波湖、皇后镇等
地图只同步显示这些区域
↓
用户只在右侧修改 preference
↓
点击“生成详细兴趣点”
↓
右侧切换 ③ 兴趣点
每个目的地展开具体景点
系统自动定位和 Coverage Check
↓
弗朗茨·约瑟夫冰川地区缺具体地点
右侧该区域直接显示“正在补充推荐”
仍失败则在同一位置显示修复按钮
地图不弹错误操作菜单
↓
Coverage ready
点击“生成行程与路线”
↓
右侧切换 ④ 行程
地图同步画真实路线
↓
Day 12 太绕
用户在右侧 Day 12 拖拽，或在右侧 AI Composer 输入：
“冰川步道必须保留，重新安排这一天”
↓
右侧展示 Proposal
Apply 后相关路线 dirty
↓
右侧显示“更新路线”
地图刷新结果
```

---

## 24. 一句话产品定义

> **一个左侧地图只展示结果、右侧控制台承担全部业务交互的旅行规划工作台：用户按“需求 → 目的地 → 兴趣点 → 行程”四步完成规划，AI 负责 Macro / Micro 语义规划，地图服务负责真实地点与路线，并且任何修改都从同一个右侧工作区进入。**