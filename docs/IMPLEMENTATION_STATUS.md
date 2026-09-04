# TravelPlanner Implementation Status

> 更新时间：2026-09-04
> 当前分支：`codex/user-control-correction`
> 当前最高优先级：**User Control Correction / 用户控制权修正**
> 当前状态：**施工中，暂不合并 main；原五步最终综合 Gate 暂缓，待本专项收口后重新定义。**

---

# 1. 为什么插入 User Control Correction

五步规划流程此前已经完成大量实现与真实 E2E，但运行中暴露出一个更底层的产品问题：

```text
系统把“旅行计划是否合理”
当成了
“数据是否允许保存”
```

这会导致：

- 未定位地点无法继续规划；
- `excluded` 一旦出现在 Day 中就失败或被自动删除；
- must-go 未覆盖会阻止保存；
- Planning Area 被强制等同于 `Place.kind=city`；
- 时间不完整、重叠、跨夜、天数不一致会被当成非法数据；
- AI / 代码会为了满足规则自动修正用户已经接受的内容。

现已确认新的产品原则：

```text
Canonical = 用户当前已经接受的旅行方案
Advisory  = 系统发现的规划问题或能力限制
Proposal  = AI 建议发生的修改
Scope     = AI 本轮被允许修改的范围
```

Canonical 只保证：

```text
数据可以可靠保存
引用可以可靠解析
权限与安全边界没有被突破
Provider / 实时事实没有被伪造
```

Canonical **不再负责保证旅行计划合理**。

---

# 2. 历史五步结果

以下历史成果继续保留，不回滚：

```text
1 旅行需求
2 想去哪些地方
3 路线和天数
4 补充景点（可选）
5 每日行程
```

历史已实现能力包括：

- 五步 WorkflowStep 与四 ConversationStage 映射；
- PlanningRole；
- Step 3 Skeleton；
- Step 4 optional interest discovery；
- Step 5 detailed itinerary；
- scoped downstream impact / needs_review；
- Proposal / Apply / Undo；
- generation CAS；
- Route Provider 与 Resolution；
- Provider geometry 不进入 AI transport；
- Repair #8 跨步骤 replan 用户意图恢复；
- private_data 边界与 fresh-v3 fail-closed。

此前真实新西兰 20 天旅行的 E2E 证据继续作为历史验证记录保留，不删除 private_data，也不清理历史 Action / Task。

但旧的“最终综合 Gate”中包含正在被本专项主动废止的规划硬约束，因此旧 Gate **不能直接作为当前验收标准**。

---

# 3. User Control Correction 当前已实施

详细施工记录见：

```text
docs/USER_CONTROL_CORRECTION.md
docs/USER_CONTROL_CORRECTION_PROGRESS.md
```

当前已完成的核心变化：

## Canonical / Structural

- 日期反向、天数不一致、时间不完整、跨夜、duration mismatch、overlap 等不再作为 canonical blocker。
- `scheduleText` 已进入 DayStop。
- PlanningRole 与 PlaceKind 已解耦。
- Candidate 可以暂时没有 Planning Area parent。
- semantic duplicate 允许保存并交给 Advisory。
- exact same canonical Place ID 仍只能对应一个 Candidate。
- 未知引用、重复 ID、父引用缺失/自引用/循环、Stop Candidate/Place 不一致仍硬失败。

## Advisory

新增纯派生：

```text
apps/server/planning-advisories-v3.ts
```

Advisory 不写 canonical、不写 Revision、不持久化 ignored 状态；workspace 每次根据当前 plan / resolution 重新计算。

## Candidate / Planning Area

- Planning Area helper 改为 planningRole 驱动；
- legacy 缺失 planningRole 时仍使用历史 city fallback；
- semantic duplicate 不再静默过滤；
- `excluded` 不再意味着不可见或不可排入。

## Itinerary / PlanCommand

