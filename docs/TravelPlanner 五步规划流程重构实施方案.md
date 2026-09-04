# TravelPlanner 五步规划流程重构实施方案

> 状态：**已确认的文档设计，尚未实施**  
> 更新日期：2026-09-02  
> 适用范围：TravelPlanner v3 产品流程、Candidate 角色、Macro / Detail 规划、Prompt / Action / Context、增量更新、兼容边界、用户复杂度下沉与实施顺序  
> 配套 UI 规范：[`五步 UI 交互规范.md`](./五步%20UI%20交互规范.md)

---

# 1. 目标与最终流程

用户可见流程统一为：

```text
1 旅行需求
      ↓
2 想去哪些地方
   ├─ 停留区域候选
   └─ 重要游览地候选
      ↓
3 路线和天数
   ├─ 最终采用哪些区域
   ├─ Stay Block / 停留段
   ├─ 顺序
   ├─ 停留天数
   └─ 跨区域语义交通方式
      ↓
4 补充景点（可选）
   └─ Detail Interest / 普通兴趣点
      ↓
5 每日行程
   ├─ Core Visit 落入具体日期
   ├─ Detail Interest 选择与排序
   ├─ 时间安排
   └─ Detail Route
```

内部核心原则：

> 先确定哪些地点决定旅行结构，再分配时间；先有时间容量，再发现普通兴趣点；最后才安排具体日期和真实路线。

增量原则：

> 用户修改哪里，只重新计算真正受影响的部分；未受影响结果继续有效。

---

# 2. 用户 Workflow 与 ConversationStage

内部 WorkflowStep：

```ts
type WorkflowStepV3 =
  | "requirements"
  | "backbone"
  | "skeleton"
  | "interests"
  | "detail";
```

用户显示：

```text
1 旅行需求
2 想去哪些地方
3 路线和天数
4 补充景点（可选）
5 每日行程
```

数据库仍只保留四个 ConversationStage：

```ts
type ConversationStage =
  | "requirements"
  | "destinations"
  | "interests"
  | "itinerary";
```

映射：

```text
requirements → requirements
backbone     → destinations
skeleton     → destinations
interests    → interests
detail       → itinerary
```

ConversationStage 只负责消息 / Thread / Dialogue / Action 命名空间，不替换 canonical TripStage。

所有需要“返回上游”的 AI 输出必须使用 WorkflowStep，而不是仅使用 ConversationStage：

```ts
type RequiresWorkflowStep =
  | "requirements"
  | "backbone"
  | "skeleton"
  | "interests";
```

统一结果建议：

```ts
{
  type: "requires_workflow_step";
  requiresWorkflowStep: RequiresWorkflowStep;
  reason: string;
  assistantMessage: string;
}
```

这样 Step 5 可以明确要求回 Step 3，而不会因为 Step 2 / Step 3 共用 `destinations` ConversationStage 产生歧义。

---

# 3. 新增 P0：复杂度下沉，不把工程模型做成产品 UI

这次重构保留必要的内部复杂度，但禁止把以下概念直接变成普通用户必须理解的界面：

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

工程状态必须翻译为用户行动语言，例如：

```text
macroDirty
→ 路线和天数需要重新确认

affectedDayIds = 2
→ 2 天需要更新，其他 18 天不变

requiresWorkflowStep = skeleton
→ 自动切换到“路线和天数”并展示待处理内容
```

该原则是 Phase 6 UI 验收的硬要求，而不是文案优化项。

## 3.1 本专项阶段测试闸门：每个 Phase 都必须暂停，由用户在 Codex 独立测试

这是本次五步重构的**专属执行规则**，优先于本文后续出现的任何测试清单或“连续施工”描述。

实施 Agent 在 GitHub / 当前实施环境中：

```text
可以：
- 只读 review
- 查看代码 / diff
- 修改代码与文档
- 静态检查实现是否符合施工图
- 为当前 Phase 生成 Codex 测试提示词

不得执行：
- Vitest / Jest / 任何单元或集成测试
- typecheck
- build
- 真实 AI smoke
- Browser E2E
- GitHub Actions 测试工作流
- 任何为了验证功能而启动应用或运行测试脚本
```

整个实施过程必须严格采用：

```text
Phase 0 完成
→ STOP
→ 给用户 Phase 0 Codex 验证提示词
→ 用户在 Codex 独立执行
→ 用户返回结果并明确说“通过 / 继续”
→ 才允许进入 Phase 1

Phase 1 完成
→ STOP
→ 给用户 Phase 1 Codex 测试提示词
→ 用户在 Codex 独立执行
→ 用户返回结果并明确说“通过 / 继续”
→ 才允许进入 Phase 2

Phase 2 完成
→ STOP
→ Phase 2 Codex 测试
→ 用户确认
→ Phase 3

……

Phase 6 完成
→ STOP
→ Phase 6 Codex 测试
→ 用户确认
→ Phase 7 最终交接 / 回归验收
```

**严禁：**

```text
一次连续实施多个 Phase 后再统一测试
Phase N 完成后自动开始 Phase N+1
因为静态 review 看起来正确就跳过 Codex 测试闸门
用户尚未明确确认通过时继续施工下一 Phase
```

每个 Phase 的 Codex 提示词必须是**阶段特定提示词**，只验证：

```text
1. 当前 Phase 承诺完成的内容
2. 当前 Phase 必须保持的旧行为 / 前序 Phase 关键回归
3. 当前 Phase 对下一 Phase 提供的接口是否已经准备好
```

不得在早期 Phase 提示词中要求尚未实施的未来能力。例如：

```text
Phase 1 不得因为 Phase 4 的 Step 4 Discovery 尚未完成而判 FAIL
Phase 2 不得因为 Phase 6 UI 尚未完成而判 FAIL
Phase 3 只验证 Backbone Producer 及必要前序回归，不要求完整 Detailed Itinerary
```

每个阶段测试提示词必须要求 Codex：

```text
- 先读取当前实际代码与 package.json / 测试脚本
- 不凭空发明测试命令
- 只使用隔离测试数据，不读写真实私人数据库
- 先测试和报告，不自动修改实现代码
- 输出 PASS / FAIL / BLOCKED
- 给出实际执行命令与失败证据
- 明确区分“当前 Phase 应完成”与“未来 Phase 尚未实施”
```

如果当前 Phase 测试结果为 `FAIL`：

```text
不得进入下一 Phase
→ 用户把 Codex 报告交回实施 Agent
→ 实施 Agent 只修当前 Phase 的问题（需用户明确要求修复）
→ 修复后再次 STOP
→ 重新给当前 Phase Codex 测试提示词
→ 直到用户明确确认通过
```

如果结果为 `BLOCKED`：

