# TravelPlanner 五步 UI 交互规范

> 状态：**已确认的产品交互规范，尚未实施**  
> 更新日期：2026-09-02  
> 配套施工图：[`TravelPlanner 五步规划流程重构实施方案.md`](./TravelPlanner%20五步规划流程重构实施方案.md)

---

# 1. 核心原则

用户在任何时刻都应该知道：

```text
我现在在哪一步？
这一页要解决什么？
哪里可以修改？
修改后影响什么？
下一步应该去哪？
```

最高优先级规则：

> **地图 / 时间轴负责展示和选择；右侧控制台负责所有业务操作；同一个业务动作只有一个 canonical UI 入口；局部修改只让真正受影响的部分需更新。**

---

# 2. 五步用户流程

```text
1 旅行需求
2 去哪些地方
3 安排路线和天数
4 补充景点
5 每日行程
```

不要要求用户理解：

```text
Backbone
Skeleton
Macro
Detail
Planning Area
Core Visit
```

这些是内部术语。

---

# 3. 页面只有两个主要职责区

```text
┌──────────────────────────────┬───────────────────────────┐
│                              │ 五步导航                  │
│      地图 / 时间轴 / 路线    │───────────────────────────│
│      展示 + 选择             │ 当前步骤内容              │
│                              │ 当前对象详情              │
│                              │ AI / Action / 状态        │
│                              │ [唯一 Primary CTA]       │
└──────────────────────────────┴───────────────────────────┘
```

不新增独立左侧步骤栏。

地图 / 时间轴不提供：

```text
新增 / 删除
设置必去
角色调整
生成 / 更新 AI 结果
修复定位
推进步骤
```

右侧控制台负责全部业务入口。

---

# 4. 唯一入口与跨步骤导航

业务动作唯一归属：

| 业务动作 | 归属步骤 |
|---|---|
| 修改旅行需求 | Step 1 |
| Planning Area / Core Visit | Step 2 |
| Skeleton 生成 / 更新 / 手工调整 | Step 3 |
| Detail Interest | Step 4 |
| Detailed Itinerary / Stop / Day | Step 5 |
| 定位修复 | 对象归属步骤右侧详情 |

如果用户在错误步骤发起意图：

```text
识别 intent
→ 导航到归属 WorkflowStep
→ 保留 selection / intent
→ 在归属步骤展示确认或执行入口
```

不能直接跨步骤 mutation。

---

# 5. 一个全局 selection

整个 App 只维护一个主要 selection：

```text
Planning Area
Core Visit
Detail Interest
Stay Block
Day
Stop
Route Segment
```

地图、列表、时间轴都只更新这一个 selection。

管理归属：

```text
Planning Area / Core Visit → Step 2
Stay Block / Macro Day     → Step 3
Detail Interest            → Step 4
Day / Stop                 → Step 5
```

---

# 6. Primary Button 规则

任意时刻最多一个 Primary Button。

优先级：

```text
1 阻塞修复
2 前往上游处理
3 当前步骤生成 / 更新 / Apply
4 下一步导航
```

Secondary / Menu 可以有：

```text
手动新增
筛选
查看影响
全量重做危险操作
```

但不能与 Primary 抢层级。

---

# 7. Step 1：旅行需求

用户任务：

> 告诉系统我想进行什么旅行。

右侧显示：

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

完成后：

```text
[下一步：去哪些地方]
```

只导航 Step 2，不自动生成地点。

需求变化若改变 Macro dependency：

```text
Step 3 显示需更新
但不自动 Replan
```

---

# 8. Step 2：去哪些地方

用户任务：

> 确认这趟旅行有哪些停留区域和重要游览地候选。

用户语言：

```text
停留城市 / 区域
重要游览地
```

列表必须同时显示 planningRole 与 preference 的用户语言，不把二者混成一个状态。

例如：

```text
蒂阿瑙             [想去]
  Milford Sound    [重要游览地] [必去]

皇后镇             [必去]
  Routeburn Track  [重要游览地] [可选]
```

## 没有 Backbone

```text
[生成推荐地点]
```

## 已有 Backbone

```text
[下一步：安排路线和天数]
```

只导航 Step 3。

---

# 9. Step 2 Preference 的用户含义

Planning Area：

```text
必去
→ Step 3 一定纳入

想去
→ Step 3 优先纳入；放不下要解释

可选
→ Step 3 可以不纳入

不去
→ Step 3 禁止纳入
```

Core Visit：

```text
必去
→ Step 3 必须考虑时间；Step 5 必须安排

想去
→ 优先考虑

可选
→ 不为了它额外增加天数

不去
→ 不参与规划
```

Step 2 要让用户清楚：

> “可选地点出现在候选列表里”不等于“一定会进入最终路线”。

---

# 10. Core Visit 唯一管理入口

Step 2 负责：

```text
新增 / 删除重要游览地
修改 parent
修改 preference
角色降级
确认 Detail → Core 升级
```

Step 4 不提供第二套 Core 编辑器。

Step 4 发起“设为重要游览地”时：

