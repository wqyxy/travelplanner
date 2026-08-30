# TravelPlanner Implementation Status

更新时间：2026-08-31  
实施分支：`refactor/stage-dialogue-actions-v3`  
目标文档：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

## Current Gate

Phase 1–7 staged-v3 重构、atomic cutover 与 A–I post-review hardening 已完成。

最近一次完整自动化验收基于 `e2c0ce9356b8f27385a246aa4a3b25e239e1171d`：

- strict Prompt Registry 真实 Prompt Tree：PASS；
- Review A–I：全部 PASS；
- fresh v3 / cutover：PASS；
- `git diff --check`：PASS；
- `npm run typecheck`：PASS；
- `npm test`：PASS，45 files / 251 tests；
- `npm run build`：PASS；
- 真实 Codex structured-output smoke：PASS；
- Browser E2E：已运行，但在 itinerary 最终链路发现 2 个剩余问题，因此仍未 READY FOR MERGE。

## Latest Browser E2E Findings

### P0 — itinerary.refine 真实模型无法稳定形成 Proposal

真实模型在 Day 2 / Day 3 refine 时均改变了 Anchor。旧 `itinerary.refine.output` 使用完整 `DetailedDaySchema`，因此 Anchor、Day identity、Candidate/Place identity 虽由 Runtime fail closed，但仍暴露在模型输出合同中；Prompt 约束不足以保证真实模型稳定原样返回。

### P1 — unresolved Macro city 可进入 itinerary

旧 `validateItineraryReferences()` 对 `Place.kind === "city"` 存在 Resolution 豁免。E2E 中两个未定位 Macro city 被作为 Anchor/Stop 引用，Route 因此进入 attention。

目标边界已经明确为：**任何非 null 的 Day Anchor / Stop Place 都必须拥有当前有效 Provider/手工 Resolution，city 不例外。**

## Final E2E Hardening

本轮针对上述两个真实 E2E 问题做结构性修复。

### 1. itinerary.refine 改为 patch-only 输出合同

`itinerary.refine.output` 不再返回完整 Day。

成功结果只包含：

- `dayIds`
- `dayUpdates[]`
  - `dayId`
  - `stops[]`
    - `stopId`
    - activity / period
    - startTime / endTime / durationMinutes
    - transportFromPrevious
    - scheduleVerification
    - costNote / costVerification
    - notes

模型输出中不再存在：

- Day title/date/identity；
- startAnchor / endAnchor；
- Candidate ID / Place ID；
- Stop 新增、删除、排序字段。

Runtime 再执行以下校验：

- dayIds 与 dayUpdates 必须一一对应；
- 每个目标 Day 必须恰好覆盖全部现有 Stop ID；
- 不允许重复、缺失或额外 Stop；
- 只生成 `update_day_stop` PlanCommand；
- Proposal 前先预演命令，并把目标 Day 临时标记为 detailed/ready 后通过 `TravelPlanDocumentSchema` 完整验证；
- Apply 后仍由服务端把目标 Day 标记为 detailed/ready。

因此 Anchor、Day identity、地点引用和 Stop 顺序不再依赖 Prompt 服从，而是在模型输出 Schema 上不可表达。

### 2. itinerary Resolution 边界统一

`validateItineraryReferences()` 已删除 city 豁免：

- Anchor Place 必须存在当前有效 Resolution；
- Stop Place 必须存在当前有效 Resolution；
- `kind=city` 与其他 Place 使用完全相同的规则。

该边界应用于：

- itinerary.generate；
- itinerary.replan；
- itinerary.repair；
- deterministic itinerary Actions；
- 直接 PlanCommand itinerary mutation。

因此 AI、按钮动作和直接编辑均不能把 unresolved Place 写入 canonical itinerary。

### 3. Macro destination save-first + map-best-effort

为了避免统一 Resolution 边界导致 destination.generate 后普遍无法进入 itinerary：

- destination.generate 仍先保存 Macro Candidate / Place；
- 保存成功后立即对本轮新增 Macro Place 执行 Resolver best-effort；
- 定位失败的 Macro 仍保留并显示 unresolved，不删除、不补位、不回滚整批；
- 但 unresolved Macro 在完成 Resolution 前不能进入 Day Anchor / Stop。

这与 Micro Candidate 的 save-first / map-best-effort 原则保持一致。

### 4. Prompt 同步

生成行程、重新规划、修复行程 Prompt 已明确：

- 任何 Anchor / Stop Place 都必须具有服务端提供的当前有效 Resolution；
- city 不例外；
- unresolved Place 不得进入输出 Days；
- 缺少足够可定位地点时按合同返回 `requiresStage=interests` / 保守处理，不得伪造地图事实。

refine Prompt 已同步到新的 patch-only `dayUpdates` 合同。

## Regression Coverage Added

新增/扩展正式回归测试覆盖：

- `itinerary.refine.output` 接受 patch-only dayUpdates；
- refine 输出尝试携带 Anchor 会被 strict Schema 拒绝；
- destination.generate 新增 Macro Place 后会逐个触发 best-effort Resolver；
- unresolved Macro city 作为 itinerary Anchor 会被拒绝；
- refine patch-only 输出可以生成 Proposal；
- Proposal 只包含 `update_day_stop`；
- Proposal Apply 后 Anchor、Stop ID、Candidate/Place identity 保持不变；
- Apply 后目标 Day 为 detailed/ready。

## Verification Status

本轮 E2E hardening 已完成代码与测试修改，但**尚未对最终 HEAD 重新运行**：

- targeted Vitest；
- `npm run typecheck`；
- 全量 `npm test`；
- `npm run build`；
- 真实 Codex refine；
- Browser Proposal → Apply → UI/Map/Route 最终链路。

因此当前状态仍是：**等待最终复测，不能宣称 READY FOR MERGE。**

## Data Safety

固定数据库路径仍为：

```text
private_data/travel-v2.sqlite3
```

活动 Runtime 要求 `PRAGMA user_version = 3`。

固定策略：

- 不迁移现有 v2 数据；
- 正常启动绝不自动删除、移动或覆盖旧库；
- v2 / 未知 / 损坏数据库在 HTTP listen 前 fail closed；
- 真正删除或人工移走真实数据库仍是独立破坏性步骤；
- GitHub 修复未触碰任何真实 `private_data` 数据。

## Final Gate

下一轮仅做最终复测：

1. branch / HEAD / clean worktree；
2. targeted refine + resolution regressions；
3. `git diff --check`；
4. `npm run typecheck`；
5. `npm test`；
6. `npm run build`；
7. 全部 PASS 后使用 isolated fresh-v3 运行真实 Codex + Browser E2E；
8. 必须完成 `itinerary.refine → awaiting_apply → Proposal Apply → UI/Map/Route sync`；
9. 全部通过后才可标记 `READY FOR MERGE`；
10. merge 后真实本地旧 v2 DB 的备份/移走/删除仍需独立确认。

## Do Not Do

- 不自动删除、迁移或覆盖真实 v2 数据库。
- 不恢复旧全局 AI Conversation/Adjustment、旧 00–03 Prompt 或 taskMode 主链。
- 不增加新 PlaceKind 或把 ConversationStage 写入 canonical TripStage。
- 最终门禁未通过前不宣称重构验收完成。
