# P0 Temporary Worklog

> 临时施工记忆文件。P0 完成后应整理有效结论到正式文档，再删除本文件。
>
> 开始时间：2026-09-07
> 当前分支：main
> 当前状态：P0-1 runtime architecture in progress

## 目标

P0 分三条主线，按风险从低到高推进：

1. `planner-runtime-v3.ts`：先做行为保持的职责拆分，降低 God Object 风险。
2. V2/V3 边界：识别真正 legacy、canonical-but-misnamed 和可复用 capability，消除不安全 cast，不做盲目改名/删除。
3. finalRoute / Day / Route：收敛 canonical 与派生边界，保持 finalRoute 为唯一用户维护线路，Day/Route 为派生/Provider 事实。

当前只开始 P0-1；除非拆分需要，不提前改 canonical 数据结构。

## 当前产品事实（不得破坏）

- 产品只有 `规划 · 旅行需求` / `行程 · 最终线路` 两个主工作区。
- 用户只维护 `finalRoute`；Day 自动派生。
- 同一 Place 可在线路中多次出现，每次拥有独立 route node ID。
- `tentative / no_go` 保留，但退出当前 Day / Route。
- `住 / 不住` 控制日程分界；`多一晚` 新增同 Place 独立 route node。
- 右侧最终线路是唯一业务操作入口；地图负责展示/选择/聚焦/响应定位选点。
- Provider 坐标、Place ID、geometry、distance、duration、verified 状态不能由 AI/前端伪造。
- 用户是旅行方案唯一决策者；“不合理”原则上是 advisory，不是 canonical blocker。

## 工程边界

- fresh v3 数据库策略保持；不重新加入 v2 -> v3 migration/双写。
- SQLite 事务、generation CAS、Proposal Scope、Provider 事实边界不可弱化。
- 不为了架构整洁改变 Action 权限或 AI scope。
- 普通施工不运行完整 test/typecheck/build；先静态 review。完整验证需用户确认。

## 已发现的 P0-1 问题

`apps/server/planner-runtime-v3.ts` 当前同时承担：

- workspace 聚合；
- Dialogue thread / turn / web-required 生命周期；
- CTA / conversation Action 创建、确认、取消、执行；
- Action state 构造；
- AI 输出 -> Proposal / canonical 持久化；
- interest discovery 批处理；
- Place resolution；
- Day route batch；
- Google Maps link；
- 各类 deterministic itinerary mutation；
- task/event/active-run 协调；
- 一部分 domain validation / diff / command derivation。

这已经超过单一 runtime orchestration 的职责范围。

## 第一阶段拆分原则

先拆“纯函数 / 纯领域逻辑”，再拆“有状态 orchestration”。

优先候选：

1. `planner-action-scope-v3.ts`
   - `dayMutationScope`
   - `actionScope`
2. `planner-proposal-v3.ts`
   - Proposal diff / command derivation / replacement/refinement 等纯逻辑（需进一步核对依赖后决定颗粒度）
3. 保留 `TravelPlannerRuntimeV3` 作为 facade/orchestrator，HTTP 调用方暂时不变。

第一刀应尽量满足：只移动代码 + 明确 import/export，不改变行为、合同、错误文案和持久化顺序。

## 当前读取基线

已读：

- `AGENTS.md`
- `README.md`
- `docs/PLAN_PROGRESS.md`
- `apps/server/planner-runtime-v3.ts` 入口及 Action 生命周期前半部分

注意：`AGENTS.md` 仍引用不存在的 `docs/IMPLEMENTATION_STATUS.md`，且有旧五步/city-only 规则与后面的 User Control Correction 冲突。这个属于后续 P2 文档清理，不在当前 P0 第一刀顺手修改。

## 下一步

1. 继续扫描 `planner-runtime-v3.ts` 全部方法和外部调用。
2. 先建立职责清单和依赖图。
3. 选择最安全的纯函数模块进行第一次行为保持拆分。
4. 静态检查所有 import/call site；把结果同步回本文件。