```text
由用户决定：
- 解决环境阻塞后重测
或
- 明确接受该阻塞并允许进入下一 Phase
```

实施 Agent 不得自行把 `BLOCKED` 当作 `PASS`。

因此，本文各 Phase 中列出的“测试文件 / 测试场景”表示：

> **该 Phase 完成后必须生成的 Codex 阶段测试提示词需要覆盖什么。**

不是本次实施 Agent 可以自行执行的命令，也不是只留到最后统一测试。

Phase 7 仍需要一份最终综合回归提示词，但它是**阶段测试之后的最终回归**，不能替代 Phase 0–6 的逐阶段测试闸门。

---

# 4. 页面结构与动作唯一归属

产品保持：

```text
地图 / 时间轴 / 路线
+
右侧唯一控制台
```

五步导航位于右侧顶部，不新增独立左侧步骤栏。

地图 / 时间轴只负责：

```text
展示
选择
聚焦
```

所有业务修改、AI 生成、定位修复、流程推进都从右侧控制台发起。

动作唯一归属：

```text
Step 1 → requirements update
Step 2 → destination.* / Planning Area / Core Visit
Step 3 → skeleton generate / replan / edit / apply
Step 4 → interest.* / Detail Interest
Step 5 → detail generate / update / Stop / Day
```

但“唯一归属”不等于让用户手动来回找入口。

如果用户在错误步骤提出意图：

```text
识别 intent
→ 自动切换到归属 WorkflowStep
→ 保留 selection / intent
→ 展示对应 Draft / Proposal / Confirmation
```

自动切换步骤可以发生；高影响 mutation 仍不得跨步骤静默执行。

---

# 5. Place.kind、planningRole、preference 必须独立

## 5.1 Place.kind

现实实体类型：

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

## 5.2 planningRole

规划层级：

```ts
type PlanningRole =
  | "planning_area"
  | "core_visit"
  | "detail_interest";
```

Canonical 规则：

```text
planning_area:
  Place.kind = city
  planningAreaCandidateId = null

core_visit:
  Place.kind != city
  planningAreaCandidateId = parent planning_area

detail_interest:
  Place.kind != city
  planningAreaCandidateId = parent planning_area
```

Core Visit 影响 Step 3 时间预算，在 Step 5 成为 Stop，但绝不成为 Macro Anchor。

## 5.3 preference

```ts
must_go
want_to_go
optional
excluded
```

它回答“用户有多想去”，不能与 planningRole 隐式绑定。

UI 主操作不需要四级全部显性展示：

```text
must_go    → 用户主要看到“必去”
want_to_go → 用户主要看到“想去”
optional   → AI 推荐默认状态，可弱化展示
excluded   → 用户通过“移除 / 不考虑”表达
```

数据模型保持四级，用户交互尽量两级。

---

# 6. preference 在 Step 3 的最终语义

## 6.1 Planning Area

```text
must_go
→ 必须至少进入一个 Stay Block

want_to_go
→ 优先进入；若总天数 / 路线确实不允许，可以不进入，但必须输出 omitted reason

optional
→ AI 可以不选；不能为了覆盖 optional 而强行挤压旅行

excluded
→ 禁止进入 Skeleton
```

旧规则：

```text
每个 active planning_area 都必须覆盖一次
```

废止。

新规则：

```text
所有 must_go planning_area 必须覆盖
want_to_go 优先覆盖
optional 由 Step 3 AI 决定是否采用
excluded 禁止采用
```

Step 3 输出仍需要可审计：

```ts
type OmittedPlanningArea = {
  candidateId: string;
  reason: string;
};
```

服务端验证：

```text
represented Stay Blocks
+
omittedPlanningAreas
=
全部 non-excluded Planning Areas
```

`must_go` 不允许出现在 omitted 中；`want_to_go` 被 omitted 必须有明确理由。

UI 不需要默认铺满全部 omitted optional；`want_to_go` omitted 要显著解释，optional omitted 可以折叠。

## 6.2 Core Visit

```text
must_go
→ Step 3 必须为它预留合理时间容量；Step 5 必须安排

want_to_go
→ Step 3 优先考虑；放不下时必须解释

optional
→ 不得仅为了它额外增加 stayDays；既有容量足够时可安排

excluded
→ 不参与容量，也不排入 Day
```

---

# 7. Core Visit 严格判定与用户表达

Core Visit 必须首先满足：

> 会显著改变宏观时间安排。

至少符合一种：

```text
通常独立占用半天或全天
明显绕行
特殊交通
强时间窗口
需要围绕它安排某一天
显著消耗某区域容量
```

并且：

```text
用户明确重视
或
研究确认其对当前旅行主题具有显著代表性
```

“用户点名”或“地点很有名”本身不等于 Core Visit。

UI 不做 engineering Role editor。

用户自然表达：

```text
这个地方很重要，要单独留一天
这个地方不用专门安排这么多时间
```

服务端 / Action 层再映射为角色变化，并在高影响时展示确认。

---

# 8. TripCandidate 兼容策略

新增可选字段：

```ts
planningRole?: PlanningRole;
```

统一运行时解释：

```ts
if (candidate.planningRole) return candidate.planningRole;
if (place.kind === "city") return "planning_area";
return "detail_interest";
```

旧 Candidate 可读，不自动回写；新创建或真正发生角色变化的 Candidate 显式写 `planningRole`。

建议新增纯函数模块：

```text
apps/server/planning-roles-v3.ts
```

至少包含：

```ts
effectivePlanningRole()
isPlanningAreaCandidate()
isCoreVisitCandidate()
isDetailInterestCandidate()
planningAreaParent()
activePlanningAreas()
activeCoreVisits()
activeDetailInterests()
```

---

# 9. Stay Block 是稳定业务对象，但不新增第二套 MacroDay 表

Step 3 的一级编辑对象是 Stay Block。

环线必须允许：

```text
Auckland #1
...
Auckland #2
```

同一 Planning Area 可出现多个 Stay Block。

为了保证 selection、Diff、Day ID reuse 和局部编辑稳定，canonical Day 增加可选：

```ts
stayBlockId?: string;
```

同一 Stay Block 展开的所有 Day 使用同一个 `stayBlockId`。

不新增独立 StayBlock 数据表，不维护第二套天数事实。

Stay Block 仍由 canonical Day 派生：

```text
stayBlockId
→ 连续 Day 集合
→ endAnchor / Planning Area
→ Day 数量 = stayDays
→ 第一日 transferMode = 进入该 Block 的交通方式
```

AI Skeleton Draft 不生成 canonical UUID：

```ts
type SkeletonStayDraft = {
  planningAreaCandidateId: string;
  stayDays: number;
  transferModeFromPrevious: TransportMode;
};
```

服务端 formalization 时：

