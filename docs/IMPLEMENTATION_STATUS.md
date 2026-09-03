# TravelPlanner Implementation Status

> 更新时间：2026-09-03
> 当前状态：**五步重构的隔离测试、typecheck、build、production Map Gate 已通过；真实 private_data + Real AI E2E 已验证 Step 1–4。Repair #6 已真实消除 Step 5 的 1 MB AI transport failure；最新真实失败是 Detailed AI 输出引用不在本轮白名单中的 Candidate。Repair #7 已将 Step 5 语义校验前移到 Structured AI repair 边界，等待继续同一旅行的真实 Step 5。**

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

保留的真实 E2E 测试旅行：

```text
Trip ID: d028c5f7-906e-4027-8fa1-faab7a3b7d71
Title: [五步E2E测试-保留] 新西兰20天南北岛自驾
```

测试数据按用户要求保留，不清理。

---

# 2. 已通过的隔离综合 Gate

Production Map 修复后的综合验证曾通过：

```text
git diff --check PASS
typecheck PASS
69 test files / 406 tests PASS
build PASS
fresh dist/web production MapLibre worker PASS
candidate marker render/click/popup PASS
itinerary GeoJSON / routes PASS
five-step mounted Browser smoke PASS
Provider boundary PASS
security/private-data isolated checks PASS
```

Repair #5 / #6 的专项测试和 typecheck 也已由真实 E2E 执行环境通过。

---

# 3. Real Private-Data E2E Progress

真实测试授权使用：

```text
private_data/travel-v2.sqlite3
真实 AI
真实 Provider
真实产品 UI
真实数据库写入
```

只操作上述 `[五步E2E测试-保留]` 旅行，不修改其他旅行。

## Step 1 — PASS

Repair #5 已在 fresh backend 上真实验证：

```text
BASE_GENERATION: 3
NEW_GENERATION: 4
OLD_ACTION_ID: 6ae82bcf-665a-4935-9edd-3b33ac9b6779
NEW_ACTION_ID: 9f2d719d-8b8e-452e-995b-673d36270c27
```

模型即使只返回：

```json
{ "changes": { "brief": { "duration": "20天" } } }
```

共享 Action normalization 也会在持久化前补为：

```json
{
  "changes": {
    "brief": { "duration": "20天" },
    "dates": {
      "start": null,
      "end": null,
      "requestedDurationDays": 20
    }
  }
}
```

Canonical：

```text
brief.duration = "20天"
dates.requestedDurationDays = 20
```

## Step 2 — PASS

真实生成结果：

```text
17 Candidates
8 Planning Areas
9 Core Visits
```

Milford Sound：

```text
planningRole = core_visit
parent = Te Anau
```

Canonical parent 中无 temporary ID。

Repair #4 的 same-batch Planning Area / Core parent reference 已真实通过。

## Step 3 — PASS

真实 Skeleton：

```text
20 Days
remainingDays = 0
Auckland Day 1 / Day 20 为不同 stayBlockId
Te Anau = Day 14–17
```

重复 Planning Area Stay Block 行为正确。

## Step 4 — PASS

进入 Step 4 时没有自动 discovery。

正常 UI 操作后当前真实数据：

```text
38 Candidates
38 Places
32 resolved
6 unresolved
```

Auckland、Queenstown、Te Anau 均补充了普通兴趣点。

旧数据中存在未显式保存 `planningRole` 的 Candidate，继续按 legacy effective role 兼容读取。

---

# 4. Repair #6 — Step 5 Input Size

第一次真实 Step 5 在进入模型前失败：

```text
Input exceeds the maximum length of 1048576 characters.
```

根因：AI state 中包含完整 Provider DayRoute / MacroRoute，包括：

```text
route.geometry
leg.geometry
inputFingerprint
calculatedAt
```

真实 20 天路线使 transport 超过 1 MB。

Repair #6 在 `StagedTravelAiV3` 的 AI transport 边界压缩 itinerary route context：

保留：

```text
dayId / routeId / required / dirty
status
distanceKm
durationMinutes
warnings
leg endpoints / mode / status / distance / duration / warning
```

删除 AI 不需要的 Provider geometry 和内部元数据。

专项大输入夹具真实验证：

```text
beforeBytes = 7,611,991
afterBytes = 621
geometry absent
```

真实 E2E 再跑 Step 5 后，AI 请求成功进入 running，原 1 MB transport 错误不再出现。

