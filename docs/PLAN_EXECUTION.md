# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)  
> 当前产品：[`PRODUCT.md`](./PRODUCT.md)  
> 当前技术：[`TECHNICAL.md`](./TECHNICAL.md)  
> 实时进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 当前基线

前一轮 finalRoute 重构已经完成并经过用户本地 Codex 验证：

```text
Phase 1：finalRoute / Day / Route 基础
Phase 2：右侧最终线路人工规划
Phase 3：AI 生成、详细安排、显式优化
```

当前产品已经收敛为：

```text
规划 · 旅行需求
行程 · 最终线路
```

唯一用户线路是 `finalRoute`。

本次不重新设计 finalRoute 数据模型，也不重新拆 Day / Route 后端语义。

本次目标是：

> **把已经正确的数据逻辑，重新做成一个真正可读、可操作的“旅行线路编辑器”，而不是配置表单。**

---

# 2. 当前代码中与本次改造直接相关的问题

当前 `FinalRoutePanelV3` 存在以下交互耦合：

1. 地点 Click 通过 `selectedNodeId` 同时触发选中、地图 flyTo 和 inline 编辑。
2. 选中地点后，详细安排和地点信息直接在地点下方展开，导致线路列表不断被撑长。
3. 交通方式被放在地点展开表单中，用户无法直接读出“两个地点之间怎么走”。
4. `RouteLeg` 已经有真实距离和时长，但最终线路主视图没有展示。
5. Day 当前更像 divider，不像真正的日程块。
6. 住 / 不住 / 多一晚属于主操作，却被藏在展开编辑区。
7. 正常 / 已定位等常态标签长期占据地点块空间。
8. 地点整块 draggable，同时又有上移 / 下移按钮，操作入口重复。
9. AI Day 操作和 Proposal 卡片长期挤占线路空间。

---

# 3. 已确认的关键产品决定

本次实施必须严格遵守：

```text
Hover 地点 = 只高亮地点块 + 地图 Marker，不移动地图、不缩放
Click 地点 = 地图 flyTo 当前地点，不打开编辑
Click 编辑 = 打开当前地点编辑抽屉，不触发地图 flyTo
Click 交通条 = 修改这一段交通方式
Click 住 / 不住 / 多一晚 = 修改 Day 分界
```

前端 UI 状态必须从单一 `selectedNodeId` 语义中拆开，至少形成：

```text
hoveredNodeId
mapSelectedNodeId / mapFocusedNodeId
editingNodeId
```

编辑抽屉从最终线路列表左侧向地图方向弹出，覆盖地图一部分，不把地点列表向下撑开。

交通条放在当前有效线路的两个地点之间，显示：

```text
交通方式 · Provider 距离 · Provider 时间
```

距离、时长、geometry 仍只能来自 Provider。

---

# 4. 实施策略

本次分成两个 Phase，尽量减少测试次数，同时隔离主交互风险与次级 UI 清理。

```text
Phase 4：P0 最终线路主交互闭环
Phase 5：P1 界面减法与辅助交互收敛
```

不再细拆“地图 / 抽屉 / 交通 / Day”多个测试 Phase，因为它们共同组成同一个完整用户闭环；拆开会产生无法正常使用的半成品。

---

# 5. Phase 4 — P0 最终线路主交互闭环

状态：pending

## 5.1 目标

一次性完成：

```text
地点 Hover 只高亮
地点 Click 才 flyTo
独立编辑按钮
左侧编辑抽屉
移除 inline 大表单
地点间真实交通条
Day 日程块视觉
住 / 不住 / 多一晚主界面操作
异常状态精简显示
hover / map selection / editing 状态解耦
```

Phase 4 完成后，用户应该能够不打开任何编辑表单直接阅读完整旅行线路。

## 5.2 主要修改范围

优先涉及：

```text
apps/web/src/AppFinalRouteV3.tsx
apps/web/src/FinalRoutePanelV3.tsx
apps/web/src/FinalRouteMapV3.tsx
apps/web/src/final-route-ui-v3.ts
apps/web/src/final-route-map-v3.ts
apps/web/src/phase2-final-route.css
相关前端测试文件
```

如果实现 ViewModel 需要新增小型纯函数文件，可以新增，但不要扩大到后端 finalRoute 核心模型。

## 5.3 UI 状态解耦

将当前“一个 selectedNodeId 控制全部”的模式拆开：

- `hoveredNodeId`：仅视觉联动；
- `mapSelectedNodeId`：地图选中 / flyTo 目标；
- `editingNodeId`：编辑抽屉当前节点；
- map-pick 状态继续独立存在。

必须保证：

```text
Hover 不触发 flyTo
Hover 不触发编辑
地点 Click 不触发编辑
编辑按钮不触发地点 Click
住宿 / 状态 / 交通等按钮不触发地点 Click
```

