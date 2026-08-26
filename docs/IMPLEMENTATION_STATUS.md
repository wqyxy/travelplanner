# TravelPlanner v3 Implementation Status

更新时间：2026-08-27
目标文档：`docs/TRAVEL_WORKBENCH_V3.md`
实施分支：`codex/v3-candidate-workbench`
基线：`main@b2eb9a20a821408d6c2cdf34cda04478f0ba1745`

## Target

把当前“聊天直接生成完整 itinerary、每次修改自动重算地图、AI 可联网输出坐标”的 v2 流程，替换为 Candidate-first 工作台：地点发现与筛选 → Place Resolver → Day/Anchor 计划 → 确定性编辑 → Route Dirty → AI Scope Proposal / Preview / Apply / Undo → 细化。

## Current Phase

Phase 1 — Contracts v2 与纯迁移转换器。

## Completed

### Phase 0

- 阅读并核对用户提供的产品方案、详细修改方案和大型重构实施工作流。
- 读取 `README.md`、`AGENTS.md`、现有架构文档、实施状态、源码树、关键合同、Store、Planner、Detail、Map、Prompt、API 和前端主组件。
- 确认远程基线 HEAD 为 `b2eb9a20a821408d6c2cdf34cda04478f0ba1745`。
- 建立独立实施分支 `codex/v3-candidate-workbench`。
- 新增 `docs/TRAVEL_WORKBENCH_V3.md`，作为 v3 唯一目标架构依据。
- 明确保留认证、本地数据隔离、Codex 受控调用、generation CAS、正式 ID、版本历史、AI Task、MapLibre、地图公共缓存等外围能力。
- 明确删除 03 坐标 Agent、旧 `planning|draft|detailed` 产品阶段、直接 draft 快捷动作、AI 普通修改直接写 canonical、跨日首尾硬相等与自动全路线重算。

## Important Decisions

- Canonical 使用 `TravelPlanDocument schemaVersion=2`。
- 产品阶段只有 `place_selection | itinerary_planning | itinerary_refinement`。
- 语义 Place 与 PlaceResolution 分离；AI 永不输出可信坐标。
- Route Dirty 由 fingerprint 比较派生，不保存任意布尔值。
- 用户编辑使用固定 PlanCommand；AI 修改使用 Proposal。
- Proposal Apply 使用 generation CAS 和原子命令执行；Undo 使用 Revision。
- 数据迁移代码可以实现和测试，但本次不得读取、迁移、重置或删除真实 `private_data/`。
- 用户已明确允许阶段连续执行；每阶段仍形成独立提交和状态记录。

## Files Changed

- `docs/TRAVEL_WORKBENCH_V3.md`
- `docs/IMPLEMENTATION_STATUS.md`

## Tests / Checks

- Phase 0 仅进行远程仓库只读检查和文档一致性复核。
- 未运行应用、测试、typecheck、build 或真实 Codex/地图 Provider。
- 未读取或接触 `private_data/`。

## Known Issues / Risks

- 当前 v1 合同、Store、Prompt、API 与前端均与 v3 冲突，后续阶段会有较大切换半径。
- 容器不能直接 clone GitHub；代码验证将通过分支提交后的 GitHub Actions CI 完成，并根据失败日志迭代。
- 真实数据库迁移必须保持显式、安全、可恢复，不能因应用启动静默执行。

## Next Phase

Phase 1：

- 重写 `apps/server/contracts.ts` 为 TravelPlanDocument v2、PlaceResolution、DayRoute、PlanCommand、AI mode contracts 和 Proposal contracts。
- 新增纯 `v1 -> v2` 转换器，不访问文件或数据库。
- 重写合同测试，覆盖引用、Candidate preference、must-go、Anchor、Scope、命令和坐标禁令。
- 不修改 Store、API、Prompt 或前端运行链路。

## Recommended Model

高推理 Planner/Reviewer 用于合同与迁移边界；确定后由 Worker 实施。

## Do Not Do

- 不触碰真实 `private_data/`。
- 不增加坐标 Agent、开放式 Patch、额外业务 stage 或兼容性平行事实源。
- 不在 Phase 1 顺手重写 API/UI。
