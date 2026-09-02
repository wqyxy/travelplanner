# TravelPlanner Macro / Detail 增量更新设计

> 状态：**五步流程下的当前增量设计，尚未实施本次五步变更**  
> 更新日期：2026-09-02  
> 详细施工图：[`TravelPlanner 五步规划流程重构实施方案.md`](./TravelPlanner%20五步规划流程重构实施方案.md)

---

# 1. 目标

五步流程中，与行程直接相关的层级是：

```text
Step 2 去哪些地方
→ Planning Area + Core Visit

Step 3 安排路线和天数
→ Macro Skeleton / Stay Block

Step 4 补充景点
→ Detail Interest

Step 5 每日行程
→ Detailed Itinerary
```

上游修改不允许默认让全部下游失效。

统一流程：

```text
Change Set
→ Role-Aware Impact Analyzer
→ affected scope / macroDirty
→ 用户在归属步骤主动更新
→ old/new Diff
→ only affectedDayIds needs_update
→ Patch AI / Route refresh
```

---

# 2. Macro Skeleton 的最小事实

Step 3 只决定：

```text
Stay Block 顺序
每个 Stay Block 的 Planning Area
stayDays
从上一 Stay Block 进入的语义交通方式
```

服务端确定性展开 canonical Day。

不新增一套与 canonical Day 重复的 MacroDay 数据表。

Step 5 复用相同 Day ID，只补充 Stop / 时间 / Detail Route。

---

# 3. Stay Block 支持重复 Planning Area

同一 Planning Area 可以在一次旅行出现多次。

例如：

```text
Auckland
→ South Island
→ Auckland
```

两个 Auckland 是两个独立 Stay Block。

不能因为 Candidate ID 相同而合并。

用于 Diff / Day ID 复用时至少区分：

```text
planningAreaCandidateId
+
occurrenceIndex
```

---

# 4. stayDays / 移动日唯一语义

转移日计入到达 Stay Block。

例如：

```text
A 2 天
B 3 天
```

展开：

```text
Day 1 A
Day 2 A
Day 3 A → B   // B 第 1 天
Day 4 B
Day 5 B
```

因此：

```text
所有 Stay Block stayDays 之和
= 旅行总天数
```

任何 Prompt、Context、UI、Impact Analyzer 都必须采用相同语义。

---

# 5. Core Visit 的 Macro 作用

Core Visit：

```text
不成为 Stay Block
不成为 Macro Anchor
```

但：

```text
参与 Step 3 时间容量判断
```

例如：

```text
Te Anau
Core: Milford Sound ≈ 1 day
```

Step 3 应为 Te Anau 留出合理容量，但不决定 Milford 到底落入哪一天。

具体落日属于 Step 5。

---

# 6. Macro Dependency Fingerprint

建议：

```ts
planningState?: {
  macroBasisVersion: 1;
  macroBasisFingerprint: string | null;
  macroDirty: boolean;
};
```

Fingerprint 包含真正影响 Macro 的输入：

```text
旅行总天数 / 日期
起点
交通偏好
pace
travelers
重要 constraints / themes / preferences
Planning Areas
Core Visits + parent + preference + suggestedDuration
```

不包含：

```text
普通 Detail Interest
AI score
纯显示名称
Resolution 状态
坐标微调
Provider Place ID
Route geometry
```

---

# 7. 旧 Skeleton 没有 Fingerprint

旧旅行已有 Day，但没有 planningState：

```text
不自动迁移
不自动 Replan
不自动补写 fingerprint
```

Step 3 显示：

```text
需要确认路线和天数
```

用户下一次主动更新 Step 3 后建立新 fingerprint。

---

# 8. Planning Area 变化

以下变化通常导致：

```text
macroDirty = true
```

包括：

```text
新增 / 删除 Planning Area
excluded / 恢复
影响是否参与旅行的 preference 变化
总旅行天数变化
重要交通约束变化
```

纯显示名变化：

```text
不重新规划
```

Resolution / coordinate 变化：

```text
规划不变
只刷新相关 Macro Route
```

---

# 9. Core Visit 变化

以下变化：

```text
新增
删除
excluded / 恢复
preference 改变
Detail → Core
Core → Detail
parent 改变
suggestedDuration 显著变化
```

结果：

```text
macroDirty = true
```

并先把当前 Skeleton 中相关 Planning Area / Stay Block 对应 Detail Day 标记 `needs_review`。

不要立刻把全旅行 Detailed Itinerary 全部失效。

---

# 10. Detail Interest 变化

新增普通 `optional / want_to_go`：

```text
Skeleton 不变
现有 Detail 继续 ready
只是新增候选
```

新增 / 升级普通 `must_go`：

```text
Skeleton 通常不变
对应 Planning Area 可承载 Day needs_review
```

删除已排入 Day 的兴趣点：

```text
只影响实际使用它的 Day
```

删除未使用兴趣点：

