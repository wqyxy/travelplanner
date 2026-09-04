# TravelPlanner Implementation Status

> 更新时间：2026-09-04
> 当前分支：`codex/user-control-correction`
> 当前最高优先级：**User Control Correction / 用户控制权修正**
> 当前状态：**最终本地综合 Gate PASS；Draft PR #5 保持 Draft，暂不合并 main，等待用户决定。**

---

# 1. 当前产品原则

TravelPlanner 已从“系统保证旅行计划合理”调整为：

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

Canonical **不负责保证旅行计划符合系统启发式**。日期、天数、时间、地点归属、must-go、excluded、未定位等规划问题默认允许保存，由 Advisory + AI Proposal 负责提醒和建议，最终取舍属于用户。

---

# 2. 历史五步成果继续保留

```text
1 旅行需求
2 想去哪些地方
3 路线和天数
4 补充景点（可选）
5 每日行程
```

历史已实现能力继续保留：

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

此前真实新西兰 20 天旅行的 E2E 证据继续作为历史记录保留，不删除 private_data，也不清理历史 Action / Task。

旧最终 Gate 中包含正在被本专项主动废止的 planning blocker，因此旧 Gate **不能直接作为当前验收标准**。

---

# 3. User Control Correction 已完成

详细设计和实施记录：

```text
docs/USER_CONTROL_CORRECTION.md
docs/USER_CONTROL_CORRECTION_PROGRESS.md
```

## 3.1 Canonical / Structural

- 日期反向、日期与天数不一致、Day 数量不一致、时间不完整、疑似跨夜、duration mismatch、overlap 等不再作为 canonical blocker。
- `scheduleText` 已进入 DayStop / PlanCommand / AI detail contracts / Step 5 UI。
- PlanningRole 与 PlaceKind 已解耦。
- Candidate 可以暂时没有 Planning Area parent。
- semantic/name duplicate 允许保存并由 Advisory 提醒。
- exact same canonical Place ID 仍只能对应一个 Candidate。
- 未知引用、重复 ID、父引用缺失/自引用/循环、Stop Candidate/Place 不一致仍硬失败。

## 3.2 Advisory

新增纯派生：

```text
apps/server/planning-advisories-v3.ts
```

Advisory：

- 不写 canonical；
- 不写 Revision；
- 不持久化 ignored 状态；
- `/workspace` 每次根据当前 plan / resolution 重新计算；
- 前端在右侧步骤区域统一消费。

## 3.3 Candidate / Planning Area

- Planning Area helper 已改为 planningRole 驱动；
- legacy 缺失 planningRole 时仍使用 `city -> planning_area / 其他 -> detail_interest` compatibility fallback，但只用于旧数据读取；
- 新数据的 PlanningRole 与 PlaceKind 完全独立；
- 手工新增地点会原样保存用户选择的 `draft.placeKind`；
- semantic duplicate 不再静默过滤或在 PlanCommand 层硬拒绝；
- `excluded` 不再意味着不可见或不可排入。

## 3.4 Itinerary / PlanCommand / Route

- Detailed apply/runtime 不再因为 unresolved / excluded / city Stop / area membership / overlap / must-go coverage 拒绝。
- preference 改成 `excluded` 不会自动删除已经排入的 Stop。
- 普通 PlanCommand 不再自动重写 Day 日期。
- 未定位 Place 仍可进入 Day/Stop；`DayStop.placeId` 仍必须引用真实 canonical Place。
- Route 保持 best-effort：未定位端点返回 attention/warning，不伪造 Provider 距离、时长、geometry 或 Provider ID。

## 3.5 UI

- 五步导航始终可以进入；
- Step 3 的天数不一致、must-go 省略、excluded 等改为提醒而非保存门槛；
- Step 4 可继续研究/补充，父 Planning Area 可为空，不要求 Step 3 完全 ready；
- Step 5 在未定位、上游需更新、部分/自然时间情况下仍可继续编辑或生成；
- `scheduleText` 已展示；
- 保持“地图/时间轴展示 + 右侧唯一操作入口”的 UI 原则，不做布局重构。

## 3.6 AI Scope

已新增：

```text
{ type: "days", ids: [...] }
```

当前实现：