地图 Marker Click 可以选中 / 聚焦，但不能自动打开业务编辑抽屉。

## 5.4 地图 Hover 高亮

为 `FinalRouteMapV3` 增加 Hover 高亮输入。

规则：

- 地点块 hover 时，对应 Marker 增加轻量 halo / 高亮；
- 地图中心和 zoom 必须保持不变；
- hover 结束恢复；
- map selected 高亮与 hover 高亮可以同时存在，但 selected 应具有更高视觉优先级。

## 5.5 地点 Click 地图定位

地点块主体 Click：

```text
设置 mapSelectedNodeId
触发 focusRequest / flyTo
```

不得：

```text
打开 editingNodeId
展开 inline editor
修改数据
```

如果地点未定位，Click 不应报错或伪造位置；可以保持选中并通过异常状态提醒用户未定位。

## 5.6 独立“编辑”按钮与编辑抽屉

地点块新增明确“编辑”按钮。

点击后：

- `editingNodeId = 当前节点`；
- 再点当前节点编辑按钮则关闭；
- 点另一个地点的编辑则直接切换内容；
- Esc / 关闭按钮 / 切换旅行 / 切换工作区 / 删除当前节点后关闭。

抽屉内容迁移现有 inline editor：

```text
行程安排
地点信息
定位状态 / 地址
重新识别
地图选点
Google Maps 链接
删除当前 route node
```

必须删除地点列表中的 inline `final-route-editor-v3` 大块展开方式。

交通方式不进入抽屉。

窄屏下可以是 overlay Sheet，但不能退回 inline 展开。

## 5.7 地图选点与编辑抽屉协调

点击“地图选点”时：

- 保存当前 `editingNodeId` 上下文；
- 抽屉临时收起或变成紧凑态；
- 地图显示明显选点提示；
- 保存成功后恢复该地点编辑抽屉；
- 取消后也恢复原上下文。

## 5.8 有效交通连接 ViewModel

新增可测试的纯函数 / ViewModel，用于从：

```text
finalRoute nodes
派生 plan.days
routeStates.route.legs
```

生成主视图交通连接。

不能简单使用视觉上的 `rows[rowIndex - 1]`。

必须正确处理：

```text
tentative / no_go 被跳过
Day endAnchor / startAnchor
普通 stop
重复 Place
多一晚产生的同 Place route node
route dirty
route attention
Provider 尚未返回
```

特别注意：派生 Day 中 Day 结束节点可能对应 `endAnchor.id`，RouteLeg 的 from/to node id 不一定总是原 finalRoute node id；映射逻辑必须基于现有 `deriveFinalRouteDaysV3` 和 Route 生成逻辑，而不是猜测。

## 5.9 非卡片式交通条

在当前有效地点之间显示：

```text
🚗 自驾 · 72 km · 58 分
```

状态：

- ready：显示 Provider 距离 / 时间；
- dirty：显示交通方式 + “路线更新中”，不能把旧数值当当前事实；
- attention：显示可用事实 + 注意状态，具体按现有 Route 状态；
- 无 route：显示“路线待计算”；
- Provider 失败：显示“路线暂不可用”。

交通条本身不能使用和地点卡片同等级的厚边框卡片样式。

点击交通条打开轻量交通方式选择器；保存仍调用现有 `set_final_route_transport`。

## 5.10 Day 日程块

按派生 Day 对地点重新组织视觉分组。

每个 Day 顶部至少显示：

```text
Day N
日期
Day title / 起终点摘要
DayRoute ready 时：总距离 / 总交通时间
Dirty / attention 时：路线状态
```

Day 只是展示分组，数据仍来自现有 `plan.days` 和 `routeStates`，不能创建第二份可独立编辑 Day 数据。

多一晚产生的空 Day 必须显示“这一天还没有详细安排”。

## 5.11 住宿主操作

将：

```text
住
不住
多一晚
```

从地点编辑抽屉移到地点块主操作区。

普通地点：

```text
+ 住
```

已有住宿分界：

```text
住 ▾ → 多一晚 / 不住
```

底层继续调用现有 `set_final_route_boundary` 和 `add_final_route_night`。

## 5.12 状态标签减法

默认隐藏：

```text
正常
已定位
```

只显示异常：

```text
待定
不去
未定位
定位中
```

地点状态修改入口仍保留，但不要让“正常”成为长期 badge。

## 5.13 排序基础调整

Phase 4 至少要做到：

- 只有拖动手柄作为 draggable 起点；
- 地点块主体不再整体 draggable；
- 拖动不能和地点 Click 地图定位冲突。

是否彻底移除桌面 ↑ / ↓ 可以留到 Phase 5。

## 5.14 代码施工完成条件

静态 Review 必须确认：