```text
优先匹配现有稳定 Stay Block 并复用 stayBlockId
匹配不到才生成新的 UUID
```

旧 Day 没有 `stayBlockId` 时：

```text
正常读取
不因普通加载自动写回
下一次用户主动在 Step 3 保存路线和天数时再建立稳定 stayBlockId
```

UI 不显示 `stayBlockId`。

---

# 10. stayDays 与移动日唯一语义

统一：

> 转移日计入到达 Stay Block。

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
所有实际采用 Stay Block 的 stayDays 总和
>= 旅行总天数
```

其中：少于旅行总天数属于未完成 Draft，不能保存；等于旅行总天数为完整安排；手工编辑后多于旅行总天数属于可保存的警告状态，保留完整日段并提示用户后续调整。AI 自动生成 / replan 仍以旅行总天数为硬目标，不能把超额当作自动规划成功条件。

Interest Discovery 必须知道各 Block 是否包含 arrival transfer day。

---

# 11. Step 2：Backbone / 想去哪些地方

内部仍称 Backbone；用户只看到“想去哪些地方”。

Step 2 是**候选愿望清单**，不是最终路线。

页面固定说明：

> 先选出想考虑的地方，下一步会根据总天数安排最终路线。

Step 2 只管理：

```text
Planning Area
Core Visit
```

禁止批量产生普通 Detail Interest。

Step 2 是 Core Visit 结构管理唯一归属步骤，但 UI 用“重要游览地”和自然语言调整，不把 role / parent 做成主界面。

## 11.1 Mixed Destination Output

`destination.generate` 同一轮允许返回：

```text
Planning Area
Core Visit
```

建议 AI Draft 使用：

```ts
type ParentCandidateRef =
  | { type: "existing"; candidateId: string }
  | { type: "generated"; temporaryCandidateId: string };
```

两阶段 formalization：

```text
Phase A：Place + Planning Area Candidate
Phase B：Core Visit，generated parent ref → canonical Candidate ID
```

canonical 永远只保存正式 `planningAreaCandidateId`。

## 11.2 Duplicate Merge

```text
existing detail + incoming core
→ 可升级 core（parent 一致或原无 parent）

existing core + incoming detail
→ 保持 core
```

parent 冲突不得静默 reparent。

Discovery 不覆盖已有用户 preference。

---

# 12. Step 3：Skeleton / 路线和天数

内部仍称 Skeleton；用户只看到“路线和天数”。

输入只包括：

```text
TripFacts
Planning Areas + preference
Core Visits + preference + suggestedDuration
当前已有 Skeleton / Stay Blocks
```

禁止输入大量普通兴趣点。

AI 负责：

```text
选择最终采用的 Planning Areas
Stay Block 顺序
每个 Stay Block stayDays
进入 Block 的语义 transport
omitted Planning Areas + reasons
```

Core Visit 只影响容量，不成为 destination / Anchor。

如果 `must_go Planning Area` 或 `must_go Core Visit` 无法容纳，应返回：

```text
requiresWorkflowStep = requirements | backbone
```

而不是生成明显不可行 Skeleton。

UI 对 `want_to_go` omitted 使用简洁折叠提示；optional omitted 不默认铺满。

---

# 13. Step 3 手工修改必须使用“草稿 + 原子保存”

用户不能逐字段直接把 canonical Skeleton 写成临时非法状态。

右侧内部维护 UI-only `SkeletonEditDraft`：

```text
顺序草稿
stayDays 草稿
transferMode 草稿
```

但 UI 不显示 Draft / Apply / canonical 术语。

用户可以连续修改：

```text
Queenstown 4 → 3
Te Anau 2 → 3
```

实时显示：

```text
总旅行：20 天
当前分配：20 天
✓ 已分配完整
```

如果：

```text
总旅行：20 天
当前分配：19 天
```

则：

```text
还剩 1 天需要安排
[+1 蒂阿瑙]
[+1 瓦纳卡]
[让我帮你安排]
[保存调整] disabled
```

只有 Draft 的停留区域覆盖、必去约束、合法引用和最小总天数要求满足后，才允许一次原子保存。超出旅行总天数不再阻止手工保存，但必须作为可见警告保留；系统不得静默删减天数。

自然语言同样遵守：

```text
“皇后镇少一天”
```

如果用户没有说明这一天如何重新分配，系统不能偷偷决定；应形成未完成 Draft 或直接给 2–3 个重新分配建议。

用户明确说“你合理分配”时，可以由 AI 完成 Proposal。

## 13.1 交通连接段是 Stay Block 间的 UI 表达

`transferModeFromPrevious` 继续表示“进入当前 Stay Block 的交通方式”，不新增第二份跨区域交通事实。UI 将其从地点卡移到上下 Stay Block 之间的轻量连接段：

```text
方向/交通图标
交通方式选择
Provider 距离 + 预计时长
重新生成路线
```

普通连接段不重复显示上下地点名；只有明确出发地且首站不同于出发地时，首段显示一次出发地。地图结果只在已保存行程且 Provider 返回后显示。航班和轮渡没有陆路 Provider geometry 时，地图展示层以两个已定位端点生成虚线直线；这只是可视化关系，不生成距离、时长或虚构 Provider 路线。草稿修改、待定位、待计算或失效时显示真实状态；草稿先原子保存，再异步更新受影响路线。连接段可复用对应到达日的地图预览和聚焦，但交通方式选择和重新生成不能触发地图聚焦。

---

# 14. Skeleton Save 使用专用原子服务，不受通用 100 PlanCommand 上限约束

现有通用 Proposal / PlanCommand 适合局部编辑，但 90 天大范围 Skeleton Replan 可能超过 100 command 上限。

因此新增服务端专用原子边界：

```text
applySkeletonPlanV3()
```

职责：

```text
校验 Skeleton Draft
校验 must / want / optional coverage
formalize / reuse stayBlockId
展开 canonical Days
复用 Day ID
计算 old/new Macro Diff
计算 affectedDayIds
原子 CAS 写入
更新 macroBasisFingerprint
```

UI / AI 仍可以生成 Proposal / Diff 给用户确认，但 Save 不必机械展开为数百条通用 PlanCommand。

这不是新增第二事实源；最终事实仍是 canonical Day。

---

# 15. Day ID 与 Stay Block ID 复用

Replan 优先：

```text
1 相同稳定 stayBlockId + block 内相对日
2 相同 Planning Area + 相邻结构 / occurrence 匹配
3 相同 Macro signature
4 相同 end Planning Area
5 最后才新建 Day ID
```

只有真正受 Macro Diff 影响的 Day 才进入 `needs_review`。

未受影响 Detailed Day 的 Stop / Route / detailStatus 保持不变。

---

# 16. Macro Dependency Fingerprint：macroDirty 必须派生，不双写

canonical 只保存：

```ts
planningState?: {
  macroBasisVersion: 1;
  macroBasisFingerprint: string | null;
};
```

**不持久化 `macroDirty` 布尔值。**

运行时派生：

```ts
macroDirty =
  currentMacroDependencyFingerprint !== macroBasisFingerprint;
