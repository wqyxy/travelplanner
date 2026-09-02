# TravelPlanner 分阶段 AI 对话与动作 Agent 重构计划

> 状态：staged-v3 AI Dialogue / Action 架构基线；**2026-09-02 已同步五步 Workflow 设计，五步对应代码尚未实施**  
> 原始重构日期：2026-08-30  
> 五步专项施工图：[`TravelPlanner 五步规划流程重构实施方案.md`](./TravelPlanner%20五步规划流程重构实施方案.md)  
> UI 规范：[`五步 UI 交互规范.md`](./五步%20UI%20交互规范.md)

---

# 1. 目标

本架构解决：

```text
AI 入口缺少阶段确定性
简单对话加载过重
确定性操作不应重复调用 AI
AI 修改必须受 Scope / Proposal / generation 约束
```

本文件负责 **Conversation / Dialogue / Action 架构**。

五步产品 Workflow、PlanningRole、Stay Block、Macro Fingerprint 和增量规划细节，以五步专项施工图为最高优先级。

---

# 2. 最重要的修订：用户 Workflow 五步，ConversationStage 仍四个

以前把四个 ConversationStage 直接等同于用户流程的表述已经废止。

用户可见 Workflow：

```text
1 旅行需求
2 去哪些地方
3 安排路线和天数
4 补充景点
5 每日行程
```

内部 `WorkflowStepV3`：

```ts
type WorkflowStepV3 =
  | "requirements"
  | "backbone"
  | "skeleton"
  | "interests"
  | "detail";
```

数据库 ConversationStage 继续四个：

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

因此：

```text
destinations ConversationStage
= Step 2 Backbone + Step 3 Skeleton 的 Macro Planning 对话空间

itinerary ConversationStage
= Step 5 Detailed Planning 对话空间
```

不增加数据库第五 Stage。

---

# 3. ConversationStage 不是 canonical TripStage

ConversationStage 只用于：

```text
对话 Prompt
消息历史
Codex / model thread
Action Registry namespace
阶段白名单输入
UI 草稿 / 助手状态
```

它不写入 canonical `TravelPlanDocument.stage`，也不替换既有 TripStage。

`WorkflowStep` 同样是 UI / request scope，不成为 canonical 旅行事实。

---

# 4. Conversation 请求增加 workflowStep

前端对话请求必须携带：

```ts
workflowStep
```

服务端校验：

```text
requirements stage ← requirements only

destinations stage ← backbone | skeleton

interests stage ← interests only

itinerary stage ← detail only
```

`workflowStep` 用于：

```text
Prompt 选择
Context Builder
Action 白名单
用户意图归属
```

旧 Message 不迁移。

---

# 5. 右侧控制台仍是唯一 AI / Action 入口

页面产品结构：

```text
地图 / 时间轴 / 路线展示
+
右侧唯一控制台
```

五步导航也在右侧控制台顶部，不新增独立左侧步骤栏。

所有：

```text
AI Composer
Action Card
Proposal
生成 / 更新 CTA
定位修复
流程导航
```

都属于右侧控制台。

地图只允许：

```text
展示
选择
聚焦
```

---

# 6. 业务动作只在归属 WorkflowStep 执行

这是五步修订后的 P0 边界。

```text
requirements
→ requirements.update / clear

backbone
→ destination.generate / add / remove / replace / edit / preference
→ Core Visit 结构管理

skeleton
→ itinerary.generate / itinerary.replan
→ stay order / stayDays / transferMode 的确定性修改

interests
→ interest.discover / supplement / add / remove / replace / edit / preference

detail
→ itinerary.detail.generate / update
→ stop.* / day.optimize / repair / verify / refine
```

跨步骤 CTA 只导航。

例如在 detail 发现 Macro Dirty：

```text
返回导航 action: skeleton
```

而不是从 detail stage 直接执行 `itinerary.replan`。

---

# 7. Stage Dialogue 的职责

Stage Dialogue：

```text
普通回答
澄清
判断是否需要实时 web
识别一个明确动作
识别动作应归属哪个 WorkflowStep
```

Stage Dialogue 不直接：

```text
生成 PlanCommand
修改 canonical 数据
创建子 Agent
自行选择任意 Prompt
绕过 Action Registry
```

普通对话继续优先：

```text
reasoning = none
web = disabled
```

需要时效性核验时：

```text
第一次 → web_required
服务端第二次联网 → 最终回答 / Action
```

