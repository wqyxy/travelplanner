# AI 旅行计划网页版产品方案

> 状态：**当前产品与代码演进的总体需求依据**  
> 更新日期：2026-09-02  
> 本次更新：同步已确认的五步规划流程；**仅更新文档，尚未实施对应代码**  
> 详细施工图：[`TravelPlanner 五步规划流程重构实施方案.md`](./TravelPlanner%20五步规划流程重构实施方案.md)  
> UI 规则：[`五步 UI 交互规范.md`](./五步%20UI%20交互规范.md)

---

# 1. 产品定位

TravelPlanner 是一个以 **地图 / 时间轴展示 + 右侧唯一控制台** 为核心的 AI 旅行规划工作台。

它不是“一次性生成一篇旅行攻略”的聊天机器人。

用户操作的是结构化旅行计划；AI 负责：

```text
理解需求
研究和推荐地点
做宏观时间分配
在固定骨架内安排具体地点
解释依赖与影响
生成受控 Proposal / Action
```

地图 Provider 负责：

```text
坐标
Provider Place ID
路线 geometry
Provider 距离 / 时长
```

服务端是唯一调度者和 canonical 数据写入边界。

---

# 2. 当前用户流程：五步

用户看到：

```text
1 旅行需求
2 去哪些地方
3 安排路线和天数
4 补充景点
5 每日行程
```

用户心智：

```text
我要怎么玩
→ 去哪些地方
→ 这些天怎么分
→ 还有什么值得去
→ 每天具体怎么玩
```

内部 WorkflowStep：

```text
requirements
backbone
skeleton
interests
detail
```

数据库仍只保留四个 ConversationStage：

```text
requirements
destinations
interests
itinerary
```

映射：

```text
requirements → requirements
backbone     → destinations
skeleton     → destinations
interests    → interests
detail       → itinerary
```

因此：

- Step 2 + Step 3 共用 Macro Planning 对话空间；
- Step 5 itinerary ConversationStage 只负责 Detailed Planning；
- 不增加第五种数据库 ConversationStage。

---

# 3. 最高优先级 UX：右侧唯一控制台

页面只保留两个主要职责区：

```text
┌──────────────────────────────┬───────────────────────────┐
│                              │ 五步导航                  │
│       地图 / 时间轴          │───────────────────────────│
│       展示 + 选择            │ 当前步骤工作区            │
│                              │ AI / Action / 状态        │
│                              │ [唯一主 CTA]             │
└──────────────────────────────┴───────────────────────────┘
```

明确：

- **不新增独立左侧步骤导航；**
- 五步导航固定在右侧控制台顶部；
- 地图、时间轴、路线只负责展示、聚焦、选择；
- Marker / Route Popup 不能形成第二套编辑器；
- 所有业务修改、AI 生成、定位修复、流程推进都从右侧发起。

---

# 4. 同一个业务动作只有一个入口

这是 P0 产品规则。

动作归属：

```text
Step 1 → 修改旅行需求
Step 2 → 生成 / 管理 Planning Area 与 Core Visit
Step 3 → 生成 / 更新 Skeleton，修改顺序 / 天数 / 跨区交通
Step 4 → 生成 / 管理 Detail Interest
Step 5 → 生成 / 更新 Detailed Itinerary
```

跨步骤 CTA 只负责导航。

禁止：

```text
Step 2 直接调用 itinerary.generate
Step 4 直接调用 itinerary.detail.generate
Step 5 直接从当前页执行 Step 3 replan
```

正确方式：

```text
发现上游需更新
→ [前往对应步骤]
→ 在归属步骤执行唯一 Generate / Update
```

---

# 5. Candidate-first 与三个独立语义

## Place.kind

回答现实实体类型：

```text
city
attraction
lodging
meal
airport
station
port
stop
waypoint
```

## planningRole

回答规划层级：

```text
planning_area
core_visit
detail_interest
```

## preference

回答用户重视程度：

```text
must_go
want_to_go
optional
excluded
```

三者不能隐藏耦合。

---

# 6. Planning Area

Planning Area 表达：

> 用户在哪里住宿、停留或组织宏观路线。

当前 canonical 规则：

```text
planningRole = planning_area
Place.kind = city
planningAreaCandidateId = null
```

注意：旧产品文档中“Macro 可以直接是国家公园、岛屿、景区”等定义在本次五步设计后不再作为 canonical 规划规则。

非城市但显著影响行程的重要地点由 Core Visit 表达。

---

# 7. Core Visit

Core Visit 表达：

> 不作为住宿基地，但会显著占用半天 / 全天、明显绕行、需要特殊交通或强时间窗口的重要地点。

