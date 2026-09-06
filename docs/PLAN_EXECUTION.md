# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)
> Phase 4 r2 纠正：[`PLAN_PHASE4_R2_CORRECTION.md`](./PLAN_PHASE4_R2_CORRECTION.md)
> 当前产品：[`PRODUCT.md`](./PRODUCT.md)
> 当前技术：[`TECHNICAL.md`](./TECHNICAL.md)
> 实时进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 当前基线

已经完成并通过用户本地 Codex 验证：

```text
Phase 1：finalRoute / Day / Route 基础
Phase 2：右侧最终线路人工规划
Phase 3：AI 生成、详细安排、显式优化
```

产品只有：

```text
规划 · 旅行需求
行程 · 最终线路
```

唯一用户线路是 `finalRoute`。

Phase 4 r1 的自动测试曾全部通过，但随后产品 Review 纠正了视觉模型：Day 不应该重新成为包住地点的一级大卡片。

因此 Phase 4 当前以 r2 为唯一有效验收基线。

---

# 2. Phase 4 r2 产品合同

线路主体只有三类对象：

```text
地点 = 统一地点卡
交通 = 两个当前有效地点之间的连接条
Day / 住宿 = 地点之间的“第 N 晚”分隔线
```

禁止：

```text
Day 大卡片 / Day Header 包住地点
Day title 冒充地点名
activity（例如“前往 xxx”）冒充地点名
```

交互继续固定为：

```text
Hover 地点 = 只高亮地点卡 + Marker，不移动 / 缩放地图
Click 地点 = 显式 flyTo，不打开编辑
Click 编辑 = 打开独立抽屉，不触发 flyTo
Click 交通条 = 修改当前有效交通方式
Click 住 / 不住 / 多一晚 = 修改 Day 分界
```

排序固定为：

```text
只有拖动把手可以启动拖动
→ 整张地点卡作为 drag image 跟手
→ 目标位置显示 before / after 插入线
→ 松手自动 move_final_route_node
→ Day / 夜晚分隔 / Route / 有效交通自动重新派生
```

Provider 边界不变：距离、时长、geometry 只能来自 Provider。

---

# 3. 实施 Phase

仍然只保留：

```text
Phase 4：P0 最终线路主交互闭环
Phase 5：P1 界面减法与辅助交互收敛
```

Phase 4 r2 未通过自动回归 + 真实浏览器 Gate 前，不进入 Phase 5。

---

# 4. Phase 4 r2 — 已完成施工

状态：`awaiting_local_test`

## 4.1 r1 继续保留的能力

### UI 状态解耦

`AppFinalRouteV3.tsx`：

```text
selectedNodeId      = 地图当前选中
hoveredNodeId       = Hover 联动
editingNodeId       = 当前编辑抽屉节点
mapFocusRequest     = 显式 flyTo 请求
mapPickReturnNodeId = 地图选点返回编辑上下文
```

地图不会因为 selected / hover 变化自动 flyTo。

### 独立编辑抽屉

`FinalRouteEditorDrawerV4.tsx` 继续负责：

```text
行程安排
地点信息
地图定位
重新识别
地图选点
Google Maps 链接
删除当前 route node
```

交通不在抽屉内。

桌面抽屉覆盖地图；窄屏是覆盖式 Sheet，不回退成 inline。

### 有效交通连接

`finalRouteTransportConnectionsV4` 继续按：

```text
active finalRoute
派生 plan.days
routeStates.route.legs
```

构造连接，处理 tentative / no_go 跳过、跨 Day Anchor、dirty、attention、pending 等。

Route dirty 时不把旧 distance / duration 当当前事实。

---

## 4.2 r2 纠正：取消 Day 容器

`FinalRoutePanelV3.tsx` 不再渲染线路中的 Day card / Day header。

现在的顺序是：

```text
地点 A

🚗 A → B

地点 B【住】

──────── 第 1 晚 ────────

🚗 B → C

地点 C
```

派生 Day 仍用于日期、Route、AI scope，但不是地点的父级视觉容器。

---

## 4.3 r2 纠正：地点名称只来自 Place

地点主标题统一使用 Place name presentation。

fallback 只允许：

```text
未命名地点
```

不再允许：

```text
row.node.activity
Day.title
“前往 xxx”
```

成为地点名称。

---

## 4.4 r2 纠正：Day 用“第 N 晚”分隔线表示

当前有效：

```text
node.status === "normal" && node.endsDay
```

才在地点后显示：

```text
──────── 第 N 晚 ────────
```

N 使用派生 Day 编号，因此住宿和排序变化后自动连续重排。

待定 / 不去节点保存的 `endsDay` 暂不切当前 Day。

---

## 4.5 r2 纠正：多一晚

继续使用服务端已有 `add_final_route_night`：同 Place 新增一个独立 route node。

视觉上仍然是普通地点卡：

```text
陶波【住】
──────── 第 3 晚 ────────
陶波【住】
──────── 第 4 晚 ────────
```

