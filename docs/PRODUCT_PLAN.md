# AI 旅行计划网页版产品方案

> 状态：**当前产品与代码演进的总体需求依据**  
> 更新日期：2026-09-02  
> 当前五步设计已确认，**对应代码尚未实施**  
> 下一步正式施工图：[`TravelPlanner 五步规划流程重构实施方案.md`](./TravelPlanner%20五步规划流程重构实施方案.md)  
> UI 规范：[`五步 UI 交互规范.md`](./五步%20UI%20交互规范.md)

---

# 1. 产品定位

TravelPlanner 是一个以 **地图 / 时间轴展示 + 右侧唯一控制台** 为核心的结构化 AI 旅行规划工作台。

它不是“一次性生成攻略”的聊天机器人。

AI 负责：

```text
理解需求
研究和推荐地点
做宏观时间分配
在固定骨架内安排具体地点
解释影响与变化
```

地图 Provider 负责可信：

```text
坐标
Provider Place ID
路线 geometry
Provider 距离 / 时长
```

服务端是 canonical 数据、Scope、CAS 和 Action 执行边界。

---

# 2. 用户流程：五步

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

数据库 ConversationStage 仍保持：

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

需要用户返回某一步时，以 WorkflowStep 表达，不用 ConversationStage 猜具体页面。

---

# 3. 最高优先级 UX：右侧唯一控制台

页面只有两个主要职责区：

```text
地图 / 时间轴 / 路线
+
右侧控制台
```

五步导航、AI Composer、编辑、Action / Proposal、定位修复、生成 / 更新、流程推进都属于右侧控制台。

地图 / 时间轴只负责：

```text
展示
选择
聚焦
```

同一个业务动作只有一个 canonical UI 入口。

跨步骤 CTA 只导航：

```text
Step 2 不直接生成 Step 3
Step 4 不直接生成 Step 5
Step 5 不直接执行 Step 3 Replan
```

---

# 4. 三个独立语义

## Place.kind

回答现实实体是什么。

## planningRole

```text
planning_area
core_visit
detail_interest
```

回答地点在哪一层参与规划。

## preference

```text
must_go
want_to_go
optional
excluded
```

回答用户有多想去。

三者不能隐式耦合。

---

# 5. Planning Area

Planning Area 表达：

> 用户在哪里住宿、停留或组织宏观路线。

Canonical：

```text
planningRole = planning_area
Place.kind = city
planningAreaCandidateId = null
```

它可以在一趟环线旅行中形成多个不同 Stay Block。

例如：

```text
Auckland #1
...
Auckland #2
```

两次 Auckland 是同一个 Candidate 的两段不同停留，不得合并。

---

# 6. Core Visit

Core Visit 是：

> 不作为住宿基地，但会显著改变半天 / 全天时间预算的重要非城市地点或活动。

Canonical：

```text
planningRole = core_visit
Place.kind != city
planningAreaCandidateId = parent Planning Area
```

Core Visit：

```text
影响 Step 3 时间分配
Step 5 成为真实 Stop
绝不成为 Macro Anchor
```

知名度、用户点名本身都不自动等于 Core Visit。

---

# 7. Detail Interest

普通景点、餐厅、观景点、短活动：

```text
planningRole = detail_interest
Place.kind != city
planningAreaCandidateId = parent Planning Area
```

原则上不改变 Step 3 Skeleton，只在 Step 4 / Step 5 参与普通地点选择。

---

# 8. preference 真正影响是否采用

这是五步设计的重要产品语义。

## Planning Area

```text
must_go
→ Step 3 必须纳入路线

want_to_go
→ 优先纳入；确实放不下可以不纳入，但必须解释

optional
→ 可以不纳入，不能为了覆盖它强行挤压路线

excluded
→ 禁止纳入
```

因此 Step 2 是“旅行骨干候选”，Step 3 才决定最终采用哪些非必去区域。

未采用的 `want_to_go / optional` 需要在 Step 3 结果中可见，而不是静默消失。

## Core Visit