```text
导航 Step 2
→ 自动选中该地点
→ Role Change Impact Card
→ 用户确认
→ 才真正改变 role
```

---

# 11. Step 2 地图

显示：

```text
Planning Area
Core Visit
```

不显示大量普通 Detail Interest。

地图点击只：

```text
selection 更新
→ 右侧显示对应对象
```

Popup 不提供删除、偏好、重要角色、定位修复、生成路线等业务操作。

---

# 12. Step 3：安排路线和天数

用户任务：

> 决定最终去哪些候选地点、以什么顺序停留、每段几天。

## 没有 Skeleton

```text
[生成路线和天数]
```

## Skeleton 需更新

```text
[更新路线和天数]
```

## Skeleton Ready

```text
[下一步：补充景点]
```

只导航 Step 4。

---

# 13. Step 3 要显示“采用 / 未采用”

Step 3 不是机械覆盖所有 Step 2 Candidate。

必须明显区分：

```text
已纳入路线
未纳入路线
```

未纳入示例：

```text
Napier [想去]
未纳入：20 天内会明显增加绕行

Waitomo [可选]
未纳入：当前路线容量不足
```

`must_go` Planning Area 不允许出现在未纳入区域。

`want_to_go` 未纳入必须显示原因。

---

# 14. Step 3 主视觉：稳定 Stay Block

推荐时间轴：

```text
Day 1–2
奥克兰 · 2 天

↓ 自驾

Day 3–4
罗托鲁瓦 · 2 天

↓

Day 5
陶波 · 1 天
```

环线：

```text
Day 1–2   奥克兰
...
Day 19–20 奥克兰
```

两个 Auckland 是两个独立 Stay Block。

用户编辑其中一个，不默认同步另一个。

UI 不显示内部 `stayBlockId`，但 selection 必须稳定指向对应 Block。

---

# 15. Step 3 手工编辑：先草稿，后 Apply

选中 Stay Block 后允许：

```text
调整停留天数
调整顺序
调整进入该段的交通方式
```

这些编辑先进入本地 / 会话级 Skeleton Draft，不立即污染 canonical。

右侧持续显示：

```text
总旅行：20 天
当前分配：19 天
还需要分配 1 天
```

此时：

```text
[应用修改] disabled
```

当用户调整为：

```text
总旅行：20 天
当前分配：20 天
✓ 分配完整
```

才允许：

```text
[应用修改]
```

Apply 一次性更新合法 Skeleton。

---

# 16. Step 3 自然语言编辑也必须遵守草稿规则

用户说：

```text
皇后镇少一天
```

如果系统不知道这一天下放到哪里，不能静默做决定。

应：

```text
建立未完成 Skeleton Draft
或
给出重新分配建议
```

例如：

```text
皇后镇减少 1 天后还需要重新分配 1 天。
建议增加到：
- 蒂阿瑙
- 瓦纳卡

[选择]
```

除非用户明确说“你合理分配”，AI 才能形成完整 Proposal。

---

# 17. 移动日统一说明

UI 始终使用：

> 移动到某个区域的当天，算作到达区域的第 1 天。

例如：

```text
A 2 天
B 3 天

Day 1 A
Day 2 A
Day 3 A → B  // B 第 1 天
Day 4 B
Day 5 B
```

所有页面不得出现另一种计数口径。

---

# 18. Step 3 更新后必须展示 Diff

例如：

```text
蒂阿瑙：2 → 3 天
皇后镇：4 → 3 天
其他 15 天保持不变
```

如果结果 Macro 完全相同：

```text
路线和停留天数无需调整。
只需要更新蒂阿瑙的每日安排。
```

旧旅行没有 Macro fingerprint：

```text
需要确认路线和天数
```

不自动重算。

---

# 19. Planning Area 未定位 UX

如果某个 Step 3 已采用的 Planning Area 尚未定位：

```text
⚠ 尚未定位
路线和天数仍可先确认
真实路线待定位后计算
```

Macro Route 对应段：

```text
待定位 / 待计算
```

不能显示伪造的距离 / 时长。

进入 Step 5 前，如果某 Day 的实际 Anchor 仍 unresolved，应显示阻塞卡。

---

# 20. Step 4：补充景点

只有 Step 3 Ready 后才允许 AI capacity-aware discovery。

第一次进入：

```text
只展示已有内容
不自动生成
```

Primary：

```text
[根据当前行程补充兴趣点]
```

只针对已经纳入 Step 3 Skeleton 的 Planning Area 生成普通兴趣点。

被 Step 3 omitted 的可选区域，不默认发现兴趣点。

AI 每个区域可返回 0–9 个，允许 0。

---

# 21. Step 4 内容结构

```text
蒂阿瑙 · 2 天

重要游览地（时间背景）
★ Milford Sound

普通兴趣点
○ Glowworm Caves
○ Lake Te Anau
```

Core Visit 在 Step 4 只读展示。

点击后：

```text
查看摘要
[前往“去哪些地方”管理]
```

---

# 22. Step 4 Skeleton 需更新

允许：

