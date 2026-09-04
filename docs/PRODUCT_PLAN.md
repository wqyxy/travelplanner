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

# 2. 产品复杂度原则：内部严谨，用户简单

五步架构内部允许复杂，但这些复杂度原则上不直接暴露给普通用户。

用户不需要理解：

```text
PlanningRole
Backbone
Skeleton
Macro / Detail
stayBlockId
macroBasisFingerprint
macroDirty
affectedDayIds
requiresWorkflowStep
ConversationStage
CAS
Resolution
```

用户只需要理解：

```text
我想怎么玩
→ 我想去哪些地方
→ 这些天怎么排
→ 要不要再补点景点
→ 每天具体怎么玩
```

最高原则：

> **系统内部可以复杂，但任何工程状态都必须翻译成用户能直接行动的语言。**

---

# 3. 用户流程：五步

统一用户文案：

```text
1 旅行需求
2 想去哪些地方
3 路线和天数
4 补充景点（可选）
5 每日行程
```

其中：

```text
Step 2 = 愿望清单 / 候选
Step 3 = 真正排得下的最终路线
```

Step 2 页面必须明确告诉用户：

> 先选出想考虑的地方，下一步会根据总天数安排最终路线。

这样 Step 3 没有采用某个普通候选时，用户不会感觉系统擅自删除地点。

内部 WorkflowStep 继续保持：

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

需要返回某一步时，以 WorkflowStep 表达；但用户只看到对应中文步骤，不看到内部枚举。

---

# 4. 最高优先级 UX：右侧唯一控制台

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

但“唯一入口”是系统规则，不应成为用户负担。

如果用户在错误步骤发起请求：

```text
系统识别意图
→ 自动切换到归属步骤
→ 保留 selection / intent
→ 展示可执行结果或确认卡
```

用户不应该频繁看到：

```text
请前往第二步
请前往第三步
请前往第四步
```

跨步骤不得静默执行高影响 mutation，但可以自动完成上下文切换。

---

# 5. 三个独立语义

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

这些概念主要属于数据 / Prompt / 服务端；UI 应使用自然语言。

---

# 6. Planning Area

Planning Area 表达：

> 用户在哪里住宿、停留或组织宏观路线。

Canonical：

```text
planningRole = planning_area
Place.kind = city
planningAreaCandidateId = null
```

同一个 Planning Area 在环线旅行中可以形成多个 Stay Block：

```text
Auckland #1
...
Auckland #2
```

用户只看到两段独立的“奥克兰停留”，不看到内部 `stayBlockId`。

---

# 7. Core Visit

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

## 用户界面不要做“角色管理器”

普通用户不应该看到：

```text
planningRole
Detail → Core
Core → Detail
修改 parent role
```

用户看到的是：

```text
Milford Sound
重要游览地 · 必去
预计占用全天
```

用户可以自然表达：

```text
这个地方很重要，要单独留一天
这个地方不用专门安排这么多时间
```

系统内部再转换 planningRole / parent，并在必要时展示影响确认。

高级角色调整可以放在“更多”里，不作为主操作。

---

# 8. Detail Interest

普通景点、餐厅、观景点、短活动：

```text
planningRole = detail_interest
Place.kind != city
planningAreaCandidateId = parent Planning Area
```

原则上不改变 Step 3 Skeleton，只在 Step 4 / Step 5 参与普通地点选择。

---

# 9. preference：数据层四级，用户层尽量两级

数据模型继续保留：

```text
must_go
want_to_go
optional
excluded
```

但主 UI 不需要让用户反复操作四级选择器。

用户主要操作：

```text
⭐ 必去
♡ 想去
```

其余语义：

```text
optional
→ AI 新推荐的默认状态；通常不显示醒目 Badge
→ 用户“取消想去”可回到 optional

excluded
→ 用户通过“移除 / 不考虑”表达
```

这样保留完整数据语义，但不让用户管理一个四状态系统。

## Planning Area 的实际采用规则

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

# 10. Step 1：旅行需求

用户任务：

> 告诉系统我想进行什么旅行。

包括：

```text
日期 / 天数
出发地
人数
交通偏好
节奏
主题 / 偏好
限制
明确想去的地方
```

需求变化必须先做 dependency analysis；只有真正影响宏观路线的变化才使 Step 3 需更新。

完成后只进入 Step 2。

---

# 11. Step 2：想去哪些地方

用户任务：

> 先选出这趟旅行想考虑的停留区域和重要游览地。