```text
不影响现有 Detailed Itinerary
```

定位变化：

```text
只刷新实际使用地点的 Detail Route
```

---

# 11. Core Role 修改归属

Core Visit 的结构管理只归 Step 2。

如果用户在 Step 4 对某 Detail Interest 提出：

```text
设为重要游览地
```

流程：

```text
Step 4 只导航 Step 2
→ Step 2 Impact Card
→ 用户确认 role change
→ macroDirty=true
```

避免 Step 2 / Step 4 各有一套 Core 管理入口。

---

# 12. Step 3 Replan 后二次 Diff

真正的 affectedDayIds 不能只凭“Core 变了”推断全旅行。

流程：

```text
Macro Dirty
→ 用户在 Step 3 主动 Replan
→ 比较 old/new Stay Blocks
→ 比较 expanded Macro Days
→ 识别 affectedDayIds
→ 只扩展这些 Day 的 needs_review
```

例如：

```text
Queenstown 4 → 3
Te Anau 2 → 3
```

只影响真实发生结构变化的 Day 与必要相邻 transfer Day。

---

# 13. Replan 后 Macro 完全相同

例如加入 Core Visit 后，AI 判断：

```text
Te Anau 仍然 2 天即可
```

则：

```text
macroDirty=false
Macro Day 结构保持
```

只需要更新 Core 所属区域的 Detailed Day，把新的 Core Visit 安排进去。

这正是增量设计的价值。

---

# 14. Day ID 稳定

Replan 优先复用已有 Day ID。

建议匹配优先级：

```text
1 planningAreaCandidateId + occurrenceIndex + block 内相对日
2 相同 Macro signature
3 相同 end Planning Area
4 最后才重新映射
```

未受影响 Day：

```text
Stop 保持
Detail Route 保持
detailStatus 保持
```

---

# 15. Detailed Update 必须 Patch-only

Step 5 增量更新必须：

```text
只返回 affectedDayIds 对应 patch
不得返回整趟替换结果
不得修改 Macro Anchor / Day identity
```

当前已保存 Detailed Day 视为 sticky baseline：

```text
能保留的 Stop 保留
能保留的顺序保留
能保留的时间保留
用户手工确认内容优先保留
```

如果没有可靠 provenance 字段，不在本次重构中擅自增加复杂迁移；默认最小 Diff。

---

# 16. 两种 Route

```text
Macro Route
= Day.startAnchor → Day.endAnchor
只在两者不同时需要

Detail Route
= Step 5 真实 Stop Sequence
```

两种 Route 不能互相覆盖。

Provider 路线失败：

```text
只影响对应 route status
不回滚 AI 规划
```

---

# 17. contentGeneration 的职责

`contentGeneration` 继续用于：

```text
并发控制
旧任务取消
CAS 写入
```

不得解释为：

```text
任何 generation 变化
→ 整个 Step 3 / Step 5 失效
```

是否需更新必须由 dependency + structural Diff 决定。

---

# 18. Action 归属

Step 3：

```text
itinerary.generate
itinerary.replan
```

其 Registry：

```text
ConversationStage = destinations
WorkflowStep = skeleton
```

Step 5：

```text
itinerary.detail.generate
itinerary.detail.update
```

其 Registry：

```text
ConversationStage = itinerary
WorkflowStep = detail
```

不要让 Step 3 / Step 5 再共用同一个生成入口。

---

# 19. UI 状态

继续复用：

```ts
Day.detailStatus = "ready" | "needs_review";
```

UI：

```text
已完成
需更新
```

`needs_update` 不表示整个步骤数据不可用。

必须展示：

```text
为什么需要更新
受影响的 Stay Block / Day
哪些内容保持不变
唯一下一步动作
```

---

# 20. 示例

## 新增普通咖啡馆

```text
Step 3 不变
Step 5 不变
只是多一个候选
```

## 普通地点变 must_go

```text
只标记可承载该地点的区域 Day 需更新
```

## Detail → Core

```text
Step 4 → 导航 Step 2 确认
Step 3 needs_update
对应区域 Detail needs_review
其他地区保持 ready
```

## Replan 结构不变

```text
Step 3 ready
只更新相关区域 Detail
```

## 环线

```text
Auckland occurrence 1
...
Auckland occurrence 2
```

两个 Stay Block 独立 Diff / Day 复用。

---

# 21. 数据库兼容

本次五步设计不新增第五种数据库 ConversationStage。

继续：

```text
PRAGMA user_version = 3
```

`planningRole / planningState` 采用 optional backward-compatible 读取。

不自动迁移真实私人数据库。

---

# 22. 最终原则

```text
Planning Area / Core Visit 决定 Macro 依赖
Skeleton 决定时间结构
Detail Interest 只在已知容量内补充
Detailed Itinerary 只在固定 Skeleton 内排程
局部变化只传播到真正依赖它的范围
```
