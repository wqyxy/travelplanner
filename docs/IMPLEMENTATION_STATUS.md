# TravelPlanner Implementation Status

> 更新时间：2026-09-03
> 当前状态：**五步重构所有隔离测试、typecheck、full suite、build、production Browser Map Gate 已通过；第一次真实 private_data + Real AI 五步 E2E 在 Step 2 暴露 parent reference 问题。Repair #4 已实施，等待使用保留测试旅行继续真实 E2E。**

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

Production Map 修复后、第一次真实 E2E 的 HEAD：

```text
0cd5037114c12c1ae0b0cbfe4492a18cf95fafd3
```

第一次真实测试旅行：

```text
Trip ID: d028c5f7-906e-4027-8fa1-faab7a3b7d71
Title: [五步E2E测试-保留] 新西兰20天南北岛自驾
```

测试数据按用户要求保留，不清理。

---

# 2. 已通过的综合 Gate

在 `0cd5037...` 上已经验证：

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

因此当前没有已知 Map、Provider、build、typecheck 或普通 regression 问题。

---

# 3. Real Private-Data E2E #1

真实测试明确授权使用：

```text
private_data/travel-v2.sqlite3
真实 AI
真实 Provider
真实产品 UI
真实数据库写入
```

测试只新增并操作 `[五步E2E测试-保留]` 旅行，没有修改或删除其他旅行。

## Step 1

UI 需求保存成功，但发现一个 warning：

```text
brief.duration = "20天"
requestedDurationDays = null
```

原因：原“旅行需求对话”Prompt 只要求把时长写入 `changes.brief.duration`；数字时长没有同步写入 `changes.dates.requestedDurationDays`。CTA 路径虽有 normalization，但真实 conversation Action 不经过该入口。

## Step 2

真实 `destination.generate` 连续两次失败，未保存任何 Candidate。

错误：

```text
Core Visit 引用无效 Planning Area Candidate：candidate-auckland
Core Visit 引用无效 Planning Area Candidate：tmp-candidate-rotorua
```

真实 AI 在同一批次同时生成 Planning Area 和 Core Visit 时，把本轮 Planning Area 的 `temporaryId` 错放进：

```json
{ "type": "existing", "candidateId": "...temporaryId..." }
```

正确形式应为：

```json
{ "type": "generated", "temporaryCandidateId": "...temporaryId..." }
```

由于旧 contract 只校验 `generated` ref 的同批关系，该错误能通过 Structured AI parse，直到正式化/落库前才失败，因此没有利用已有 structured-output 自动修正机会。

Step 3–5 因 Step 2 无 Candidate 合法 BLOCKED。

---

# 4. Repair #4

## 4.1 Step 2 parent reference 前移校验

`apps/server/backbone-contracts-v3.ts` 现在额外拒绝：

```text
Core Visit 的 parentCandidateRef.type = existing
且 candidateId 同时等于本轮任意 Candidate temporaryId
```

错误会在 `DestinationGenerateOutputSchema.parse()` 阶段出现：

```text
existing parent 不得引用本轮 temporaryId；本轮生成的 Planning Area 必须使用 generated parent。
```

这会进入现有 Structured AI 自动修正机制，而不是等到准备写 canonical plan 时整批失败。

安全边界没有放宽：

```text
真正 existing parent 仍必须引用当前 canonical Planning Area
真正 generated parent 仍必须引用本轮 planning_area temporaryId
不存在的 parent 仍拒绝
reparent 仍拒绝
```

新增回归测试：

```text
apps/server/real-ai-step2-parent-ref-regression-v3.test.ts
```

覆盖真实出现的 `candidate-auckland` 型错误与正确 `generated` 写法。

## 4.2 Step 2 Prompt 加硬

`prompts/actions/destinations/生成目的地建议.md` 明确：

```text
existing.candidateId 只能从输入当前 Backbone 原样复制
本轮 temporaryId 无论长得多像正式 ID 都不得写入 existing
同批父级必须使用 generated.temporaryCandidateId
```

## 4.3 Step 1 数字时长同步

`prompts/dialogues/旅行需求对话.md` 现在要求：

```text
20天 / 20 天左右 / 2周 / 7 days
→ 保留 brief.duration 原话
→ 同步 dates.requestedDurationDays
```

没有精确日期时不得编造日期，例如：

```json
{ "start": null, "end": null, "requestedDurationDays": 20 }
```

已有完整 start+end 时精确日期优先，不同时保存非 null requestedDurationDays。

---

# 5. 当前五步合同不变

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

无 DB migration，无 Provider 权限扩大。

---

# 6. Next Step

继续使用已经保留的真实测试旅行：

```text
d028c5f7-906e-4027-8fa1-faab7a3b7d71
```

不要新建第二个测试旅行。

先通过正常 Step 1 对话再次确认：

```text
旅行时长仍然是20天。
```

验证 `requestedDurationDays = 20` 后，回 Step 2 正常重新运行 `destination.generate`。

如果 Step 2 成功保存 Planning Areas + Core Visits，则继续原真实 E2E 的 Step 3–5、Provider、Detail→Core 和 incremental update。

如果再次出现真实失败，不修改代码，记录当前数据与错误后 STOP。

只有真实五步 E2E 完整通过后，才能把专项状态标记为最终 PASS 并准备合并 main。
