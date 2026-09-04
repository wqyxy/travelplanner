# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 1 — 最终线路、旧数据兼容与自动 Day / Route 基础  
总体状态：in_progress  
最后更新时间：2026-09-05

---

## 已确认的产品决定

- 用户只维护一份“最终线路”。
- 最终线路中的同一个现实地点允许出现多次，每次有独立线路节点 ID。
- 不再使用地点级 `stayDays` 表达住几晚；多住一晚通过新增一个同地点线路节点和新的日程分界表达。
- 地点状态只保留：正常 / 待定 / 不去。
- 待定 / 不去都保留在线路原排序和地图中，但暂时不参与当前有效 Day 和交通路线。
- 待定 / 不去节点原有住宿分界保留但暂时失效；恢复正常后原分界恢复。
- “不住”只取消日程分界，不删除地点、不自动重排。
- “多一晚”只新增一个同地点的空日程块，不自动移动前后已有景点。
- 每个线路节点保存“从上一个当前有效地点到当前节点”的交通方式。
- 跳过中间节点后，后一个有效节点自己的交通方式用于新的上一有效地点。
- Day 编号由当前线路自动连续生成。
- 最后一天允许没有住宿分界。
- 生成详细地点只允许插入新地点，不能借机重排已有地点、修改状态或住宿分界。
- 只有用户明确触发优化时，AI 才能在授权范围重排已有地点。
- 地图展示正常 / 待定 / 不去全部地点，交通路线只连接正常地点。
- 地图主要负责展示 / 选择 / 定位辅助；业务编辑入口统一在右侧。
- Place / PlaceResolution / Provider 事实边界继续保留。
- 数据结构损坏、实体引用错误、generation / revision / Scope / 安全问题继续硬阻止；旅行合理性问题只提醒。

---

## Phase 状态

### Phase 1：最终线路、旧数据兼容与自动 Day / Route 基础

状态：in_progress

完成：

- 已完成 PRODUCT / TECHNICAL / PLAN 与当前关键代码 Review。
- 已确认当前五步流程和多层数据同步问题确实存在于实际代码，不只是文档描述。
- 已确认当前 Step 3 `stayDays` 会真正展开 Day。
- 已确认当前 Step 4 Candidate 仍需 Step 5 再安排成 DayStop。
- 已确认当前 TravelPlanDocument 为 schemaVersion 2。
- 已确认数据库版本为 3，旅行当前版本和历史 Revision 都保存完整 plan JSON。
- 已确认用户关于“待定 / 不去时住宿分界如何处理”的产品决定。
- 已确认用户关于“跳过地点后交通方式如何继承”的产品决定。
- 已创建 `docs/PLAN_EXECUTION.md`，施工压缩为 3 个 Phase。

未完成：

- 最终线路数据结构尚未落地代码。
- 旧 schemaVersion 2 读取转换尚未实现。
- 旧 Revision 恢复兼容尚未实现。
- 最终线路 → Day 自动生成尚未实现。
- 住 / 不住 / 多一晚 / 状态切换 / 拖动等底层命令尚未实现。
- Route 输入和 dirty 逻辑尚未切换到最终线路。
- Phase 1 自动测试尚未运行。

测试：

- 尚未开始 Phase 1 代码测试。
- Phase 1 完成后必须至少运行：`npm run typecheck`、`npm test`、`npm run build`。

发现的问题：

- 当前 Candidate 明确限制“一趟旅行中同一个 Place 只能有一个 Candidate”，不能直接承担“同一个地点在线路中多次出现”的新需求。
- 当前 DayStop 可以重复引用 Place，但被固定嵌套在某个 Day 中，也不适合作为整条最终线路本身。
- 当前旧数据读取使用严格旅行计划 schema；若直接替换 schema 而不做兼容，旧旅行和历史 Revision 会无法读取。
- 当前五步 Workflow、Action Scope、Skeleton、Macro / Detail Route、itineraryUpdateState 都直接依赖旧分层，后续必须按 Phase 逐步收敛。

### Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：pending

完成：

- 无。

未完成：

- 两工作区导航。
- 最终线路右侧 UI。
- 人工新增 / 编辑 / 删除 / 拖动。
- 正常 / 待定 / 不去。
- 住 / 不住 / 多一晚。
- 交通设置。
- Day 自动展示。
- 地图三状态地点展示和仅 normal 路线。
- 定位修复。
- 旧 Step 2 / 3 / 4 / 5 正常入口移除。

测试：

- 待 Phase 2 施工后执行自动测试和 `PLAN_EXECUTION.md` 中的独立 Codex UI 测试 Prompt。

发现的问题：

- 无新增 blocker。

### Phase 3：AI 生成 / 局部补充 / 优化 + 旧流程清理

状态：pending

完成：

- 无。

未完成：

- 生成主要地点直接进入最终线路。
- 生成详细地点直接插入最终线路。
- 局部详细地点生成。
- 生成只插入、不重排。
- 优化范围授权。
- Action / Scope / Prompt 重构。
- Proposal / Revision / Undo 完整覆盖。
- Skeleton / stayDays / Candidate→DayStop 二次安排等旧职责清理。
- PRODUCT / TECHNICAL 完成后的现状更新。

测试：

- 待 Phase 3 施工后执行最终自动测试和端到端独立 Codex 验收 Prompt。

发现的问题：

- 无新增 blocker。

---

## 当前已知问题

1. 旧旅行计划中“已有 Day 的路线事实”和“只有 Candidate、尚未排 Day 的建议地点”语义不同，迁移必须分别处理，不能简单复制数组。
2. Phase 1 过渡期可能继续保留 `days[]` 供现有地图 / 路线代码读取，但必须由最终线路统一生成，不能继续作为另一套独立编辑内容。
3. 当前 Scope 冲突检测主要理解 candidate / place / day；最终线路节点和线路区间需要新的 Scope 表达或等价受控映射。
4. 当前数据库表结构暂未发现必须升级的理由；优先只升级旅行计划 JSON 并兼容旧 schema，避免无必要数据库迁移。

---

## 与原计划的偏差

- 无产品方向偏差。
- 为降低一次性重构风险，实施方案允许在过渡期继续生成现有 `days[]` 供已有地图 / Route 基础设施读取；但 `days[]` 只能由最终线路生成，不能继续独立编辑。
- Candidate 在过渡期允许保留用于旧数据和内部兼容，但退出正常用户线路职责。

---

## 下一步

开始 Phase 1 代码施工：

1. 先确定并实现最终线路节点类型和旅行计划新 schema；
2. 实现旧 schemaVersion 2 → 新结构的读取转换；
3. 实现最终线路 → 当前有效线路 → Day 的纯函数和底层确定性修改；
4. 接入旅行 Store / Revision；
5. 接入 Route 输入与 dirty 逻辑；
6. 补齐自动测试；
7. 运行 `npm run typecheck`、`npm test`、`npm run build`；
8. 自动测试全部通过后立即更新本文件，然后进入 Phase 2。