```text
浏览
手工新增普通兴趣点
编辑
定位
修改 preference
```

禁止：

```text
根据旧 stayDays 再做 AI capacity discovery
```

Primary：

```text
[前往更新路线和天数]
```

只导航 Step 3。

---

# 23. Step 5：每日行程

## 没有 Detailed Itinerary

```text
[生成每日行程]
```

## 局部需更新

```text
[更新受影响的 N 天]
```

## Macro 需更新

```text
[前往更新路线和天数]
```

只导航 Step 3。

---

# 24. Step 5 未定位阻塞规则

必须区分对象类型。

## Planning Area / origin Anchor unresolved

```text
该 Day 不能生成真实 Detailed Itinerary / Route
```

提示：

```text
Day 12 的起点 / 终点尚未定位。
路线和天数已经确认，但真实每日路线需要先定位。

[前往定位]
```

## must_go Core / Detail unresolved

```text
阻塞相关 Day / 区域 Detailed Generate
```

## want / optional Core / Detail unresolved

```text
不排入 Stop
不阻塞其他 Day
```

未定位提示必须在执行失败前可见。

---

# 25. Step 5 日列表与局部状态

```text
Day 12 蒂阿瑙  已完成
Day 13 蒂阿瑙  需更新
Day 14 皇后镇  已完成
```

汇总：

```text
2 天需更新
其他 18 天保持不变
```

默认不要显示“重新生成全部 20 天”。

全量重做只作为 Secondary / Danger。

---

# 26. Detailed Update 最小变更体验

更新原则：

```text
只改 affectedDayIds
能保留的 Stop 保留
能保留的顺序保留
能保留的时间保留
用户已经确认的手工调整优先保留
```

如果必须大改某一天，先展示 Diff。

---

# 27. “需更新”统一 Update Card

任何 `macroDirty / needs_review / needs_update` 用户态必须包含：

```text
为什么
影响哪些区域 / Day
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

`macroDirty` 是工程派生状态，不直接作为用户文案。

---

# 28. 删除确认

普通未使用 Detail Interest 可轻量删除 / Undo。

高影响删除进入 Impact Confirmation：

```text
删除“蒂阿瑙”还会影响：

重要游览地
- Milford Sound [必去]

普通兴趣点
- Glowworm Caves

路线
- 对应 Stay Block
- Day 12
- Day 13
```

不能静默 cascade。

自然语言删除遵守同一规则。

---

# 29. AI Composer

AI Composer 是右侧控制台的一部分，不是第二套管理系统。

用户说：

```text
Milford 我一定要去
皇后镇少一天
这个景点设为重要游览地
```

系统根据 WorkflowStep 归属：

```text
当前步骤可处理 → 当前步骤 Action / Draft / Proposal
不属于当前步骤 → 导航对应步骤并携带 intent / selection
```

高影响动作必须说明：

```text
改什么
为什么
影响哪里
是否满足当前约束
确认
```

---

# 30. 不自动发生的事

进入页面不得自动：

```text
批量生成兴趣点
重新规划 Skeleton
重新生成每日行程
角色升级 / 降级
大范围删除
改变 preference
```

可以自动：

```text
读取
恢复 selection
计算只读依赖状态
展示 Diff
展示未定位
新地点保存后的 best-effort resolve
Provider 路线刷新
```

失败不得让已确认 Candidate 消失。

---

# 31. 移动端

窄屏：

```text
主视图 = 右侧工作区全屏
地图 = Tab / 抽屉
```

地图仍然只展示 / 选择，不创造第二套编辑入口。

---

# 32. 核心验收

## 第一次规划

```text
旅行需求
→ 去哪些地方
→ 安排路线和天数
→ 补充景点
→ 每日行程
```

## Preference

```text
must Planning Area 一定进入
want 未进入必须解释
optional 可以未进入
excluded 绝不进入
```

## 环线

```text
Auckland #1
...
Auckland #2
```

两个 Block 独立可选、可编辑。

## Step 3 草稿

19 / 20 天时不能 Apply；20 / 20 天时才能原子 Apply。

## 未定位

Planning Area 可先参与 Step 3，但真实 Step 5 Anchor 必须 resolved；must_go Core / Detail unresolved 阻塞相关 Detail。

## 唯一入口

```text
五步导航只在右侧
地图无业务 mutation
Step 2 不生成 Step 3
Step 4 不生成 Step 5
Core 不在 Step 2 / Step 4 各有一套编辑器
```

---

# 33. 最终 UX 心智

用户：

```text
我要怎么玩
→ 去哪些地方
→ 这些天怎么分
→ 还有什么值得去
→ 每天具体怎么玩
```

系统：

```text
候选不等于最终采用
preference 真正影响采用优先级
Stay Block 有稳定身份
Step 3 编辑先草稿后 Apply
上游决定结构
下游补充细节
局部修改只局部失效
地图 / 时间轴只展示与选择
右侧控制台是唯一业务入口
```

最终体验应像一个持续可修改、理解依赖关系的旅行规划工作台，而不是一次性生成攻略。