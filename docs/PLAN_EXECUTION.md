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

本次新增目标来自 `PLAN.md` 第 31–47 节：

> **把已经正确的数据逻辑，重新做成一个真正可读、可操作的旅行线路编辑器，而不是配置表单。**

---

# 2. 已确认的交互合同

必须严格遵守：

```text
Hover 地点 = 只高亮地点块 + 地图 Marker，不移动地图、不缩放
Click 地点 = 地图 flyTo 当前地点，不打开编辑
Click 编辑 = 打开当前地点编辑抽屉，不触发地图 flyTo
Click 交通条 = 修改这一段交通方式
Click 住 / 不住 / 多一晚 = 修改 Day 分界
```

前端状态必须区分：

```text
地图当前选中节点
hoveredNodeId
editingNodeId
显式 map focus request
map-pick 上下文
```

交通条表达的是当前**有效线路**，不能机械连接视觉上相邻的 DOM 地点。

距离、时长、geometry 继续只能来自 Route Provider。

---

# 3. 实施 Phase

本次只拆两个 Phase：

```text
Phase 4：P0 最终线路主交互闭环
Phase 5：P1 界面减法与辅助交互收敛
```

Phase 4 未经用户本地测试 PASS 前，不进入 Phase 5。

---

# 4. Phase 4 — P0 最终线路主交互闭环

状态：`awaiting_local_test`

## 4.1 已完成修改

### UI 状态解耦

`AppFinalRouteV3.tsx` 已拆分：

```text
selectedNodeId      = 地图当前选中
hoveredNodeId       = Hover 联动
editingNodeId       = 当前编辑抽屉节点
mapFocusRequest     = 只有地点 Click 才创建的 flyTo 请求
mapPickReturnNodeId = 地图选点完成 / 取消后恢复编辑上下文
```

原来地图因为 `selectedNodeId` 变化自动 flyTo 的 effect 已移除。

### 独立编辑抽屉

新增：

```text
apps/web/src/FinalRouteEditorDrawerV4.tsx
```

编辑抽屉从最终线路列表左侧向地图方向覆盖，不进入地点列表文档流。

包含：

```text
行程安排
地点信息
地图定位
重新识别
地图选点
Google Maps 链接
删除当前 route node
```

交通方式不放进地点编辑抽屉。

### 有效交通连接 ViewModel

`apps/web/src/final-route-ui-v3.ts` 新增：

```text
finalRouteTransportConnectionsV4
finalRouteDayViewsV4
```

输入只使用：

```text
finalRoute
派生 plan.days
routeStates.route.legs
```

处理：

```text
tentative / no_go 跳过
跨 Day 住宿边界
Day Anchor node id 与 finalRoute node id 不同
route dirty
route attention
Provider pending
同 Place 连续住宿
```

Route dirty 时 ViewModel 不返回旧 distance / duration。

### 非卡片式交通条

`FinalRoutePanelV3` 在两个当前有效地点之间显示轻量连接：

```text
交通方式 · Provider 距离 · Provider 时间
```

点击交通条修改的仍然是目标节点的 `transportFromPrevious`。

### Day 日程块

Day 顶部现在显示：

```text
Day N
日期
标题
总距离 / 总交通时间（Route ready）
路线更新中 / 需注意 / 待计算
```

同地点连续住宿形成的空 Day 显示：

```text
这一天还没有详细安排
```

### 住宿 / 状态 / 排序

- 普通地点直接显示 `+ 住`。
- 住宿边界显示 `住 ▾ → 多一晚 / 不住`。
- 正常 / 已定位不长期显示 badge。
- 待定 / 不去 / 未定位 / 定位中继续显示。
- 只有拖动手柄是 draggable 起点。

### 地图选点

点击编辑抽屉“地图选点”：

```text
保存 editingNodeId 上下文
→ 抽屉暂时关闭
→ 地图进入选点模式
→ 保存 / 取消
→ 恢复原地点编辑抽屉
```

### 样式

新增：

```text
apps/web/src/phase4-final-route-interaction.css
```

桌面抽屉覆盖地图；窄屏使用覆盖式 Sheet，不回退为 inline 展开。

