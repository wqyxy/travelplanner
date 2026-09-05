# AI Travel Planner

本地优先、以用户为主、AI 为辅的可视化旅行规划工作台。

当前产品已经收敛为两个工作区：

```text
规划 · 旅行需求
行程 · 最终线路
```

用户只维护一份最终线路：`finalRoute`。Day、地图路线和详细安排都围绕这份线路派生或编辑，不再要求用户理解旧的 Candidate / Skeleton / Step 2–5 流程。

## 当前产品原则

> **用户是旅行方案的唯一决策者，AI 只提供建议和受控修改。系统允许保存不完整、有冲突、暂未定位或不符合 AI 建议的规划；代码只阻止数据损坏、越权和伪造事实。**

核心规则：

- 同一 Place 可以在线路中出现多次，每次拥有独立 route node ID。
- `tentative / no_go` 仍保留在线路和地图上，但暂时退出当前 Day / Route。
- 交通属于“到达当前节点”。
- `住 / 不住` 只控制当天是否在该节点结束；`多一晚` 会新增同 Place 的独立线路节点。
- Day 根据最终线路自动派生，用户不维护第二份 Day 顺序。
- 右侧最终线路是唯一业务操作入口；地图只负责展示、选择、聚焦和响应右侧发起的定位选点。

## AI 权限

普通 AI 不拥有“替用户重做行程”的权限：

```text
生成主要地点
= 只在空线路时建立第一版最终线路

生成 / 补充详细地点
= 只能插入本轮新地点
= 不能修改已有线路节点

完善这一天
= 只能修改授权节点的活动 / 时间 / 停留 / 备注

优化这一天 / 这一段 / 全程
= 只有用户明确启动后才能重排授权范围内已有 normal 节点
```

优化结果先形成 Proposal，由用户决定采用、不采用或撤销。

## Provider 事实边界

以下事实不能由 AI、前端或普通 API 调用方伪造：

- 坐标；
- Provider Place ID；
- 真实路线 geometry；
- Provider 距离；
- Provider 时长；
- `verified` 核验状态。

finalRoute 的人工 / AI 交通选择只保存交通方式 `mode`；真实路线事实由地图 / Route Provider 补充。

未定位地点可以继续留在旅行方案中，不因为暂时无法定位就自动删除或补位。

## 当前实施状态

本轮最终线路重构已经完成，并通过三阶段冻结基线测试：

```text
Phase 1  finalRoute / Day / Route 基础             PASS
Phase 2  右侧人工最终线路 + 地图                   PASS
Phase 3  AI 生成 / 详细安排 / 显式优化             PASS
```

Phase 3 最终验收：

```text
Test Branch: test/plan-phase3-final-route-ai-20260905-r3
Test HEAD: 8b17dde239484e79a98b7900766442d1b8836ea2
Typecheck: PASS
Phase 3 专项: 54 / 54 tests passed
AI / Prompt / Runtime 回归: 63 / 63 tests passed
完整 npm test: 505 / 505 tests passed
Build: PASS
```

浏览器 UI E2E 和真实外部 Route Provider 未在该冻结环境执行；它们不是这轮强制 Gate。

完整实施记录见 [`docs/PLAN_PROGRESS.md`](docs/PLAN_PROGRESS.md)。

## 开发运行

要求 Node.js 24 或更高版本。

```bash
npm install
npm run dev
```

默认服务端口：`6688`。

生产构建 / 启动：

```bash
npm run build
npm run start
```

Windows 便携包：

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

公共地图缓存：

```text
private_data/public-data-cache.sqlite3
```

`private_data/` 不进入 Git，也不会被便携包复制。

本轮 finalRoute 重构不迁移旧测试旅行数据；旧测试库可以清理后使用新结构重新创建旅行。

## 当前文档

后续开发优先阅读：

- 当前产品现状：[`docs/PRODUCT.md`](docs/PRODUCT.md)
- 当前技术现状：[`docs/TECHNICAL.md`](docs/TECHNICAL.md)
- 本轮目标 / 规则背景：[`docs/PLAN.md`](docs/PLAN.md)
- 最终实施记录：[`docs/PLAN_EXECUTION.md`](docs/PLAN_EXECUTION.md)
- 最终完成状态与测试基线：[`docs/PLAN_PROGRESS.md`](docs/PLAN_PROGRESS.md)

旧五步方案、旧状态文档名和已经被替代的专项文档不再作为当前事实入口；需要历史追溯时使用 Git history。