数据库 / workspace / Map 的完整 Provider geometry 没有被删除：当前 8 条 route 中 6 ready、2 attention，6 条仍有 geometry。

---

# 5. Latest Real Step 5 Failure

Repair #6 后新的 Step 5 Action：

```text
Action: cbd32abf-42f8-4a13-bcc6-03be608933e2
Task: action:5cc26843-89fe-46c2-a763-089daa769812
```

AI 已真实执行约 149 秒，但输出在准备保存时失败：

```text
详细行程引用未知或已排除 Candidate：15a30b03-dbed-47ab-9c8d-c32c3499c3bc2
```

没有写入部分 Detailed Day：

```text
0 ready
0 needs_review
0 stops
canonical generation 仍为 13
```

Milford Sound 仍保持合法 Core Visit，但因 Step 5 整体未保存，尚未进入 Day Stop。

根因不是 canonical 校验过严，而是校验发生得太晚：

```text
Output JSON Schema 只知道 candidateId 是字符串
→ Structured AI 认为输出合法
→ result 返回 runtime
→ applyDetailedUpdatesPhase5V3 才检查 canonical Candidate
→ 此时已离开 Structured AI repair 机制
```

---

# 6. Repair #7 — Detailed Semantic Repair Gate

新增：

```text
apps/server/ai-action-state-validation-v3.ts
apps/server/ai-action-state-validation-v3.test.ts
```

`StagedTravelAiV3.startAction()` 现在会在 Structured AI 接受 `itinerary.detail.generate` / `itinerary.detail.update` 输出前，使用本轮 state 做语义校验。

校验包括：

```text
baseGeneration 必须匹配
必须恰好返回 targetDayIds
增量 affectedDayIds 必须匹配 target scope
Stop candidateId 必须来自本轮 candidates 白名单
Stop Candidate 必须 resolved=true
unavailable Candidate 不得成为 Stop
Candidate 必须属于该 Day 起点/终点对应的停留区域
unscheduledCandidates 必须属于本轮 scope
must_go 不得进入 unscheduledCandidates
required must-go 必须实际排入
priority Core 未排入时必须说明 unscheduled 原因
```

任何错误都会由 `validateResult` 抛回 Structured AI Runner，因此可触发现有最多 2 次 structured repair。

最终 canonical 持久化校验仍保留，Repair #7 没有放宽或删除：

```text
applyDetailedUpdatesPhase5V3
validateItineraryReferences
validateDetailedSchedulingOutcomeV3
```

因此这是“提前反馈给模型”，不是“自动吞掉坏数据”。

## Action-wide timeout

真实 20 天第一次输出用了约 149 秒；旧默认总预算只有 180 秒，几乎没有 structured repair 时间。

Repair #7 仅为：

```text
itinerary.detail.generate
```

提供 420 秒 Action-wide budget，使第一次完整输出失败后至少有实际修正空间。

其他 Action timeout 规则不变。

---

# 7. 五步合同不变

```text
1 旅行需求
2 想去哪些地方
3 路线和天数
4 补充景点（可选）
5 每日行程
```

内部继续保持：

```text
PlanningRole = planning_area | core_visit | detail_interest
Core Visit 不成为 Macro Anchor
Planning Area 可以重复 Stay Block
Day.stayBlockId optional backward-compatible
Step 3 原子 Skeleton save
Step 4 可跳过
Step 5 incremental affected days
PRAGMA user_version = 3
```

无 DB migration，无 Provider 边界变化。

---

# 8. Next Step

继续使用同一真实测试旅行：

```text
d028c5f7-906e-4027-8fa1-faab7a3b7d71
```

不要重新执行 Step 1–4，不创建新旅行。

下一轮：

1. 对 Repair #7 新增语义 validator + Structured AI integration 做 targeted tests / typecheck。
2. fresh restart backend。
3. 当前 generation 13 上重新点击 Step 5“生成每日行程”。
4. 记录新 Action / Task。
5. 如果第一次输出再次使用无效 Candidate，应看到 `turn:repair` / “AI 结果校验失败，正在自动修正”。
6. 只有修正后的完整 20 Day Detailed 行程成功写入后，继续 Milford、Detail→Core、scoped impact、incremental update、Map regression。
7. 任何新的核心失败都停止并保留证据，不现场改代码或手工修改数据库。

只有真实五步 E2E 完整通过后，才能标记最终 PASS 并准备合并 main。
