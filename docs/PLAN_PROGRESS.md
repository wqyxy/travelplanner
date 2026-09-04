# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 1 — 最终线路、旧数据兼容与 Day / Route 基础  
总体状态：awaiting_local_test  
最后更新时间：2026-09-05

---

## 已确认的产品决定

- 用户只维护一份“最终线路”。
- 同一个现实地点可以在线路中出现多次，每次有独立线路节点 ID。
- 不再用地点级 `stayDays` 表达住几晚；多住一晚通过新增同地点线路节点和新的日程分界表达。
- 地点状态只保留：正常 / 待定 / 不去。
- 待定 / 不去保留原排序和地图展示，但暂时不参与当前有效 Day 和交通路线。
- 待定 / 不去节点原有住宿分界保留但暂时失效；恢复正常后原分界恢复。
- “不住”只取消日程分界，不删除地点、不自动重排。
- “多一晚”只新增一个同地点的空日程块，不自动移动前后已有景点。
- 每个线路节点保存“从上一个当前有效地点到当前节点”的交通方式。
- 跳过中间节点后，后一个有效节点自己的交通方式用于新的上一有效地点。
- Day 编号根据最终线路连续生成。
- 最后一天允许没有住宿分界。
- 生成详细地点只允许插入新地点，不能借机重排已有地点、修改状态或住宿分界。
- 只有用户明确触发优化时，AI 才能在授权范围重排已有地点。
- 地图展示正常 / 待定 / 不去全部地点，交通路线只连接正常地点。
- 地图主要负责展示 / 选择 / 定位辅助；业务编辑入口统一在右侧。
- Place / PlaceResolution / Provider 事实边界继续保留。
- 数据损坏、未知实体引用、generation / Revision / Scope / 安全问题继续硬阻止；旅行合理性问题只提醒。

---

## 测试规则

用户在 2026-09-05 明确修改施工方式：

- 不允许施工 Agent 在 GitHub、GitHub Actions、CI、容器或自身环境运行任何测试；
- 不运行 typecheck、unit test、integration test、build、migration、API test、UI 启动等执行型验证；
- 每个 Phase 代码完成后必须生成 Codex 本地测试 Prompt；
- 由用户在本地 Codex 独立测试；
- 用户未返回 PASS 前，Phase 只能是 `awaiting_local_test`，不能进入下一 Phase。

`docs/PLAN_EXECUTION.md` 已同步改成这一规则。

---

## Phase 状态

### Phase 1：最终线路、旧数据兼容与 Day / Route 基础

状态：awaiting_local_test

### 已完成代码施工

- 在旅行计划中增加最终线路结构。
- 增加线路节点状态：`normal / tentative / no_go`。
- 增加 `endsDay` 日程分界。
- 增加线路节点自己的 `transportFromPrevious`。
- 同一 Place 可以被多个线路节点引用。
- 线路节点可以保留活动、时间、费用、备注等详细信息。
- 增加最终线路 → 当前有效节点 → Day 的生成逻辑。
- Day 编号和日期由最终线路重新生成。
- tentative / no_go 节点在 Day 生成时跳过，但原节点和分界仍保存。
- 增加底层最终线路操作：
  - 新增节点；
  - 移除节点；
  - 拖动节点；
  - 状态切换；
  - 住 / 不住；
  - 多一晚；
  - 修改交通方式。
- “多一晚”通过新增同 Place 的线路节点形成同地点到同地点的 Day。
- Route 读取增加 Day 终点的到达交通方式，避免终点交通信息丢失。
- Route fingerprint 同步考虑 Day 终点交通方式。
- 旧旅行读取时会补出过渡最终线路。
- 有旧 Day / Stop 的旅行优先从 Day / Stop 转换。
- 没有 Day 的旧旅行从 Candidate 顺序转换状态。
- 旧 Revision 读取使用同一兼容逻辑。
- 数据库 `user_version` 保持 3，没有增加无必要表迁移。
- PlanCommand 增加最终线路相关命令，并继续进入现有 Revision / generation 写入通道。
- 当前旧 AI Scope 暂时没有获得最终线路重排权限；正式 AI 权限调整留在 Phase 3。
- 增加最终线路节点变化的并发冲突识别基础。
- 最终线路已经接管后，旧 Day 写入会重新由最终线路生成 Day，不能保存出第二份独立线路。
- 最终线路尚未正式接管时，旧五步写入仍可用于过渡兼容。
- 已准备 Phase 1 相关测试文件，供用户本地 Codex 执行。

主要代码提交：

