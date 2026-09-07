# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)
> Phase 4 r2 纠正：[`PLAN_PHASE4_R2_CORRECTION.md`](./PLAN_PHASE4_R2_CORRECTION.md)
> 实时进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 当前施工状态

Phase 1–3 已完成并经过此前本地自动验证。

Phase 4 r1 因产品视觉模型错误被 r2 取代。

Phase 4 r2 与 Phase 5 的计划内代码已全部施工完成，并完成静态 code review。

用户在 2026-09-06 明确要求：

> **不要浏览器测试。先把所有代码写完，再 review 代码。**

因此浏览器人工测试不作为代码完成 Gate。

2026-09-07 后续 P0 架构 / canonical 收尾也已完成，并额外执行仓库正式 Node 24 CI：typecheck、590 项全量测试、production build 全部通过。

本次仍未执行浏览器人工交互回归、真实 Google Maps / Route Provider E2E、真实 AI Provider E2E。

---

# 2. 最终产品合同

最终线路主视图固定为：

```text
地点卡

当前有效交通

地点卡【住】

──────── 第 N 晚 ────────

当前有效交通

地点卡
```

禁止重新引入：

```text
Day 大卡片 / Day Header 包住地点
activity / Day.title 冒充地点名称
stayDays
第二套用户可维护线路
DOM 相邻地点直接等同于有效交通
前端伪造 Provider 距离 / 时间 / geometry
```

交互：

```text
Hover 地点 = 只高亮地点卡 + Marker
Click 地点 = 显式地图 flyTo
Click 编辑 = 打开独立地点抽屉
Click 交通 = 修改目标节点 transportFromPrevious
Click 住 / 不住 / 多一晚 = 修改 Day 分界
```

---

# 3. Phase 4 r2

