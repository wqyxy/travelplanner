# TravelPlanner 五步 UI 交互规范

> 状态：**已确认的产品交互规范，尚未实施**  
> 更新日期：2026-09-02  
> 配套实施设计：[`TravelPlanner 五步规划流程重构实施方案.md`](./TravelPlanner%20五步规划流程重构实施方案.md)

---

# 1. 文档目的

本文档只定义用户交互，不定义底层数据库实现。

用户在任何时刻都应该清楚：

```text
我现在在哪一步？
这一页主要做什么？
哪里可以修改？
修改后会影响什么？
下一步应该去哪？
```

最高优先级原则：

> **地图 / 时间轴负责展示和选择，右侧控制台负责所有业务操作；同一个业务动作只有一个 canonical UI 入口；局部修改只让真正受影响的部分需更新。**

---

# 2. 用户可见五步

统一显示：

```text
1 旅行需求
2 去哪些地方
3 安排路线和天数
4 补充景点
5 每日行程
```

不要在主导航直接使用：

```text
Backbone
Skeleton
Macro
Detail
Planning Area
Core Visit
```

---

# 3. 页面只有两个主要职责区

不要新增独立左侧步骤栏。

```text
┌──────────────────────────────┬───────────────────────────┐
│                              │ 1需求 2去哪 3路线天数     │
│                              │ 4景点 5每日行程           │
│      地图 / 时间轴 / 路线    │───────────────────────────│
│      展示 + 选择             │ 当前步骤内容              │
│                              │ 当前对象详情              │
│                              │ AI 对话 / Action / 状态   │
│                              │ [唯一 Primary CTA]       │
└──────────────────────────────┴───────────────────────────┘
```

## 左侧 / 主画布

负责：

```text
地图
时间轴
路线
高亮
选择
聚焦
```

不负责：

```text
新增 / 删除
设置必去
角色调整
生成 / 更新 AI 结果
修复定位
推进步骤
```

## 右侧控制台

负责：

```text
五步导航
当前步骤内容
当前对象详情
新增 / 删除 / 修改
preference
角色 / parent 的唯一管理入口
Action Card / Proposal
AI Composer
状态 / Update Card
主 CTA
```

---

# 4. 唯一入口原则

禁止同一个功能同时出现在：

```text
地图 Popup
地图浮动按钮
右侧列表工具栏
右侧详情卡
页面 Header
AI Composer 旁独立按钮
另一套步骤栏
```

中的多个位置。

如果用户从非归属步骤发起某个意图：

```text
只导航到归属步骤
→ 在归属步骤展示上下文 / Impact Card
→ 用户在归属步骤执行唯一动作
```

**跨步骤按钮不直接执行目标步骤 Action。**

---

# 5. 业务动作归属表

| 业务动作 | 唯一归属步骤 |
|---|---|
| 修改旅行需求 | Step 1 |
| 生成 / 管理停留区域 | Step 2 |
| 生成 / 管理重要游览地 | Step 2 |
| 修改 Core Visit parent / role | Step 2 |
| 生成 / 更新路线和天数 | Step 3 |
| 修改 Stay Block 顺序 / 天数 / 交通 | Step 3 |
| AI 补充普通兴趣点 | Step 4 |
| 管理普通兴趣点 / preference | Step 4 |
| 生成 / 更新每日详细行程 | Step 5 |
| Stop / Day 细化 | Step 5 |
| 地图定位修复 | 对象归属步骤的右侧详情 |

---

# 6. 一个主要 selection

整个 App 只维护一个主要 `selection`。

可选：

```text
Planning Area
Core Visit
Detail Interest
Stay Block
Day
Stop
Route Segment
```

地图、列表、时间轴都只是更新同一 selection。

禁止不同组件各自维护“当前正在编辑谁”。

归属：

```text
Planning Area → Step 2
Core Visit → Step 2
Detail Interest → Step 4
Stay Block / Macro Day → Step 3
Day / Stop → Step 5
```

---

# 7. 右侧 Primary Button 规则

任意时刻最多一个 Primary Button。

优先级：

```text
1 阻塞修复
2 前往上游处理
3 当前步骤生成 / 更新
4 下一步导航
```

“下一步”只导航，不顺便生成下一步结果。

Secondary / Menu 可放：

```text
手动新增
筛选
重新查看影响
全量重做危险操作
```

但不能和 Primary 抢层级。

---

# 8. Step 1：旅行需求

用户任务：

> 告诉系统我想进行什么样的旅行。

