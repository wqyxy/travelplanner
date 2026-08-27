# AI 旅行计划网页版产品方案

> 状态：当前产品与代码实现的唯一需求依据  
> 更新日期：2026-08-27  
> 数据策略：V3 直接使用独立新数据库 `private_data/travel-v2.sqlite3`，不迁移、不兼容读取、不双写旧数据库。

## 1. 产品定位

打造一个以 **“地点发现 → preference 标注 → 一键生成行程与路线 → 局部调整”** 为核心流程的 AI 旅行规划网页版。

产品不是“生成旅行攻略的聊天机器人”，而是：

> **AI 驱动的可视化旅行规划工作台。**

用户真正操作的是结构化旅行计划；AI 负责理解需求、推荐地点、根据优先级和整体路线自动取舍并排程；地图服务负责地点解析、坐标、真实路线和交通时间。

## 2. 核心产品原则

### 2.1 preference 是规划约束，不是生成门槛

用户不需要先把所有地点人工筛选、全部定位完成后才能生成。

```text
旅行需求
  ↓
AI 推荐地点
  ↓
用户可选调整 preference
★ 必去 / ✓ 想去 / ○ 可选 / × 不去
  ↓
[✨ 生成行程与路线]
  ↓
系统自动解析仍未定位的参与规划地点
  ↓
AI 根据天数、位置、节奏和 preference 全局排程
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
Routing Service
   ↓
真实路线 / 距离 / 交通时间
```

### 2.3 AI 负责语义规划，系统负责确定性执行

| 操作 | 实现方式 |
|---|---|
| 推荐景点 | AI |
| 判断适合哪一天 | AI + 地理信息 |
| 根据 preference 取舍地点 | AI，受服务端硬规则约束 |
| 景点坐标 | 地图服务 |
| 两点交通时间 | Routing API |
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

1. `must_go`：硬约束，必须排入；不能被 AI 舍弃；
2. `want_to_go`：高优先级软约束，应尽量排入；如果加入会造成明显折返、严重超时、节奏冲突或明显降低整体路线质量，可以不排入，但必须明确说明原因；
3. `optional`：AI 根据地理位置、推荐度、时长、节奏和路线效率自动取舍；
4. `excluded`：不得进入行程，也不需要参与自动定位和排程。

**`want_to_go` 不等于 `must_go`。** “不能静默省略”表示必须解释，而不是禁止 AI 做合理取舍。

## 5. 地点定位与异常处理

### 5.1 自动解析

地点推荐后系统可以后台自动解析；用户点击“生成行程与路线”时，服务端还会对所有参与规划且尚未可靠定位的地点再自动尝试解析。

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

### 5.2 未定位地点

未定位不再统一阻塞生成：

- `must_go` 未定位：自动重试后仍失败则阻塞生成，因为无法保证硬约束地点进入真实线路；
- `want_to_go` 未定位：不阻塞整趟行程，可以继续规划；AI 必须看到该 Candidate，不得静默消失；
- `optional` 未定位：不阻塞整趟行程，由 AI 自动取舍；
- `excluded`：不需要参与生成前定位。

如果未定位的软约束地点仍被排入 Day，路线服务必须明确显示 `attention` / “路线端点尚未正确定位”，不得伪造路线。

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

## 7. 一键生成行程与路线

一次点击的服务端流程：

```text
读取所有非 excluded Candidate
↓
自动解析尚未可靠定位的地点
↓
检查 must_go 是否仍有未定位
↓
构造全部 Candidate + preference + Resolution + GeoClusters
↓
AI 全局排程并自动取舍软约束地点
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
All Non-excluded Candidates
+
Preference
+
Current Place Resolutions（允许部分为 null）
+
Geo Clusters
+
Suggested Duration
+
User Preferences
+
Travel Days
```

硬规则：