```

缺少 fingerprint：

```text
needs_confirmation
```

Fingerprint 包含真正影响宏观规划的输入：

```text
旅行总天数 / 日期
origin
交通偏好
pace
travelers
重要 constraints / themes / preferences
Planning Area identity + preference
Core parent + preference + duration + role
```

不包含：

```text
纯显示名
Resolution 状态
坐标微调
Provider ID
普通 Detail Interest
AI score
```

旧 Skeleton 无 fingerprint：不自动迁移、不自动 replan；Step 3 用户只看到“需要确认路线和天数”，主动保存后建立基线。

UI 永远不直接显示 `macroDirty` / fingerprint。

---

# 17. Resolution / 未定位完整边界

## 17.1 Planning Area unresolved

```text
Step 2：可显示轻量“尚未定位”
Step 3：允许做语义 Skeleton
Macro Route：标记待定位，不伪造 geometry / distance / duration
Step 5：只要某 Detailed Day 使用 unresolved Anchor，则阻塞该 Day 的 Detailed Generate / Update
```

因此 Step 3 与地图解析解耦，但 Step 5 的真实日程与路线不能伪造 Anchor。

## 17.2 Core Visit unresolved

```text
Step 3：仍可参与时间预算
must_go：阻塞相关 Detail Generate / Update
want_to_go / optional：不能成为 Stop，可保留 unscheduled reason
```

## 17.3 Detail Interest unresolved

```text
must_go：阻塞相关 Detail Generate / Update
want_to_go / optional：不进入 Stop，不阻塞其他可用地点
```

## 17.4 origin unresolved

若 origin 会成为某 Day 的真实 startAnchor：

```text
Step 3 可先形成语义 Day
Step 5 / Provider Route 前必须 resolved
```

任何 unresolved 都不得用城市中心 / 猜测坐标伪装 resolved。

UI 分级：

```text
非阻塞 unresolved → 轻量状态
真正阻塞下一步 → 明确行动卡
```

不把 Resolution 状态机直接暴露给用户。

---

# 18. Step 4：Capacity-Aware Interests / 补充景点（可选）

Step 4 是可选增强步骤，不是必须经过一次 AI Discovery 的 gate。

只有 Skeleton Ready 才允许 AI discovery。

第一次进入 Step 4：

```text
只展示已有内容
不自动批量发现
```

用户可以直接：

```text
下一步：每日行程
```

也可以主动：

```text
帮我补充景点
```

输入至少包含：

```text
Planning Area
采用的 Stay Blocks / stayDays
arrival transfer burden
Core Visits
已有 Detail Interests
TripFacts
pace
```

AI 只返回 `detail_interest`，每个 Planning Area 本轮 0–9，允许 0，不凑数量。

未进入 Skeleton 的 optional Planning Area 默认不做 capacity-aware discovery；如用户之后把它纳入 Step 3，再为它发现兴趣点。

Skeleton Dirty 时：

```text
允许浏览 / 手工编辑 / 定位
禁止按旧容量 AI discovery
UI 紧凑提示路线和天数需要更新
点击后自动切换 Step 3
```

---

# 19. Step 5：Detailed Itinerary

Step 5 负责：

```text
每天具体地点
Core Visit 放在哪一天
Detail Interest 选择
时间
Stop 顺序
Detail Route
```

不得修改：

```text
Stay Block 顺序
stayDays
Day start/end Anchor
Day identity
transfer-day 结构
```

若发现 Skeleton 不合理：

```text
requiresWorkflowStep = skeleton
```

用户体验：自动切换到“路线和天数”，展示需要处理的内容；不显示内部 WorkflowStep。

## 19.1 排程优先级

```text
core + must_go     → resolved 后必须安排
core + want_to_go  → 优先；失败必须解释
core + optional    → 可不安排

detail + must_go   → resolved 后必须安排
detail + want/opt  → 按容量 / 路线 / pace 选择
```

## 19.2 Detail Update 最小 Diff

只处理 `affectedDayIds`。

当前已保存 Detailed Day 是 sticky baseline：

```text
能保留的 Stop 保留
能保留的顺序保留
能保留的时间保留
用户已确认的手工调整优先保留
```

如果必须大改某一天，Proposal / Update Card 显示用户可读 Diff，不显示内部 IDs。

---

# 20. Role-Aware Impact Analyzer

统一：

```ts
analyzeItineraryImpactV3()
```

先计算 before / after 的 effectivePlanningRole。

Planning Area / Core / 重要 TripFacts 变化：

```text
current fingerprint 改变
→ derived macroDirty=true
```

普通 Detail Interest：

```text
新增 optional / want
→ Skeleton 不变，Detail 不立即失效

新增 / 升级 must_go
→ 只影响可承载的相关 Detail Day

删除未使用
→ 不影响已有 Day

删除已排入
→ 只影响实际使用它的 Day
```

Resolution / 坐标变化只刷新相关 Route，不改变 Macro Fingerprint。

UI 不显示 analyzer / dirty / affectedDayIds，只显示翻译后的范围和下一步。

---

# 21. Replan 后二次 Diff

Core Change 不直接让整趟 Detail 失效。

```text
Macro dependency change
↓
derived macroDirty
↓
用户主动 Step 3 Replan / Save
↓
Compare old/new Stay Blocks + Macro Days
↓
affectedDayIds
↓
只扩展这些 Day needs_review
```

若 Macro 结果完全相同：

```text
macroBasisFingerprint 更新为 current
Skeleton 结构保持
只更新 Core 所属区域 Detail
```

用户看到：

```text
路线和停留天数无需调整。
只需要更新蒂阿瑙的每日安排。
```

---

# 22. Step 状态

内部：

```text
Step 1
基本 TripFacts 存在 → ready

Step 2
至少存在一个 non-excluded Planning Area → 可进入 Step 3

Step 3
存在合法 Skeleton
+ macroBasisFingerprint current
→ ready

旧 Skeleton 无 fingerprint
→ needs_confirmation

Step 4
Step 3 非 ready → 禁止 AI discovery，但仍可跳过页面 / 浏览已有内容

