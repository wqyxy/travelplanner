# TravelPlanner Implementation Status

更新时间：2026-08-31  
实施分支：`refactor/stage-dialogue-actions-v3`  
目标文档：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

## Target

实现四个 `ConversationStage` 的独立 Dialogue / Thread / Message、统一 `AiAction` Registry、deterministic / AI executor、Proposal / Apply、fresh SQLite v3，并继续保持 Candidate-first、canonical `TravelPlanDocument.schemaVersion=2`、三阶段 `TripStage`、Place Resolver、Route Provider、Scope 与 generation CAS 边界。

## Current Phase

### Phase 7 — Post-review hardening / second verification gate

**Phase 1–7 代码级重构与 cutover 已完成。**  
**第一次 Codex 验收：FAIL，发现 A–I 边界问题及 typecheck/test/build 失败。**  
**针对该报告的修复批次：已提交 `4279cd6d27fa2c3790d613342efa623a317f92c4`。**  
**第二次验证：尚未执行，当前不能宣称测试通过。**  
**真实本地数据库破坏性 cutover：尚未执行，必须独立确认。**

## First Verification Findings

第一次 Codex 验收基于 `b31d3755db7fb72e2904986ba6ea833631b4bc67`，确认：

- A：Stage Dialogue 在 canonical generation 变化后仍可把旧推理包装成最新 generation Action；
- B：20 天整体 replan / repair 会机械展开为 120 条命令并触发 100 条上限；
- C：两个 Macro 的 interest.discover 会产生 3 次 AI 调用，且 stop 无法命中当前内部 child run；
- D：`itinerary.stop.add` 的 `index=null` 被解释为 0；
- E：Action Registry 的 `inputContract` 没有成为运行时服务端校验边界；
- F：replan / repair 可把 unresolved concrete Place 放入 Proposal；
- G：Candidate / Place 关联 Scope 的并发冲突检测过窄，可错误 rebase；
- H：`itinerary.verify` 可借通用 `update_day_stop` 修改 Candidate / Place；
- I：单日 AI Action 和 Stage Dialogue 缺少足够的上下文窗口化。

同时：
- `git diff --check` PASS；
- `npm run typecheck` FAIL；
- `npm test` FAIL（233 passed / 5 failed）；
- `npm run build` FAIL（Web build 成功，server tsc 失败）；
- strict Prompt / Structured Output 定向测试、fresh v3 Store、Resolver / Route、cutover 静态检查通过。

## Post-review Repair — `4279cd6d27fa2c3790d613342efa623a317f92c4`

### A — stale Dialogue generation
- Dialogue 启动时固定 `baseGeneration`。
- 第一轮 AI 返回后、Web 第二轮返回后均重新检查 canonical generation。
- generation 已变化时结果直接进入 `cancelled_by_generation` / failed turn，不保存旧回答、不创建 Action。
- Dialogue Action 不再调用 `latestGeneration()` 偷换 generation。

### B — long itinerary replan / repair
- `replacementCommands()` 改为语义 diff：优先复用已有 Stop，只有实际顺序变化才 move，字段变化才 update，真正新增/删除才 add/remove。
- 20 天 × 2 Stop 的纯重排不再机械生成 120 条 remove/add/anchor 命令。
- 仍保留单 Proposal 100 条受控命令资源上限；不是简单把常量调大。

### C — multi-Macro interest discovery
- `interest.discover / supplement` 不再先做一轮多 Macro AI 调用。
- Runtime 直接逐 Macro 启动单职责 child run，每个 Macro 恰好一次调用。
- 当前 child handle 会写入 active task，因此用户 stop 命中当前正在执行的 Macro。

### D — null stop index
- `index == null` 统一解释为追加到 Day 末尾。

### E — Action inputContract enforcement
- 新增 `ai-action-input-contracts-v3.ts`。
- 每个 Action 有 strict CTA 参数 Schema，并与 Registry `inputContract` 映射校验。
- conversation 的固定参数信封先解析，再压缩为 action-specific 参数。
- Runtime 创建 Action 时校验一次；`TravelStoreV3.createAction()` 落库前再校验一次。
- 未知字段、空 requirements.update 等不再允许持久化或生成空 revision。

### F — unresolved Place in itinerary mutation
- 新增统一 itinerary reference / current Resolution 校验。
- itinerary.generate、replan、repair 都拒绝把未定位 non-city Place 加入 Day。

