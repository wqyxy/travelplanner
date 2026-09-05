# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 2 — 右侧最终线路人工规划闭环 + 地图联动  
总体状态：in_progress  
最后更新时间：2026-09-05

---

## 已确认的产品决定

- 用户只维护一份最终线路。
- 同一现实地点可以在线路中出现多次，每次拥有独立线路节点 ID。
- 节点状态为 normal / tentative / no_go。
- tentative / no_go 保留顺序和保存的住宿分界，但退出当前有效 Day 和交通路线；恢复 normal 后重新生效。
- 交通方式属于“到达当前节点”。
- 不住只取消日程分界。
- 多一晚新增同 Place 的线路节点，不移动其他地点。
- Day 根据最终线路自动生成，最后一天允许没有住宿分界。
- 普通 AI 生成只能插入新地点；只有显式优化才能重排已有地点。
- 地图显示全部状态，交通路线只使用 normal。
- 地图只负责展示 / 选择 / 定位辅助，业务修改入口统一在右侧。
- Provider 坐标、真实距离、时长和 geometry 的事实边界继续保留。

---

## 数据策略

用户已确认当前全部旅行数据都是测试数据，可以从头开始。

因此：

- 不迁移已经落盘的旧旅行 JSON；
- 不从旧 Candidate / Day 猜测最终线路；
- 不兼容施工前旧 Revision；
- 旧本地数据库可以直接清空 / 删除后重建；
- Revision / Undo 只保证新结构。

Phase 2 / 3 尚未完全拆掉旧 Skeleton、Day 和 detailed itinerary 内部路径。Phase 1 保留一个施工中间态的当前写入翻译层：

```text
当前旧代码路径产生新的 Day 视图
→ Store 保存边界翻译成最终线路节点
→ 再由最终线路生成 Day
→ 数据库最终只有一份线路
```

这层逻辑不能用于读取或迁移已经落盘的旧格式旅行。

---

## 测试规则

- 施工 Agent 不运行测试、typecheck、build、应用启动或 CI。
- 每个 Phase 由用户本地 Codex 独立验证。
- 测试必须绑定唯一 `Test Branch + Test HEAD`。
- Branch / HEAD 不一致或工作树影响待测代码时不能给 PASS。
- 任意业务代码新提交都会使旧测试基线失效。
- 用户未返回匹配基线的 PASS 前，不进入下一 Phase。

---

# Phase 1：最终线路底层与自动 Day / Route 基础

状态：completed

## 已完成能力

- 最终线路节点、三状态、住宿分界、到达交通字段。
- 同一 Place 多线路节点。
- 最终线路 → Day 自动生成。
- 新增 / 删除 / 拖动 / 状态 / 住 / 不住 / 多一晚 / 交通修改。
- 最终线路变化进入 generation / Revision / Proposal 冲突判断。
- Route 能读取 Day 终点的到达交通方式。
- 完全空白 `finalRoute.version = 0` 只作为启动占位，进入最终线路逻辑后提升到 version 1。
- 已经落盘的非空旧格式旅行直接报 `OLD_TEST_PLAN_UNSUPPORTED`，不迁移。
- 当前旧 Skeleton / Day / detail 新写入可以在 Store 边界翻译到最终线路，避免形成第二份可独立保存的线路。
- Stop-only Day 的 null Anchor 过渡形态可以保存并继续追加 Stop。
- Detailed Update 不会误清由 Day 到达交通落实到首 Stop 的交通方式。

## R1 本地验收

```text
Test Branch: test/plan-phase1-final-route-20260905
Test HEAD: b751f0dff0c475419c54bf657a8cc541343443ac
```

结果：FAIL。完整回归有 21 个失败，暴露旧 Day 写入与最终线路保存边界冲突。

## R2 本地验收

```text
Test Branch: test/plan-phase1-final-route-20260905-r2
Test HEAD: 5adec91f04d6c74614464f38516626bd15fcc45c
```

结果：FAIL。收敛到 2 个 High 问题：Stop-only Day 和 Detailed 首站到达交通 sticky。

## R3 本地验收

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
```

用户本地结果：**PASS**。

实际：

- Git Branch / HEAD 与冻结基线一致；
- 工作树干净；
- typecheck：PASS（Windows 使用 `npm.cmd run typecheck`）；
- Phase 1 + R3 专项：6 files，28/28 PASS；
- R2 两个失败文件：2 files，16/16 PASS；
- 历史 7 个失败文件：7 files，50/50 PASS；
- 完整 `npm test`：83 files passed / 0 failed；479 tests passed / 0 failed；
- build：PASS（Windows 使用 `npm.cmd run build`）；
- 用户独立临时审计：6/6 PASS；
- 未运行真实 AI / 地图 Provider 网络调用 / 浏览器 E2E，Provider 事实边界由源码与单元测试覆盖。

结论：Phase 1 Gate 已通过，可以进入 Phase 2。

---

# Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：in_progress

## 本阶段目标

1. 正常导航收敛为两个工作区：
   - `规划：旅行需求`
   - `行程：最终线路`
2. 右侧成为最终线路唯一业务编辑入口。
3. 最终线路右侧支持：
   - 新增地点；
   - 编辑地点；
   - 删除线路节点；
   - 拖动排序；
   - normal / tentative / no_go；
   - 住 / 不住 / 多一晚；
   - 到达当前节点的交通方式；
   - 定位修复 / 地图选点。
4. Day 仅作为最终线路分界后的派生展示，不再作为正常编辑入口。
5. 地图显示最终线路全部 normal / tentative / no_go 地点；交通路线只连接 normal。
6. 地图点击只负责选择 / 聚焦，不新增删除、状态、住宿等第二套业务按钮。
7. 旧 Step 2 / 3 / 4 / 5 不再作为正常导航入口。
8. 不合理线路只提醒，不自动改动用户顺序或住宿分界。

## 当前施工状态

- Phase 1 R3 PASS 已记录。
- 正在审查当前五步 UI、地图展示和 PlanCommand 接口，开始将它们收敛到最终线路工作区。
- 尚未由用户本地验证 Phase 2。

---

# Phase 3：AI 生成 / 局部补充 / 显式优化 + 旧流程清理

状态：pending

只有 Phase 2 本地测试 PASS 后才开始。

Phase 3 负责：

- 主要地点生成直接加入最终线路；
- 详细地点生成直接插入最终线路；
- 局部补充；
- 普通生成只能插入，不重排；
- 显式优化才允许重排；
- Action / Scope / Prompt 收敛；
- 删除或显著缩小 Phase 1 的旧 Day 写入翻译层；
- 更新 PRODUCT / TECHNICAL。

---

## 当前已知中间态

- Phase 2 施工期间，旧 AI Action / Prompt 仍主要按 Candidate / Day 组织，Phase 3 才正式收敛。
- Candidate 仍可作为内部 Place / AI 研究关联对象，但不能继续成为用户必须维护的独立页面。
- Day 仍作为派生数据供 Route / 旧内部逻辑使用，但不能成为正常业务编辑入口。
- 本地旧测试数据库如果含施工前旧计划 JSON，直接清空重建。

---

## 下一步

1. 完成 Phase 2 右侧最终线路面板和两工作区导航；
2. 完成最终线路地图状态展示与地图 → 右侧选择联动；
3. 静态 Review，确认地图无重复业务编辑入口、Day 无独立编辑入口；
4. 更新本文件为 `awaiting_local_test`；
5. 冻结 Phase 2 Test Branch + 40 位 HEAD；
6. 输出 Phase 2 本地 Codex 测试 Prompt；
7. 等待用户 PASS / FAIL。