Step 5
Step 3 非 ready → 禁止 Detailed Generate / Update
使用到 unresolved Anchor / must_go Stop → 局部阻塞
```

`macroDirty` 是运行时派生状态，不是持久化字段。

Day 继续：

```ts
detailStatus = "ready" | "needs_review";
```

用户态只允许：

```text
已完成
需更新
未开始
处理中
需要处理
尚未定位
```

且状态必须配自然语言行动提示。

---

# 23. Context Builder

建议新增：

```text
apps/server/planning-context-v3.ts
```

纯函数：

```ts
buildBackboneContextV3()
buildSkeletonContextV3()
buildInterestAreaContextV3()
buildDetailPlanningContextV3()
```

Skeleton Context 需包含：

```text
Planning Areas + preference
Core Visits + preference / duration
当前 Stay Blocks
omitted Planning Areas
current vs basis fingerprint state
```

Detail Context 只窗口化相关 Day / Block，并带 sticky baseline。

继续遵守 Context budget。

---

# 24. Prompt / Action 合同

## 24.1 destination.generate

只生成 Planning Area + Core Visit；允许 mixed parent ref；禁止普通兴趣点。

Prompt 必须理解 Step 2 是“候选愿望清单”，不要因为总天数限制提前过度裁掉可考虑的 `want_to_go / optional`。

## 24.2 skeleton generate / replan

成功输出：

```ts
{
  type: "success";
  stays: SkeletonStayDraft[];
  omittedPlanningAreas: OmittedPlanningArea[];
}
```

校验：

```text
must_go Planning Area 全覆盖
non-excluded Planning Area = represented + omitted
同一 Planning Area 可出现多个 Stay Block
stayDays 总和 = trip day count
Core 不得作为 stay destination
```

失败 / 上游不足：

```ts
{
  type: "requires_workflow_step";
  requiresWorkflowStep: "requirements" | "backbone";
  reason: string;
}
```

## 24.3 interest.discover

只返回 detail_interest，0–9，允许 0；Step 4 可跳过，不把“必须发现兴趣点”作为进入 Step 5 的条件。

## 24.4 detail generate / update

固定 Macro；update 只返回 affectedDayIds；遇到 Macro 问题：

```text
requiresWorkflowStep = skeleton
```

---

# 25. Provider / Map 边界

所有 Candidate：

```text
先保存
再 best-effort resolve
```

失败：

```text
保留 Candidate
不自动补位
不回滚其他区域
```

AI 不生产可信：

```text
坐标
Provider Place ID
geometry
distance
duration
```

Macro Route：Day Anchor → Anchor。  
Detail Route：真实 Stop Sequence。  
两种 Route 互不覆盖。

地图仍只展示 / 选择 / Provider 事实，不增加第二套编辑器。

---

# 26. 数据库与兼容策略

保持：

```text
PRAGMA user_version = 3
```

本专项不做：

```text
v3 → v4 migration
旧 loader
双写
自动私人数据库 rewrite
```

新增 `planningRole?`、`planningState?`、`Day.stayBlockId?` 使用 optional backward-compatible JSON 读取。

旧数据不因普通加载自动回写；只有用户主动执行对应业务更新时，新字段才随新的 canonical 结果写入。

---

# 27. 建议新增 / 修改代码边界

服务端重点：

```text
apps/server/contracts-v2.ts
apps/server/planning-roles-v3.ts               新增
apps/server/planning-context-v3.ts             新增
apps/server/itinerary-workflow-v3.ts
apps/server/itinerary-impact-v3.ts
apps/server/ai-action-contracts-v3.ts
apps/server/ai-action-input-contracts-v3.ts
apps/server/ai-stage-contracts-v3.ts
apps/server/ai-registries-v3.ts
apps/server/candidate-workflow-v2.ts
apps/server/planner-runtime-v3.ts
```

Skeleton 相关纯逻辑尽量拆出：

```text
normalizeSkeletonDraft()
validateSkeletonCoverage()
formalizeStayBlockIds()
expandSkeletonDays()
diffMacroDays()
applySkeletonPlanV3()
```

避免继续扩大 Runtime。

前端重点：

```text
apps/web/src/v2-types.ts
apps/web/src/v3-types.ts
apps/web/src/AppV3.tsx
apps/web/src/CandidatePanel.tsx
apps/web/src/MacroItineraryPanelV3.tsx
apps/web/src/ItineraryPanelV2.tsx
apps/web/src/WorkspaceMapV2.tsx
```

前端新增明确的“用户语言转换层”：工程状态不得直接透传为 UI 标签。

---

# 28. 实施顺序

正式实施前先做只读差异审查；随后遵循：

> **先让消费者理解新数据，再让上游生产新数据；最后统一做复杂度下沉的 UI 集成。**

再次强调：本节列出的测试文件和测试场景全部用于**对应 Phase 完成后的 Codex 阶段测试提示词**，实施 Agent 本身不执行测试。

每个 Phase 的固定结束动作都是：

```text
完成当前 Phase
→ 静态总结本 Phase 改了什么
→ 生成当前 Phase 专属 Codex 测试提示词
→ STOP
→ 等待用户在 Codex 测试并明确确认
```

没有用户明确确认，不得进入下一 Phase。

## Phase 0：Read-only Gap Review

不改代码，只列：

```text
当前 schema / contracts 与本文差异
当前 Skeleton 单目的地一次限制
当前 requiresStage 限制
当前 Resolution readiness
当前 100 PlanCommand 限制
当前 UI 入口
当前哪些工程状态会直接泄露到 UI
```

产出逐文件差异清单。

### Phase 0 Gate

Phase 0 完成后立即停止，交付一份 **Codex 差异审查验证提示词**，要求 Codex 只读验证：

```text
- gap list 是否覆盖实际相关文件
- KEEP / EXTEND / REPLACE / DO NOT TOUCH 分类是否合理
- 是否误判已经存在的能力
- 是否遗漏会影响 Phase 1–6 的现有耦合
- 不改代码、不跑未来功能测试
```

用户明确确认 Phase 0 通过后，才进入 Phase 1。

## Phase 1：Role + Contract Foundation

完成：

```text
PlanningRole optional schema
Day.stayBlockId optional schema
planningState 仅保存 fingerprint
runtime-derived macroDirty
effectivePlanningRole helpers
requiresWorkflowStep contracts
legacy compatibility
frontend types
```

### Phase 1 Codex Gate Prompt 必须覆盖

```text
contracts-v2.test.ts
planning-roles-v3.test.ts
ai-action-contracts-v3.test.ts
```

必须验证：

```text
旧 Candidate / Day 可读
planningRole 新旧兼容
非法 role / parent 被拒绝
Day.stayBlockId optional 兼容
planningState 不持久化 macroDirty
无 fingerprint → needs_confirmation
requiresWorkflowStep 合同正确
```

不要测试 Phase 2 以后尚未实施的 Skeleton / Core Producer / UI 功能。

Phase 1 完成后必须 STOP，交付 Phase 1 Codex 测试提示词；只有用户明确确认通过，才进入 Phase 2。

## Phase 2：Skeleton + Impact Consumer Foundation

**先改消费者，再让 Step 2 开始生产 Core。**

完成：

```text
preference-aware Skeleton coverage
repeated Planning Area
stable stayBlockId
arrival transfer day
SkeletonEditDraft validation
applySkeletonPlanV3 atomic Save
Day ID reuse
Macro fingerprint
Impact Analyzer
Planning Area unresolved semantic Skeleton
```

### Phase 2 Codex Gate Prompt 必须覆盖

```text
itinerary-workflow-v3.test.ts
itinerary-impact-v3.test.ts
ai-stage-contracts-v3.test.ts
stage-context-v3.test.ts
```

核心场景：

```text
Auckland → ... → Auckland
must / want / optional coverage
20 天 draft 分配校验
90 天 Save 不受 100 command 上限阻断
arrival transfer day 计入到达 Stay Block
stable stayBlockId / Day ID reuse
Macro fingerprint / impact scope
Planning Area unresolved 仍可形成语义 Skeleton
```

Phase 2 提示词必须包含 Phase 1 合同的必要回归，但不要求 Phase 3 的 Mixed Backbone Producer 已存在。

Phase 2 完成后必须 STOP；只有用户在 Codex 验证并明确确认通过，才进入 Phase 3。

## Phase 3：Backbone Producer

完成：

```text
Mixed Planning Area + Core Visit output
ParentCandidateRef
two-pass formalization
duplicate role upgrade
preserve preference
reparent conflict
Step 2 Core management
Resolver
```

只有到本 Phase，新的 `destination.generate` 才开始正式生产 Core Visit。

### Phase 3 Codex Gate Prompt 必须覆盖

```text
candidate-workflow-v2.test.ts
planner-runtime-v3-ai-actions.test.ts
ai-action-contracts-v3.test.ts（必要回归）
```

核心场景：

```text
Planning Area + Core Visit mixed output
两阶段 parent formalization
existing detail → incoming core 升级
existing core 不被 incoming detail 静默降级
preference 不被 discovery 覆盖
parent 冲突不静默 reparent
新 Candidate save-first + best-effort resolver
Core 不成为 Macro Anchor
```

不要求 Phase 4 的 capacity-aware interest discovery 或 Phase 5 的完整详细行程已经实施。

Phase 3 完成后必须 STOP；用户明确确认通过后才进入 Phase 4。

## Phase 4：Capacity-Aware Interests

完成：

```text
只针对采用的 Skeleton 容量 discovery
0–9 detail only
Core duplicate prevention
首次进入不自动 discovery
Step 4 可跳过，不作为 Step 5 gate
Core Step 4 只读背景
role upgrade 走 Step 2 归属逻辑
```

### Phase 4 Codex Gate Prompt 必须覆盖

```text
interest-discovery-v3.test.ts
candidate-discovery-policy-v2.test.ts
workspace-v2.test.ts
planner-runtime-v3-ai-actions.test.ts
```

核心场景：

```text
只针对已采用 Planning Area 做 capacity-aware discovery
0–9 个 detail_interest，允许 0
不重复 Core Visit
首次进入不自动发现
Step 4 可跳过
Skeleton Dirty 时禁止按旧容量 discovery
Detail → Core 只发起 Step 2 归属流程
save-first / 单区域失败不回滚其他区域
```

Phase 4 提示词只做必要的 Phase 1–3 回归，不要求 Phase 5 Detailed Itinerary 或 Phase 6 最终 UI 已完成。

Phase 4 完成后必须 STOP；用户明确确认通过后才进入 Phase 5。

## Phase 5：Detailed Itinerary

完成：

```text
role-aware Detail Context
Anchor / Core / Detail unresolved readiness
Core scheduling priority
unscheduled reasons
patch-only affectedDayIds
sticky baseline
minimal diff
requiresWorkflowStep=skeleton
```

### Phase 5 Codex Gate Prompt 必须覆盖

```text
itinerary-workflow-v3.test.ts
itinerary-impact-v3.test.ts
planner-runtime-v3-ai-actions.test.ts
```

核心场景：

```text
Core must_go resolved → 必须安排
Core want_to_go → 优先，失败有理由
Detail must_go resolved → 必须安排
Planning Area / origin Anchor unresolved → 只阻塞相关真实 Detail
must_go Core / Detail unresolved → 只阻塞相关范围
patch-only affectedDayIds
sticky existing Detailed Day
最小化 Stop / 顺序 / 时间 Diff
Macro 不合理 → requiresWorkflowStep=skeleton
Step 4 未运行 discovery 也可在已有地点足够时进入 Step 5
```

Phase 5 提示词必须回归 Macro / stayBlockId / fingerprint 的关键契约，但不要求 Phase 6 UI 复杂度下沉已经完成。

Phase 5 完成后必须 STOP；用户明确确认通过后才进入 Phase 6。

## Phase 6：UI / Map Integration + Complexity Downshift

本 Phase 不只是“把五步画出来”，还必须完成用户复杂度下沉。

完成：

```text
右侧五步导航
Step 2 文案 = 想去哪些地方 / 愿望清单
Step 3 文案 = 路线和天数
Step 4 标记可选并允许直接进入 Step 5
Backbone Candidate Panel
Step 3 时间轴 / Stay Block
Skeleton Edit Draft + 自然语言“还差 N 天”
原子保存
Preference 主 UI 只强调“必去 / 想去”
optional 默认弱化显示，excluded 用“移除 / 不考虑”表达
重要游览地使用自然语言，不做 planningRole 编辑器
omitted want-to-go 用折叠原因，optional omitted 次级收纳
Update Card 默认紧凑 + 查看原因渐进披露
未定位按“非阻塞轻量 / 阻塞突出”分级
requiresWorkflowStep 自动切换上下文
工程术语不直接出现在普通 UI
唯一业务入口
Map role filtering
```

### Phase 6 Codex Gate Prompt 必须覆盖

优先使用现有前端测试 / isolated Browser E2E；如果环境缺少浏览器能力则明确 `BLOCKED`，不得伪造通过。

至少验证：

```text
五步导航只在右侧主工作区
Step 2 = 想去哪些地方，表达愿望清单而非最终路线
Step 3 = 路线和天数
Step 4 明确可选且可直接进入 Step 5
19/20 天显示“还剩 1 天需要安排”，而不是工程 Draft 状态
主 UI 主要使用“必去 / 想去”
不把 planningRole / stayBlockId / fingerprint / macroDirty / affectedDayIds / WorkflowStep / CAS / Resolution 暴露给普通用户
Update Card 默认紧凑，可渐进展开原因
未定位按阻塞程度分级
跨步骤意图自动切换正确上下文，但不静默 mutation
地图 / 时间轴只展示选择，没有第二套业务编辑入口
环线两个 Auckland Stay Block 独立展示 / 选择
```

Phase 6 提示词还应做关键端到端回归，但不能把 Phase 7 的最终综合回归当作本阶段可以省略的理由。

Phase 6 完成后必须 STOP；用户明确确认通过后，才进入 Phase 7。

## Phase 7：Docs + Final Codex Regression Handoff

只有 Phase 6 已被用户明确确认通过后，才进入本 Phase。

本 Phase **仍不运行任何测试或验证命令**。

禁止在本次实施环境执行：

```text
git diff --check
Vitest / Jest
typecheck
全量测试
build
真实 AI smoke
Browser E2E
GitHub Actions 测试工作流
```

本 Phase 只做：

```text
1. 静态 review 最终代码 / diff 与施工图是否一致
2. 更新必要文档 / handoff 信息
3. 生成一份完整、可直接复制给 Codex 的最终综合回归测试提示词
4. STOP，等待用户在 Codex 完成最终回归
```

最终 Codex 回归提示词至少必须要求 Codex：

```text
先只读 review 实际 diff 与施工图
读取 package.json / 现有测试脚本，不凭空发明命令
执行 git diff --check
执行 Phase 1–6 已使用过的 targeted tests / 必要回归
执行 typecheck
执行全量 Vitest / 项目现有全量测试
执行 build
在环境允许时执行真实 AI smoke
在隔离环境执行 Browser E2E
覆盖第 29 节全部核心场景
逐项记录 PASS / FAIL / BLOCKED 与证据
失败时只诊断并报告，不自动修改代码，除非用户另行要求修复
```

Phase 7 最终回归失败时，同样不得宣称本专项完成；由用户决定是否回到对应 Phase 修复并重新走该 Phase 的 Codex Gate。

### 28.7.1 Phase 7 最终 Codex 回归提示词模板

实施 Agent 应根据最终实际改动文件、实际 npm scripts 和实际测试文件，把下面模板补全后直接交给用户：

```text
你现在只负责对 TravelPlanner 本次“五步规划流程重构”做独立最终回归测试与验收。