右侧主要显示：

```text
日期 / 天数
出发地
旅行人数
交通方式
节奏
主题 / 偏好
明确限制
明确想去的地方
```

允许：

```text
自然语言修改
结构化字段修改
```

Step 1 不直接生成 Step 2 结果。

完成后 Primary：

```text
[下一步：去哪些地方]
```

进入 Step 2 后，由 Step 2 自己提供：

```text
[生成推荐地点]
```

如果 Step 1 修改导致 Macro Dependency 改变：

```text
Step 3 标记需更新
但不自动 Replan
```

---

# 9. Step 2：去哪些地方

用户任务：

> 确认这趟旅行围绕哪些停留城市 / 区域和重要游览地展开。

用户语言：

```text
停留城市 / 区域
重要游览地
```

说明：

```text
重要游览地
= 会占用较多时间、明显绕行，或需要单独安排半天 / 一天的地点
```

不要把“核心”和“必去”混成同一状态。

列表示例：

```text
蒂阿瑙
  Milford Sound        [重要] [必去]

皇后镇
  Routeburn Track      [重要] [想去]
```

## 首次没有 Backbone

Primary：

```text
[生成推荐地点]
```

## 已有 Backbone

Primary：

```text
[下一步：安排路线和天数]
```

它只切换 Step 3，不调用 itinerary.generate。

## Core Visit 唯一管理入口

Step 2 负责：

```text
新增重要游览地
删除重要游览地
修改所属停留区域
角色降级为普通兴趣点
确认普通兴趣点升级为重要游览地
```

Step 4 不再提供第二套 Core 编辑器。

---

# 10. Step 2 新增与角色升级

新增菜单：

```text
添加停留城市 / 区域
添加重要游览地
```

添加重要游览地时必须选择 parent。

如果用户在 Step 4 对普通兴趣点选择“设为重要游览地”：

```text
Step 4 只发起导航
→ Step 2 自动选中该地点
→ 右侧显示 Role Change Impact Card
→ 用户确认
→ 才真正修改 planningRole
```

Impact Card 至少解释：

```text
该地点将参与路线和停留天数判断
Step 3 将需要重新确认
当前区域的每日行程可能需要更新
其他无关区域保持不变
```

---

# 11. Step 2 地图

显示：

```text
停留城市 / 区域
重要游览地
```

不显示大量普通兴趣点。

Core Visit marker 可以不同样式，但不能被画成 Macro Route 中间站。

地图点击：

```text
selection 更新
→ 右侧显示对应对象
```

地图 Popup 不允许：

```text
删除
设置必去
设置重要
重新定位
生成路线
```

---

# 12. Step 3：安排路线和天数

用户任务：

> 决定去的顺序，以及每一段停留多少天。

这是五步中最重要的结构确认步骤。

## 没有 Skeleton

Primary：

```text
[生成路线和天数]
```

## Skeleton Dirty

Primary：

```text
[更新路线和天数]
```

## Skeleton Ready

Primary：

```text
[下一步：补充景点]
```

只切换 Step 4，不自动 interest.discover。

---

# 13. Step 3 主视觉：时间轴 / Stay Block

不能只显示普通地点列表。

推荐：

```text
Day 1–2
奥克兰 · 2 天

↓ 自驾

Day 3–4
罗托鲁瓦 · 2 天

↓ 自驾

Day 5
陶波 · 1 天
```

同一个城市可以出现多次：

```text
Day 1–2   奥克兰
...
Day 19–20 奥克兰
```

必须显示为两个独立 Stay Block，不因为 Candidate 相同而合并。

---

# 14. Step 3 手工编辑

选中 Stay Block 后，右侧允许确定性修改：

```text
停留天数
顺序
进入该段的交通方式
```

用户可以表达：

```text
皇后镇少一天
把蒂阿瑙放到皇后镇前面
这段改成飞机
```

AI Composer 可以识别意图，但实际修改仍通过 Step 3 的确定性 Action / Proposal 边界完成。

中间时间轴不直接拖拽 canonical 顺序，避免形成第二套编辑入口。

总 stayDays 不等于总旅行天数时不能保存非法 Skeleton。

---

# 15. Step 3 移动日说明

UI 对 stayDays 使用统一语义：

> **移动到某个区域的那一天，算作到达区域的第 1 天。**

例如：

```text
A 2 天
B 3 天
```

展示 / 计算：

```text
Day 1 A
Day 2 A
Day 3 A → B  // B 第 1 天
Day 4 B
Day 5 B
```