- Detailed apply 不再因为 unresolved / excluded / city Stop / area membership / overlap / must-go coverage 拒绝。
- preference 改成 `excluded` 不再自动删除已经排入的 Stop。
- 普通 PlanCommand 不再自动重写 Day 日期。
- semantic duplicate add_candidate 不再被 PlanCommand 层拒绝。

## UI

- 五步导航始终可以进入；
- Advisory 在右侧步骤区域统一显示；
- Step 3 的天数不一致、must-go 省略、excluded 等改为提醒而非保存门槛；
- Step 4 可继续研究/补充，不再要求 Step 3 完全 ready；
- Step 5 未定位、上游需更新等不再隐藏生成入口；
- 自然时间 / 部分时间已可展示；
- 保持“地图/时间轴展示 + 右侧唯一操作入口”的 UI 原则，不做布局重构。

## AI Scope

已增加：

```text
{ type: "days", ids: [...] }
```

用于表达多日局部写 Scope；Scope Policy 已能拒绝范围外 Day / Stop 修改和局部 Scope 下的整趟 Day 重排。

## Repair #8

继续保留用户明确数字指令的语义约束，并移除旧 90 天业务上限：

```text
120 天
+120 天
```

可以表达；导致负数 stayDays 的指令仍因结构无法成立而拒绝。

---

# 4. 当前剩余收口项

## 4.1 Runtime 多日 Scope

`planner-runtime-v3.ts` 还需把多日：

```text
itinerary.detail.update
itinerary.refine
```

从兼容的 Trip Scope 改为：

```text
1 Day  -> { type: "day", id }
N Days -> { type: "days", ids }
```

读取相邻上下文可以继续更宽，但写入必须只覆盖明确 Day。

整趟首次 generate、用户明确整体 replan、显式全局 repair 可以继续使用 Trip Scope。

## 4.2 手工 PlaceKind 接线

`CandidateWorkflowPanelV3` 已允许用户独立选择：

```text
planningRole
Place.kind
```

`AppWorkflowV3` 的手工 addCandidate 还需确保直接使用：

```text
draft.placeKind
```

而不是继续按 planningRole 自动映射 city/attraction。

---

# 5. 当前测试策略

按项目约定，本专项施工阶段：

- 不自动运行完整 test；
- 不自动运行完整 typecheck；
- 不自动 build；
- 不运行 Browser E2E；
- 不运行真实 AI / private_data E2E。

已经新增 targeted regression test 文件，用来固定：

- canonical structural / advisory 边界；
- excluded scheduled preservation；
- semantic duplicate preservation；
- Day 日期不被普通 command 自动重写；
- 多 Day Proposal Scope；
- Repair #8 多位数字天数。

完整 Gate 要等上述剩余接线完成后重新列出，再由用户确认是否执行。

---

# 6. 不得回归的边界

后续 Agent 不得重新引入：

```text
planning_area 必须 kind=city
未定位不得进入行程
excluded 不得排入 Day
must_go 未覆盖则 canonical reject
时间重叠则 canonical reject
Day 数不等于旅行天数则 canonical reject
为了“合理”自动删用户内容
因为 source=ai/user 而产生字段权限差异
```

继续严格保留：

```text
fresh-v3 / PRAGMA user_version = 3
private_data 不迁移、不删除
CAS
Proposal Apply / Undo
Scope Policy
有效 ID / 引用 / 无 cycle
Provider / realtime fact boundary
登录与安全边界
```

---

# 7. 下一 Gate

当前下一步只做代码收口：

1. runtime 多日 Action 使用 `days` Scope；
2. App 层手工新增使用真实 `draft.placeKind`；
3. 对残留旧 blocker / city-only / max90 规则做只读搜索审核；
4. 更新 PR 状态；
5. 列出 targeted Gate 与完整 Gate 成本。

在这五项完成前：

> **Draft PR 保持 Draft，不合并 main。**