---

# 8. AI Composer 在错误步骤收到请求时

例如用户在 Step 4 说：

```text
把这个景点设成重要游览地
```

由于 Core role 管理归 Step 2：

```text
Dialogue 识别 intent
→ 返回 navigate_to_step = backbone
→ 保留 candidate selection / role-change intent
→ Step 2 展示 Impact Card
→ 用户确认后执行
```

不要在 Step 4 建第二套 Core mutation。

类似地，在 Step 5 请求改 Stay Block 天数：

```text
导航 Step 3
```

而不是 itinerary detail Agent 偷改 Macro。

---

# 9. Action Registry

每个 Action Registry entry 固定：

```text
stage
workflowStep allowlist
executor: deterministic | ai
prompt
reasoning level
web policy
input schema
output schema
scope policy
save / proposal policy
```

服务端是唯一调度者。

模型不能自行改变 Action 类型、调用文件 / Shell / MCP 或绕过 Scope。

---

# 10. deterministic 与 AI executor

确定性动作不重复调用模型。

典型：

```text
requirements 明确字段更新
preference
明确删除
明确 role / parent 修改后的 canonical command
Stay Block 手工顺序 / 天数 / transport 修改
Stop 明确移动
日期调整
地图定位重试入口
```

需要语义研究 / 规划的动作使用 AI executor：

```text
destination.generate
interest.discover
itinerary.generate / replan
itinerary.detail.generate / update
语义 replace / optimize / repair / verify
```

---

# 11. Action 确认规则

用户直接点击当前步骤主 CTA：

```text
点击本身就是确认
→ 服务端校验
→ 创建 / 执行 Action
```

不重复弹“是否确认生成”。

自然语言识别出的高影响 Action：

```text
先展示 Action / Impact Card
→ 用户确认
→ 执行
```

需求阶段明确、低风险、受控的 `requirements.update / clear` 可按现有规则直接 deterministic 执行。

---

# 12. Proposal 边界

AI 修改已有规划时继续遵守 Proposal 边界。

Proposal 必须：

```text
显示 scope
diff
影响范围
generation basis
Apply / Reject
```

Apply 时重新校验：

```text
Scope
generation
canonical invariants
```

首次生成 / discovery 类动作可按对应 Action contract save-first 保存新增 Candidate；不能因此绕过地图事实边界。

---

# 13. PlanningRole 对 Dialogue / Action 的影响

五步规划新增：

```text
planning_area
core_visit
detail_interest
```

与：

```text
Place.kind
preference
```

完全独立。

Shared Prompt 和相关 Action Prompt 必须理解三者。

ConversationStage 不再用简单 `city / non-city` 判断 Macro / Micro 权限。

---

# 14. Backbone Dialogue Context

`workflowStep=backbone` 时只提供：

```text
TripFacts
Planning Areas
Core Visits
当前 selection
必要 resolution 摘要
```

不把大量普通 Detail Interest 塞进 Context。

允许识别：

```text
destination.generate / add / remove / replace / edit / preference
Core role / parent 管理
```

---

# 15. Skeleton Dialogue Context

`workflowStep=skeleton` 仍属于 destinations ConversationStage。

Context：

```text
TripFacts
Planning Areas
Core Visits
当前 Stay Block / Macro Day 摘要
Macro Dirty / fingerprint 状态
Macro Route 摘要
当前 selection
```

允许：

```text
itinerary.generate
itinerary.replan
确定性 stayDays / order / transferMode 意图
```

禁止创建新地点。

缺地点时导航 Step 2。

---

# 16. Interests Dialogue Context

提供：

```text
Planning Areas
Stay Blocks / stayDays
arrival transfer burden
Core Visits
Detail Interests
Resolution status
focused area
Skeleton status
```

允许：

```text
interest.discover
interest.supplement
interest.add / remove / replace / edit / preference
```

不直接修改 Core role。

角色升级意图导航 Step 2。

---

# 17. Detail Dialogue Context

提供窗口化：

```text
相关 Day
Stay Block / Macro Anchor
Core Visits
must_go Detail Interests
现有 Detailed Day baseline
unscheduled 状态
Route status
```

继续遵守 64 KB 上下文预算。

允许：

```text
itinerary.detail.generate / update
stop.*
day.optimize
repair
verify
refine
```

禁止创建 Place / Candidate，也禁止修改 Macro Skeleton。

---