例如：

```text
Milford Sound
Hobbiton
Tongariro Alpine Crossing
```

规则：

```text
planningRole = core_visit
Place.kind != city
planningAreaCandidateId = parent Planning Area
```

Core Visit：

- 影响 Step 3 时间分配；
- 在 Step 5 成为真实 Stop；
- 不成为 Macro Anchor；
- 知名度或“用户提到过”不能自动等于 Core Visit。

---

# 8. Detail Interest

普通景点、餐厅、观景点、短活动：

```text
planningRole = detail_interest
Place.kind != city
planningAreaCandidateId = parent Planning Area
```

原则上：

```text
不影响 Step 3 Skeleton
在 Step 4 作为候选发现 / 管理
在 Step 5 参与具体日程
```

---

# 9. Step 1：旅行需求

Step 1 解决：

> 我想进行什么样的旅行？

包括：

```text
日期 / 天数
起点
旅行人数
交通方式
pace
主题 / 偏好
明确限制
用户点名地点
```

需求修改后必须做 dependency analysis。

只有真正影响 Macro 的修改才让 Step 3 需更新。

Step 1 完成后只导航 Step 2；Step 2 自己负责生成推荐地点。

---

# 10. Step 2：去哪些地方

Step 2 解决：

> 这趟旅行围绕哪些停留城市 / 区域和重要游览地展开？

AI 可生成：

```text
Planning Area
Core Visit
```

禁止在此阶段批量生成普通 Detail Interest。

Step 2 是 Core Visit 结构管理的唯一主步骤：

```text
新增 / 删除
parent
角色升级 / 降级的最终确认
preference
```

Step 4 发现某普通地点值得升级为 Core 时，只导航 Step 2 完成确认。

---

# 11. Step 3：安排路线和天数

Step 3 解决：

```text
Stay Block 顺序
每个 Stay Block stayDays
跨区域语义交通方式
Macro Day Anchor
```

Core Visit 只作为时间需求输入。

第三步必须提供时间轴 / Day Range，而不是简单城市列表。

用户可在右侧确定性修改：

```text
Stay Block 顺序
stayDays
transferMode
```

---

# 12. Stay Block 与环线旅行

同一个 Planning Area 可以多次出现。

例如：

```text
Auckland
→ South Island
→ Auckland
```

两次 Auckland 是两个不同 Stay Block。

不能因为 Candidate 相同就合并。

每个 active Planning Area 至少被覆盖一次；若总天数不允许，AI 必须返回需要调整需求 / 地点，而不是静默漏掉。

---

# 13. stayDays / 移动日统一语义

> 移动到某个 Stay Block 的那一天，计入到达 Stay Block。

例如：

```text
A 2 天
B 3 天
```

展开：

```text
Day 1 A
Day 2 A
Day 3 A → B  // B 第 1 天
Day 4 B
Day 5 B
```

所有 Stay Block `stayDays` 总和必须严格等于旅行总天数。

---

# 14. Step 4：补充景点

只有 Step 3 Skeleton Ready 后，AI 才能做 capacity-aware Interest Discovery。

第一次进入 Step 4：

```text
不自动批量生成
```

用户点击唯一入口：

```text
根据当前行程补充兴趣点
```

AI 根据：

```text
stayDays
移动负担
Core Visit 占用
pace
已有 Detail Interest
```

自主返回 0–9 个普通兴趣点，允许 0，不凑数量。

Core Visit 在 Step 4 可见但作为只读容量背景。

---

# 15. Step 5：每日行程

Step 5 解决：

```text
哪一天去哪个 Core Visit
选择哪些普通兴趣点
每天几点开始 / 结束
Stop 顺序
Detail Route
```

Detailed Planner 不能改变：

```text
Stay Block 顺序
stayDays
Day Anchor
Day identity
```

如 Skeleton 不合理，只能要求回 Step 3。

---

# 16. Detailed Update 最小变更

局部更新时：

```text
只处理 affectedDayIds
当前已保存 Detailed Day 是 sticky baseline
尽量保留 Stop / 顺序 / 时间
尽量保留用户手工调整
```

不能因为新增一个普通地点或局部 Core 变化就默认重做整趟旅行。

全量重做只作为次级危险操作。

---

# 17. Macro Dependency 与增量更新

新增可选规划状态：

```ts
planningState?: {
  macroBasisVersion: 1;
  macroBasisFingerprint: string | null;
  macroDirty: boolean;
};
```

Macro Fingerprint 只包含真正影响宏观规划的输入。

普通 detail_interest、坐标微调、Provider ID、纯展示名等不应使 Skeleton 过期。

