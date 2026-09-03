# TravelPlanner Implementation Status

> 更新时间：2026-09-03
> 当前状态：**五步重构的隔离综合 Gate 已通过；真实 private_data + Real AI E2E 已真实跑通 Step 1–5、Milford、Detail→Core 与 scoped impact。最新唯一核心失败位于 Step 3 增量 replan：跨步骤新增 Wanaka 后，通用“更新受影响安排”丢失了用户原始 +1/-1 天数要求。Repair #8 已实现“因果意图续传 + 明确天数硬约束 + Structured repair”，等待同一保留旅行继续真实验证。**

---

# 1. Current Gate

分支：

```text
feature/five-step-workflow-refactor
```

实施前 `main` / merge-base：

```text
b048c1980247443b5d6568ddd4302c41c9ce832b
```

保留真实 E2E 旅行：

```text
Trip ID: d028c5f7-906e-4027-8fa1-faab7a3b7d71
Title: [五步E2E测试-保留] 新西兰20天南北岛自驾
```

当前真实数据按用户要求继续保留，不清理历史失败 Action / Task。

---

# 2. 已通过的综合 Gate

历史隔离验证：

```text
git diff --check PASS
typecheck PASS
69 test files / 406 tests PASS
build PASS
fresh dist/web production MapLibre PASS
candidate marker render/click/popup PASS
itinerary GeoJSON / routes PASS
F1–F14 PASS
Provider boundary PASS
security/private-data isolated checks PASS
```

后续 Repair #4–#7 的专项测试与 typecheck 也均由用户侧 Codex Gate 通过。

---

# 3. Real Private-Data E2E — 已通过部分

真实授权范围：

```text
private_data/travel-v2.sqlite3
真实 AI
真实 Provider
真实产品 UI
真实数据库写入
```

## Step 1 — PASS

Repair #5 已证明共享 Action normalization 可以把：

```text
brief.duration = "20天"
```

确定性保存为：

```text
dates.requestedDurationDays = 20
```

fresh runtime 实测 generation `3 → 4`，新旧 Action ID 已区分。

## Step 2 — PASS

真实结果：

```text
17 Candidates
8 Planning Areas
9 Core Visits
```

Milford Sound：

```text
core_visit
parent = Te Anau
```

同批 Planning Area / Core parent ref repair 已真实通过，canonical 无 temporary parent ID。

## Step 3 初始 Skeleton — PASS

```text
20 Days
remainingDays = 0
Auckland Day 1 / Day 20 为不同 stayBlockId
Te Anau = Day 14–17
```

## Step 4 — PASS

进入 Step 4 无自动 discovery。

真实数据曾达到：

```text
38 Candidates
38 Places
32 resolved
6 unresolved
```

## Step 5 — PASS after Repair #6/#7

Repair #6 消除了真实 1 MB route geometry transport failure：

```text
large fixture beforeBytes = 7,611,991
afterBytes = 621
```

完整 Provider geometry 仍保留在 DB / Map，只从 AI transport 移除。

Repair #7 将 Detailed Candidate / Day scope 语义校验前移到 Structured AI `validateResult`。

真实 Step 5：

```text
Action: fa5089e3-8b1a-4c1a-b7ee-4fcc8745bf7e
Task: action:1668cc0c-4078-42f2-9726-5776013c2c92
baseGeneration: 13
```

首轮真实出现：

```text
turn:repair
AI 结果校验失败，正在自动修正（1/2）
```

第二轮成功：

```text
generation = 14
20 / 20 Days detailed/ready
14 Stops
时间正序，无 overlap
Candidate scope / resolution 全部合法
```

Milford Sound 保持 `core_visit` + Te Anau parent，并实际进入 Day 16 Stop。

## Detail → Core — PASS

“蒂阿瑙萤火虫洞”真实升级链：

```text
Step 5/4 语境
→ 自动回 Step 2
→ pending confirmation
→ 确认前 generation 14 不变
→ 确认后 generation 15
→ 同一 Candidate / Place / parent
→ planningRole = core_visit
```

Scoped impact：

```text
仅 Te Anau Day 14–17 needs_review
其他 16 天继续 ready
```

---

# 4. Latest Real Failure — Incremental Replan Intent Loss

用户通过正常 UI 输入：

```text
我想把瓦纳卡多留一天，皇后镇少一天，总天数仍然保持20天。
```

系统先正确要求新增 Wanaka，并成功保存：

```text
Wanaka Candidate: e17e8094-8789-4235-951d-56cf004b190d
generation = 16
```

随后 Step 3 的“更新受影响安排”执行：

