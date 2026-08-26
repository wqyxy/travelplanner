# TravelPlanner v3 Implementation Status

更新时间：2026-08-27
目标文档：`docs/TRAVEL_WORKBENCH_V3.md`
实施分支：`codex/v3-candidate-workbench`
基线：`main@b2eb9a20a821408d6c2cdf34cda04478f0ba1745`

## Target

把当前“聊天直接生成完整 itinerary、每次修改自动重算地图、AI 可联网输出坐标”的 v2 流程，替换为 Candidate-first 工作台：地点发现与筛选 → Place Resolver → Day/Anchor 计划 → 确定性编辑 → Route Dirty → AI Scope Proposal / Preview / Apply / Undo → 细化。

## Current Phase

Phase 2 — TravelStore v2 与安全数据库迁移代码。

## Completed

### Phase 0 — 目标冻结与仓库分析

- 阅读并核对产品方案、详细修改方案和大型重构实施工作流。
- 读取项目规则、现有架构、源码树、关键合同、Store、工作流、地图、Prompt、API 和前端主组件。
- 建立独立实施分支 `codex/v3-candidate-workbench` 与 PR #1。
- 新增 `docs/TRAVEL_WORKBENCH_V3.md` 作为 v3 唯一目标架构依据。
- 建立分支 CI 与可下载源码/Node 24 依赖快照，基线 19 个测试文件、122 个测试通过。

### Phase 1 — Contracts v2 与纯迁移转换器

- 新增 `TravelPlanDocument schemaVersion=2`，业务阶段收敛为 `place_selection | itinerary_planning | itinerary_refinement`。
- 新增语义 Place、TripCandidate、DayAnchor、DayStop、PlaceResolution、DayRoute、ProposalScope、AiProposal 等运行时 Zod 合同。
- 新增固定 `PlanCommand` 集合与 generation 请求合同；未引入开放式 JSON Patch。
- 将 00 Planner 拆为 `conversation`、`discover_candidates`、`generate_plan`、`propose_adjustment` 四个独立输出合同。
- 02 地图辅助合同只允许选择已注入候选、返回搜索提示或 unresolved，不含坐标字段。
- 新增纯 `v1 -> v2` 转换器：将旧首尾 Stop 转为 Anchor、中间 Stop 转为 Candidate/DayStop，并确定性生成迁移 ID。
- 旧 `ai-web`/`researched` 坐标在转换时降级为 unresolved；可信 Provider exact/approximate 坐标可以转换。
- 当前运行入口仍使用 v1；Phase 1 只建立新基础，没有双写或触碰真实数据库。

## Important Decisions

- Canonical 使用 `TravelPlanDocument schemaVersion=2`。
- 产品阶段只有 `place_selection | itinerary_planning | itinerary_refinement`。
- 语义 Place 与 PlaceResolution 分离；AI 永不输出可信坐标。
- Route Dirty 由 fingerprint 比较派生，不保存任意布尔值。
- 用户编辑使用固定 PlanCommand；AI 修改使用 Proposal。
- Proposal Apply 使用 generation CAS 和原子命令执行；Undo 使用 Revision。
- 正式实体 ID 由服务端分配，模型只使用当前调用临时 ID。
- 数据迁移必须显式执行到新文件并通过事务/校验；应用启动不得静默迁移或重建旧库。
- 本次连续实施不得读取、迁移、重置或删除真实 `private_data/`；最终只做临时数据库迁移验证。
- 用户已明确允许阶段连续执行；每个 Phase 仍形成独立 commit、测试和状态记录。

## Files Changed

- `docs/TRAVEL_WORKBENCH_V3.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `apps/server/contracts-v2.ts`
- `apps/server/contracts-v2.test.ts`
- `apps/server/migration-v2.ts`
- `apps/server/migration-v2.test.ts`

工作区另有一份尚未纳入 Phase 1 的 v3 前端样式草稿 `apps/web/src/styles.css`；保留至 Phase 4/5 与组件一起验收，不在基础合同提交中回退或提交。

## Tests / Checks

- 基线 CI：19 个测试文件、122 个测试通过。
- Phase 1 定向 Vitest：2 个测试文件、11 个测试全部通过。
- `npm run typecheck:server`：通过。
- 未运行真实服务、真实 Codex、真实地图 Provider 或浏览器 E2E。
- 未读取或接触 `private_data/`。

## Known Issues / Risks

- 当前 v1 运行入口尚未切换；新合同暂时独立存在，这是受控 Phase 边界，不允许长期形成双系统。
- v1→v2 转换器只负责纯数据转换；数据库事务、备份、目标文件原子切换与旧任务状态处理属于 Phase 2。
- 地点解析与路线拆分尚未实施；当前旧 MapPipeline 仍可联网取得坐标，必须在后续 Phase 删除其 AI 坐标路径。
- 本地 Node 为 22，`node:sqlite` 行为和最终生产验证以 Node 24 CI 为准。

## Next Phase

Phase 2：

- 新增 TravelStore v2，保存 canonical plan、generation、Revision、Message、AI Task、PlaceResolution、DayRoute 与 AiProposal。
- 所有 canonical 写入使用事务与 expectedGeneration CAS；标题索引与 plan 同事务维护。
- Proposal Apply/Undo 所需的 Revision 原语在 Store 中建立，但不实现 AI 工作流。
- 新增显式、可恢复的数据库迁移函数：只读源 v1，写入新的目标文件，完整验证后返回结果；不得覆盖源文件。
- 在临时 SQLite 上覆盖新建、CAS、Revision、派生状态、Proposal 和迁移失败回滚测试。
- 不修改真实 `private_data/`，不在应用启动时自动执行迁移，不进入 API/UI。

## Recommended Model

高推理 Reviewer 复核事务、CAS、版本和迁移安全；实现使用 Worker。

## Do Not Do

- 不触碰真实 `private_data/`。
- 不在 Store 中保存 routeDirty 布尔值。
- 不把 PlaceResolution/DayRoute 变成 canonical 第二事实源。
- 不增加坐标 Agent、开放式 Patch、额外业务 stage 或 legacy 双写。
- 不在 Phase 2 顺手接入 API、Prompt 或前端。