```text
must_go
→ 必须预留容量并最终安排

want_to_go
→ 优先考虑；失败要解释

optional
→ 不得仅为了它额外增加停留天数

excluded
→ 不参与规划
```

---

# 9. Step 1：旅行需求

解决：

> 我想进行什么旅行？

包括：

```text
日期 / 天数
出发地
人数
交通偏好
pace
主题 / 偏好
限制
用户明确点名地点
```

需求变化必须先做 dependency analysis；只有真正影响 Macro 的变化才使 Step 3 需更新。

完成后只导航 Step 2。

---

# 10. Step 2：去哪些地方

解决：

> 哪些停留区域和重要游览地构成这趟旅行的候选骨干？

AI 只生成：

```text
Planning Area
Core Visit
```

不批量生成普通 Detail Interest。

Step 2 是 Core Visit 唯一结构管理入口。

Step 4 若发现普通地点应升级为重要游览地，只导航 Step 2 完成影响确认。

---

# 11. Step 3：安排路线和天数

Step 3 决定：

```text
最终采用哪些 Planning Areas
Stay Block 顺序
每个 Stay Block stayDays
跨区域语义交通方式
未采用 Planning Areas 及原因
```

同一个 Planning Area 可形成多个 Stay Block。

Stay Block 是稳定业务对象；canonical Day 使用可选稳定 `stayBlockId` 标记其归属，但不新增第二套 MacroDay / StayBlock 数据表。

移动日统一计入到达 Stay Block：

```text
A 2 天
B 3 天

Day 1 A
Day 2 A
Day 3 A → B  // B 第 1 天
Day 4 B
Day 5 B
```

实际采用的 Stay Block `stayDays` 总和必须严格等于总旅行天数。

---

# 12. Step 3 手工编辑是草稿，不直接制造非法 canonical 状态

用户修改：

```text
顺序
stayDays
transferMode
```

先进入 Step 3 编辑草稿。

例如只做：

```text
Queenstown 4 → 3
```

如果总分配变成 19 / 20 天：

```text
还需要分配 1 天
[应用修改] disabled
```

再把 Te Anau 2 → 3，使总数恢复 20 天后，才能一次原子 Apply。

AI Composer 也不能在“皇后镇少一天”这种信息不足时偷偷决定多出的一天给谁。

---

# 13. Step 4：补充景点

只有 Step 3 Ready 后，AI 才按真实容量发现普通兴趣点。

第一次进入：

```text
不自动批量生成
```

用户主动点击：

```text
根据当前行程补充兴趣点
```

AI 根据：

```text
采用的 Stay Blocks
stayDays
移动负担
Core Visit 占用
pace
已有普通兴趣点
```

每个区域本轮可返回 0–9 个 Detail Interest，允许 0，不凑数。

未进入 Skeleton 的 optional Planning Area 默认不做 capacity-aware discovery。

---

# 14. Step 5：每日行程

解决：

```text
Core Visit 放在哪一天
采用哪些普通兴趣点
每天时间
Stop 顺序
Detail Route
```

Detailed Planner 不得改变：

```text
Stay Block 顺序
stayDays
Day Anchor
Day identity
```

发现 Macro 不合理时，明确返回 Step 3。

局部更新只处理 affectedDayIds，并把已保存 Day 作为 sticky baseline，尽量保留 Stop / 顺序 / 时间和用户手工调整。

---

# 15. Macro Dependency：dirty 是派生状态

Canonical 可保存：

```ts
planningState?: {
  macroBasisVersion: 1;
  macroBasisFingerprint: string | null;
};
```

不持久化第二个 `macroDirty` 布尔真相。

运行时：

```text
current fingerprint != basis fingerprint
→ macroDirty
```

旧 Skeleton 没有 fingerprint：

```text
不自动迁移
不自动 Replan
显示“需要确认路线和天数”
```

用户主动在 Step 3 Apply 后建立新基线。

---

# 16. 未定位完整规则

## Planning Area unresolved