- 不再存在地点 Click 直接展开 inline editor；
- hover 和 flyTo 代码路径分离；
- 编辑按钮使用 stopPropagation；
- 住宿 / 状态 / 交通按钮不冒泡触发 flyTo；
- inline editor 已从地点流中移除；
- 交通条使用有效线路 ViewModel；
- Route dirty 时不把旧距离 / 时间当当前事实；
- Day 分组完全来自现有派生 Day；
- Provider 事实边界没有被放松；
- 没有修改 finalRoute 服务端核心数据语义。

## 5.15 本地测试要求

Phase 4 必须由用户本地 Codex 验证：

```text
相关 unit / component tests
typecheck
build
浏览器 UI 人工验证
至少一趟包含 3+ Day 的真实测试旅行
至少一个 tentative/no_go 中间节点
至少一个多一晚场景
至少一个 route dirty 场景
至少一个未定位地点
```

浏览器人工验证是本 Phase 强制 Gate，因为前一轮缺失的主要问题正是 UI E2E 未覆盖。

## 5.16 Codex 本地测试 Prompt

代码完成并冻结后再填写：

```text
Test Branch: <PHASE4_BRANCH>
Test HEAD: <PHASE4_FULL_SHA>
```

测试 Prompt：

```text
请独立验收 TravelPlanner Phase 4：最终线路 P0 主交互闭环。

本次测试只允许针对以下 Git 基线：

Test Branch: <PHASE4_BRANCH>
Test HEAD: <PHASE4_FULL_SHA>

在任何测试前先运行：

git branch --show-current
git rev-parse HEAD
git status --short

如果当前 Branch 或 HEAD 与上面不完全一致：
立即停止，不要 checkout / switch / pull / merge / rebase / reset / cherry-pick，输出 TEST_BASE_MISMATCH。

如果存在会改变待测生产代码的本地未提交修改：
立即停止，输出 TEST_WORKTREE_DIRTY。

先阅读：
- docs/PLAN.md 第 31–47 节
- docs/PLAN_EXECUTION.md Phase 4
- docs/PLAN_PROGRESS.md Phase 4

不要相信施工 Agent 的结论，不要为了让测试通过而修改生产代码。

重点验证：
1. Hover 地点只高亮地点块和 Marker，地图中心 / zoom 完全不变。
2. Click 地点才 flyTo，且不打开编辑抽屉。
3. Click 编辑不触发 flyTo，打开左侧/覆盖式独立编辑抽屉。
4. 编辑抽屉不把地点列表向下撑开，可切换地点、关闭、Esc。
5. 地图选点完成 / 取消后能恢复编辑上下文。
6. 地点之间直接显示交通方式、Provider 距离、Provider 时间。
7. tentative/no_go 中间节点不会污染当前有效交通连接。
8. route dirty 时不会把旧距离 / 时间当当前事实。
9. 点击交通条能修改到达当前有效节点的 transportFromPrevious，并触发既有 Route 更新逻辑。
10. Day 是明确日程块，显示日期与 Route 摘要。
11. 住 / 不住 / 多一晚在地点主界面可操作，多一晚产生清楚的空 Day。
12. 正常 / 已定位不再长期占 badge；异常状态仍清楚。
13. 拖动只从手柄开始，不与地点 Click 冲突。
14. Provider 事实边界、finalRoute 数据语义、AI 权限无回归。

请运行你认为必要的 unit / integration / typecheck / build，并启动浏览器做 UI 人工验收。

最终输出必须包含：
Test Branch: ...
Test HEAD: ...
Phase 4: PASS / FAIL

实际执行的测试：
- ...

UI 人工验证场景：
- ...

发现的问题：
- ...

未覆盖或无法验证：
- ...

是否建议进入 Phase 5：是 / 否
```

---

# 6. Phase 5 — P1 界面减法与辅助交互收敛

状态：pending

前置条件：Phase 4 必须由用户本地 Codex 对冻结 Branch + HEAD 返回 PASS。

## 6.1 目标

在 Phase 4 主闭环稳定以后进一步减少界面噪音：

```text
AI Day 操作折叠
全程 AI 操作收敛
Pending Proposal 紧凑化
添加地点插入位置显式化
桌面排序入口简化
删除确认 / Undo 体验统一
响应式细节完善
```

## 6.2 AI 操作收敛

每个 Day 不再长期显示多个 AI 按钮。

收敛为：

```text
Day N                              AI ▾
```

菜单：

```text
补充详细地点
完善这一天
优化这一天
```

全程 AI 也收敛为单一入口，保留现有 Action / Scope 权限，不改后端语义。

## 6.3 Proposal 紧凑化

Pending Proposal 只显示紧凑提醒：

```text
✨ AI 有一个“Day 4 顺序优化”方案    查看
```

