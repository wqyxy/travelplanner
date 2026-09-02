# TravelPlanner Implementation Status

更新时间：2026-09-02  
实施分支：`refactor/stage-dialogue-actions-v3`

## Current Gate

此前 staged-v3 Dialogue / Action、Candidate-first、地点解析、路线与 itinerary hardening 已有实际代码实施历史。

2026-09-02 新确认了一套五步产品与架构重构方案：

```text
1 旅行需求
2 去哪些地方
3 安排路线和天数
4 补充景点
5 每日行程
```

对应新增 / 更新设计包括：

```text
PlanningRole: planning_area / core_visit / detail_interest
Stay Block 与重复 Planning Area / 环线支持
Macro Dependency Fingerprint
Step 2 Backbone / Step 3 Skeleton 分层
Step 4 capacity-aware Interest Discovery
Step 5 patch-only affectedDayIds 更新
右侧唯一业务入口
跨步骤 CTA 只导航
```

**重要：本次操作只更新设计文档，没有实施上述五步代码，也没有运行对应五步测试。**

因此当前代码仍应视为“五步重构前基线”，不能因为文档已经确认就宣称五步功能已完成。

## Current Implemented Foundation

现有代码已经具备可被五步方案复用的基础能力，包括：

```text
右侧工作区 AI 入口
四个 ConversationStage
Dialogue / Action Registry
确定性 Action 与 AI Action 分离
Proposal / Scope / generation / CAS
Candidate-first / save-first
地图 Resolution 状态
Macro / Detail Route 基础能力
Day detailStatus
```

现有地点解析 hardening 继续作为基础：

```text
新地点保存后 best-effort resolve
resolving / resolved / unresolved 状态可见
有界 Place worker 协作
保留 Provider 全局限速
定位失败不回滚 Candidate
逐 Place 状态刷新
```

五步设计不会改变“地图 Provider 才是可信地理事实来源”的边界。

## Five-Step Design Not Yet Verified In Code

后续实施前必须逐项核对当前代码是否已经满足：

```text
TripCandidate planningRole optional
统一 effectivePlanningRole
Mixed Backbone Destination Output
Core Visit parent formalization
同一 Planning Area 多 Stay Block
移动日计入到达 Stay Block
Step 3 itinerary.generate/replan 归 destinations + skeleton
Step 4 首次进入不自动 discovery
Core Visit 结构只在 Step 2 管理
Step 4 / Step 5 不重复 detail.generate 入口
Macro Fingerprint / macroDirty
旧 Skeleton 无 fingerprint 的 needs confirmation
Detail update patch-only / affectedDayIds
Detailed Day 最小 Diff / sticky baseline
右侧唯一 Action ownership
```

在实际代码 review 之前，不得从设计文档推断这些已经存在。

## Five-Step Future Phases

正式施工图定义：

```text
Phase 1 Role Foundation
Phase 2 Backbone Generation
Phase 3 Workflow + Skeleton
Phase 4 Capacity-Aware Interests
Phase 5 Detailed Itinerary
Phase 6 UI / Map
Phase 7 Docs + Final Verification Preparation
```

目前：

```text
设计文档：已确认
代码实施：未按本次五步方案执行
五步 targeted tests：未运行
五步 typecheck/build：未运行
五步 Browser E2E：未运行
```

## ConversationStage

数据库仍保持四个 ConversationStage：

```text
requirements
destinations
interests
itinerary
```

五步未来映射：

```text
requirements → requirements
backbone     → destinations
skeleton     → destinations
interests    → interests
detail       → itinerary
```

这是已确认设计；后续实施时需要核对 Stage Registry、Context Builder 与 UI 是否逐项符合。

## Data Boundary

当前 staged v3 私人数据库路径仍为：

```text
private_data/travel-v2.sqlite3
```

内部版本仍为：

```text
PRAGMA user_version = 3
```

本次五步文档设计不要求增加第五种数据库 ConversationStage，也不要求为了 Workflow 五步变更数据库版本。

本次操作没有对真实旅行数据执行迁移或内容改写。

## Future Verification

五步代码真正实施完成后，再准备：

```text
git diff --check
targeted Vitest
typecheck
全量 Vitest
build
真实 AI smoke
isolated Browser E2E
```

仍遵守项目规则：最终完整验收需用户明确确认后执行。

本次仅更新文档，所以不运行以上验收。

## Required Browser Scenarios After Implementation

未来至少验证：

```text
新西兰 20 天：
Te Anau = Planning Area
Milford Sound = Core Visit
Milford 不成为 Macro Anchor

环线：
Auckland → ... → Auckland
必须保留两个独立 Stay Block

增量：
普通 optional 兴趣点不使 Skeleton / Detail 失效
Detail → Core 只传播到相关 Macro / Detail
Replan Macro 不变时只更新相关区域 Detail
Macro 天数改变时只更新 affectedDayIds

未定位：
unresolved must_go Core 可参与 Step 3 时间判断
但不能成为 Step 5 真实 Stop

唯一入口：
Step 2 不直接执行 Step 3 Generate
Step 4 不直接执行 Step 5 Generate
地图不承担业务修改
Core 不在 Step 2 / Step 4 各维护一套编辑器
```

## Current Handoff

当前最准确的交接描述：

> staged-v3 已有 Dialogue / Action / Candidate / Resolution / Itinerary 基础代码；2026-09-02 又完成了五步产品与架构重构的正式文档设计，但该五步设计尚未实施。

后续开发应：

```text
先 review 当前代码与五步施工图的差异
→ 再按 Phase 1–6 实施
→ 用户确认后进入最终完整验收
```