流程：

```text
Change
→ Impact Analyzer
→ macroDirty / affected scope
→ 用户在对应步骤主动更新
→ compare old/new
→ 只扩展真正受影响的 Day
```

---

# 18. 旧旅行兼容

旧 Candidate 没有 `planningRole`：

```text
city → planning_area
non-city → detail_interest
```

只在运行时解释，不自动回写。

旧旅行已有 Skeleton 但没有 Macro Fingerprint：

```text
不自动迁移
不自动 Replan
Step 3 显示“需要确认路线和天数”
用户主动更新后建立新基线
```

---

# 19. “需更新”不是整阶段报废

所有 `needs_update / needs_review / macroDirty` 必须告诉用户：

```text
为什么
影响哪里
哪里保持不变
下一步去哪处理
```

禁止笼统显示：

```text
行程已过期
请重新生成
```

例如：

```text
2 天需更新
其他 18 天保持不变
```

---

# 20. 地图与 Provider 边界

地图只负责展示 / 选择 / Provider 事实。

AI 不得生产可信：

```text
坐标
Provider Place ID
geometry
Provider distance
Provider duration
```

所有新 Candidate：

```text
先保存
再 best-effort resolve
```

定位失败：

```text
保留 Candidate
不补位
不整批回滚
```

未定位 Core Visit：

```text
可影响 Step 3 时间分配
但不能成为 Step 5 真实 Stop
```

---

# 21. Macro Route 与 Detail Route

```text
Macro Route
= Day.startAnchor → Day.endAnchor

Detail Route
= 真实 Stop Sequence
```

两种路线互不覆盖。

Provider 路线失败只影响对应 route status，不回滚已经保存的 AI 规划。

---

# 22. AI Dialogue / Action 架构

ConversationStage 仍是四个：

```text
requirements
destinations
interests
itinerary
```

Stage Dialogue：

```text
回答 / 澄清
判断是否需要 web
识别受控 Action
不直接绕过 Action Registry 修改 canonical plan
```

Action：

```text
deterministic executor
或
AI executor
```

精确删除、preference、明确字段编辑、Stay Block 手动修改等应优先走 deterministic code。

AI 生成修改类结果继续遵守 Proposal / Scope / generation / CAS 安全边界。

---

# 23. AI Composer 与步骤归属

AI Composer 固定在右侧控制台底部。

用户在错误步骤提出请求时：

```text
识别 intent
→ 导航到业务归属步骤
→ 保留 selection / intent
→ 在归属步骤执行 / 确认
```

不能因为自然语言入口存在，就形成第二套跨阶段 mutation 系统。

---

# 24. 删除与高影响操作

删除 Planning Area 等高影响动作必须先展示：

```text
下属 Core Visit
下属 Detail Interest
受影响 Stay Block / Day
must_go 风险
```

再确认。

自然语言删除同样不能静默 cascade。

---

# 25. 数据库策略

当前 staged v3 固定私人数据库路径：

```text
private_data/travel-v2.sqlite3
```

内部版本：

```text
PRAGMA user_version = 3
```

本五步重构设计明确不做：

```text
v3 → v4 migration
旧 loader
双写
private DB rewrite
自动迁移 planningRole
```

当前文档更新不读取、不修改真实私人数据库。

---

# 26. 当前文档与实施状态

2026-09-02 已确认：

```text
五步流程设计
Planning Area / Core Visit / Detail Interest 分层
Stay Block / 环线支持
Macro Fingerprint
局部 Detail 更新
右侧唯一入口
```

**但这些五步变更目前仅完成文档设计，尚未作为本次操作实施代码或运行测试。**

实际代码完成状态继续以 [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) 为准。

---

# 27. 当前文档优先级

涉及五步产品流程、规划角色、Macro / Detail 依赖与 UI 入口时：

```text
当前用户明确决定
→ TravelPlanner 五步规划流程重构实施方案.md
→ 五步 UI 交互规范.md
→ PRODUCT_PLAN.md
→ AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md（Action / Dialogue 非冲突部分）
→ AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md（非冲突部分）
→ IMPLEMENTATION_STATUS.md（只描述实施事实）
→ 历史文档
```

---

# 28. 最终产品原则

```text
Candidate-first
地图事实与 AI 语义分离
右侧唯一业务入口
每个 Action 只有一个归属步骤
上游决定结构，下游补充细节
局部修改只局部失效
旧数据不静默迁移
失败不破坏已确认数据
```

TravelPlanner 最终应该让用户感受到：

> **AI 知道这趟旅行是怎么逐层规划出来的，也知道我改了一个地方之后，到底只需要重新考虑哪里。**
