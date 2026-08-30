# TravelPlanner Implementation Status

更新时间：2026-08-30  
实施分支：`refactor/stage-dialogue-actions-v3`  
目标文档：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

## Target

实现四个 `ConversationStage` 的独立 Dialogue/Thread/Message、统一 `AiAction` Registry、deterministic/AI executor、Proposal/Apply、fresh SQLite v3，并保持 Candidate-first、canonical v2 Document、Place Resolver、Route Provider、Scope 与 generation CAS 边界不变。

## Current Phase

### Phase 5 — Right-Side UI Migration

**状态：完成。下一阶段：Phase 6。**

## Completed

### Phase 1–4
- 公共合同、Prompt/Action Registry、专用 Prompt、fresh v3 Store、Stage Dialogue、Action Runtime、Proposal/Apply 与 v3 API 已建立。

### Phase 5 — Right-Side UI
- 新增 `WorkspaceV3` 前端类型：四阶段 message map、Action、v3 Task。
- 新增 `WorkspaceAssistantV3`，完全移除原“对话 / 调整”双模式。
- 四阶段固定助手名称与边界：旅行需求 AI、目的地 AI、兴趣点 AI、行程 AI。
- 每阶段独立 message history 与独立输入 draft；切换阶段不会复用另一阶段草稿。
- 对话识别出的 Action 作为 Action Card 挂在对应消息下，可 Confirm/Cancel。
- CTA Action 在当前阶段任务区显示，不伪装成聊天消息。
- AI 修改类 Action 的 Proposal 显示在关联 Action 下，支持 Apply / Reject / Undo。
- Action Card 展示 executor、generation、target、状态和失败原因；superseded/failed 不制造伪成功。
- 新 UI 没有地图 AI 输入框，也没有其他第二套 AI 输入入口。
- 新增 `AppV3`：固定右侧四步 `requirements / destinations / interests / itinerary`。
- 新建旅行固定进入需求阶段并选择 trip scope。
- 阶段对话调用显式 stage turn API。
- 主 CTA 统一调用 `/actions/cta`；点击本身即确认，不再弹重复确认卡。
- 目的地主 CTA → `destination.generate`；进入兴趣点 → `interest.discover`；补充 → `interest.supplement`；生成行程 → `itinerary.generate`；行程细化 → `itinerary.refine`。
- 页面 Candidate preference、手工新增地点、字段编辑、删除、拖拽、Anchor、地图选择、手工坐标、Route recalc 继续走确定性代码，不调用 AI。
- 全局 reasoning 强度不再暴露给正常阶段动作；服务端 Registry 决定 reasoning。UI 只保留模型选择。
- WebSocket 监听新增 `travel.action.changed`，刷新后 Action/Proposal 可从数据库恢复。
- 复用现有 CandidatePanel、ItineraryPanelV2、WorkspaceMapV2，没有新建第二套 Candidate/Map/Route UI 事实模型。
- 新增 Stage Action/Proposal 样式文件。

## Important Decisions

1. Phase 5 采用新增 `AppV3.tsx` 而不是直接覆盖活动 `App.tsx`，确保 Phase 6 原子 cutover 前旧运行链仍可用。
2. CandidatePanel/ItineraryPanel 的精确操作继续是 deterministic；其中“发现/继续/细化”按钮的 callback 已由 AppV3 统一改为 Action CTA。
3. 所有 AI 入口均位于右侧工作区；地图只负责展示、选择和 Provider 交互。
4. 目标计划明确要求 v3 继续使用文件路径 `private_data/travel-v2.sqlite3`，只是内部 `user_version` 升级到 3；Phase 6 代码切换仍使用该路径。现有 v2 文件若未显式移走/删除，新 Store 会 fail closed，不会迁移或覆盖。

## Files Changed

- `apps/web/src/v3-types.ts`
- `apps/web/src/WorkspaceAssistantV3.tsx`
- `apps/web/src/AppV3.tsx`
- `apps/web/src/stage-ai-v3.css`
- Phase 1–4 文件继续保留。

## Tests / Checks

未执行 Vitest、typecheck、build、真实 Codex、地图 Smoke 或浏览器 E2E。按照项目规则，完整验证在所有代码修改与静态 Review 完成后一次性征求用户确认。

## Known Issues / Risks

- `AppV3` 尚未成为活动前端入口；Phase 6 才修改 `main.tsx`。
- 新 server Runtime 尚未成为活动 `index.ts` 装配；Phase 6 才做原子切换。
- `stage-ai-v3.css` 需要在 Phase 6/7 静态 Review 中与现有 CSS variable 命名对齐。
- 现有 CandidatePanel/ItineraryPanel 的 prop 类型仍引用旧 `Workspace`，AppV3 当前通过结构兼容 cast 复用；最终 typecheck 若暴露不兼容必须修正。
- 当前 `private_data/travel-v2.sqlite3` 的真实删除/移动是破坏性操作，尚未执行，也不能通过 GitHub connector执行。

## Next Phase

### Phase 6 — Atomic Code Cutover & Legacy Cleanup

代码级切换：
- `index.ts` 切到 strict v3 Prompt loader、TravelStoreV3、StagedTravelAiV3、TravelPlannerRuntimeV3、v3 API。
- 数据库路径仍是目标文档指定的 `private_data/travel-v2.sqlite3`；旧 version 2 文件存在时必须 fail closed。
- `main.tsx` 切到 `AppV3` 和 staged UI stylesheet。
- 删除旧 00–03 Prompt；strict Registry 成为唯一 Prompt 入口。
- 删除活动入口中的旧 `/turns`、direct plan/refinement/proposal-create AI 旁路。
- 通过引用搜索删除可安全删除的旧 Runtime/Assistant 代码；仍被 Resolver/Route 类型依赖的基础能力不得误删。
- 更新 README/docs 数据库和用户流程说明。

破坏性本地 cutover：
- **不在代码里自动执行。**
- 真实 `private_data/travel-v2.sqlite3` 的删除或人工移走必须在停止旧 Runtime 后由用户明确确认。

## Recommended Model

高推理 Reviewer 参与 Phase 6/7。

## Do Not Do

- 不自动删除、迁移或覆盖真实 v2 数据库。
- 不恢复旧全局 AI 对话/adjustment 入口。
- 不增加新 PlaceKind 或四阶段 canonical TripStage。