重要限制：
- 这是测试任务，不是实现任务。
- 先不要修改任何源代码、Prompt、数据库或测试代码。
- 发现失败时先记录、定位、解释，不自动修复；除非我之后明确让你修。
- 不读取或改写真实私人数据库；需要数据时使用项目已有的测试 / isolated 数据路径。
- 以 docs/TravelPlanner 五步规划流程重构实施方案.md 为最高优先级验收依据。
- UI 体验同时对照 docs/五步 UI 交互规范.md。
- 前面 Phase 0–6 已逐阶段验收；本次是最终综合回归，不能用“之前阶段通过”替代当前实际验证。

请按下面顺序执行：

1. 只读 Review
- 查看当前分支相对实施前基线的 diff。
- 核对本次改动是否只围绕五步重构目标，没有无关重构。
- 按 KEEP / EXTEND / REPLACE / DO NOT TOUCH 判断是否复用了已有 staged-v3 设计。
- 重点核对：PlanningRole、stayBlockId、requiresWorkflowStep、Macro fingerprint、Skeleton 原子保存、Impact Analyzer、Resolution readiness、Step 4 可跳过、复杂度下沉、唯一业务入口。

2. 静态完整性
- 运行 git diff --check。
- 读取 package.json 和 workspace scripts，确认项目真实可用的 test / typecheck / build 命令。
- 不猜测不存在的脚本。