Step 2 是候选愿望清单，不保证所有候选最终都会进入路线。

页面顶部应有一句稳定说明：

> 先选出想考虑的地方，下一步会根据总天数安排最终路线。

AI 只生成：

```text
Planning Area
Core Visit
```

不批量生成普通 Detail Interest。

Step 2 是 Core Visit 的唯一结构归属步骤，但角色细节尽量通过自然语言和少量高级操作表达。

---

# 12. Step 3：路线和天数

Step 3 决定：

```text
最终采用哪些 Planning Areas
Stay Block 顺序
每个 Stay Block stayDays
跨区域语义交通方式
没有采用的高优先级候选及原因
```

同一个 Planning Area 可形成多个 Stay Block。

Stay Block 是稳定业务对象；canonical Day 使用可选稳定 `stayBlockId` 标记归属，但 UI 不显示该 ID。

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

AI 自动生成和重新规划仍以总旅行天数为目标。手工调整时，实际采用的 Stay Block `stayDays` 总和少于总旅行天数不能保存；等于总天数时为完整安排；多于总天数时允许先保存并继续，但必须明确提示超出的天数，不能静默截断或伪造日期。

## 未采用候选的展示要克制

`want_to_go` 未采用必须解释，但不需要把所有 optional 候选铺满页面。

默认可以显示：

```text
还有 2 个“想去”的地方没有排进路线
[查看原因]
```

optional 未采用候选收在可折叠的“其他未采用候选”中。

---

# 13. Step 3 手工编辑：内部是 Draft，用户只看到时间分配状态

用户可以调整：

```text
顺序
stayDays
transferMode
```

内部先进入 Skeleton Edit Draft，不直接污染 canonical。

但 UI 不出现：

```text
Skeleton Draft
Atomic Apply
Canonical
```

用户只看到自然状态：

```text
皇后镇 4 → 3 天

总旅行：20 天
当前分配：19 天
还剩 1 天需要安排
```

并给直接建议：

```text
[+1 蒂阿瑙]
[+1 瓦纳卡]
[让我帮你安排]
```

少于总天数时：

```text
[保存调整] disabled
```

分配刚好完整时可正常保存。超过总天数时显示警告但允许保存并继续：

```text
总旅行：20 天
当前分配：21 天
当前安排多 1 天；可以继续，之后再调整。

[保存调整]
[下一步：补充景点（可选）]
```

保存保留完整的 21 天安排；系统不自行删减某一段。用户可继续手动调整，或让 AI 在用户确认的意图下重新分配。

## 路线卡的地图联动与排序

Step 3 默认显示全程路线和地点标记。路线卡交互为：

```text
悬停卡片 → 保持全路线，仅高亮对应日段与标记
点击卡片 → 保存当前视角，聚焦对应日段，只显示该路线
再次点击同一卡片 → 恢复全路线和聚焦前视角
```

地点卡之间使用轻量交通连接段，而非重复起终点名称的额外卡片。连接段展示方向/交通图标、交通方式、地图距离、预计时长与“重新生成”入口；距离与时长只能来自已经返回的路线 Provider。待定位、待计算、失效及未保存草稿都展示真实状态，不用旧路线数据伪装成新安排。航班和轮渡在地图上使用两端已定位坐标的虚线直线表达，不冒充陆路 Provider geometry。已填写且不同于首站的出发地，只在首段显示一次。

路线卡顺序通过拖动手柄调整；卡片随指针移动，跨越其他卡片中线时即时重排，连接段随相邻地点关系重组。排序只改变当前编辑草稿，点击“保存这个调整”后才写入 canonical 行程并自动更新受影响路线。地图仍不承担业务编辑。

如果用户说“皇后镇少一天”，系统不知道这一天去哪时不能偷偷决定；但可以主动给 2–3 个建议，或者在用户明确说“你合理分配”时由 AI 完整处理。

---

# 14. Step 4：补充景点（可选）

Step 4 是明确的**可选增强步骤**。

它解决：

> 路线和天数已经确定，还要不要再找一些值得去的普通景点？

只有 Step 3 Ready 后，AI 才按真实容量发现普通兴趣点。

第一次进入：

```text
不自动批量生成
```

用户可以：

```text
[帮我补充景点]
```

也可以直接：

```text
[下一步：每日行程]
```

因此用户已有足够地点时，不必为了流程完整性强制跑一次 Discovery。

AI Discovery 根据：