### G — Proposal / Action conflict scope
- Candidate scope 同时观察关联 Place；Place scope 同时观察关联 Candidate。
- Day scope 同时观察该 Day 引用的 Candidate / Place。
- 关联事实发生冲突修改时旧 Proposal / Action superseded，不再错误 rebase。

### H — itinerary.verify boundary
- AI 输出 Schema 已收窄为只允许 `update_day_stop` 的动态事实字段。
- Runtime 再次白名单校验允许字段：时间、时长、transport、schedule/cost verification、costNote、notes。
- `candidateId / placeId / activity` 等身份或结构字段不得由 verify 修改。

### I — context windowing
- itinerary Dialogue 改为全局轻量 `dayIndex` + 当前 Day/Stop 所在 Day ±1 的详细窗口。
- 超过 64 KB 时进一步压缩为当前 Day + 截断长文本 / Stop 数量，而不是立即抛错。
- `itinerary.day.optimize / refine` 只注入目标 Day、相邻 Day 摘要、目标 Day 引用 Candidate 和必要 Route state。
- interests Dialogue 优先当前 Macro 的 Micro Candidate。

## Typecheck / Test Drift Repairs

修复批次同时处理第一次报告中的已知非业务失败：

- `ai-registries-v3.ts` Registry validation 类型收窄；
- `staged-ai-v3.ts` runnable PromptId / Zod 泛型 cast；
- itinerary `requires_stage` discriminated-union narrowing；
- 删除 planner Runtime 中无意义的 `stage === "map"` 比较；
- `candidate-discovery-policy-v2.test.ts` 更新到当前 AI 自主 0–9、单 Macro、无补位 / 业务过滤规则；
- `map-service.test.ts` 更新当前 geocode cache key，并增强 Windows SQLite 临时目录清理重试。

## Added Regression Coverage

新增/扩展正式测试覆盖：

- stale Dialogue generation；
- conversation Action 确认前不 mutation；
- CTA idempotency；
- stop.add `index=null` 默认追加；
- multi-Macro interest discover 调用次数与 stop；
- 20 天 replan 语义 diff；
- replan unresolved Place 拒绝；
- Action inputContract 未知字段拒绝；
- Candidate scope + linked Place 并发 supersede；
- verify 动态字段白名单；
- 20 天 Stage Context 窗口化；
- itinerary schema 继续禁止 `newPlaces / newCandidates`。

## Database Cutover Decision

固定路径仍是：

```text
private_data/travel-v2.sqlite3
```

活动 Runtime 要求内部：

```text
PRAGMA user_version = 3
```

固定策略：
- 不迁移、不保留现有 v2 数据；
- 正常启动绝不自动删除、移动、覆盖旧库；
- 旧 v2 / 未知 / 损坏数据库在 HTTP listen 前 fail closed；
- 真正删除或人工移走真实 `private_data/travel-v2.sqlite3` 是独立破坏性步骤，尚未执行。

## Verification Status

截至本状态更新：

- 本次修复只完成 GitHub 代码修改与静态复核；
- **没有在 ChatGPT 侧运行** Vitest、typecheck、build、真实 Codex、浏览器 E2E；
- 第二轮必须由本地 Codex 对 `4279cd6d27fa2c3790d613342efa623a317f92c4` 重新执行 Review A–I + 完整自动化检查；
- 只有 A–I、typecheck、unit tests、build 全部通过后，才进入真实 Codex / Browser E2E；
- E2E 通过后才考虑 merge main；
- merge 后再单独确认真实旧 v2 DB 的备份 / 移走 / 删除。

## Next Step

第二轮 Codex 验收顺序：

1. 确认 branch / HEAD / clean worktree；
2. 重跑 Review A–I；
3. `git diff --check`；
4. `npm run typecheck`；
5. `npm test`；
6. `npm run build`；
7. 若全部通过，再使用隔离 fresh v3 DB 做最小真实 Codex / Browser E2E；
8. 不操作真实 `private_data/travel-v2.sqlite3`。

## Do Not Do

- 不自动删除、迁移或覆盖真实 v2 数据库。
- 不恢复旧全局 AI Conversation / Adjustment、旧 00–03 Prompt 或 taskMode 主链。
- 不增加新 PlaceKind 或四阶段 canonical TripStage。
- 第二轮验证完成前不 merge main，不宣称实现已验收通过。