3. Targeted Tests
至少覆盖本次各 Phase 已确认的相关测试：
- contracts-v2.test.ts
- planning-roles-v3.test.ts
- ai-action-contracts-v3.test.ts
- itinerary-workflow-v3.test.ts
- itinerary-impact-v3.test.ts
- ai-stage-contracts-v3.test.ts
- stage-context-v3.test.ts
- candidate-workflow-v2.test.ts
- planner-runtime-v3-ai-actions.test.ts
- interest-discovery-v3.test.ts
- candidate-discovery-policy-v2.test.ts
- workspace-v2.test.ts
如实际文件名因实现调整而变化，先说明映射关系再执行对应测试。

4. Typecheck / Full Test / Build
- 执行项目现有 typecheck。
- 执行项目现有全量测试。
- 执行项目现有 build。

5. 核心业务场景
逐项验证并给出证据：
- must / want / optional / excluded Planning Area 语义正确。
- Auckland → ... → Auckland 可以形成两个稳定 Stay Block，互不错误合并。
- Step 3 19/20 天不能保存，20/20 天可原子保存，21/20 天显示警告但也可原子保存且不截断日段。
- 90 天大范围 Skeleton 更新不受通用 100 PlanCommand 上限阻断。
- Milford Sound 可作为 Core Visit 影响时间预算，但不成为 Macro Anchor。
- Planning Area unresolved 可做 Step 3，但真实 Step 5 Anchor 必须 resolved。
- must_go Core / Detail unresolved 只阻塞相关 Detail。
- Detail → Core 后只传播到相关 Macro / Detail 范围。
- Replan 后 Macro 不变时，只更新相关区域 Detail。
- Macro 天数变化只使真实 affectedDayIds 需更新。
- Step 4 可以完全跳过 discovery 后直接进入 Step 5。
- Step 5 提出“蒂阿瑙再加一天”时自动切换到 Step 3 上下文，不静默跨步骤 mutation。
- UI 主操作只突出“必去 / 想去”，不要求用户理解四级内部 preference。
- UI 不暴露 planningRole / stayBlockId / fingerprint / macroDirty / affectedDayIds / WorkflowStep / CAS / Resolution 等工程术语。
- Update Card 默认紧凑，详细原因渐进展开。
- 地图 / 时间轴只展示和选择，业务 mutation 仍只有右侧唯一入口。

6. 真实 AI Smoke
如果当前测试环境已有合法 AI 配置且项目已有 smoke 方法，则执行最小 smoke：
- Step 2 能生成 Planning Area + Core Visit。
- Step 3 能生成合法 Skeleton。
- Step 4 discovery 只生成 detail_interest。
- Step 5 固定 Macro 生成 Detailed Itinerary。
如果环境缺少 AI 凭据，标记 BLOCKED，不要伪造通过。

7. Browser E2E
如果项目已有隔离 E2E 方法，则至少验证：
- 五步导航在右侧。
- Step 2 = 想去哪些地方。
- Step 3 = 路线和天数。
- Step 4 明确可选且可跳过。
- Step 3 时间分配不足时显示自然语言“还剩 N 天需要安排”。
- unresolved 非阻塞时轻量显示，真正阻塞时才出现行动卡。
- 跨步骤意图自动切换上下文。
- 地图没有第二套业务编辑入口。
不要使用或污染真实私人旅行数据。

