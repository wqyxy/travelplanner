# AI Travel Planner

本地优先、Candidate-first 的 AI 可视化旅行规划工作台。

核心流程：

```text
描述旅行需求
→ AI 推荐地点
→ 用户筛选并完成地图定位
→ AI 使用真实地理信息生成按天行程
→ 地图服务计算路线
→ 用户确定性编辑或应用受控 AI Proposal
→ 分批细化行程
```

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

V3 旅行数据写入：

```text
private_data/travel-v2.sqlite3
```

公共地图缓存写入：

```text
private_data/public-data-cache.sqlite3
```

`private_data/` 不进入 Git，也不会被便携包复制。

V3 不读取、不迁移、不覆盖旧 `private_data/travel.sqlite3`。旧数据库迁移和 v1/v2 双写不属于当前产品范围。

## 文档

- 产品唯一需求依据：[`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md)
- 当前改进步骤：[`docs/IMPROVEMENT_STEPS.md`](docs/IMPROVEMENT_STEPS.md)
- 实施状态：[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)
- 本地测试提示词：[`docs/LOCAL_TEST_PROMPT.md`](docs/LOCAL_TEST_PROMPT.md)
- 文档优先级：[`docs/README.md`](docs/README.md)

## 安全边界

- AI 不输出可信坐标、路线 geometry、地图 Provider 距离或时间。
- 坐标只来自地图 Provider 或用户明确输入。
- 用户基础编辑使用固定 `PlanCommand`。
- AI 修改必须先生成带 Scope 的 Proposal，用户 Apply 后才写正式计划。
- Route Dirty 由输入 fingerprint 派生，拖拽后不会自动调用 Route Provider。
