# AI Travel Planner

本地优先、Candidate-first 的 AI 可视化旅行规划工作台。

核心流程：

```text
需求
→ 目的地
→ 兴趣点
→ 行程骨架
→ 每日详细行程
```

右侧工作区是唯一 AI 交互入口。四个 `ConversationStage` 分别拥有独立对话、消息历史和 Codex Thread；它们只是 UI / Dialogue / Action 命名空间，不替换 canonical `TravelPlanDocument` 的三阶段 `TripStage`。

AI 对话只负责回答、澄清、判断是否需要实时核验以及识别受控 Action。精确编辑使用确定性代码；需要 AI 修改旅行计划时先生成 Proposal，用户 Apply 后才写入 canonical plan。坐标和真实路线事实继续只来自地图 Provider 或用户明确输入。

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

Windows 可执行 `npm run package:windows`；macOS 使用：

```bash
bash scripts/build_portable_macos.sh <Node.js-24-目录>
```

## 数据

当前 staged v3 运行时仍使用固定文件路径：

```text
private_data/travel-v2.sqlite3
```

但该文件内部必须是：

```text
PRAGMA user_version = 3
```

这是一次 fresh database cutover：

- 不实现旧 v2 → v3 数据迁移；
- 不兼容读取旧 version 2 数据库；
- 不双写；
- 不在正常启动时自动 DROP、DELETE、移动、覆盖或重建旧数据库；
- 如果该路径已经存在旧 version 2、未知版本或损坏 Schema，服务端会 fail closed；
- 真正删除或人工移走旧 `private_data/travel-v2.sqlite3` 只能作为明确的最终 cutover 操作执行。

公共地图缓存仍写入：

```text
private_data/public-data-cache.sqlite3
```

`private_data/` 不进入 Git，也不会被便携包复制。

## AI 架构

提示词按职责显式注册：

```text
prompts/
├─ shared/
├─ dialogues/
└─ actions/
```

运行时只组合“共享规则 + 当前一份具体 Prompt”。旧 00–03 编号 Agent Prompt 已从 staged v3 运行链删除。

执行边界：

- Dialogue 首次调用默认 `reasoning=none`、`summary=none`、`web=disabled`；
- 需要时效性核验时先返回 `web_required`，服务端第二次联网后才形成最终回答；
- Action Registry 固定每个动作的 executor、Prompt、reasoning、web、输入/输出合同和 Scope Policy；
- deterministic Action 不调用模型；
- AI Action 使用临时独立线程；
- 行程 AI 不得创建新 Place/Candidate，需要新地点时返回兴趣点阶段；
- Stage Thread 只是性能上下文，数据库消息才是长期历史事实源。

## 文档

- 当前 AI Stage/Action 目标设计：[`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`](docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md)
- 产品总体依据：[`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md)
- 当前实施交接：[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)
- 文档优先级：[`docs/README.md`](docs/README.md)

## 安全边界

- AI 不输出可信坐标、Provider Place ID、路线 geometry、地图 Provider 距离或时间。
- 坐标只来自地图 Provider 或用户明确输入。
- 用户基础编辑使用固定 `PlanCommand` / 受控确定性 mutation。
- AI 修改必须先生成带 Scope 的 Proposal，用户 Apply 后才写正式计划。
- Proposal Apply 时重新校验 Scope 和 generation。
- Route Dirty 由输入 fingerprint 派生；精确拖拽不会自动调用 AI。
- AI 不能读写文件、执行 Shell、调用 MCP、创建子 Agent，服务端是唯一调度者。