8. 最终报告
请输出：
- 总体结论：PASS / FAIL / PARTIAL
- 实际执行过的命令
- Targeted Tests 结果
- Typecheck 结果
- Full Test 结果
- Build 结果
- AI Smoke 结果
- Browser E2E 结果
- 第 5 节每个核心业务场景的 PASS / FAIL / BLOCKED
- 发现的问题，按 P0 / P1 / P2 排序
- 每个失败对应的文件 / 行为 / 复现方式
- 明确哪些项目因为环境原因没有验证

再次强调：先测试和报告，不自动修代码。
```

实施 Agent 可以根据最终实际文件名和 npm scripts 对这份提示词做事实性补全，但不得弱化上述验收范围。

---

# 29. 必须验收的核心场景

以下场景必须分配到对应 Phase 的 Codex Gate 中逐阶段验证，并在 Phase 7 最终综合回归中再次覆盖。本次实施环境只负责实现与静态检查，不实际运行。

## 29.1 用户复杂度

普通用户不理解：

```text
PlanningRole
Macro
Skeleton
fingerprint
dirty
affectedDayIds
Resolution
WorkflowStep
```

仍能完整走完：

```text
旅行需求
→ 想去哪些地方
→ 路线和天数
→ 可选补充景点
→ 每日行程
```

## 29.2 Preference 选择

Planning Areas：

```text
A must_go
B want_to_go
C optional
D excluded
```

Step 3：

```text
A 必须进入
B 优先；若 omitted 必须解释
C 可 omitted
D 绝不能进入
```

UI 主操作只需要“必去 / 想去”；C 默认可以无 Badge，D 通过移除 / 不考虑表达。

## 29.3 新西兰 20 天

```text
Te Anau = planning_area
Milford Sound = core_visit
parent = Te Anau
```

Milford：

```text
不成为 city
不成为 Stay Block / Macro Anchor
影响 Te Anau 时间预算
Step 5 成为 Stop
```

用户只看到：

```text
Milford Sound · 重要游览地 · 必去 · 预计全天
```

## 29.4 环线

```text
Auckland #1
...
Auckland #2
```

两个 Block 有不同稳定 `stayBlockId`，修改其中一个不默认改另一个；UI 不显示 ID。

## 29.5 Step 3 手工分配

```text
Queenstown 4 → 3
```

若总分配变 19 / 20 天：不能保存；UI 只提示“还剩 1 天需要安排”并给建议。

再：

```text
Te Anau 2 → 3
```

总分配恢复 20 天后，一次原子保存。

若总分配变为 21 / 20 天：显示“当前安排多 1 天；可以继续，之后再调整”，允许保存和继续，保存完整 21 天安排；系统不能自行裁掉某一 Stay Block。

## 29.6 Detail → Core

用户不操作 role 字段，而是说：

```text
这个地方很重要，要单独留一天
```

系统内部：

```text
Detail → Core
→ Impact
→ 用户确认
→ fingerprint 改变
→ Step 3 需重新确认
```

## 29.7 Replan Macro 不变

更新 basis fingerprint，只使 Core 所属区域 Detail 需更新。

用户看到：

```text
路线和天数无需调整，只需要更新蒂阿瑙的每日安排。
```

## 29.8 Macro 天数变化

```text
Te Anau 2 → 3
Queenstown 4 → 3
```

只影响真实 changed Day。

## 29.9 unresolved

```text
Planning Area unresolved
→ Step 3 可规划
→ Macro Route pending
→ Step 5 使用该 Anchor 时阻塞

must_go Core / Detail unresolved
→ 阻塞相关 Detail Generate

want / optional unresolved
→ 不排入 Stop，不阻塞无关 Day
```

UI 非阻塞时轻量，阻塞时才突出。

## 29.10 Step 4 可跳过

用户已有足够地点：

```text
Step 3 Ready
→ Step 4
→ 不运行 discovery
→ 直接 Step 5
```

必须正常生成 Detailed Itinerary。

## 29.11 Update Card 渐进披露

默认：

```text
蒂阿瑙需要更新
预计影响 2 天，其他 18 天不变
[去更新] [查看原因]
```

完整原因只在用户展开后显示。

## 29.12 跨步骤自动上下文

用户在 Step 5 说：

```text
蒂阿瑙再加一天
```

系统自动切换 Step 3 并展示重新分配建议；不能只回复“请去 Step 3”，也不能在 Step 5 静默 mutation。

## 29.13 旧数据

无 `planningRole` / `stayBlockId` / `planningState`：正常读取，不自动写回。

## 29.14 长行程

90 天大范围 Skeleton Replan 使用 `applySkeletonPlanV3` 原子事务，不因通用 100 PlanCommand 上限失败。

---

# 30. 最终架构原则

内部责任：

```text
TripFacts          → 我想进行什么旅行？
Planning Area      → 我在哪里停留和组织路线？
Core Visit         → 哪些重要活动会改变时间预算？
Stay Block         → 以什么顺序停留、每段几天？
Detail Interest    → 固定容量内还有什么值得去？
Detailed Itinerary → 哪一天几点去哪里？
```

用户心智：

```text
我想怎么玩
→ 我想去哪些地方
→ 这些天怎么排
→ 要不要再补点景点
→ 每天具体怎么玩
```

系统必须始终满足：

```text
内部复杂、用户简单
Step 2 是愿望清单，Step 3 才是最终路线
Step 4 可跳过
四级 preference 留在数据层，主 UI 主要使用“必去 / 想去”
Core Visit 保留，但不做工程化 Role 管理器
Stay Block 有稳定身份，但 ID 不暴露
宏观 dirty 由 fingerprint 派生，但用户只看到自然语言影响
跨步骤返回使用 WorkflowStep，但用户体验是自动切换上下文
Step 3 编辑先草稿后原子保存，但用户只看到“还差几天”
Update Card 渐进披露
未定位按阻塞程度展示
上游决定结构，下游补充细节
局部修改只局部失效
地图 / 时间轴只展示与选择
右侧控制台是唯一业务入口
每个 Phase 完成后必须暂停，由用户在 Codex 独立测试并明确确认，才能继续下一 Phase
```

本方案完成文档确认后即可作为下一步代码实施的正式施工图；在用户明确要求实施前，不执行任何代码修改。即便未来进入实施，本专项也不在 GitHub / 当前实施环境运行测试；而是每个 Phase 完成后暂停，交付该 Phase 的 Codex 测试提示词，由用户独立验收并明确确认后，再进入下一 Phase。Phase 7 再做最终综合回归交接。