```text
Step 3 可先做语义 Skeleton
Macro Route 显示待定位
Step 5 只要 Day 使用 unresolved Anchor，就阻塞该 Day 的真实 Detail
```

## Core Visit unresolved

```text
Step 3 可参与时间预算
must_go → 阻塞相关 Detail Generate
want / optional → 不成为 Stop，可解释未安排
```

## Detail Interest unresolved

```text
must_go → 阻塞相关 Detail Generate
want / optional → 跳过，不阻塞无关 Day
```

任何 unresolved 都不能使用猜测坐标伪装 resolved。

---

# 17. 增量更新

核心流程：

```text
Change
→ Impact Analysis
→ current Macro fingerprint
→ 用户在归属步骤主动更新
→ old/new Diff
→ affectedDayIds
→ 只更新真正受影响内容
```

普通 Detail Interest：

```text
新增 optional / want → Skeleton / 当前 Detail 不失效
新增 must_go → 只影响相关 Day
删除未使用 → 不影响现有 Day
删除已使用 → 只影响实际使用 Day
```

Core / Planning Area 变化先改变 Macro dependency；Replan 后再根据真实 Macro Diff 扩展 Detail 影响范围。

---

# 18. “需更新”不是整阶段报废

所有需要更新状态必须告诉用户：

```text
为什么
影响哪里
哪里保持不变
下一步去哪处理
```

例如：

```text
2 天需更新
其他 18 天保持不变
```

禁止笼统：

```text
行程已过期，请重新生成
```

---

# 19. Map / Provider 边界

所有新 Candidate：

```text
先保存
再 best-effort resolve
```

定位失败：

```text
保留 Candidate
不自动补位
不整批回滚
```

Macro Route：Anchor → Anchor。  
Detail Route：真实 Stop Sequence。  
两者互不覆盖。

---

# 20. AI Dialogue / Action

AI Dialogue：

```text
回答 / 澄清
判断是否需要 web
识别受控 Action
```

精确编辑优先 deterministic executor。

AI 修改继续遵守 Scope / Proposal / generation / CAS。

跨步骤需求返回：

```text
requiresWorkflowStep
```

而不是仅返回 ConversationStage。

---

# 21. Skeleton 大范围 Apply

长行程不能因为通用 Proposal 的 100 PlanCommand 上限而失败。

Skeleton Generate / Replan / Step 3 Draft Apply 使用专用服务端原子边界：

```text
validate
→ formalize stable stayBlockId
→ expand canonical Days
→ reuse Day IDs
→ diff
→ affectedDayIds
→ CAS atomic apply
```

Proposal 仍负责向用户展示变化，但 canonical 写入不要求机械拆成数百个通用 PlanCommand。

---

# 22. 数据与兼容

保持：

```text
PRAGMA user_version = 3
```

不做：

```text
v3 → v4 migration
双写
旧 loader
自动私人数据库 rewrite
```

新增 `planningRole?`、`planningState?`、`stayBlockId?` 均为 backward-compatible optional JSON 字段。

旧数据正常读取，不因普通加载自动写回。

---

# 23. 当前实施状态

当前已确认：

```text
五步产品设计
五步 UI 设计
最终施工合同
```

但对应五步代码仍未实施。

实际代码状态见 [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)。

下一步施工必须以：

```text
TravelPlanner 五步规划流程重构实施方案.md
```

为最高优先级实施依据。

---

# 24. 最终产品原则

```text
Candidate-first
地图事实与 AI 语义分离
preference 真正影响是否采用
Stay Block 有稳定身份
Macro dirty 由 fingerprint 派生
跨步骤返回定位到 WorkflowStep
Step 3 草稿后原子 Apply
右侧唯一业务入口
上游决定结构，下游补充细节
局部修改只局部失效
旧数据不静默迁移
失败不破坏已确认数据
```

TravelPlanner 最终应让用户感受到：

> AI 不但会规划旅行，还知道每个决定依赖什么，因此当我修改局部时，它只重新考虑真正受到影响的部分。