# User Control Correction / 用户控制权修正

> 状态：实施中
> 分支：`codex/user-control-correction`
> 开始日期：2026-09-04
> 数据策略：fresh-v3，`PRAGMA user_version = 3` 不变；不迁移、不删除 private_data

## 核心原则

TravelPlanner 从“系统保证旅行计划合理”调整为“系统保证数据安全可靠，旅行方案由用户决定”。

```text
Canonical = 用户当前已经接受并保存的旅行方案
Advisory = 系统发现的规划问题或能力受限提醒
Proposal = AI 建议对 canonical 做出的修改
Scope = AI 本次被允许修改的范围
```

Canonical 只保证数据可以被可靠保存、引用和恢复，不保证旅行计划符合系统启发式。日期、天数、时间、地点归属、must-go、excluded、未定位等规划问题默认允许保存，并由 Advisory + AI Proposal 处理。

## 继续硬失败的边界

- 重复实体 ID。
- Candidate / Stop / Anchor 引用不存在的 canonical 实体。
- 同一 canonical Place ID 对应多个 Candidate。
- Candidate 父引用自己、父引用不存在或形成循环。
- generation CAS、Proposal Scope、事务和 revision/undo 边界。
- 非法 schema/type/enum、无法解析的日期或时间格式。
- AI 伪造坐标、Provider Place ID、Provider 路线/距离/时长或实时事实。
- 登录、安全、密钥、private_data 和数据库版本边界。
- 单次 AI/Provider/HTTP 操作的技术资源保护。

## 规划问题改为 Advisory

包括但不限于：

- 日期范围反向、requestedDurationDays 与日期范围不一致。
- Day 数量不足或超出日期范围。
- Day 日期重复/不连续。
- planningRole 与 PlaceKind 的非传统组合。
- 非 planning_area Candidate 没有父规划区域。
- semantic/name duplicate。
- excluded Candidate 被安排进 Day。
- must_go 未被安排。
- Place 未定位。
- Stop 只填写开始或结束时间。
- 跨夜或疑似跨夜时间。
- duration 与开始/结束时间不一致。
- 同日 Stop 时间重叠。

## 已实施

### UC0 — 原则基座

- 新增本专项文档。
- 更新 `prompts/shared/旅行规划共享规则.md`：canonical 视为用户已接受方案；AI 只在最小 Scope 修改；规划冲突不再作为拒绝理由；未定位不得伪造 Provider 事实。

### UC1 — Canonical Structural Foundation

已修改 `apps/server/contracts-v2.ts`：

- `TripDates` 不再拒绝 start > end，也允许日期范围与 requestedDurationDays 同时存在。
- 删除 requestedDurationDays 90 天业务上限。
- 删除 Day `dayNumber <= 90`、Day stops `<=80`、Document days/places/candidates 等 canonical 旅行规模业务上限。
- `DayStop` 新增兼容型 `scheduleText`。
- Stop 开始/结束时间不再要求成对。
- 不再要求 `endTime > startTime`。
- 不再要求 `durationMinutes === end-start`。
- detailed Day 不再要求每个 Stop 都有完整时间、duration 和 verification。
- 不再要求 dayNumber 按数组连续递增。
- 不再因为 stage 已进入 itinerary 而要求必须已有 Day。
- 不再因为日期范围而要求 Day 数量/日期精确匹配。
- 不再因为 excluded Candidate 已经进入行程而拒绝 canonical。
- 不再在 canonical validation 中限制 planningRole 与 PlaceKind。
- 不再要求 core/detail 必须绑定 Planning Area。
- 保留同一 canonical Place ID 单 Candidate、实体引用、ID 唯一性和 Candidate 父关系完整性。
- 新增 Candidate parent cycle 检查。

新增 `apps/server/planning-advisories-v3.ts`：

- Advisory 纯派生，不写 canonical、不写 revision。
- Advisory ID 由 code + object refs 确定性生成。
- 首批实现日期、Day 数量、重复地点、PlanningRole、未定位、excluded、must-go、时间和 overlap 提醒。

新增 `apps/server/user-control-correction-v3.test.ts`，固定“允许规划冲突、继续拒绝结构损坏”的新边界。

### UC2 — Planning Area / Duplicate

已修改 `apps/server/planning-areas-v2.ts`：

- Planning Area 以 `planningRole === planning_area` 为主，不再以 `kind=city` 为 canonical 身份。
- 旧数据缺失 planningRole 时继续使用 `city -> planning_area / 其他 -> detail_interest` compatibility fallback。
- 新增 `planningAreaCandidateId` / `planningAreaPlaceId` 语义，同时保留旧 `cityCandidateId` / `cityPlaceId` 兼容字段。
- excluded 只影响默认参与规划，不再表示 canonical 禁止关系。

已修改 `apps/server/candidate-discovery-policy-v2.ts`：

- `filterCoreVisitDuplicatesV3()` 不再静默删除 semantic duplicate。
- Macro discovery 不再使用“最多 80 个目的地”作为整趟旅行的业务上限。
- 单区域单次 0–9 个兴趣点继续作为 AI operation resource limit 保留。

## 待实施

### UC3 — Itinerary / Manual / Route

- 移除 `planner-runtime-v3.ts` / `detail-itinerary-v3.ts` 等运行时的 resolved-only、excluded、city-stop、must-go、overlap、area-membership 业务 blocker。
- 保留未知引用、Scope、Provider fact 等结构/安全失败。
- Route 保持 best-effort，未定位只产生 attention leg。
- `scheduleText` 接入 replacement/refinement diff。

### UC4 — Advisory Pipeline

- 将 `derivePlanningAdvisoriesV3()` 接入 workspace API。
- UI 只消费后端统一 Advisory，不另造第二套规划规则。

### UC5 — AI Scope / Explicit User Intent

- Read Context 与 Mutation Scope 分离。
- Day-scoped action 可读取相邻上下文，但只能写目标 Day。
- Trip Scope 只在首次全局 Generate 或用户明确“整体重排”时签发。
- Repair #8 保留明确 +N/-N/absolute day instruction enforcement，同时删除 90 天业务限制。

### UC6 — Action Prompts

- must-go coverage、时间完整、已定位、区域归属、无 overlap 等从“必须满足”调整为“默认尽量满足”。
- 结构化合同、Scope、Provider fact boundary 继续必须满足。

### UC7 — UI / Handoff

- 五步始终可进入。
- blocker card 改 Advisory card。
- Save 只因真正无效输入禁用。
- AI Composer 保持可用；对象级 Action 没有目标时只说明原因，不伪造目标。
- 未定位地点继续显示在行程中。
- 支持 scheduleText 展示。
- 保持地图/时间轴展示 + 右侧唯一交互入口，不做大规模视觉重设计。

## 测试策略

本专项按既定项目规则执行：每个 UC Phase 只做直接相关的轻量 Gate。完整 test suite、完整 typecheck/build、Browser E2E 和真实 AI/private_data E2E 在最终阶段单独列出并经用户确认后执行。