不要在不同页面出现另一种计数方式。

---

# 16. Step 3 更新完成必须展示 Diff

禁止只显示：

```text
更新完成
```

必须类似：

```text
蒂阿瑙：2 天 → 3 天
皇后镇：4 天 → 3 天
其他 15 天保持不变
```

如果 Replan 后 Macro 完全相同：

```text
路线和停留天数无需调整。
只需要更新蒂阿瑙的每日安排。
```

如果是旧旅行没有 fingerprint：

```text
需要确认路线和天数
```

不自动重算；用户主动在 Step 3 更新后才建立新基线。

---

# 17. Step 4：补充景点

用户任务：

> 在已经确定的时间容量里，为每个区域补充普通景点和活动。

第一次进入：

```text
只展示已有内容
不自动批量生成
```

Primary：

```text
[根据当前行程补充兴趣点]
```

只有用户点击后才启动 AI Discovery。

AI 允许某区域返回 0 个，不为了凑数量生成。

---

# 18. Step 4 分区结构

按 Planning Area / 当前容量展示：

```text
蒂阿瑙 · 2 天

重要游览地
★ Milford Sound

普通兴趣点
○ Glowworm Caves
○ Lake Te Anau
○ Bird Sanctuary
```

Core Visit 必须可见，因为用户需要理解：

> 为什么这个区域没有太多剩余容量？

但 Core Visit 在 Step 4 是**只读结构背景**。

点击 Core Visit 后：

```text
查看摘要
[前往“去哪些地方”管理]
```

---

# 19. Step 4 普通兴趣点操作

允许：

```text
新增
删除
替换
修改 preference
定位
发起“设为重要游览地”
```

“设为重要游览地”不是本页直接 mutation；它导航 Step 2 并在那里确认。

Step 4 默认新增永远是普通兴趣点。

---

# 20. Step 4 Skeleton Dirty

如果上游路线 / 天数 Dirty：

允许：

```text
浏览
手工新增
编辑
定位
preference
```

禁止：

```text
基于旧 stayDays 的 AI 批量发现
```

Primary 替换成：

```text
[前往更新路线和天数]
```

它只切换 Step 3。

Step 4 不直接执行 itinerary.replan。

---

# 21. Step 4 完成后的下一步

当 Skeleton Ready 且用户已完成兴趣点选择：

Primary：

```text
[下一步：每日行程]
```

只进入 Step 5。

不得在 Step 4 直接生成 Detailed Itinerary。

---

# 22. Step 5：每日行程

用户任务：

> 确认每天具体几点去哪里，以及当天真实路线。

## 没有 Detailed Itinerary

Primary：

```text
[生成每日行程]
```

## 局部 Dirty

Primary：

```text
[更新受影响的 N 天]
```

## Macro Dirty

禁止 Detailed Generate / Update。

Primary：

```text
[前往更新路线和天数]
```

只切换 Step 3。

---

# 23. Step 5 日列表与局部状态

推荐：

```text
Day 12  蒂阿瑙        已完成
Day 13  蒂阿瑙        需更新
Day 14  皇后镇        已完成
```

如果只有局部受影响：

```text
2 天需更新
其他 18 天保持不变
```

不要默认展示：

```text
重新生成全部 20 天
```

全量重做只能作为 Secondary / Danger 动作。

---

# 24. Step 5 单日详情

选中 Day 后显示：

```text
起点
Stop
时间
活动
交通方式
终点
Detail Route
```

Core Visit 和普通兴趣点都作为 Stop。

不要让用户误以为 Core Visit 是住宿城市 / Macro Anchor。

---

# 25. Detailed Update 最小变更体验

局部更新时默认把当前 Detailed Day 当作 sticky baseline。

更新原则：

```text
只改 affectedDayIds
能保留的 Stop 保留
能保留的顺序保留
能保留的时间保留
用户已经确认过的手工调整优先保留
```

如果必须大改某天：

```text
先展示变更 Diff
```

不要因为某个新 must_go 兴趣点把整趟 20 天重新生成。

---

# 26. “需更新”统一 Update Card

任何 `macroDirty / needs_review / needs_update` 不得只显示一个图标或状态词。

统一包含：

```text
为什么需要更新
受影响区域 / Day
哪些内容保持不变
下一步唯一动作
```

例如：

```text
Milford Sound 已设为重要游览地。
原来的蒂阿瑙 2 天没有考虑这个全天活动。

可能影响：
- 蒂阿瑙
- 相邻移动日

保持不变：
- 其他 18 天

[前往更新路线和天数]
```

