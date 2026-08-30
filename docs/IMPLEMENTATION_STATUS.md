# TravelPlanner Implementation Status

更新时间：2026-08-31  
实施分支：`refactor/stage-dialogue-actions-v3`  
目标文档：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

## Current Gate

Phase 1–7 staged-v3 重构、cutover 与 A–I post-review hardening 已完成。

第二轮 Codex 验收基于 `c9592bc304c1d316b19abba9a9ee06722b9f4919`：

- Review A–I：全部 PASS；
- fresh v3 / cutover：PASS；
- `git diff --check`：PASS；
- `npm run typecheck`：FAIL，仅剩 `ai-registries-v3.ts` 的 `never.id` 编译错误；
- `npm test`：247 PASS / 1 FAIL，仅剩 `runtime-invariants-v3.test.ts` conversation fixture 与新 Action inputContract 不一致；
- `npm run build`：FAIL，仅由同一 server TypeScript 错误导致；
- 真实 Codex / Browser E2E：因门禁未全绿而未运行。

## Final Gate Cleanup

已针对第二轮剩余问题做最小修复：

1. `ai-registries-v3.ts`
   - 删除非 shared Prompt “策略字段缺失”的冗余运行时分支。
   - `PromptRegistrationV3` 已在类型层强制 dialogue/action Prompt 必须拥有 reasoning / reasoningSummary / web / outputContract；原分支被 TypeScript 判定为不可达，导致分支中的 `prompt` 收窄为 `never`。
   - 保留 Prompt ID/path 唯一性、AI Action Prompt 类型、stage、outputContract、deterministic 禁止 AI 策略等真正的运行时 Registry 校验。

2. `runtime-invariants-v3.test.ts`
   - 该测试只验证 deterministic Action 成功后由数据库 invariant 归一为 `applied`，不负责验证 Dialogue 参数信封。
   - fixture 改为 CTA Action，并使用 CTA 的 action-specific 压缩参数；删除无关 user message/sourceMessageId。
   - Dialogue 参数信封压缩和 conversation Action 已由独立 Runtime/InputContract 回归测试覆盖。

## Verification Status

当前代码修复完成，但尚未对最终 HEAD 重新运行：

- `npm run typecheck`
- `npm test`
- `npm run build`
- 真实 Codex smoke
- Browser E2E

因此当前状态仍是：**等待第三轮最终门禁复测，不能宣称 PASS。**

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
- 本轮 GitHub 修复未触碰任何真实 `private_data` 数据。

## Next Gate

第三轮只需要做最终收尾复测：

1. 确认 branch / HEAD / clean worktree；
2. `git diff --check`；
3. `npm run typecheck`；
4. `npm test`；
5. `npm run build`；
6. 定向确认 `ai-registries-v3.test.ts` 与 `runtime-invariants-v3.test.ts`；
7. 上述全部 PASS 后，才执行隔离 fresh-v3 的真实 Codex smoke 与 Browser E2E；
8. E2E 通过后再进入 merge / 真实本地 DB cutover 决策。

## Do Not Do

- 不自动删除、迁移或覆盖真实 v2 数据库。
- 不恢复旧全局 AI Conversation/Adjustment、旧 00–03 Prompt 或 taskMode 主链。
- 不增加新 PlaceKind 或把 ConversationStage 写入 canonical TripStage。
- 最终门禁未通过前不宣称重构验收完成。