# 18. Prompt Registry

目录继续：

```text
prompts/
├─ shared/
├─ dialogues/
└─ actions/
```

共享规则：

```text
旅行规划共享规则.md
```

Dialogue：

```text
旅行需求对话.md
目的地对话.md
兴趣点对话.md
行程对话.md
```

其中 `目的地对话.md` 必须根据 `workflowStep=backbone | skeleton` 切换边界，而不是把两个步骤混成同一种动作权限。

---

# 19. Action Prompt

五步专项至少需要：

```text
actions/destinations/生成目的地建议.md
actions/destinations/新增目的地.md
actions/destinations/替换目的地.md

actions/interests/发现兴趣点.md
actions/interests/补充兴趣点.md
actions/interests/新增兴趣点.md
actions/interests/替换兴趣点.md

actions/itinerary/生成行程.md
actions/itinerary/重新规划行程.md
actions/itinerary/生成每日详细行程.md
actions/itinerary/更新每日详细行程.md
```

精确字段修改不为每个操作新建 AI Prompt。

---

# 20. itinerary.generate / replan 的 Stage 归属修订

Action 名称可以继续叫：

```text
itinerary.generate
itinerary.replan
```

但 Registry 归属改为：

```text
ConversationStage = destinations
WorkflowStep = skeleton
```

这样 Step 3 与 Step 5 不再共享同一个 itinerary 对话空间。

`itinerary` ConversationStage 以后只负责 Step 5 Detailed Planning。

---

# 21. Detailed Update 边界

`itinerary.detail.update` 必须：

```text
patch-only
affectedDayIds only
Macro Anchor / Day identity immutable
当前 Detailed Day 作为 sticky baseline
最小化 Stop / order / time diff
```

需要更新 Macro 时：

```text
返回导航 Step 3
```

而不是在 Detail Action 内偷偷 Replan。

---

# 22. 地图 / Resolution 边界

AI 继续不能产生可信：

```text
坐标
Provider Place ID
route geometry
Provider distance / duration
```

新 Candidate：

```text
先保存
后 best-effort resolve
```

Resolver 失败：

```text
不回滚 Candidate
不补位
显示 unresolved
```

Core Visit unresolved 可以影响 Macro 语义，但不能成为 Detailed Stop。

---

# 23. Thread 与消息持久化

ConversationStage 继续拥有独立消息历史 / thread。

由于 Step 2 / Step 3 共用 destinations ConversationStage：

- 两步可以共享 Macro Planning 对话历史；
- 每轮请求必须带 `workflowStep`；
- Prompt / Context / Action 权限必须按本轮 workflowStep 裁剪；
- 不能因为 thread 里曾讨论 Step 2，就允许 Step 3 创建地点。

数据库消息仍是长期历史事实源，Thread 只是模型性能上下文。

---

# 24. 数据库策略

继续：

```text
private_data/travel-v2.sqlite3
PRAGMA user_version = 3
```

本五步 Workflow 不新增第五 ConversationStage，因此不要求为此 bump 数据库版本。

`planningRole` / `planningState` 采用五步专项文档定义的 optional backward-compatible 策略。

不自动迁移真实私人数据库。

---

# 25. 当前实施关系

staged-v3 Dialogue / Action 基础架构已有代码实施历史，实际状态见：

```text
docs/IMPLEMENTATION_STATUS.md
```

但 2026-09-02 新确认的：

```text
五步 Workflow
PlanningRole 分层
Step 3 Skeleton 独立 UX
Core Visit
Stay Block
Macro Fingerprint
五步 Action ownership
```

**本次只更新文档，没有实施代码，也没有运行对应测试。**

---

# 26. 文档优先级

涉及五步规划时：

```text
当前用户明确决定
→ TravelPlanner 五步规划流程重构实施方案.md
→ 五步 UI 交互规范.md
→ PRODUCT_PLAN.md
→ 本文件的 Dialogue / Action 非冲突部分
→ 其他专项 / 历史文档
```

---

# 27. 最终架构原则

```text
用户 Workflow 可以五步
数据库 ConversationStage 仍四个
WorkflowStep 决定本轮 Prompt / Context / Action 边界
每个业务动作只有一个归属步骤
跨步骤请求只导航，不越权执行
Dialogue 不直接写 canonical
确定性动作不重复调用 AI
AI 修改受 Proposal / Scope / generation 约束
地图 Provider 保持事实来源
```