禁止：

```text
行程已过期
请重新生成
```

---

# 27. 未定位状态

从 Step 2 / Step 4 就显示：

```text
⚠ 尚未定位
```

详情：

```text
不会影响当前路线和天数规划，
但生成实际每日路线前需要完成定位。
```

修复按钮只出现在该对象归属步骤的右侧详情：

```text
[重新定位]
[手工定位]
```

如果 `must_go + unresolved`：

Step 5 顶部直接显示阻塞原因。

不要等 Action 执行失败后才 Toast。

---

# 28. 删除确认

普通未使用兴趣点可轻量删除 / Undo。

高影响删除进入 Impact Confirmation Card。

例如：

```text
删除“蒂阿瑙”还会删除：

重要游览地
- Milford Sound [必去]

普通兴趣点
- Glowworm Caves

受影响行程
- 对应 Stay Block
- Day 12
- Day 13

[取消] [确认删除]
```

禁止静默 cascade。

自然语言删除遵守同一规则。

---

# 29. AI 对话与右侧工作区

AI Composer 是右侧控制台的一部分，不是第二套管理 UI。

用户可以说：

```text
Milford 我一定要去
皇后镇少一天
这个景点设为重要游览地
```

系统根据动作归属：

```text
当前步骤可执行 → 展示 / 执行该步骤 Action
不属于当前步骤 → 导航归属步骤并带上 intent / selection
```

高影响动作必须显示：

```text
改什么
为什么
影响哪里
确认
```

禁止 AI 在聊天区静默完成大范围 mutation。

---

# 30. 不自动发生的事情

禁止因为“进入页面”自动：

```text
批量生成兴趣点
重新生成路线和天数
重新生成每日行程
角色升级 / 降级
大范围删除
改变 preference
```

进入页面可以自动：

```text
读取
选择恢复
只读状态计算
展示 Diff
展示未定位
```

---

# 31. 可以自动发生的基础设施动作

不改变用户规划意图的 best-effort 动作可以自动：

```text
新地点保存后的地图解析
Provider 路线刷新
只读影响分析
状态计算
Marker 更新
```

失败不得让已经保存的 Candidate 消失。

---

# 32. 环线旅行 UX

同一 Planning Area 可以出现多个 Stay Block。

例如：

```text
奥克兰 2 天
...
奥克兰 2 天
```

Step 3 必须把两段分开显示。

用户调整其中一个 Stay Block 时，不默认同步修改另一个。

---

# 33. 移动端 / 窄屏

窄屏仍保持：

> 工作区为主，地图为辅。

推荐：

```text
主视图：右侧控制台内容成为全屏工作区
地图：Tab / 抽屉
```

不因为移动端再创造第二套业务入口。

---

# 34. 验收：第一次规划

用户不理解任何内部术语，也能完成：

```text
旅行需求
→ 去哪些地方
→ 安排路线和天数
→ 补充景点
→ 每日行程
```

每一步的生成动作都只存在于结果所属步骤。

---

# 35. 验收：修改体验

任何局部修改后，用户都能看到：

```text
为什么需要更新
影响哪些内容
哪些内容不变
下一步唯一应该去哪 / 做什么
```

例如：

```text
新增普通 optional 咖啡馆
→ Skeleton 不变
→ Detailed 不变

普通景点升级重要游览地
→ Step 4 导航 Step 2 确认
→ Step 3 需更新
→ 无关地区保持不变

Replan 后 Macro 不变
→ 只更新相关区域 Detail
```

---

# 36. 验收：唯一入口

必须满足：

```text
五步导航只在右侧控制台
地图没有业务修改入口
Step 2 / Step 3 不同时提供 itinerary.generate
Step 4 / Step 5 不同时提供 detail.generate
Core Visit 不在 Step 2 / Step 4 各维护一套编辑器
跨步骤 CTA 只导航
```

---

# 37. 最终 UX 原则

用户心智：

```text
我要怎么玩
→ 去哪些地方
→ 这些天怎么分
→ 还有什么值得去
→ 每天具体怎么玩
```

系统行为：

```text
上游决定结构
下游补充细节
局部修改只局部失效
地图 / 时间轴只展示与选择
右侧控制台是唯一业务入口
每个业务动作只有一个归属步骤
任何“需更新”都解释原因和影响范围
```

最终体验应该像一个持续可修改、知道依赖关系的旅行规划工作台，而不是一次性生成攻略的聊天机器人。