不新增 `stayDays`。

同 Place 连续住宿产生的 synthetic same-place hop 不允许伪装成“交通待定”并让用户编辑虚假交通。

---

## 4.6 r2 纠正：拖动整卡排序

新增：

```text
apps/web/src/final-route-drag-v4.ts
apps/web/src/final-route-drag-v4.test.ts
```

拖动把手本身是唯一 drag source；开始拖动后用整个 `.final-route-row-v3` 作为 drag image。

目标卡上半 / 下半区域分别代表：

```text
before
after
```

CSS 显示明确插入线。

`finalRouteMoveTargetIndexV4` 把 UI 插入槽转换为服务端 `moveFinalRouteNodeV3` 的 post-removal `targetIndex`，覆盖：

```text
向上移动
向下移动
移动到第一位
移动到最后一位
实际位置不变时 no-op
```

松手直接调用现有 `onMoveNode`，不新增第二次保存动作。

---

## 4.7 Day 级 AI 操作

线路不再有 Day Header 后，以下动作迁到统一 AI 辅助区：

```text
第 N 天选择器
补充详细地点
完善这一天
优化这一天
```

这里只改变 UI 入口，不改变 AI scope / 权限。

Phase 5 再做折叠菜单等减法。

---

# 5. r2 改动范围

相对 r1 冻结代码：

```text
apps/web/src/FinalRoutePanelV3.tsx
apps/web/src/phase4-final-route-interaction.css
apps/web/src/phase4-final-route-interaction.test.ts
apps/web/src/final-route-drag-v4.ts
apps/web/src/final-route-drag-v4.test.ts
```

没有修改 server finalRoute / Day / Route 核心模型。

施工 Agent 不运行 test / typecheck / build / app / Provider / CI。

---

# 6. r2 冻结测试基线

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r2
Test HEAD: 99e0974f66f7e1ad189adc9c806cec4d9a85f181
```

这是唯一允许验收的 Phase 4 当前代码基线。

r1：

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2
```

已被产品纠正取代。

---

# 7. Phase 4 r2 本地 Codex 测试 Prompt

