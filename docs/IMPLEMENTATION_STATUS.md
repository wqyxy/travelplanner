# TravelPlanner Implementation Status

更新时间：2026-08-30  
目标分支：`main`  
当前重构目标：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`  
执行方法：按“AI 大型项目重构实施工作流”分 Phase 实施；仓库状态和本文件作为跨模型、跨 Thread 的长期交接依据。

## Target

本轮目标不是重新设计 TravelPlanner，而是按已确认目标文档实施“分阶段 AI 对话 + 统一 Action 执行”重构：

```text
右侧工作区唯一 AI 入口
→ requirements / destinations / interests / itinerary 四个 ConversationStage
→ 阶段 Dialogue 只回答、澄清、判断 web_required、识别 Action
→ Action Registry 选择 deterministic 或 AI executor
→ AI 修改生成 Proposal
→ Apply 后才修改 canonical TravelPlanDocument
```

必须继续保留的既有产品基线：

- Candidate-first；
- canonical `TravelPlanDocument schemaVersion=2`；
- canonical `TripStage` 仍只有 `place_selection / itinerary_planning / itinerary_refinement`；
- Place 是语义实体，Resolution 是地图派生数据；
- AI 不输出可信坐标、Provider Place ID、路线 geometry、Provider 距离或 Provider 时长；
- 用户精确编辑优先使用确定性 `PlanCommand`；
- AI 修改继续受 Schema、Scope、generation CAS、Proposal / Apply 保护；
- Route Dirty、Place Resolution 失效与现有 Candidate/Route/Map 边界继续保留。

本轮已确认的新增决策：

1. `ConversationStage` 与 canonical `TripStage` 是两套不同维度，前者不得写入或替换后者。
2. 四个 ConversationStage 只负责 UI / Dialogue / Message / Thread / Action 命名空间。
3. 所有 AI 输入、Action Card、Proposal 和主要 CTA 只放在右侧工作区，不增加第二套 AI 入口。
4. Dialogue Agent 默认 `reasoning=none`、首次调用 `web=disabled`；时效性咨询先返回 `web_required`，第二次联网后才产生最终回答。
5. Action 分为 `ai` 与 `deterministic` executor；精确删除、preference、拖拽、明确移动/排序、明确字段编辑等不重复调用 AI。
6. 主 CTA 点击本身视为确认；自然语言识别出的 Action 才显示确认卡。
7. Prompt Registry 显式注册 `shared / dialogue / action`；不再依赖 00–03 编号和文件名扫描。
8. 阶段 Codex Thread 可轮换；数据库消息历史才是真实历史来源。同一 `(tripId, stage)` 的 turn 必须串行化。
9. 行程 AI 不得创建 `newPlaces / newCandidates`；需要新地点时返回 `requiresStage=interests`。
10. `itinerary.refine` 属于修改类 AI Action，统一走 Proposal → Apply。
11. Macro UI 可以表达城市、区域、岛屿或独立停留地，但本轮不扩展 `PlaceKind`；后台继续统一以 `kind=city` 表示 Macro。
12. SQLite v3 使用全新数据库，不实现 v2 → v3 数据迁移；旧 v2 数据不保留。
13. 运行时遇到 v2 / 未知 / 损坏数据库必须 fail closed，不得静默删除、迁移或重建。
14. 真正删除/移走 `private_data/travel-v2.sqlite3` 只允许在最后的明确 cutover Phase 执行。

## Current Phase

### Phase 0 — Repository Analysis

**状态：完成。**

本 Phase 只做仓库分析、风险识别、代码映射和交接状态更新；没有实施业务重构，没有删除 Prompt，没有修改数据库，没有运行测试、typecheck、build 或应用。

remote `main` 当前观察到的 HEAD：

```text
a09a9f9c6fc96f7abc630b08e38e5e4abe31f920
"docs: tighten staged AI dialogue and action refactor plan"
```

最近一笔与当前运行代码直接相关的大改基线为兴趣点发现/定位流水线合并：

```text
bbafbb0c41fe860a8a824e49989dd94f6f58aabd
"Merge optimized interest discovery resolution pipeline"
```

当前工作环境通过 GitHub remote connector 操作，**无法观察某台开发机尚未提交的本地 `git status` / `git diff`**。因此任何本地 Codex / Worker 在进入 Phase 1 前仍必须重新执行并检查：

```text
git status
git diff
git log --oneline -n 10
```

如果发现本地未提交修改，必须保护并避开，不能假定 remote `main` 等于本地工作树。

## Completed

Phase 0 已完成：

- 阅读目标设计 `docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`；
- 阅读现有 `docs/IMPLEMENTATION_STATUS.md` 并确认其仍记录上一轮 Candidate/Resolution 改造，需要切换到本轮重构交接；
- 阅读根 `README.md`、`AGENTS.md`、`docs/README.md`；
- 检查 remote `main` 最近相关 git log；
- 读取当前 Prompt 目录；
- 映射 contracts、Prompt loader、Codex client、Structured AI runner、Planner runtime、Store、API、Web UI；
- 识别目标设计与现有代码的直接冲突；
- 识别必须保留的现有基础设施，避免本轮大重构误伤 Candidate/Resolution/Route/Proposal 主链；
- 定义 Phase 1 的准确边界。

## Existing Repository Baseline

### Canonical Contracts — 保留主体，扩展 AI 外围合同

关键文件：

- `apps/server/contracts-v2.ts`
- `apps/web/src/v2-types.ts`

当前事实：

- `TripStage` 已正确保持三阶段；
- `PlaceKind` 当前没有 `region / island / area`，符合本轮“不扩 PlaceKind”的决定；
- `TravelPlanDocument.schemaVersion` 为 2；
- `PlanCommand`、`ProposalScope`、`AiProposal` 已存在；
- 当前 `ConversationOutputSchema` 仍直接包含 `tripChanges`，现有 Runtime 会直接应用这些 TripFactCommand；这必须被新的只读/识别型 Stage Dialogue 合同替换；
- 当前 `PlanGenerationOutputSchema` 仍有 `newPlaces`；
- 当前 `DetailBatchOutputV2Schema` 仍有 `newPlaces / newCandidates`；
- 当前 `AiAgentKind` 仍为 `planner | detailer | map`。

结论：

- 不改 canonical TravelPlanDocument 三阶段结构；
- 新增 ConversationStage / AiAction 等外围合同；
- 后续按目标文档移除 itinerary 输出创建新 Place/Candidate 的能力。

### Prompt System — 必须替换

关键文件：

- `prompts/00-旅行规划Agent.md`
- `prompts/01-行程细化Agent.md`
- `prompts/02-地图候选消歧Agent.md`
- `prompts/03-兴趣点发现Agent.md`
- `apps/server/prompt-contract-v2.ts`

当前事实：

- `prompts/` 目前只有 00–03 四份 Prompt；
- `prompt-contract-v2.ts` 硬编码四个文件名；
- loader 扫描 `\d{2}-.*Agent.md` 并强制“恰好四份”；
- 根 `AGENTS.md` 仍写着“旅行规划提示词入口固定为 `prompts/00-旅行规划Agent.md`”。

结论：

- 这是本轮明确需要替换的旧架构；
- Phase 1 只建立 Registry 类型/验证骨架，不删除旧 Prompt、不切旧 loader；
- 新 Prompt 在 Phase 2 建立并注册；
- 旧 Prompt 和旧 loader 只在最终 cutover 后删除。

### Codex / Structured AI — 可复用底层，但必须解除全局默认

关键文件：

- `apps/server/codex-client.ts`
- `apps/server/structured-ai-v2.ts`

当前事实：

- `ReasoningEffort` 已支持 `none`；
- `ReasoningSummary` 已支持 `none`；
- `StructuredAiRunnerV2` 已支持 `existingThreadId`、`ephemeral`、`webSearch`、`effort`、中断和最多两次结构化修复；
- 但 `StructuredAiRunOptions` 还没有 per-call `summary`；
- `structuredTurn()` 当前强制 `summary: "detailed"`；
- `StructuredAiRunnerV2` 的 web 默认值仍是 `live`；
- active run 当前以 `threadId` 为 key，因此未来阶段线程并发必须明确串行，不能让两个 turn 同时占用同一 thread。

结论：

- 不重写 Codex RPC client；
- Phase 1 只让 `effort / summary / web` 都可由每次调用显式决定，并保持旧调用行为兼容直到 cutover；
- 阶段 thread 生命周期和串行控制放到后续 Runtime/Store Phase，不在 Phase 1 顺手实现。

### Runtime — 这是主替换区域，但保留底层业务服务

关键文件：

- `apps/server/planner-runtime-core-v2.ts`
- `apps/server/planner-runtime-base-v2.ts`
- `apps/server/planner-runtime-v2.ts`
- `apps/server/ai-task-monitor.ts`

当前事实：

- `planner-runtime-core-v2.ts` 仍通过一个 `plannerRun()` 承担 conversation / macro discovery / plan generation / adjustment 等多个 `taskMode`；
- `plannerRun()` 每次注入完整 `canonicalPlan`；
- planner 对话和多数规划动作共用 `trip.codexThreadId`；
- planner 默认 `webSearch: "live"`；
- `startConversation()` 会把 AI 返回的 `tripChanges` 直接写入 canonical plan；
- `planner-runtime-base-v2.ts` 和 `planner-runtime-v2.ts` 已包含本轮必须保留的 Candidate、Proposal、Resolution 与优化后的兴趣点研究/定位流程；
- `AiTaskMonitor` 已有统一任务状态、事件和 metadata 写入入口，可扩展 timing / input-size 信息，不需要另造第二套任务系统。

结论：

- 后续要替换“全局 conversation + taskMode + 单 planner thread”编排层；
- 不能为了重构 AI 对话而重写已稳定的 Candidate Discovery / Place Resolver / Route / PlanCommand / Proposal 业务能力；
- 新 Action execution service 应适配这些现有服务，而不是复制一套平行业务逻辑。

### Persistence — v3 Fresh Schema，高风险但延后 cutover

关键文件：

- `apps/server/travel-store-v2.ts`
- `apps/server/config.ts`

当前事实：

- `travel-store-v2.ts` 当前 `DATABASE_VERSION = 2`；
- `trips` 保存单个 `codex_thread_id`；
- `messages` 没有 `stage`；
- 当前没有 `stage_conversation_threads`、`ai_actions`；
- `ai_tasks.agent` CHECK 只允许 `planner / detailer / map`；
- Store 已具备“空 DB 才创建、版本或 Schema 不匹配则 fail closed”的安全模式，这一模式应保留；
- `config.ts` 当前同时保留旧 `travel.sqlite3` 和活动的 `travel-v2.sqlite3` 路径；本轮目标仍使用活动路径名 `travel-v2.sqlite3`，只升级其内部 schema version；
- 用户已明确选择不迁移、不保留现有 v2 数据。

结论：

- Phase 3 可以编写全新 v3 Schema 和 fresh-create/fail-closed 逻辑；
- 不写 v2 migration；
- 不在 Phase 3 删除真实 DB；
- 数据删除/移走只在最终 Atomic Cutover 独立执行。

### API — 需要从全局 turn 迁移到 stage conversation + action

关键文件：

- `apps/server/travel-api-v2.ts`
- `apps/server/index.ts`

当前事实：

- 当前对话是全局 `/api/trips/:tripId/messages` + `/api/trips/:tripId/turns`；
- Candidate discover、plan generate、refinement、commands、resolution、route、proposal 已有各自端点；
- `index.ts` 启动时仍加载旧 00–03 Prompt、创建 `TravelStoreV2`、设置全局 model reasoning、保存单个 trip thread；
- bootstrap 仍报告 DB schema version 2。

结论：

- 后续新增 stage conversation / Action 接口；
- 现有 deterministic command / resolution / route / proposal 端点优先复用；
- 不在 Foundations 阶段提前切 `index.ts` 启动路径。

### Web UI — 已有四步外壳，可复用，不要再造第二个 Stage 模型

关键文件：

- `apps/web/src/App.tsx`
- `apps/web/src/WorkspaceAssistantV2.tsx`
- `apps/web/src/ProposalPanelV2.tsx`
- `apps/web/src/CandidatePanel.tsx`
- `apps/web/src/ItineraryPanelV2.tsx`
- `apps/web/src/WorkspaceMapV2.tsx`
- `apps/web/src/v2-types.ts`

当前事实：

- `App.tsx` 已有本地 `WorkspaceStep = requirements | destinations | interests | itinerary`，与目标 `ConversationStage` 语义高度一致；
- 当前 Assistant 仍只有一个全局 chat；
- `WorkspaceAssistantV2.tsx` 仍有 `conversation | adjustment` 双模式；
- Proposal 在独立 adjustment 模式中展示，而不是附着到对应消息/Action；
- `send()` 仍调用全局 `/turns`；
- Candidate preference、地图选择、PlanCommand 编辑等已有确定性 UI 入口。

结论：

- Phase 5 应复用现有四步外壳，把 `WorkspaceStep` 收敛到共享的 `ConversationStage`；
- 删除 Assistant 的双模式，不增加另一个 AI 输入组件；
- 已有确定性 Candidate / Map / Itinerary 操作继续复用。

## Keep / Modify / Replace

### Keep

- canonical `TravelPlanDocument schemaVersion=2`；
- 现有三种 `TripStage`；
- `PlaceKind` 当前枚举；
- Candidate-first 数据模型；
- PlanCommand 和服务端命令应用；
- Proposal Scope / validation / Apply / Reject / Undo；
- generation CAS / superseded 保护；
- Place Resolver 与 Resolution fingerprint；
- Route Provider 与 Route Dirty；
- 当前优化后的 Micro Candidate discovery + save-first + best-effort resolution；
- Auth / session / config / public map cache 等与本轮无关基础能力。

### Modify

- `contracts-v2.ts`：新增 Conversation/Action 合同，后续收紧 itinerary 输出；
- `codex-client.ts` / `structured-ai-v2.ts`：per-call reasoning summary/web；
- `travel-store-v2.ts`：v3 fresh Schema、stage messages/thread/action persistence；
- `ai-task-monitor.ts` / AiTask 类型：新的 `dialogue | action | map` 语义与 timing metadata；
- `travel-api-v2.ts`：stage conversations + actions；
- `index.ts`：最终 cutover 时切新 Registry/Store/Runtime；
- `App.tsx` / `WorkspaceAssistantV2.tsx` / `v2-types.ts`：阶段化右侧 AI 体验。

### Replace / Remove at Final Cutover

- 00–03 数字 Prompt 命名与旧 loader；
- 单 `codex_thread_id` 对话假设；
- 全局 `/turns` conversation 路径；
- ConversationOutput 中 AI 直接返回并自动应用 `tripChanges` 的流程；
- Planner `taskMode` 作为多动作总分发器的核心职责；
- Assistant `conversation / adjustment` 双模式；
- 与这些旧入口绑定且最终无引用的 dead code / tests。

## Important Decisions

后续模型不得重新讨论或反向实现以下事项，除非发现目标文档本身不可实施：

- 不新增 canonical business stage；
- 不新增 `region / island / area` PlaceKind；
- 不做 SQLite v2 → v3 migration；
- 不双写 v2/v3；
- 不静默 reset DB；
- 不让 Dialogue 直接 mutation canonical plan；
- 不让 deterministic Action 再调用 AI；
- 不允许 itinerary AI 创建新 Place/Candidate；
- 不新增开放式 JSON Patch；
- 不削弱 generation CAS / Scope / Proposal；
- 不把 AI 坐标或路线当 Provider 数据；
- 不复制现有 Candidate/Resolution/Route 业务逻辑形成平行系统；
- 不把右侧工作区之外再做一套 AI 入口。

## High-Risk Areas

### 1. 数据库破坏性 cutover

用户选择不保留 v2 数据，但实际删除/移走 `private_data/travel-v2.sqlite3` 仍属于不可逆操作。必须留到最终独立 cutover，且运行时代码不能代替用户静默执行。

### 2. Thread 并发与历史污染

`StructuredAiRunnerV2.active` 当前以 `threadId` 为 key。阶段 thread 引入后必须在服务层保证同一 `(tripId, stage)` 串行化，否则并发 turn 会互相覆盖 active run 状态。

### 3. Generation / Proposal 一致性

新 Action 自身有 `baseGeneration`，现有 Proposal 也有 generation。confirm、executor start、result save、Proposal apply 都必须按目标设计重新检查，不能只在入口检查一次。

### 4. Runtime 分层较深

当前 Runtime 是 `planner-runtime-core-v2.ts → planner-runtime-base-v2.ts → planner-runtime-v2.ts` 的叠加结构，且最新兴趣点定位优化位于最外层。重构时如果直接重写 core 或把逻辑搬平，容易误删已修复的 save-first / best-effort resolution 行为。优先新增受控 Action orchestration 适配现有能力，再在最终 cleanup 删除真正无引用的旧层。

### 5. Prompt 新旧并存窗口

Phase 2 创建新 Prompt 后，旧 Runtime 仍依赖 00–03。此时不能启用“所有 `.md` 必须注册且旧文件非法”的 production startup check，直到新 Runtime 切换条件满足。Registry 校验需要区分“新 Registry 目标集合”与“最终 cutover 后 prompts 目录完整性”。

### 6. 文档规则冲突

根 `AGENTS.md` 当前仍强制 00 Prompt 入口；`docs/README.md` 当前有效文档索引尚未列出新的 AI Stage 重构专项计划。它们都是本轮需要同步更新的旧规则，但不能把安全、私人数据、验证授权等其他 AGENTS 规则一起删掉。

## Files Changed

Phase 0 只修改：

- `docs/IMPLEMENTATION_STATUS.md`

没有修改业务代码、Prompt、数据库 Schema、UI、配置或 private_data。

## Tests / Checks

本 Phase 只执行只读仓库检查：

- 读取目标设计、项目规则和当前状态；
- 查看 remote `main` 最近相关 commit history；
- 读取关键 Server/Web/Prompt 文件并建立架构映射。

未运行：

```text
npm test
npm run typecheck
npm run build
Playwright / browser E2E
真实 Codex smoke
真实 Map / Route smoke
```

原因：Phase 0 只分析并更新交接文档；没有需要测试的业务代码修改，同时项目规则禁止未经授权自动运行完整检查。

## Known Issues / Risks

- 当前 remote 仓库状态可确认，但无法通过 GitHub connector 判断用户某台开发机上的未提交修改；本地 Worker 开工前必须再次检查 `git status` / `git diff`。
- 根 `AGENTS.md` 与目标 Prompt Registry 规则存在已知冲突，必须在新 Prompt 建立阶段按目标计划修订。
- `docs/README.md` 尚未把 `AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md` 列为当前专项实施基线。
- 当前 conversation 会直接应用 AI 返回的 TripFactCommand；在新 Dialogue Runtime 上线前不能把它误认为已经满足“Dialogue 不 mutation”目标。
- 当前全局 AI reasoning 设置仍会影响旧 Runtime；新 Action Registry 上线后才应由动作策略接管。
- 当前数据库仍是 version 2；在最终 cutover 前不得删除真实 `private_data/travel-v2.sqlite3`。

## Next Phase

### Phase 1 — Foundations: Public Contracts + Registry Skeleton + Runner Controls

**只执行以下范围，不进入 Prompt 内容迁移、DB v3、Runtime orchestration 或 UI。**

1. 在 `apps/server/contracts-v2.ts` 增加并导出：
   - `ConversationStage` / Schema；
   - `AiActionExecutor`；
   - `AiActionStatus`；
   - 封闭的 `AiActionType`；
   - `StageDialogueOutput` 基础合同（reply / clarification / web_required / action）；
   - 必要的 Action 参数基础类型/Schema，只做到后续 Registry 可验证的程度。
2. 明确测试：`TravelPlanDocumentSchema` 和 `TripStageSchema` 不发生四阶段扩展，`PlaceKindSchema` 不新增 region/island/area。
3. 新建 Prompt Registry / Action Registry 的**类型和静态完整性骨架**：
   - 支持 Prompt `kind = shared | dialogue | action`；
   - Action 必须固定 `executor / inputContract / outputContract / scopePolicy / resultPolicy`；
   - `executor=ai` 才允许 Prompt/reasoning/web；
   - `executor=deterministic` 禁止 Prompt/reasoning/web；
   - Phase 1 不要求新 Prompt 文件已经存在，不把新 Registry 接到 production startup。
4. 修改 `apps/server/codex-client.ts` / `apps/server/structured-ai-v2.ts`：
   - Structured AI 每次调用可以显式设置 `effort`、`summary`、`webSearch`；
   - 不再由 `structuredTurn()` 无条件强制 `summary=detailed`；
   - 保持现有调用在未传新参数时的兼容行为，避免 Phase 1 提前改变当前 Runtime 行为。
5. 增加/调整只覆盖上述 Foundations 的单元测试。
6. 完成后更新本文件，记录实际修改、轻量检查结果、风险，并停止在 Phase 2 之前。

### Phase 1 明确禁止

- 不创建/迁移新的实际 Prompt 目录内容；
- 不删除 00–03 Prompt；
- 不切换 `index.ts` 到新 Prompt Registry；
- 不修改真实数据库版本或 Schema；
- 不删除/移动 `private_data/travel-v2.sqlite3`；
- 不实现 Stage thread persistence；
- 不实现 Action execution service；
- 不修改 API 路由；
- 不修改右侧 UI；
- 不顺手重写 Candidate Discovery / Resolver / Route / Proposal；
- 不删除旧 Runtime。

## Recommended Model

Phase 1 推荐：**高推理编码模型（GPT-5.6 Sol，high）**。

原因：这一阶段代码量不一定最大，但决定后续所有 Prompt、Action、Runtime 与持久化边界，适合优先保证合同设计和兼容性正确。Phase 1 完成后建议先做一次高推理 Review，再进入以 Prompt/合同机械迁移为主的 Phase 2。

## Do Not Do

- 不重新设计已经确认的目标架构；
- 不因为旧代码更容易复用而恢复单 Prompt / 单 Thread / `taskMode` 总入口设计；
- 不为了“通用性”新增目标文档之外的核心 Agent、Stage、Patch 系统或长期事实源；
- 不在 Foundations 阶段执行数据库 reset 或其他不可逆操作；
- 不覆盖用户未提交的本地修改；
- 不在未获许可时运行完整测试、typecheck、build 或 E2E；
- 不把 private_data、Prompt 全文、用户旅行内容或隐藏推理写入日志/测试夹具。