## 4.2 主要修改文件

```text
apps/web/src/AppFinalRouteV3.tsx
apps/web/src/FinalRouteMapV3.tsx
apps/web/src/FinalRoutePanelV3.tsx
apps/web/src/FinalRouteEditorDrawerV4.tsx
apps/web/src/final-route-ui-v3.ts
apps/web/src/phase4-final-route-interaction.css
apps/web/src/main.tsx
apps/web/src/final-route-ui-v3.test.ts
apps/web/src/phase4-final-route-interaction.test.ts
apps/web/src/phase3-final-route-ai-cutover.test.ts
```

未修改 server finalRoute / Day / Route 核心模型。

## 4.3 静态 Review 完成条件

已静态确认：

- 地点 Hover 不创建 flyTo 请求；
- 地图 flyTo 只由显式 `focusRequest` 触发；
- 编辑不再使用 inline `final-route-editor-v3`；
- 编辑抽屉与地点主列表分离；
- 交通条按 active nodes 构造；
- tentative / no_go 中间节点不会成为有效交通端点；
- Route dirty 不暴露旧距离 / 时间；
- 跨 Day Anchor 映射已有对应测试用例；
- 地图选点保存 / 取消均保留编辑返回上下文；
- Provider 事实边界没有放松；
- 没有修改后端核心数据语义。

施工 Agent 没有运行 test / typecheck / build / app / Provider / CI。

## 4.4 冻结测试基线

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2
```

说明：上述 Branch + HEAD 是实际待测代码。本文档记录更新在 `main`，不会改变测试分支 HEAD。

## 4.5 Phase 4 本地测试要求

必须至少覆盖：

```text
相关 unit / contract tests
typecheck
build
浏览器 UI 人工验证
3+ Day 测试旅行
tentative / no_go 中间节点
多一晚 / 空 Day
Route dirty
未定位地点
地图选点保存 + 取消
桌面 + 窄屏
```

浏览器人工验证是 Phase 4 强制 Gate。

## 4.6 Codex 本地测试 Prompt

```text
请独立验收 TravelPlanner Phase 4：最终线路 P0 主交互闭环。

本次测试只允许针对以下 Git 基线：

Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2

在任何测试前先运行：

git branch --show-current
git rev-parse HEAD
git status --short

如果当前 Branch 或 HEAD 与上面不完全一致：
立即停止，不要 checkout / switch / pull / merge / rebase / reset / cherry-pick，输出 TEST_BASE_MISMATCH。

如果存在会改变待测生产代码的本地未提交修改：
立即停止，输出 TEST_WORKTREE_DIRTY。

然后阅读：
- docs/PLAN.md 第 31–47 节
- docs/PLAN_EXECUTION.md Phase 4（如果测试分支中的文档尚未含冻结 SHA，以本 Prompt 的 Branch + HEAD 为唯一测试基线）
- docs/PLAN_PROGRESS.md Phase 4（同上）

不要相信施工 Agent 的结论，不要为了让测试通过而修改生产代码。

第一部分：静态 Review
1. 检查 AppFinalRouteV3 的 selected / hovered / editing / focusRequest / map-pick 状态是否真正解耦。
2. 检查 FinalRouteMapV3 是否只有显式 focusRequest 才调用 flyTo；hover / selected 变化不能移动地图。
3. 检查 FinalRoutePanelV3 是否彻底移除 inline final-route-editor-v3。
4. 检查 FinalRouteEditorDrawerV4 是否只编辑地点自身；交通不在抽屉中。
5. 检查交通 ViewModel 是否基于 active finalRoute + 派生 Day + RouteLeg，而不是 DOM 相邻 row。
6. 检查 route dirty 是否不会显示旧 distance / duration。
7. 检查任何用户输入都不能伪造 Provider distance / duration / geometry。
8. 检查本 Phase 没有无关后端核心重构。

第二部分：执行测试
请在本地执行项目现有必要的测试，包括至少：
- Phase 4 新增 / 修改测试；
- final-route UI helper 测试；
- Phase 2 / Phase 3 final-route 回归测试；
- 相关 map / route 测试；
- 完整 typecheck；
- 完整 build；
- 如果成本合理，运行完整 npm test。

