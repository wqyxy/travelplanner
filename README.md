# AI Travel Planner

本地优先、Candidate-first 的 AI 可视化旅行规划工作台。

> 2026-09-02：五步产品与架构重构已经完成文档设计，**本次只更新文档，五步对应代码尚未实施**。实际代码状态见 `docs/IMPLEMENTATION_STATUS.md`。

核心产品流程：

```text
1 旅行需求
→ 2 去哪些地方
→ 3 安排路线和天数
→ 4 补充景点
→ 5 每日行程
```

用户心智：

```text
我要怎么玩
→ 去哪些地方
→ 这些天怎么分
→ 还有什么值得去
→ 每天具体怎么玩
```

## 产品交互原则

TravelPlanner 使用：

```text
地图 / 时间轴展示
+
右侧唯一控制台
```

五步导航、AI Composer、Action / Proposal、编辑、生成 / 更新和流程推进都属于右侧控制台。

地图 / 时间轴只负责：

```text
展示
选择
聚焦
```

同一个业务动作只能有一个 canonical UI 入口；跨步骤 CTA 只导航，不代替目标步骤执行生成动作。

## 规划层级

五步设计区分：

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

Step 3 使用 Stay Block 表达停留段；同一个 Planning Area 可以在环线旅行中出现多次。

移动日统一计入到达 Stay Block。

## AI / Stage 架构

用户 Workflow 是五步，但数据库 ConversationStage 仍保持四个：

```text
requirements
destinations
interests
itinerary
```

未来五步映射：

```text
requirements → requirements
backbone     → destinations
skeleton     → destinations
interests    → interests
detail       → itinerary
```

ConversationStage 只是 UI / Dialogue / Action 命名空间，不替换 canonical `TravelPlanDocument` 的 TripStage。

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

五步设计不因为 UI Workflow 变成五步而新增第五数据库 ConversationStage，也不要求为此提升数据库版本。

公共地图缓存：

```text
private_data/public-data-cache.sqlite3
```

`private_data/` 不进入 Git，也不会被便携包复制。

## 文档

- 五步正式施工图：[`docs/TravelPlanner 五步规划流程重构实施方案.md`](docs/TravelPlanner%20五步规划流程重构实施方案.md)
- 五步 UI 规范：[`docs/五步 UI 交互规范.md`](docs/五步%20UI%20交互规范.md)
- 产品总体依据：[`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md)
- Dialogue / Action 架构：[`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`](docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md)
- Macro / Detail 增量设计：[`docs/ITINERARY_MACRO_DETAIL_INCREMENTAL_DESIGN.md`](docs/ITINERARY_MACRO_DETAIL_INCREMENTAL_DESIGN.md)
- 实际实施状态：[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)
- 文档优先级：[`docs/README.md`](docs/README.md)

## 安全边界

- AI 不输出可信坐标、Provider Place ID、路线 geometry、地图 Provider 距离或时间；
- 用户基础编辑使用固定 PlanCommand / 受控确定性 mutation；
- AI 修改必须遵守 Scope / generation / Proposal 边界；
- Route Dirty / itinerary needs_update 由依赖与输入 Diff 派生，不用单纯 generation 变化代表整阶段失效；
- AI 不能自行读写文件、执行 Shell、调用 MCP、创建子 Agent；服务端是唯一调度者。