- Day 数量必须与完整日期范围或 `requestedDurationDays` 一致；
- `must_go` 全部排入；
- `want_to_go` 尽量排入，未排入必须给出具体原因；
- `optional` 可自动取舍，未排入必须给出原因；
- `excluded` 不得进入 Day；
- 每个非 `excluded` Candidate 必须“已排程”或“明确未排程并说明原因”，不得静默消失；
- Anchor 未知时允许为空，不伪造酒店；
- AI 不输出坐标、路线 geometry、Provider 距离或时间；
- 保存完整合法计划后才切换到 `itinerary_planning`；
- 首次 Plan 保存成功后自动计算每天路线。

## 8. 地理算法辅助排程

排程不完全依赖 LLM。服务端先根据当前有效坐标提供地理分组：

```text
坐标
↓
地理聚类 / 城市分组
↓
区域候选
↓
AI 结合语义、优先级、节奏和天数排程
```

没有 Resolution 的软约束 Candidate 仍然传给 AI，只是没有可信坐标，不允许系统伪造位置。

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

必须支持：

- 全部 / 必去 / 想去 / 可选 / 不去 / 未定位；
- 搜索；
- 单选、多选、全选当前筛选；
- 批量 preference；
- 单个和批量定位修复；
- 手动新增地点；
- 一键“生成行程与路线” CTA。

摘要文案使用“参与规划”，不再把非 `excluded` Candidate 描述成需要用户额外确认的“已选择地点”。

点击地点卡片，地图定位并高亮 Marker；点击 Marker，右侧滚动并选中对应地点。

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

## 13. 地图与右侧双向联动

### 行程 → 地图

点击 Day 后：

- 自动缩放到当天区域；
- 只突出当天节点；
- 显示当天当前路线；
- dirty 旧路线弱化并标注“旧路线，仅供参考”。

### 地点 / Stop → 地图

点击地点或 Stop 后，Marker 高亮并定位。

### 地图 → 列表

- Candidate Marker 点击后定位到 Candidate 卡片；
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

## 15. 路线更新机制

首次完整 Plan 生成后自动计算一次路线。

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

> **Place 不等于 Candidate，也不等于 DayStop。**

### Place

真实世界地点的语义身份，不保存 AI 坐标。

### TripCandidate

这趟旅行与地点之间的候选关系，保存 preference、AI 理由、推荐度和建议时长。

### DayStop

一次具体到访。移动 Stop 只修改目标 Day 和数组顺序，Place 本身不变。

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

- AI 推荐地点；
- 用户手动新增；
- 理由、推荐度、时长、标签；
- 四级 preference。

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
- 使用全部非 `excluded` Candidate；
- `must_go` 硬约束；
- `want_to_go` 高优先级软约束；
- `optional` 自动取舍；
- 地理分组辅助；
- Day Anchor；
- 基础顺序；
- 软约束地点未排入时明确说明原因。

### Map

- Candidate Marker；
- Day 节点与路线；
- Candidate / Stop 双向联动；
- dirty 旧路线弱化；
- 未定位路线端点明确 attention。

### Editing

- 同日 / 跨日拖拽；
- 添加 / 删除；
- 重复到访；
- Anchor 和 Day 编辑。

### Route

- 首次 Plan 后自动计算；
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
  AI 推荐具体地点
↓
Prioritize（可选）
  用户按需调整 必去 / 想去 / 可选 / 不去
↓
Generate
  一键触发自动定位 + AI 全局排程
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

> **告诉系统哪些地方必须去、想去、可选或不去，然后一键得到一趟整体路线更合理的旅行。**

## 26. Hero Interaction

```text
用户查看 AI 推荐的地点池
↓
把“清水寺”标成必去，把几个地点标成想去
↓
直接点击“生成行程与路线”
↓
系统自动补充地点解析
↓
AI 根据 preference、天数和地理位置自动取舍并排程
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

> **一个以地图和结构化行程为核心，让用户用四级 preference 表达意愿，再由 AI 一键完成全局排程和路线生成、并支持后续精细调整的旅行规划工作台。**