第三部分：浏览器人工验收（本 Phase 强制）
使用一趟至少 3 Day 的测试旅行，逐项验证：

A. Hover
- 记录地图当前中心和 zoom。
- 鼠标移入多个地点块。
- 地点块与对应 Marker 应高亮。
- 地图中心和 zoom 必须完全不变。

B. Click 地点
- 点击地点主体。
- 地图应 flyTo 当前地点并保持 Marker 选中。
- 不应打开编辑抽屉。

C. 编辑按钮
- 点击某地点“编辑”。
- 地图不能因为编辑动作 flyTo。
- 编辑抽屉应从最终线路左侧覆盖地图区域。
- 最终线路后续地点不能被向下撑开。
- 再点当前地点“编辑”应关闭。
- 编辑 A 后点 B 的编辑，应直接切换到 B。
- Esc / 关闭按钮应关闭。

D. 交通条
- A/B 均 normal 且 Route ready 时，应直接显示交通方式、Provider 距离、Provider 时间。
- 点击交通条修改方式，确认保存到 B 的 transportFromPrevious，并触发 Route 更新。
- Route dirty 期间不能继续把旧距离 / 时间显示成当前事实。

E. tentative / no_go
构造：
A
X（待定或不去）
B
确认：
- X 仍在列表和地图。
- X 不参与当前交通。
- 主线路显示有效 A → B 交通，而不是 A → X → B。

F. Day / 住宿
- 普通地点可以直接点“+ 住”。
- 已住宿地点可以“多一晚 / 不住”。
- Day 编号 / 分组自动变化。
- Day ready 时显示总距离 / 时间。
- 多一晚形成空 Day 时显示“这一天还没有详细安排”。

G. 地图选点
- 打开地点编辑 → 地图选点。
- 抽屉应暂时退出，地图可操作。
- 成功保存后恢复同一个地点编辑抽屉。
- 再验证一次取消选点，也应恢复原编辑上下文。

H. 未定位地点
- Hover / Click 未定位地点不能报错或伪造坐标。
- UI 应显示未定位异常状态。

I. 排序
- 只有拖动手柄能够开始拖动。
- 点击地点主体不应误拖。
- 拖动后 Day / Route / 交通条仍跟随最终线路更新。

J. 响应式
- 桌面验证抽屉覆盖地图但不挤压线路。
- <=900px 验证编辑使用覆盖式 Sheet，不能退回地点下方 inline 展开。

最终输出必须包含：

Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2
Phase 4: PASS / FAIL

实际执行的测试：
- ...

浏览器人工验收：
- A Hover: PASS / FAIL
- B Click: PASS / FAIL
- C 编辑抽屉: PASS / FAIL
- D 交通条: PASS / FAIL
- E tentative/no_go: PASS / FAIL
- F Day/住宿: PASS / FAIL
- G 地图选点: PASS / FAIL
- H 未定位: PASS / FAIL
- I 排序: PASS / FAIL
- J 响应式: PASS / FAIL

发现的问题：
- ...

未覆盖或无法验证：
- ...

是否建议进入 Phase 5：是 / 否
```

---

# 5. Phase 5 — P1 界面减法与辅助交互收敛

状态：`pending`

前置条件：Phase 4 对冻结 Branch + HEAD 本地验证 PASS。

计划内容：

```text
Day AI 操作折叠
全程 AI 操作收敛
Pending Proposal 紧凑化
添加地点插入位置显式化
桌面排序入口进一步简化
删除产品内确认 / Undo
响应式细节
```

Phase 5 不得扩大为 finalRoute / Day / Route 数据模型重构。

---

# 6. 测试纪律

继续遵守 `PLAN_IMPLEMENTATION_PROMPT.md`：

- 施工 Agent 不运行任何测试 / typecheck / build / app / CI；
- 每个 Phase 只对明确 Test Branch + Test HEAD 接受测试结果；
- 如果测试代码 HEAD 改变，旧 PASS 立即失效；
- Phase 4 未 PASS 前不施工 Phase 5；
- 用户本地 Codex 不得为了通过测试修改生产代码。