代码基线：

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r2
Test HEAD: 99e0974f66f7e1ad189adc9c806cec4d9a85f181
```

完成：

- 统一地点卡；
- 夜晚分隔线代替 Day Header；
- 同 Place 多晚仍是独立 route node；
- same-place synthetic hop 不作为真实交通；
- handle-only drag source + whole-card drag image；
- before / after drop 位置；
- 原 Hover / Click / Edit / Drawer / map-pick / 有效交通能力保留。

Phase 5 直接建立在该 HEAD 上。

---

# 4. Phase 5 — 界面减法与辅助交互收敛

状态：`code_complete_static_review_complete`

冻结基线：

```text
Test Branch: test/plan-phase5-final-route-polish-20260906-r1
Test HEAD: e3ca7f8849a233d831b432849fc6fc2b9f77bf37
Base: 99e0974f66f7e1ad189adc9c806cec4d9a85f181
```

## 4.1 AI 操作折叠

最终线路存在时只长期显示一个紧凑 `AI 操作` 入口。

菜单中保留：

```text
生成详细地点
优化全程
补充详细地点
完善这一天
优化这一天
补充这一段
优化这一段
```

Day 选择只作为 AI scope，不恢复 Day 视觉父层级。

## 4.2 Proposal

Pending Proposal：

```text
✨ 标题 · 待你决定 · 查看
```

展开后才出现说明与采用 / 不采用。

所有 Pending 均保留；只有 settled history 限制最近 8 条。

已处理方案进入折叠“最近 AI 历史”。

## 4.3 添加地点

每次打开默认：

```text
线路末尾
```

用户可显式选择：

```text
线路最前面
在第 N 个地点“xxx”之后
线路末尾
```

同 Place 重复出现时使用线路序号区分 occurrence。

添加位置不再依赖不可见 selected / editing 状态。

## 4.4 删除

地点抽屉使用产品内二次确认，不使用浏览器 `window.confirm`。

只删除当前 route node occurrence。

恢复仍复用现有 Revision / 版本历史。

## 4.5 交通 ViewModel

有效交通继续由：

```text
active finalRoute
派生 Day
RouteState / RouteLeg
```

共同决定。

RouteLeg 匹配现在优先按派生 Day 的：

```text
startAnchor.id
stop.id
endAnchor.id
```

映射为 `fromNodeId / toNodeId` 精确匹配。

只有无法得到 endpoint ID 时才回退 Place ID。

这样重复 Place 的：

```text
A → B → A → B
```

不会把第二段 A → B 错配到第一条 Provider leg。

状态：

```text
ready       = 显示 Provider 距离 / 时间
dirty       = 路线更新中，隐藏旧事实
pending     = 路线待计算
unavailable = 路线暂不可用
attention   = 有部分真实 Provider 事实，但有警告
same_place  = synthetic 同地节点，不显示交通编辑条
```

## 4.6 排序

桌面：

```text
只有拖动把手启动排序
整张地点卡作为 drag image
```

窄屏 <=900px：

```text
增加上移 / 下移 fallback
```

避免触屏原生 drag 支持差异导致无法排序。

---

# 5. Static Code Review 结论

Review 检查：

```text
finalRoute 单一数据源
Day 派生边界
RouteLeg endpoint 映射
same-place 多晚
inactive node 跳过
Provider fact 边界
拖动 post-removal targetIndex
添加插入 index
Proposal generation / stale 状态
当前 occurrence 删除语义
移动端排序入口
```

Review 中发现并已修复：

1. Drawer 的地点名仍可能使用 activity fallback；
2. same-place synthetic hop 曾显示可编辑假交通；
3. Provider 无真实路线事实时状态表达不准确；
4. 重复 A → B 仅按 Place ID 可能错配 RouteLeg；
5. transport editor 在连接消失后可能残留；
6. 添加地点曾可能继承旧 selection；
7. 重复 Place 的添加目标文字不唯一；
8. Proposal 先截断再筛 Pending 可能隐藏未处理方案；
9. 移动端原生 drag 不可靠且无 fallback；
10. 旧 RouteLeg 测试夹具的 node ID 与真实 DayRouteService 不一致。

上述问题均已在冻结 Phase 5 HEAD 前修复，并补充对应测试代码。

---

# 6. 改动边界

Phase 5 相对 Phase 4 r2 只涉及：

```text
apps/web/src/FinalRouteEditorDrawerV4.tsx
apps/web/src/FinalRoutePanelV3.tsx
apps/web/src/final-route-ui-v3.ts
apps/web/src/final-route-ui-v3.test.ts
apps/web/src/final-route-ui-v5-review.test.ts
apps/web/src/final-route-ui-v5-factless.test.ts
apps/web/src/phase4-final-route-interaction.test.ts
apps/web/src/phase5-final-route-polish.css
apps/web/src/phase5-final-route-polish.test.ts
apps/web/src/main.tsx
```

**Phase 5 本身没有修改 server finalRoute / Day / Route 核心代码。**

后续 P0 是独立的技术架构 / canonical 收尾，主要涉及 Runtime 拆分、Provider capability seam、Store canonical write boundary、Skeleton 专用 canonical adapter 与相应测试基线，不改变上面的 Phase 5 产品合同。

---

# 7. P0 架构 / canonical 收尾

状态：`completed_node24_verified`

完成：

```text
Runtime God Object 拆分为 facade + coordinators/helpers
Provider/Store V2/V3 边界收口为窄 capability interfaces
TravelStoreV3 正常写链直接 canonicalizePlanWriteV3
Skeleton replan 脱离 generic reverse bridge 主路径
PlaceResolverV2 直接满足 Planner-facing resolver capability
canonical finalRoute 引用保护 Place，不因 Candidate 删除静默删除线路地点
```

generic Day compatibility bridge 仍存在，但只保留在明确登记的窄兼容场景；不恢复 v2 -> v3 migration、双写或第二份用户线路。

P0 验证收尾已 squash 合入 main：

```text
9c17c5f19cddbf1a1cb7c13dfc5a138744acab3f
```

---

# 8. 当前验证状态

正式 Node 24 GitHub CI 已通过：

```text
Node v24.20.0
npm ci: PASS
typecheck:web: PASS
typecheck:server: PASS
Test Files: 105 / 105 PASS
Tests: 590 / 590 PASS
build:web: PASS
build:server: PASS
```

clean CI run：`34102671270`。

当前未执行：

```text
浏览器人工交互回归
真实 Google Maps / Route Provider E2E
真实 AI Provider E2E
```

这些属于后续运行 / 发布验证；**浏览器测试仍不作为当前代码完成 Gate。**

CI 另有两个非阻塞维护项：

- npm audit 当前报告 6 个依赖漏洞（4 moderate、1 high、1 critical），未在 P0 中执行强制升级；
- Vite 提示主 JS chunk >500kB，以及 `maplibre-gl` 同时存在静态 / 动态 import，可另做性能治理。