- `30386087a956dd571acd22814c0fdd9c96e78249` — Phase 1 最终线路基础代码进入 `main`。
- `7666016a1c907ead43603d8f55f2aef4b00661ba` — 修正最终线路接管后旧 Day 写入的过渡一致性。

### 尚未完成

- **尚未由用户本地测试确认。**
- 不能确认 typecheck / test / build 是否 PASS。
- 不能确认旧真实数据库和旧 Revision 在用户本地环境中的实际兼容结果。
- 不能确认所有边界测试均已覆盖。
- Phase 2 尚未开始。

### 本地测试

状态：尚未由用户本地验证。

需要使用 `docs/PLAN_EXECUTION.md` 的：

> `Phase 1 → 本阶段 Codex 本地测试 Prompt`

由另一个本地 Codex 会话独立执行。

### 静态 Review 发现并已处理的问题

1. 当前 Candidate 限制同一 Place 只能有一个 Candidate，因此没有让 Candidate 直接承担最终线路节点职责；最终线路节点独立存在。
2. 旧 Day 的终点没有独立保存“到达终点的交通方式”，新增了 Day 的可选终点交通字段用于最终线路生成结果，同时继续兼容旧 Day。
3. 最终线路与旧 Day 在 Phase 1/2 过渡期可能形成两份状态，因此增加接管标记语义：
   - 过渡状态仍能从旧内容补线路；
   - 一旦最终线路接管，Day 只能由最终线路重新生成。
4. 第一次合入的过渡写入逻辑存在“最终线路接管后仍可能接受旧 Day 写入”的静态风险，已在 `7666016...` 修正；该修正仍需要用户本地测试验证。

### 发现的问题 / blocker

- 当前没有需要新增产品决定的 blocker。
- 唯一 blocker 是：Phase 1 尚未完成用户本地测试。

---

### Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：pending

未开始原因：

> `PLAN_IMPLEMENTATION_PROMPT.md` 要求 Phase 1 必须先由用户本地 Codex 返回 PASS。

计划内容：

- 两工作区导航；
- 最终线路右侧 UI；
- 人工新增 / 编辑 / 删除 / 拖动；
- 正常 / 待定 / 不去；
- 住 / 不住 / 多一晚；
- 交通设置；
- Day 自动展示；
- 地图三状态地点展示；
- 仅 normal 节点形成路线；
- 定位修复；
- 旧 Step 2 / 3 / 4 / 5 从正常入口退出。

---

### Phase 3：AI 生成 / 局部补充 / 优化 + 旧流程清理

状态：pending

计划内容：

- 生成主要地点直接进入最终线路；
- 生成详细地点直接插入最终线路；
- 局部详细地点生成；
- 生成只插入、不重排；
- 显式优化才允许重排；
- Action / Scope / Prompt 重构；
- Proposal / Revision / Undo 完整覆盖最终线路；
- Skeleton / stayDays / Candidate→DayStop 二次安排等旧职责清理；
- PRODUCT / TECHNICAL 更新为最终真实现状。

---

## 当前已知问题

1. 旧旅行中“已经形成 Day 的用户安排”和“只有 Candidate 的建议池”语义不同，兼容逻辑已经分开处理，但仍需本地真实数据验证。
2. Phase 1 仍保留 `days[]` 给现有地图 / Route 基础设施读取；目标是让它成为最终线路的自动结果，而不是另一套可独立维护数据。
3. 当前 AI Scope 仍主要理解 candidate / place / day；最终线路的 AI 局部生成和优化 Scope 留到 Phase 3 统一设计。
4. 当前 UI 仍是旧五步；这是 Phase 2 的工作，不代表 Phase 1 未按计划施工。

---

## 与原实施方案的偏差

- 产品方向没有变化。
- 测试执行方式发生变化：从“施工 Agent 自动测试”改成“全部由用户本地 Codex 测试”。
- 为降低一次性重构风险，Phase 1 继续保留 `days[]` 供旧地图 / Route 读取，但最终线路接管后 `days[]` 必须重新由最终线路生成。
- Candidate 暂时保留用于旧数据和内部兼容，但不作为新的最终线路节点。

---

## 下一步

**停止施工，等待用户本地 Phase 1 测试结果。**

用户需要：

1. 打开 `docs/PLAN_EXECUTION.md`；
2. 找到 `Phase 1 → 本阶段 Codex 本地测试 Prompt`；
3. 复制到另一个本地 Codex 会话执行；
4. 把测试 Agent 输出的 PASS / FAIL 和问题列表发回来。

只有收到 Phase 1 本地 PASS 后，才能：

```text
Phase 1 = completed
Phase 2 = in_progress
```
