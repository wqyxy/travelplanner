# User Control Correction / 用户控制权修正

> 状态：代码实施完成，完整综合 Gate 待确认
> 分支：`codex/user-control-correction`
> PR：Draft PR #5
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
- 更新共享旅行规划 Prompt：canonical 视为用户已接受方案；AI 只在最小 Scope 修改；规划冲突不再作为拒绝理由；未定位不得伪造 Provider 事实。
- README、AGENTS、原五步实施文档与 `IMPLEMENTATION_STATUS.md` 已明确本专项优先于旧的 city-only / Phase 7 规则。

### UC1 — Canonical Structural Foundation

已修改 `apps/server/contracts-v2.ts`：

- `TripDates` 不再拒绝 start > end，也允许日期范围与 requestedDurationDays 同时存在。
- 删除 requestedDurationDays 的旧业务天数上限。
- 删除 Day 数量、每 Day Stop 数量、Document places/candidates 等旅行规模业务上限。
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
- 实现日期、Day 数量、重复地点、PlanningRole、未定位、excluded、must-go、时间、duration 与 overlap 提醒。

### UC2 — Planning Area / Duplicate

- Planning Area 以 `planningRole === planning_area` 为主，不再以 `kind=city` 为 canonical 身份。
- 旧数据缺失 planningRole 时继续使用 `city -> planning_area / 其他 -> detail_interest` compatibility fallback；该 fallback 只用于 legacy 读取，不作为权限或新数据校验规则。
- 手工新增地点允许 PlanningRole 与 PlaceKind 独立选择并原样落盘。
- semantic duplicate 不再在 discovery / PlanCommand 阶段静默删除或硬拒绝。
- 精确同一个 canonical Place ID 仍只允许一个 Candidate。
- 单区域单次 0–9 个兴趣点继续作为 AI operation resource limit 保留。

### UC3 — Itinerary / Manual / Route

- runtime / detailed apply 已移除 resolved-only、excluded、city-stop、must-go coverage、overlap、area-membership 等规划型 blocker。
- 未定位 Place 可继续进入 Day/Stop；`DayStop.placeId` 仍必须引用真实 canonical Place。
- `preference=excluded` 不会自动删除用户已经排入的 Stop。
- 普通 PlanCommand 不再自动重写用户 Day 日期。
- `scheduleText` 已进入 detail generate/update/refine 和 replacement diff。
- Route 保持 best-effort：未定位端点返回 attention/warning，不伪造距离、时长、geometry 或 Provider ID。

### UC4 — Advisory Pipeline

- `derivePlanningAdvisoriesV3()` 已接入 `/workspace`。
- Advisory 不持久化，不进入 revision。
- 右侧步骤区域统一消费后端 Advisory，不再由每个页面分别发明规划硬规则。

### UC5 — AI Scope / Explicit User Intent

- Read Context 与 Mutation Scope 已分离。
- excluded 候选仍进入 AI read context；`preference=excluded` 只是默认规划提示，不是可见性或权限过滤。
- 单日局部 AI Action 使用 Day Scope。
- 多日 `itinerary.detail.update` / `itinerary.refine` 使用 `{ type: "days", ids: [...] }`，越界命令由 Scope Policy 代码拒绝。
- 局部 deterministic Stop/Anchor/edit Action 的 Scope 元数据同步收紧；跨日 Stop move 使用 Days Scope。
- `itinerary.day.reorder` 因会改变整条 Day 顺序，保留 Trip Scope；首次全局 Generate、明确 Replan、全局 Repair/Verify 等全局语义 Action 也保留 Trip Scope。
- Repair #8 保留用户明确 `+N/-N/absolute day` 指令 enforcement，并支持多位数字；旧 90 天限制已删除，负数结果仍作为结构无效拒绝。

### UC6 — Action Prompts

- must-go coverage、时间完整、已定位、区域归属、无 overlap 等从“必须满足”调整为“默认尽量满足”。
- AI 不得为了让计划“更合理”静默删除、移动、缩短用户未授权的内容。
- 用户明确旅行意图优先于启发式建议。
- 结构化合同、Scope、Provider fact boundary 继续必须满足。

### UC7 — UI / Handoff

- 五步始终可进入，不再用上游规划完整度锁死导航。
- blocker card 已改为 Advisory / update 提醒语义。
- Save 只因结构性无效输入禁用，不因规划“不合理”禁用。
- Step 3 可保存天数不足/超出、must-go 省略、excluded 进入路线等方案。
- Step 4 显示 excluded，普通景点父 Planning Area 可为空，路线需更新时仍可研究/补充。
- Step 5 在未定位、上游需确认、部分/自然时间情况下仍可继续编辑或生成。
- `scheduleText` 在每日行程 UI 展示。
- 保持“地图/时间轴展示 + 右侧唯一交互入口”的既有设计，不做额外大规模视觉重构。
- 已移除 AI/对话前置合同中的 365 天、90 Day、80 Stop、1800 Candidate/Place 等旅行规模业务上限。
- 保留明确的单次技术资源保护，例如单区域兴趣点 0–9、Refine 小批次、Proposal/Verify 100 commands。

## 验证结果

2026-09-04 已执行 User Control 专项轻量 Gate，以下测试通过：

- `apps/server/user-control-correction-v3.test.ts`
- `apps/server/user-control-days-scope-v3.test.ts`
- `apps/server/user-control-size-context-v3.test.ts`
- `apps/server/replan-intent-v3.test.ts`

本轮只执行专项测试与多次 `git diff --check`，没有执行完整 test suite、完整 typecheck/build、Browser E2E 或真实 AI/private_data E2E。

## 最终 Gate 策略

按照仓库既定规则，完整综合 Gate 必须单独确认后再执行。待确认项目包括：

- 全量 `npm test`
- `npm run typecheck`
- `npm run build`
- Browser E2E
- 真实 AI / private_data E2E

在完整 Gate 完成前，Draft PR #5 保持 Draft，不合并 main。