- 单日 Detail/Refine 使用 Day Scope；
- 多日 `itinerary.detail.update` / `itinerary.refine` 使用 Days Scope；
- Scope Policy 会拒绝范围外 Day / Stop 修改；
- 局部 Stop/Anchor/edit deterministic Action 记录最小 Day Scope；
- 跨日 Stop move 使用 Days Scope；
- `itinerary.day.reorder` 因实际改变整条 Day 顺序，保留 Trip Scope；
- 全局 Generate / 明确 Replan / 全局 Repair / Verify 保留全局语义 Scope。

Read Context 可以比 Mutation Scope 更宽；excluded 候选仍进入 AI read context，并通过 preference 告诉 AI 默认不要主动采用，而不是从上下文中隐藏。

## 3.7 Repair #8

用户明确数字指令继续作为语义约束：

```text
120 天
+120 天
```

已支持多位数字并删除旧 90 天业务上限；只有结果无法形成非负整数天数时才作为结构无效拒绝。

## 3.8 旅行规模业务上限

已移除会改变用户旅行表达能力的旧业务上限，包括前置合同中的：

```text
365 天
90 Day
80 Stop
1800 Candidate / Place
```

继续保留明确的**单次技术资源保护**，例如：

- 单区域兴趣点单次 0–9；
- Refine 小批次；
- Proposal / Verify 单次 100 commands；
- HTTP/body/string/Provider 等安全与资源边界。

---

# 4. 已完成的专项轻量 Gate

2026-09-04 已通过 User Control targeted regression gate：

```text
apps/server/user-control-correction-v3.test.ts
apps/server/user-control-days-scope-v3.test.ts
apps/server/user-control-size-context-v3.test.ts
apps/server/replan-intent-v3.test.ts
```

覆盖重点：

- planning conflicts 可保存；
- structural corruption 仍拒绝；
- excluded scheduled preservation；
- semantic duplicate preservation；
- 普通 command 不自动重写 Day 日期；
- Days Scope 越界拒绝；
- 120+ 天 / 90+ Day / 80+ Stop / 1800+ Candidate 旧业务上限已移除；
- excluded 候选仍进入 AI read context；
- Repair #8 多位数字明确指令。

施工中的 one-shot patch 同时执行过 `git diff --check`。

---

# 5. 最终综合 Gate

2026-09-04 已在用户明确授权后完成：

- 剩余 runtime/discovery 定向测试：3 files / 32 tests PASS；
- User Control targeted：7 files / 48 tests PASS；
- OpenAI Structured Output：8/8 PASS；
- 完整 `npm run typecheck`：PASS；
- 全量 `npm test`：79 files / 455 tests PASS，0 failed；
- 完整 `npm run build`：PASS；
- `git diff --check`：PASS。

剩余旧测试已迁移为 advisory-first 语义；active V3 micro discovery 的 semantic duplicate 静默合并回归已修复。测试夹具会在异常路径关闭 SQLite，并用有限重试清理 Windows 临时目录，未再出现 `EPERM`。

Browser smoke：NOT RUN。服务端路径固定指向项目 `private_data`，本轮不启动可能接触真实私人数据的实例，由用户人工检查 UI。

真实 AI smoke：NOT RUN。项目没有可安全覆盖 `scheduleText` 生成、保存及 null 清除的现成真实 AI smoke，未伪造 PASS，也未发明收费调用。

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
为了“合理”自动删/移/缩短用户内容
因为 source=ai/user 而产生字段权限差异
局部多日 Action 自动升级成 Trip Scope
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

# 7. 当前 Gate

当前状态：

```text
User Control Correction code/docs closeout = COMPLETE
target runtime tests                       = PASS (3 files / 32 tests)
targeted regression gate                   = PASS (7 files / 48 tests)
OpenAI Structured Output                   = PASS (8/8)
typecheck/build                            = PASS
full suite                                 = PASS (79 files / 455 tests, 0 failed)
git diff --check                           = PASS
browser/real AI smoke                      = NOT RUN
Draft PR #5                                = KEEP DRAFT
merge main                                 = NO
```

当前本地结果为 MERGE-READY；是否标记 PR Ready 或合并仍由用户决定，本轮不执行。