点击后再查看详情和 Apply / Reject。

已采用 / 已拒绝 / 已撤销的历史 Proposal 不长期占据最终线路主流，可折叠或进入历史区域。

## 6.4 添加地点插入位置显式化

添加地点按钮必须明确说明位置：

```text
+ 在“陶波”后添加
```

或：

```text
+ 添加到线路末尾
```

不能依赖用户看不到的 map selected / editing 临时状态决定插入位置。

如果继续支持“在某地点后添加”，必须使用单独显式 insertion anchor 状态或由用户从具体位置发起。

## 6.5 桌面排序入口简化

桌面以拖动手柄为主，长期显示 ↑ / ↓ 可以移除或放进更多菜单。

移动端保留易用的上移 / 下移作为备选。

## 6.6 删除反馈

优先将浏览器 `window.confirm` 替换为产品内确认 / 撤销体验。

如果现有 Revision / Undo 可以安全支持：

```text
地点已移除    撤销
```

否则先做产品内二次确认，不为了 Undo 新增复杂后端。

## 6.7 响应式

检查：

- 中等宽度地图 + 抽屉 + 线路布局；
- 移动端编辑 Sheet；
- Day header；
- 交通条；
- 长地点名；
- 中英双语地点名；
- 操作菜单不会溢出。

## 6.8 代码施工完成条件

静态 Review 确认：

- AI 权限没有变化；
- 添加位置始终显式；
- 桌面主界面无重复排序入口；
- Proposal 历史不会长期压缩线路空间；
- 删除只作用于当前 route node；
- Phase 4 的 Hover / Click / Edit / 交通 / Day 行为没有回归。

## 6.9 本地测试要求

Phase 5 必须由用户本地 Codex执行：

```text
相关 unit / component tests
typecheck
build
浏览器 UI 回归
桌面 + 至少一个窄屏尺寸
```

## 6.10 Codex 本地测试 Prompt

代码完成并冻结后再填写：

```text
Test Branch: <PHASE5_BRANCH>
Test HEAD: <PHASE5_FULL_SHA>
```

测试 Prompt：

```text
请独立验收 TravelPlanner Phase 5：P1 界面减法与辅助交互收敛。

本次测试只允许针对以下 Git 基线：

Test Branch: <PHASE5_BRANCH>
Test HEAD: <PHASE5_FULL_SHA>

在任何测试前先运行：

git branch --show-current
git rev-parse HEAD
git status --short

如果当前 Branch 或 HEAD 不匹配，输出 TEST_BASE_MISMATCH 并停止。
如果存在影响待测生产代码的未提交修改，输出 TEST_WORKTREE_DIRTY 并停止。

阅读 docs/PLAN.md 第 31–47 节、docs/PLAN_EXECUTION.md Phase 5、docs/PLAN_PROGRESS.md。

重点验证：
1. Day AI 操作已收敛，但原 AI Scope / 权限不变。
2. Pending Proposal 紧凑，历史 Proposal 不长期挤占线路。
3. 添加地点位置始终对用户显式可见。
4. 桌面排序入口不重复，移动端仍可用。
5. 删除体验已产品内统一，且只删除当前 route node。
6. 桌面 / 窄屏布局中编辑抽屉、交通条、Day header 不溢出。
7. Phase 4 全部核心交互无回归。

运行必要 unit / integration / typecheck / build，并做浏览器 UI 回归。

最终输出：
Test Branch: ...
Test HEAD: ...
Phase 5: PASS / FAIL

实际执行的测试：
- ...

发现的问题：
- ...

未覆盖或无法验证：
- ...

是否建议结束本轮 PLAN：是 / 否
```

---

# 7. 测试纪律

继续严格遵守 `PLAN_IMPLEMENTATION_PROMPT.md`：

- 施工 Agent 不运行 test / typecheck / build / app / CI；
- 施工 Agent只做代码修改、静态 Review、测试代码准备；
- 每个 Phase 代码完成后固定实际 Git Branch + 40 位 HEAD；
- `PLAN_PROGRESS.md` 和本文件同时记录该基线；
- 用户本地 Codex 返回完全一致 Branch + HEAD 的 PASS 后才进入下一 Phase；
- 任何新提交都会使旧 PASS 失效。

---

# 8. 完工条件

Phase 4 和 Phase 5 都由用户本地验证 PASS 后：

1. 最终静态 Review `PLAN.md` 第 31–47 节；
2. 检查 `PRODUCT.md` 是否需要同步新的最终线路交互；
3. 检查 `TECHNICAL.md` 是否需要记录新的 UI 状态与 ViewModel；
4. 更新 `PLAN_PROGRESS.md` 为 completed；
5. 记录浏览器 UI 覆盖范围和仍未覆盖的真实外部 Route Provider 场景。
