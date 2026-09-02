# TravelPlanner Implementation Status

> 更新时间：2026-09-03  
> 当前状态：**五步重构 Phase 1–6 已实施并逐阶段通过独立 Codex Gate；Phase 7 正在做最终综合回归交接，尚未最终验收完成**

---

# 1. Current Gate

当前分支：

```text
feature/five-step-workflow-refactor
```

实施前 `main` / merge-base：

```text
b048c1980247443b5d6568ddd4302c41c9ce832b
```

Phase 6 最终 PASS HEAD：

```text
0f8cdd2bdb58b248cc39aefbd05c8cdfd0ce2ae7
```

Phase 7 只允许：

```text
静态 review 最终 diff
更新文档与交接信息
生成最终 Codex 综合回归提示词
STOP
```

本实施 Agent 在 Phase 7 不运行：

```text
git diff --check
Vitest / Jest
typecheck
full test
build
真实 AI smoke
Browser E2E
GitHub Actions 测试工作流
```

这些由最终 Codex Gate 独立执行。

---

# 2. 已完成的 Phase Gate

```text
Phase 0 Read-only Gap Review                  DONE
Phase 1 Role + Contract Foundation            PASS
Phase 2 Skeleton + Impact Consumer Foundation PASS
Phase 3 Backbone Producer                    PASS
Phase 4 Capacity-Aware Interests             PASS
Phase 5 Detailed Itinerary                   PASS
Phase 6 UI / Map + Complexity Downshift      PASS
Phase 7 Docs + Final Regression Handoff       IN PROGRESS
```

关键 Gate 证据：

```text
Phase 1：23 targeted tests PASS
Phase 2：38 targeted tests PASS
Phase 3：33 targeted tests PASS
Phase 4：39 targeted tests PASS
Phase 5：50 targeted tests PASS，Errors 0，exit 0
Phase 6 Repair Gate：67 targeted tests PASS，web/server typecheck PASS，isolated Browser J/K PASS
```

这些逐阶段 PASS 不能替代 Phase 7 的当前最终综合回归。

---

# 3. 当前用户五步已经落地

Mounted 产品主入口：

```text
main.tsx
→ AppWorkflowV3
```

用户流程：

```text
1 旅行需求
2 想去哪些地方
3 路线和天数
4 补充景点（可选）
5 每日行程
```

内部 WorkflowStep：

```text
requirements
backbone
skeleton
interests
detail
```

数据库 / Dialogue / Action ConversationStage 仍是四个：

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

ConversationStage 没有替换 canonical `TripStage`。

---

# 4. 已落地的核心数据与规划合同

## Planning Role

```text
planning_area
core_visit
detail_interest
```

兼容旧 Candidate：

```text
无 planningRole + city     → planning_area
无 planningRole + non-city → detail_interest
```

Canonical 约束：

```text
Planning Area = city + no parent
Core Visit    = non-city + parent Planning Area
Detail        = non-city + parent Planning Area
```

Core Visit 影响时间预算，但永不成为 Macro Anchor。

## Preference

数据层继续保留：

```text
must_go
want_to_go
optional
excluded
```

Step 3：

```text
must_go     → 必须采用
want_to_go  → 优先；省略必须解释
optional    → 可省略
excluded    → 不得采用
```

普通 UI 主操作只强调：

```text
必去
想去
```

optional 默认弱化；excluded 通过“移除 / 不考虑”表达。

---

# 5. Skeleton / Stay Block 已落地

Canonical Day 支持：

```ts
stayBlockId?: string;
```

已实现：

```text
同一 Planning Area 可重复出现
Auckland → ... → Auckland 两个独立稳定 Stay Block
移动日计入到达 Stay Block
stable stayBlockId reuse
Day ID reuse
preference-aware coverage
omitted Planning Area reason
```

Step 3 手工编辑使用 UI-only Draft，只有完整合法后才一次保存。

专用边界：

```text
PUT /api/trips/:tripId/skeleton
→ validate whole Draft
→ applySkeletonPlanV3
→ one canonical CAS write
```

因此 90 天大范围 Skeleton 不依赖把整个重规划拆成不超过 100 条通用 PlanCommand。

用户只看到：

```text
还剩 N 天需要安排
还需要减少 N 天
已分配完整
```

不看到 Draft / canonical / CAS / stayBlockId。

---

# 6. Macro Dependency / Impact 已落地

Canonical 只保存：

```ts
planningState?: {
  macroBasisVersion: 1;
  macroBasisFingerprint: string | null;
};
```

不持久化 `macroDirty`。

运行时从 current fingerprint 与 basis fingerprint 派生：

```text
current     → ready
mismatch    → needs_update
无旧 basis → needs_confirmation
```

Impact Analyzer 按角色和依赖传播真实受影响范围；普通 Detail 变化不会默认使全旅程失效。

用户只看到自然语言：

```text
路线和天数需要重新确认
2 天需要更新，其他 18 天保持不变
```

---

# 7. Backbone / Interests 已落地

Step 2 `destination.generate`：

```text
可混合生成 Planning Area + Core Visit
ParentCandidateRef two-pass formalization
正式 parent ID 后再 canonical 保存
Detail → incoming Core 可受控升级
Core 不被 incoming Detail 静默降级
不覆盖已有用户 preference
parent 冲突 fail closed
save-first + best-effort Resolver
```

Step 4：

```text
只针对已采用 Planning Area 的容量发现 Detail
每区域 0–9，允许 0
不重复 Core
Core 只读背景
首次进入不自动 discovery
Skeleton dirty 时禁止按旧容量 AI 批量推荐
Step 4 可完全跳过
```

---

# 8. Detailed Itinerary 已落地

Detail Context 只窗口化相关 Day / Planning Area，并带 sticky baseline。