```text
Action: a6095de6-d9cb-46df-b7a0-9c8b9794b48e
Task: action:88875215-0cd5-4622-84a2-13cf51ec20f8
baseGeneration: 16
resultRef: generation:17;affected:0;omitted:1
```

错误结果：

```text
Queenstown 仍 2 天
Wanaka 仍 0 天 / omitted
总天数仍 20
```

没有 structured repair，也没有 validation error，因为当时 AI 实际拿到的是通用空参数 replan。

## 根因

Web Step 3 目前的通用按钮是：

```text
onUpdate={() => startCta("destinations", "itinerary.replan")}
```

即 `parameters = {}`。

原始用户请求先触发 `destination.add`，等 Wanaka Candidate 创建完成后，后续 generic `itinerary.replan` 不再携带：

```text
Wanaka +1
Queenstown -1
总天数仍 20
```

因此旧 Prompt 按正常 `optional` 规则省略 Wanaka，在当时输入下属于“合法但违背原用户意图”的结果。

---

# 5. Repair #8 — Cross-Step Replan Intent + Hard Day Constraints

## 5.1 因果用户意图续传

新增：

```text
apps/server/replan-intent-v3.ts
apps/server/replan-intent-v3.test.ts
```

当 generic CTA 创建 `itinerary.replan` 且 `parameters.request` 为空时：

1. 找到最近一次成功 `itinerary.generate` / `itinerary.replan` Skeleton 基线；
2. 查看该基线之后已成功应用、真正改变 Macro 输入的 `requirements.*` / `destination.*` Action；
3. 通过 `sourceMessageId` 找到最新因果用户消息；
4. 把该用户原话恢复为当前 `itinerary.replan.parameters.request`。

如果 CTA 已显式带 `request`，绝不覆盖。

不新增 DB 字段，不迁移 Schema。

## 5.2 明确 +N / -N 天数变成硬约束

同一模块会从：

```text
parameters.request
planningAreas
currentStays
```

派生本轮明确 Stay Day 约束。

当前真实例子：

```text
Wanaka baseline 0 + 1 => expected 1
Queenstown baseline 2 - 1 => expected 1
```

支持中文“多留 / 多住 / 增加 / 少留 / 少住 / 减少 / 改为 N 天”等基础表达。

## 5.3 Structured AI semantic repair

`ai-action-state-validation-v3.ts` 现在也覆盖：

```text
itinerary.replan
```

如果 AI 输出：

```text
Wanaka = 0
Queenstown = 2
```

或把明确要求正数天数的 Wanaka 放进 `omittedPlanningAreas`，会在保存前抛出语义校验错误，进入既有：

```text
turn:repair
```

不会静默修改 AI 输出，也没有放宽最终 `applySkeletonPlanV3` / canonical 校验。

## 5.4 Prompt

`prompts/actions/itinerary/重新规划行程.md` 已明确：

```text
parameters.request 可能来自跨步骤恢复
明确数字天数要求高于 optional 一般省略规则
先满足用户硬约束，再执行最小修改原则
```

---

# 6. 五步合同与边界保持不变

```text
1 旅行需求
2 想去哪些地方
3 路线和天数
4 补充景点（可选）
5 每日行程
```

继续保持：

```text
PlanningRole = planning_area | core_visit | detail_interest
Core Visit 不成为 Macro Anchor
Planning Area 可重复 Stay Block
Step 3 原子 Skeleton save
Step 4 可跳过
Step 5 scoped incremental update
PRAGMA user_version = 3
Provider geometry 不进入 AI transport，但完整保留给 DB / Map
```

无 DB migration。

---

# 7. Next Gate

当前保留旅行已经到 generation 17，错误 replan 记录必须继续保留。

下一轮：

1. 对 Repair #8 的 intent recovery / day constraint / semantic replan validator 做 targeted tests + typecheck。
2. fresh restart backend。
3. 不重跑 Step 1–5。
4. 通过正常 UI 再发送同一明确请求：

```text
我想把瓦纳卡多留一天，皇后镇少一天，总天数仍然保持20天。
```

5. 因 Wanaka Candidate 已存在，不应再创建重复 Candidate。
6. 新 `itinerary.replan` 必须最终得到：

```text
Wanaka = 1 天
Queenstown = 1 天
总天数 = 20
```

7. 如果模型第一轮未遵守，应出现 `turn:repair`；修正后再保存。
8. `affectedDayIds` 必须真实非空，相关 Detailed Days 进入 needs_review；无关 Days 尽量保持。
9. 通过后完成 Map regression、Public UI、最终 DB 统计。

任何新的核心失败继续 STOP 并保留证据。

只有真实五步 E2E 最终完整 PASS 后才准备合并 main。
