# TravelPlanner PLAN Progress

## Overall Status

当前阶段：Phase 3 — AI 直接写最终线路 + 显式优化 + 旧流程收敛  
总体状态：in_progress  
最后更新时间：2026-09-05

---

## 已确认的产品决定

- 用户只维护一份最终线路。
- 同一 Place 可以在线路中出现多次，每次拥有独立线路节点 ID。
- 节点状态只有 normal / tentative / no_go。
- tentative / no_go 保留顺序、地图点和原住宿分界，但暂时退出当前 Day 和交通路线；恢复 normal 后原位置重新生效。
- 交通方式属于“到达当前节点”。
- 不住只取消日程分界。
- 多一晚新增同 Place 线路节点，不移动其他地点。
- Day 根据最终线路自动生成，最后一天允许没有住宿分界。
- 地图展示全部已定位线路节点，路线只连接当前 normal 派生 Day。
- 地图只负责展示 / 选择 / 定位辅助，业务修改统一在右侧。
- finalRoute 只保存用户选择的交通方式；真实距离、时长、geometry 和 Provider 验证事实不能由 UI / AI / API 调用方伪造。
- 普通 AI 生成只能插入新地点，不能改变已有地点相对顺序、状态或住宿分界。
- 只有用户明确调用“优化这一天 / 这一段 / 全程”时，AI 才获得对应范围内重排已有节点的权限。

---

## 测试规则

- 施工 Agent 不运行任何测试、typecheck、build、应用启动、迁移或 CI。
- 每个 Phase 由用户本地 Codex 独立测试。
- 测试绑定唯一 Test Branch + 40 位 Test HEAD。
- 任意待测代码变化都会使旧测试结果失效。
- 用户未返回匹配 Branch + HEAD 的 PASS 前，不进入下一 Phase。

---

# Phase 1：最终线路底层与自动 Day / Route 基础

状态：completed

最终验收：

```text
Test Branch: test/plan-phase1-final-route-20260905-r3
Test HEAD: eeca847d16d6022416451c5223afa376e9d7c9c2
Phase 1: PASS
Test Files: 83 passed / 0 failed / 83 total
Tests: 479 passed / 0 failed / 479 total
```

---

# Phase 2：右侧最终线路人工规划闭环 + 地图联动

状态：completed

R1：

```text
Test Branch: test/plan-phase2-final-route-ui-20260905
Test HEAD: 762c8926fedb1b2fd73f113ab2989f2a207bb990
Phase 2: FAIL
```

R1 独立审计发现两个 High：

1. inactive 节点退出当前 Day 后，dirty 旧 Provider geometry 仍可能经过该节点。
2. finalRoute 交通命令可以保存调用方伪造的 duration / note / verified 事实。

R2 已修复：

- 地图 dirty leg 必须同时匹配当前 Day 的 fromNodeId / fromPlaceId / toNodeId / toPlaceId；
- finalRoute mutation 对交通输入统一正规化，仅保存 mode；
- `mode=none` 保存为 null；
- `set_final_route_transport` 与 `add_final_route_node.transportFromPrevious` 均受同一事实边界保护。

最终验收：

```text
Test Branch: test/plan-phase2-final-route-ui-20260905-r2
Test HEAD: aa55a6d616902d1c436b8f796c8e1be3c0a7f354
Phase 2: PASS
Test Files: 86 passed / 0 failed / 86 total
Tests: 489 passed / 0 failed / 489 total
```

浏览器 / UI E2E 因测试环境没有可用浏览器未覆盖，不作为 Phase 2 Gate 失败；typecheck、专项、完整回归、build 和独立负向审计均 PASS。

---

# Phase 3：AI 直接写最终线路 + 显式优化 + 旧流程收敛

状态：in_progress

## 施工目标

1. “生成主要地点”直接把 AI 新 Place / route node 写入 finalRoute。
2. “生成详细地点”直接把新增地点插入 finalRoute，不再经过 Candidate → DayStop 的二次安排。
3. 普通生成只允许插入新节点：
   - 不重排已有 route node；
   - 不删除已有节点；
   - 不改变 normal / tentative / no_go；
   - 不改变已有 endsDay；
   - 不把已有节点移动到其他 Day。
4. 支持局部详细地点生成：全程 / 某个 Day / 指定连续线路段。
5. 只有显式优化才允许重排已有节点：
   - 优化这一天；
   - 优化这一段；
   - 优化全程。
6. AI 优化必须使用 Proposal / generation / CAS 边界，用户最终决定是否采用。
7. 右侧最终线路继续是唯一业务入口；地图不新增业务按钮。
8. 旧 destination / interest / itinerary 产品职责和 Prompt 收敛到最终线路语义。
9. 缩小或删除 Phase 1 为旧 Skeleton / Day 中间态保留的过渡路径。
10. 完成后更新 `PRODUCT.md` / `TECHNICAL.md`。

## 当前施工状态

- 已完成 Phase 2 → Phase 3 状态切换。
- 正在检查现有 AI Action / Prompt / output contract，优先复用 generation、Proposal、Provider、Revision 基础设施，不恢复旧五步产品关系。

---

## 下一步

继续 Phase 3 施工；达到完整可测状态后：

1. 只做静态 Review；
2. 状态改为 `awaiting_local_test`；
3. 冻结新的 Phase 3 Test Branch + HEAD；
4. 输出完整本地 Codex 测试 Prompt；
5. 用户返回匹配基线的 PASS / FAIL 后再决定是否完成本轮 PLAN。