Resolution readiness：

```text
Planning Area unresolved
→ Step 3 可做语义 Skeleton
→ 真正被 Step 5 Anchor 使用时阻塞相关范围

must_go Core / Detail unresolved
→ 阻塞相关 Detail

want / optional unresolved
→ unavailable / 不排入 Stop
→ 不阻塞无关范围
```

调度优先级：

```text
resolved Core must_go   → 必须安排
resolved Detail must_go → 必须安排
resolved Core want      → 优先；若未排需理由
```

Detail Update：

```text
patch-only affectedDayIds
sticky existing Day
reuse Stop ID
优先 move/update
真正新增/删除才 add/remove
固定 Macro，不允许 Step 5 偷改 Stay Block / Anchor / Day identity
Macro 不合理 → requiresWorkflowStep=skeleton
```

Detailed Generate / Update 已拒绝旧 `requires_stage: interests` 强制 gate，因此 Step 4 不运行 Discovery 也可以进入 Step 5。

---

# 9. UI / Map Complexity Downshift 已落地

主入口：

```text
右侧五步导航 + 当前步骤内容 + Workflow Assistant
```

地图 / 时间轴只负责：

```text
展示
选择
聚焦
```

Marker click 只更新 selection，不产生业务 mutation。

地图点选定位必须先从右侧对象卡发起。

已验证的用户语言边界：

```text
Planning Area → 停留地点 / 停留区域
Core Visit    → 重要游览地
Detail        → 普通景点
```

普通 UI 不要求理解：

```text
planningRole
stayBlockId
fingerprint
macroDirty
affectedDayIds
WorkflowStep
ConversationStage
CAS
Resolution
generation
Candidate ID
Stop ID
```

Update Card 默认紧凑，原因渐进展开。

未定位按是否真正阻塞分级。

候选地图长期偏好图例只显示：

```text
必去
想去
```

---

# 10. 跨步骤 ownership 已落地

Step 2 / Step 3 虽共享 `destinations` ConversationStage，但 Action ownership 分开：

```text
destination.*           → Step 2
itinerary.generate      → Step 3
itinerary.replan        → Step 3
interest.*              → Step 4
itinerary.detail.*      → Step 5
```

`requiresWorkflowStep` 或识别到另一步 Action 时：

```text
自动切换正确 UI context
但不自动确认 Action
不静默 mutation
```

旧 generation 的历史 requires action 不会反复劫持当前 UI。

---

# 11. Step 1 duration bridge

Step 1 表单仍允许自然语言：

```text
20 天左右
2周
7 days
```

`requirements.update` CTA 边界会同步结构化：

```text
requestedDurationDays
```

从而保证 Step 3 UI 与服务端 Skeleton 校验使用同一总天数口径。

明确传入结构化 dates 时不会被自然语言推断覆盖。

---

# 12. 数据库 / Provider 边界没有改变

继续保持：

```text
PRAGMA user_version = 3
private_data/travel-v2.sqlite3
```

本专项没有：

```text
v3 → v4 migration
自动私人数据库 rewrite
双写
修改 Place Resolver 事实来源
修改 Route Provider 事实来源
让 AI 生产可信坐标 / Provider ID / geometry / Provider distance / duration
```

新增 optional 字段由现有 JSON canonical 文档兼容读取；旧数据普通加载不因为这些字段缺失而自动改写。

---

# 13. Final Static Diff Review

实施前基线：

```text
b048c1980247443b5d6568ddd4302c41c9ce832b
```

Phase 7 静态 review 确认分支 diff 集中在：

```text
contracts / role / workflow-step contracts
Skeleton / Impact / Planning Context
Backbone / Interest / Detail producers
Planner Runtime wiring
Step 3 atomic API
five-step mounted UI / Map presentation
Prompt user-language and action ownership
对应 targeted tests
Phase 7 文档 / handoff
```

静态 diff 未出现：

```text
travel-store migration
config/private_data changes
Resolver implementation changes
Route Provider implementation changes
与五步重构无关的大范围业务重构
```

最终是否可合并 / 发布仍以 Phase 7 Codex 综合回归结果为准。

---

# 14. Final Verification Gate

Phase 7 Codex 必须重新独立执行，而不是引用之前 PASS：

```text
git diff --check
Phase 1–6 targeted tests 的并集 / 必要回归
npm run typecheck
npm test
npm run build
isolated Browser E2E
真实 AI smoke（仅当已有合法 AI 配置且项目存在可安全执行的方法）
```

真实 AI smoke 缺配置时应标记 `BLOCKED`，不得伪造 PASS；它是否导致总体不能最终 PASS，由最终报告按施工图和用户决定明确说明。

任何测试 / build / Browser 的真实产品失败都不得在 Gate 中自动修复；先报告，由用户决定回到哪个 Phase 修复。

---

# 15. Current Handoff

当前最准确的交接描述：

> TravelPlanner 五步重构已经完成 Phase 1–6 实施，并通过逐阶段独立 Gate。Phase 7 只负责文档对齐和最终综合回归交接。当前不能因为前六阶段 PASS 就宣称专项最终完成；下一步是使用 Phase 7 提示词由 Codex 对当前 HEAD 做完整回归，得到最终 PASS / FAIL / BLOCKED 证据。

实施 / 验收依据优先级：

```text
用户当前明确决定
→ TravelPlanner 五步规划流程重构实施方案.md
→ 五步 UI 交互规范.md
→ PRODUCT_PLAN.md
→ IMPLEMENTATION_STATUS.md（只说明当前实际完成状态）
```

设计文档中若仍保留 2026-09-02 设计冻结时的历史状态描述，以本文件的实时实施状态为准；不要据此误判当前代码尚未实施。
