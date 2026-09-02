# AI Travel Planner

本地优先、Candidate-first 的 AI 可视化旅行规划工作台。

> 2026-09-03：五步规划重构 **Phase 1–6 已完成实施并逐阶段通过独立 Codex Gate**；当前处于 Phase 7 最终综合回归交接，尚未在最终回归 PASS 前宣称本专项完成。实际状态见 `docs/IMPLEMENTATION_STATUS.md`。

核心产品流程：

```text
1 旅行需求
→ 2 想去哪些地方
→ 3 路线和天数
→ 4 补充景点（可选）
→ 5 每日行程
```

用户心智：

```text
我想怎么玩
→ 我想去哪些地方
→ 这些天怎么排
→ 要不要再补点景点
→ 每天具体怎么玩
```

## 产品交互原则

TravelPlanner 使用：

```text
地图 / 时间轴展示
+
右侧唯一控制台
```

五步导航、AI Composer、编辑、生成 / 更新和流程推进都属于右侧控制台。

地图 / 时间轴只负责：

```text
展示
选择
聚焦
```

同一个业务动作只有一个 canonical UI 入口。

如果用户在错误步骤提出请求，系统可以自动切换到正确工作区并保留上下文，但不得跨步骤静默执行高影响 mutation。

更重要的是：

> **内部工程模型可以复杂，但普通用户不需要理解 PlanningRole、Skeleton、fingerprint、dirty、WorkflowStep、CAS 等术语。**

## 规划层级

五步设计内部区分：

```text
Planning Area
= 停留 / 住宿 / 组织宏观路线的城市

Core Visit
= 不作为住宿基地，但会显著影响半天 / 全天时间预算的重要非城市地点

Detail Interest
= 在已确定时间容量内补充的普通景点 / 活动 / 餐厅
```

同时：

```text
Place.kind
planningRole
preference
```

三个概念保持独立。

用户界面不要求理解这些工程术语：

```text
Planning Area → 停留地点 / 区域
Core Visit → 重要游览地
Detail Interest → 普通景点 / 活动
```

Step 3 使用 Stay Block 表达停留段；同一个 Planning Area 可以在环线旅行中出现多次。

移动日统一计入到达 Stay Block。

## Preference UX

数据层继续保留：

```text
must_go
want_to_go
optional
excluded
```

但普通 UI 主要让用户操作：

```text
必去
想去
```

AI 推荐默认 optional 可弱化展示；“不考虑”通过移除表达。

## Step 2 与 Step 3

```text
Step 2
= 愿望清单：先选出想考虑的地方

Step 3
= 最终路线：根据总天数决定真正怎么排
```

因此“想去”的地点可以因为天数 / 绕行没有进入最终路线，但必须解释；普通 optional 候选可以不采用。

## Step 4 可选

Step 4 是增强步骤，不是硬 gate。

用户已有足够地点时可以：

```text
路线和天数
→ 补充景点（不运行 Discovery）
→ 直接每日行程
```

需要更多推荐时再点击“帮我补充景点”。

## AI / Stage 架构

用户 Workflow 是五步，但数据库 ConversationStage 仍保持四个：

```text
requirements
destinations
interests
itinerary
```

当前五步映射：

```text
requirements → requirements
backbone     → destinations
skeleton     → destinations
interests    → interests
detail       → itinerary
```

ConversationStage 只是 Dialogue / Action 命名空间，不替换 canonical `TravelPlanDocument` 的 TripStage。

内部跨步骤使用 `requiresWorkflowStep`，用户体验则是自动切换到正确工作区，而不是频繁提示“请前往某一步”。

AI Dialogue 负责回答、澄清、判断是否需要实时核验和识别受控 Action；确定性编辑优先使用确定性代码。AI 修改仍遵守 Proposal / Scope / generation / CAS 边界。

坐标、Provider Place ID、真实路线 geometry、Provider 距离和时长继续只来自地图 Provider 或用户明确输入。

## 增量更新

五步设计的核心不是“重新生成全部”，而是：

```text
Change
→ Impact Analysis
→ affected scope
→ 用户在归属步骤主动更新
→ old/new Diff
→ only affectedDayIds needs_update
```

普通兴趣点变化不能默认让整个行程失效。

Detailed Update 应以当前已保存 Day 为 sticky baseline，尽量保留现有 Stop、顺序、时间和用户手工调整。

用户不看到 `affectedDayIds / macroDirty` 等内部名词，只看到：

```text
2 天需要更新
其他 18 天不变
```

Update Card 默认保持简洁，需要时再展开原因。

## 当前实施状态

Phase 1–6 已按正式施工图完成并分别通过独立 Codex Gate：

```text
Phase 1 Role + Contract Foundation             PASS
Phase 2 Skeleton + Impact Consumer Foundation PASS
Phase 3 Backbone Producer                     PASS
Phase 4 Capacity-Aware Interests              PASS
Phase 5 Detailed Itinerary                    PASS
Phase 6 UI / Map + Complexity Downshift       PASS
```

当前只剩 Phase 7 最终综合回归。最终回归需要重新执行 targeted tests、typecheck、full test、build，并在安全隔离条件下做 Browser E2E；真实 AI smoke 仅在环境已有合法 AI 配置和现有 smoke 方法时执行。最终回归未 PASS 前，不把本专项标记为“全部完成”。

## 开发运行

要求 Node.js 24 或更高版本。

```bash
npm install
npm run dev
```

首次访问时在本机创建用户名和至少 6 位密码。默认服务端口为 `6688`。

生产运行：

```bash
npm run build
npm run start
```

Windows 可执行：

```bash
npm run package:windows
```

macOS：

```bash
bash scripts/build_portable_macos.sh <Node.js-24-目录>
```

## 数据

当前 staged v3 运行时使用：

```text
private_data/travel-v2.sqlite3
```

内部：

```text
PRAGMA user_version = 3
```

五步 Workflow 不因为用户流程变成五步而新增第五数据库 ConversationStage，也不要求为此提升数据库版本。

公共地图缓存：

```text
private_data/public-data-cache.sqlite3
```

`private_data/` 不进入 Git，也不会被便携包复制。

## 文档

`docs/` 只保留当前必须读取的文档：

- 产品总纲：[`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md)
- 当前正式施工图与最终验收依据：[`docs/TravelPlanner 五步规划流程重构实施方案.md`](docs/TravelPlanner%20五步规划流程重构实施方案.md)
- UI 设计规范：[`docs/五步 UI 交互规范.md`](docs/五步%20UI%20交互规范.md)
- 当前实施状态 / 最终回归入口：[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)
- 文档索引：[`docs/README.md`](docs/README.md)

已完成、已被取代或仅用于历史解释的专项方案不继续保留在 `docs/`；历史追溯使用 Git history。

## 安全边界

- AI 不输出可信坐标、Provider Place ID、路线 geometry、地图 Provider 距离或时间；
- 用户基础编辑使用受控确定性 mutation；
- AI 修改必须遵守 Scope / generation / Proposal 边界；
- Route Dirty / itinerary needs_update 由依赖与输入 Diff 派生；
- AI 不能自行读写文件、执行 Shell、调用 MCP、创建子 Agent；服务端是唯一调度者。