```text
请独立验收 TravelPlanner Phase 4 r2：最终线路视觉模型纠正 + P0 主交互闭环。

本次测试只允许针对：

Test Branch: test/plan-phase4-final-route-interaction-20260906-r2
Test HEAD: 99e0974f66f7e1ad189adc9c806cec4d9a85f181

第一步必须运行：

git branch --show-current
git rev-parse HEAD
git status --short

如果 Branch / HEAD 不完全一致：
输出 TEST_BASE_MISMATCH 并停止。不要 checkout / switch / pull / merge / rebase / reset / cherry-pick。

如果存在会改变待测生产代码的本地未提交修改：
输出 TEST_WORKTREE_DIRTY 并停止。

阅读：
- docs/PLAN_PHASE4_R2_CORRECTION.md（如果测试分支没有该 main 文档，以本 Prompt 的规则为准）
- docs/PLAN.md 第 31–47 节；其中 Day 大卡片 / Day Header 的旧描述已被 r2 correction 覆盖
- docs/PLAN_EXECUTION.md Phase 4 r2（分支文档如较旧，以本 Prompt 为准）
- docs/PLAN_PROGRESS.md Phase 4 r2（同上）

不要相信施工 Agent 的结论，不要修改生产代码来让测试通过。

第一部分：静态 Review

1. 地点名称必须只来自 Place name presentation；确认 activity / Day.title 不能作为地点主标题 fallback。
2. FinalRoutePanelV3 的线路主体不能再有 Day 大卡片 / Day Header；只允许统一地点卡、有效交通条和第 N 晚分隔线。
3. normal + endsDay 后才显示当前有效的第 N 晚分隔；tentative / no_go 保存的 endsDay 不应切当前 Day。
4. 检查多一晚仍使用现有同 Place route node，不新增 stayDays / 第二套 Day 模型。
5. 检查拖动只从 handle 启动，drag image 使用整张地点卡。
6. 检查 finalRouteMoveTargetIndexV4 与服务端 moveFinalRouteNodeV3 的“先移除后插入”索引语义一致。
7. 检查 effective transport 仍使用 active finalRoute + 派生 Day + RouteLeg，不依赖 DOM 相邻。
8. 检查 Route dirty 不显示旧 Provider distance / duration 为当前事实。
9. 检查 hover / selected / editing / focusRequest / map-pick 状态没有重新耦合。
10. 检查本 r2 没有无关 server finalRoute / Day / Route 核心重构，也没有伪造 Provider facts。

第二部分：自动测试

至少执行：

- apps/web/src/final-route-drag-v4.test.ts
- apps/web/src/phase4-final-route-interaction.test.ts
- apps/web/src/final-route-ui-v3.test.ts
- Phase 2 / Phase 3 final-route 回归测试
- 相关 map / route tests
- 完整 typecheck
- 完整 build
- 成本合理时完整 npm test

不要修改生产代码。

第三部分：真实浏览器人工验收（Phase 4 强制 Gate）

使用至少 3 Day 的测试旅行。

A. 地点名称 / 信息模型
- 检查第一天、中间、住宿点、下一天、同 Place 连续住宿等各种节点。
- 所有地点主标题都必须只是地点名。
- 不能出现 “Day 2 前往 xxx”、Day.title、activity 冒充地点名。
- 线路中不能存在包住地点的 Day 大卡片 / Day Header。

B. 夜晚分隔
- 给某地点点“+ 住”。
- 该地点后应出现 “第 N 晚”分隔线。
- 再“不住”，分隔线应消失，后续编号自动重排。
- 改变前面的住宿分界后，所有第 N 晚编号应连续正确。

C. 多一晚
- 在住宿点点“多一晚”。
- 同 Place 应新增一个相同结构的普通地点卡。
- 应增加下一条“第 N 晚”分隔线。
- 两个同 Place 节点之间不能出现假的“交通待定”并允许用户编辑不存在的真实交通。

D. 拖动排序
- 点击/拖动地点主体不能启动排序。
- 只有拖动把手能启动。
- 抓住把手后，整张地点卡应作为拖动视觉跟随鼠标，不是只有小图标。
- 移到目标地点上半 / 下半区域时，before / after 插入线必须清楚。
- 分别测试向上、向下、移动到首位、末位、跨一个“第 N 晚”分隔。
- 松手后必须自动保存新顺序，不需要再点保存。
- 排序后地点顺序、夜晚分隔、Day、有效交通应一起更新。

E. Hover
- 记录地图 center / zoom。
- Hover 多个地点。
- 地点与 Marker 高亮，但 center / zoom 完全不动。

F. Click 地点
- 点击地点主体。
- 地图 flyTo 对应地点。
- 不打开编辑抽屉。

G. 编辑抽屉
- 点击编辑不触发 flyTo。
- 抽屉从线路左侧覆盖地图，不把后续地点向下撑。
- A 编辑 → B 编辑应直接切换；再点当前编辑、关闭按钮、Esc 都能关闭。

H. 有效交通
构造：A → X【待定或不去】→ B。
- X 保留在列表和地图。
- 当前有效交通必须显示 A → B。
- Route ready 才显示 Provider 距离 / 时间。
- Route dirty 时不能继续显示旧距离 / 时间为当前事实。

I. 地图选点 / 未定位
- 编辑 → 地图选点 → 保存，应恢复原编辑抽屉。
- 再测试取消，也应恢复。
- 未定位地点 Hover / Click 不报错、不伪造坐标，并显示异常状态。

J. 响应式
- 桌面：抽屉覆盖地图、不改变线路布局。
- <=900px：编辑变覆盖式 Sheet，不能回退 inline。

最终输出：

Test Branch: test/plan-phase4-final-route-interaction-20260906-r2
Test HEAD: 99e0974f66f7e1ad189adc9c806cec4d9a85f181
Phase 4 r2: PASS / FAIL

静态 Review:
- ...

实际执行的自动测试:
- ...

浏览器人工验收:
A 地点名称 / 信息模型: PASS / FAIL
B 夜晚分隔: PASS / FAIL
C 多一晚: PASS / FAIL
D 拖动排序: PASS / FAIL
E Hover: PASS / FAIL
F Click: PASS / FAIL
G 编辑抽屉: PASS / FAIL
H 有效交通: PASS / FAIL
I 地图选点 / 未定位: PASS / FAIL
J 响应式: PASS / FAIL

发现的问题:
- ...

未覆盖或无法验证:
- ...

是否建议进入 Phase 5：是 / 否
```

---

# 8. Phase 4 r2 PASS Gate

只有以下全部满足才能标记 completed：

```text
Branch + HEAD 精确匹配
相关自动测试 PASS
typecheck PASS
build PASS
真实浏览器 A–J 全部 PASS
没有发现 Provider facts 伪造
没有发现 finalRoute / Day 双份用户线路
```

如果浏览器环境不可用：

```text
Phase 4 r2 = NOT VERIFIED / FAIL Gate
```

不能因为自动测试 PASS 就进入 Phase 5。

如果发现具体 UI Bug：

```text
修复
→ 冻结新的 r3 Branch + HEAD
→ 旧 r2 PASS/FAIL 不再作为最新基线
```

---

# 9. Phase 5 — P1 界面减法

状态：`pending`

Phase 4 r2 PASS 后再施工。

计划：

```text
AI 操作折叠
Pending Proposal 紧凑化
添加地点插入位置进一步显式化
删除产品内确认 / Undo
响应式细节
```

Phase 5 必须继续遵守：

> **地点是地点；交通是线；Day / 住宿是第 N 晚分隔。**

不得重新引入 Day 大卡片或第二套线路结构。