```text
采用的 Stay Blocks
stayDays
移动负担
Core Visit 占用
pace
已有普通兴趣点
```

每个区域本轮 0–9 个，允许 0，不凑数。

未进入 Skeleton 的 optional Planning Area 默认不做 capacity-aware discovery。

---

# 15. Step 5：每日行程

Step 5 解决：

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

发现宏观安排不合理时，系统自动切换到 Step 3 对应上下文，并展示需要处理的内容；不得在 Step 5 静默修改宏观结构。

局部更新只处理 affectedDayIds，并把已保存 Day 作为 sticky baseline，尽量保留 Stop / 顺序 / 时间和用户手工调整。

---

# 16. Macro Dependency：复杂度留在系统内部

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

这些术语不直接展示给用户。

用户只看到：

```text
蒂阿瑙的路线和天数需要重新确认
预计影响 2 天，其他 18 天不变
```

旧 Skeleton 没有 fingerprint：

```text
不自动迁移
不自动 Replan
显示“需要确认路线和天数”
```

---

# 17. 未定位规则：只在用户需要行动时强调

## Planning Area unresolved

```text
Step 3 可先做语义路线和天数
真实路线显示“待定位”
Step 5 若 Day 使用 unresolved Anchor，则阻塞该 Day 的真实路线
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

UI 原则：

```text
普通非阻塞未定位 → 轻量状态
真正阻塞下一步 → 明确行动卡
```

不把 Resolution 状态机直接暴露给用户。

---

# 18. 增量更新

核心流程：

```text
Change
→ Impact Analysis
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

# 19. Update Card：信息完整，但渐进披露

系统内部仍必须知道：

```text
为什么需要更新
影响哪里
哪里保持不变
下一步做什么
```

但默认 UI 不要每次展开完整解释。

默认紧凑卡：

```text
⚠ 蒂阿瑙的安排需要更新
预计影响 2 天，其他 18 天不变

[去更新] [查看原因]
```

用户点“查看原因”后再展开：

```text
Milford Sound 被设为重要游览地，原来的 2 天没有考虑这个全天活动……
```

原则：

> **信息不能丢，但解释按需展开。**

禁止笼统：

```text
行程已过期，请重新生成
```

---

# 20. Map / Provider 边界

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

地图只负责展示 / 选择 / Provider 事实，不成为第二套编辑器。

---

# 21. AI Dialogue / Action

AI Dialogue：

```text
回答 / 澄清
判断是否需要 web
识别受控 Action
```

精确编辑优先 deterministic executor。

AI 修改继续遵守 Scope / Proposal / generation / CAS。

跨步骤内部使用 `requiresWorkflowStep`，但用户体验是自动切换到对应步骤和上下文，不展示工程枚举。

高影响 mutation 仍需要确认。

---

# 22. Skeleton 大范围 Apply

长行程不能因为通用 Proposal 的 100 PlanCommand 上限而失败。

Skeleton Generate / Replan / Step 3 Draft Save 使用专用服务端原子边界：

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

用户只看到“保存调整 / 更新路线和天数”。

---

# 23. 数据与兼容

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

# 24. 当前实施状态

当前已确认：

```text
五步产品设计
五步 UI 设计
复杂度下沉原则
最终施工合同
```

对应五步代码仍未实施。

实际代码状态见 [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)。

下一步施工以：

```text
TravelPlanner 五步规划流程重构实施方案.md
```

为最高优先级实施依据。

---

# 25. 最终产品原则

```text
Candidate-first
地图事实与 AI 语义分离
内部复杂、用户简单
Step 2 是愿望清单，Step 3 才是最终路线
Step 4 明确可跳过
四级 preference 留在数据层，主 UI 主要使用“必去 / 想去”
Core Visit 保留，但不做工程化 Role 管理器
Stay Block 有稳定身份，但内部 ID 不暴露
Macro dirty 由 fingerprint 派生，但用户只看到自然语言影响提示
Step 3 草稿后原子保存，但用户只看到“还差几天”
Update Card 使用渐进披露
跨步骤自动切换上下文，不让用户被系统赶来赶去
右侧唯一业务入口
上游决定结构，下游补充细节
局部修改只局部失效
旧数据不静默迁移
失败不破坏已确认数据
```

TravelPlanner 最终应让用户感受到：

> **我只是在自然地规划一趟旅行；系统在背后理解依赖关系和复杂状态，但不会要求我学习这些工程概念。**
