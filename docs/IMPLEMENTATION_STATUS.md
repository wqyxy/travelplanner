# AI Architecture Refactor — Implementation Status

更新时间：2026-08-25
架构依据：`docs/AI-architecture-refactor.md` v2  
当前 Phase：Phase 7 Follow-up — 地图与聊天交互缺陷修复
状态：国家公园定位与聊天快捷按钮互斥修复已通过定向验证；其余地图展示改动仍待后续完整验证

## 开始新阶段前的固定检查

每个新 Codex Thread / 模型开始工作前必须重新读取：

1. `docs/AI-architecture-refactor.md`
2. `docs/IMPLEMENTATION_STATUS.md`
3. `git status`
4. `git diff`
5. 最近相关 `git log`

不得依赖聊天记录恢复实施状态。不得读取、迁移、重置或删除 `private_data/`，直至代码重构、Review、测试和架构文档第 10.3 节的安全条件全部完成。

## Git 与仓库基线

- Phase 0 开始时分支：`main`
- Phase 0 开始时 HEAD：`ec6c293` (`Document v2 AI architecture refactor decisions`)
- 与 `origin/main` 的关系：一致
- Phase 0 开始时工作区：干净；`git diff` 为空
- 最近相关实现提交：
  - `4b345f6`：typed Codex RPC contracts、路线骨架、逐日细化及 outline map projector
  - `3eeab5f`：逐日地图生成重试/失败状态
  - `446a208`：TripPlan V2 地点引用及国家安全地理编码
  - `403d8c0`：MapCoordinator、地图解析和瓦片缓存
- Phase 0 只新增本状态文件；未修改业务代码、Prompt、配置或测试。
- 未读取或接触 `private_data/`。

## 已确认架构决策

以下决策来自唯一架构文档，不在实施中重新讨论或扩展：

- `itinerary:v1` 是唯一活动旅行事实来源，从新旅行的 `planning` 阶段即存在。
- 业务 stage 只有 `planning | draft | detailed`，且只保存在 itinerary 内。
- requirements、RouteSkeleton、TripPlan V1/V2、daily patch/repair、route decision 和 map patch 不再是并行核心模型。
- 初稿与详细行程共用 `Day` / `Stop` Schema；逐日完成度由 `Day.detailLevel` 表达。
- 首次明确确认生成 draft 时可返回完整 itinerary；已有 itinerary 的普通修改使用受限 `PlannerMutation`。
- 正式 Place / Day / Stop ID 由服务端分配；canonical itinerary 和 `contentGeneration` 决定写入有效性。
- 01 在同一 Codex 线程内每批处理两个 Day；每批落库后必须回灌正式 ID、canonical Day/Place、依赖失效摘要和新 generation。
- 动态事实使用 `verified | estimated | unverified`，依赖失效由确定性服务端代码执行。
- Place 保存后执行引用垃圾回收。
- 地图 Visit / Edge、query、指纹、候选硬过滤/评分和路线复用由代码生成；AI 只保留极小的候选消歧职责。
- `ResolvedPlace` 和地图快照只是派生缓存，不是第二旅行事实来源。
- 不实现旧旅行数据库迁移或 V1/V2 兼容读取；最终按架构文档的独立安全步骤重置 `private_data/`。
- 登录、签名 Cookie、配置、Codex app-server 客户端、公开 AI Task、地图瓦片/公开缓存和安全路线能力继续保留。

## Phase 0 已完成内容

- 以 UTF-8 完整阅读 `README.md`、`AGENTS.md` 和 1158 行架构文档。
- 检查 Git 状态、当前差异、最近 12 个提交及最近架构/实现提交的文件范围。
- 盘点所有 `apps/server`、`apps/web/src`、`prompts` 和现有测试文件；未扫描 `private_data/`。
- 阅读当前合同、TravelStore Schema/主要方法、Prompt loader、六个 Prompt、API 路由、前端类型、地图模块边界和配置路径。
- 建立目标架构到实际代码的切换映射。
- 明确 Phase 1 的实施边界、验收点和集成风险。

## 当前实现诊断

### 当前事实来源并不唯一

当前旅行状态同时分散在：

- `requirements` revision
- `trips.skeleton_json`
- `trips.planning_stage`
- `trips.planning_generation`
- `itinerary_revisions.plan_json` 中的 TripPlan V1/V2
- `daily_detail_tasks`
- `route_decisions`
- `map_manifests` / `map_entities` / `map_visits` / `map_routes` / `map_day_runs`
- `activity_locations`

这与 canonical itinerary 唯一事实来源直接冲突，不能通过在旧结构旁新增一套字段解决。

### 当前主流程

当前 `apps/server/index.ts` 实际链路是：

```text
聊天 → RouteSkeletonOutput → TravelStore.expandSkeleton → TripPlan V2 占位日程
     → 关键交通核验 / RouteDecision
     → 每日独立 DetailDayPatch（最多并行 3 天）
     → DailyRepairPatch
     → OutlineMapProjector 或 MapCoordinator
     → MapAgentOutput V3/V4 → Nominatim → AI resolution → 手工候选
```

目标链路要求删除上述骨架展开、独立核验/决策、逐日 repair 和地图 patch 状态机，而不是适配它们。

## 目标架构到代码的实施映射

| 目标能力 | 当前落点 | 处理方式 | 主要 Phase |
| --- | --- | --- | --- |
| `itinerary:v1`、Day/Stop、Verification | `apps/server/contracts.ts` 中 Requirements + TripPlan V1/V2 + Activity | 整体重写，不保留 legacy union/alias | 1 |
| PlannerOutput + 受限 Mutation | RouteSkeletonOutput / TravelAgentOutput | 新合同；mutation 字段逐项白名单 | 1（合同）/ 2（执行） |
| 两日 DetailBatch + canonical feedback | DetailDayPatch / DetailDayRepairPatch | 新合同；删除 repair patch | 1（合同）/ 3（执行） |
| CandidateDecisionOutput | MapAgentOutput / MapResolutionOutput | 新极小合同；删除 AI query/coordinate/patch 输出 | 1（合同）/ 4（执行） |
| canonical itinerary + generation | `TravelStore` 的 requirements/revisions/stage/generation 多套状态 | TravelStore 全面重写为新库 Schema | 1 |
| Planner workflow | `index.ts` 的 outline、verification、repair、deferred message 编排 | 重写为单一 `/turns` 规划/保存链路 | 2 |
| 01 workflow | 每天独立线程、最多 3 天并行、repair/stop/resume | 重写为同线程两日串行批处理 | 3 |
| deterministic map graph | `outline-map-projector.ts` + Map Agent day paths | 删除 projector；从 stops 派生 Visit/Edge | 4 |
| ResolvedPlace + scorer + route reuse | `map-service.ts` / `map-coordinator.ts` / 旧 map tables | 保留安全 provider/routing 代码，重写调度与持久化 | 4 |
| 简化 API / WebSocket | `index.ts` 专用 outline/detail/map routes 与事件 | 删除专用入口，保留通用快照事件 | 5 |
| 三阶段 UI / 唯一 Chat | `App.tsx`、`Itinerary.tsx`、`AssistantDrawer.tsx` | 重写 | 5 |
| 删除 requirements UI | `RequirementsDrawer.tsx`、`requirements-draft.ts` | 删除及清理 CSS/测试 | 5/6 |
| 旧代码最终引用清理 | 全仓库 | `rg` + typecheck 后删除死代码 | 6 |

## 模块处置清单

### Phase 1 必须重写

- `apps/server/contracts.ts`
- `apps/server/travel-store.ts`
- `apps/server/travel-store.test.ts`
- `apps/server/location-contract.test.ts`（改为新 itinerary / Planner 合同测试，或合并后删除）
- `apps/server/trip-language.test.ts`（适配新 Trip 结构；语言显示仍是保留能力）

### 后续重写

- `apps/server/prompt-contract.ts`（Phase 2，只加载三个新 Prompt）
- `apps/server/index.ts`（Phase 2、3、5 分阶段重写编排和 API）
- `apps/server/map-coordinator.ts`（Phase 4；允许直接替换为小型 generation 调度器）
- `apps/server/map-service.ts`（Phase 4；保留安全 geocoder/routing 核心，替换旧状态和人工选择）
- `apps/web/src/types.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/AssistantDrawer.tsx`
- `apps/web/src/Itinerary.tsx`
- `apps/web/src/MapPanel.tsx`
- `apps/web/src/VersionDrawer.tsx`
- 相关 CSS 与测试

### 明确删除候选（到相应 Phase 前必须再次 `rg`）

- `apps/server/outline-map-projector.ts`
- `apps/server/outline-map-projector.test.ts`
- `apps/web/src/RequirementsDrawer.tsx`
- `apps/web/src/requirements-draft.ts`
- `apps/web/src/requirements-draft.test.ts`
- 若快照刷新已完全替代 patch 合并：`apps/web/src/map-patch-reducer.ts` 及测试
- 旧 Prompt：原 01 地图标注、03 每日修复、04 关键交通核验、05 路线修复；旧 02 内容由新 01 替换

### 保留并只做必要适配

- `apps/server/auth.ts` 及认证测试
- `apps/server/config.ts` 的认证/端口/模型/地图颜色能力；`requirementsPanelOpen` 在 UI 清理阶段移除
- `apps/server/codex-client.ts` 的受控只读 app-server 调用、通知解析和 15/30/60 秒瞬时重试
- `apps/server/ai-task-monitor.ts` 的公开进度能力
- `apps/server/map-tile-cache.ts` 及公开缓存边界
- `apps/web/src/PasswordDrawer.tsx`、`SettingsDrawer.tsx`
- 地图分类、标签布局、日/全程联动、全屏、主题与工作区控制中不依赖旧 map alias 的部分
- Windows/macOS 打包脚本；仍不得包含 `private_data/`

## 高风险依赖

1. **合同切换半径大**：`contracts.ts` 被 `index.ts`、TravelStore、MapCoordinator、MapService、OutlineMapProjector、AI Task 和多组测试直接引用。Phase 1 删除旧导出后，旧 workflow 会立即失去类型/运行时合同。
2. **阶段性集成不可完整运行**：不允许兼容层，也不能同时保留旧核心合同。因此 Phase 1 的验收应针对新 contracts/TravelStore；旧 `index.ts`、地图和前端要到 Phase 2–5 依次切换，期间不应启动真实应用或用当前 `private_data` 做验证。
3. **旧数据库自动迁移耦合**：TravelStore 构造器当前自动执行 1→13 迁移。新 Store 必须只创建/验证新 Schema；发现旧或未知 Schema 必须停止，不能升级、重建或覆盖。
4. **地图状态与 TravelStore 强耦合**：当前地图表、patch sequence、V3/V4 alias、day run 和候选选择方法全部在 TravelStore。Phase 1 只能建立目标 `map_state` 存储边界，Phase 4 才实现派生算法；不能把旧 map 表搬入新 Store。
5. **版本概念过多**：当前同时存在 requirements revision、itinerary version、planning generation、map version、contract version、patch sequence。目标必须收敛为 canonical `contentGeneration`、用户可见 itinerary revision 及派生 map generation，避免名称相同但语义不同。
6. **历史策略变化**：当前逐日细化直接改 working revision；目标只在首次 draft、完整 00 mutation、01 全部完成和历史恢复时生成用户可见 revision。Store API 必须把 canonical 保存与 revision 创建分开且保持事务原子性。
7. **ID 与引用安全**：旧代码按名称 hash 生成 Place/Activity ID。目标正式 ID 必须由服务端随机分配并原子重写临时引用；不同物理地点不得复用旧 Place ID。
8. **启动顺序风险**：当前服务启动即打开 `private_data/travel.sqlite3`。新 Store 完成后，在最终安全清理前启动应用会因旧 Schema 被拒绝；这是预期保护，不得改成兼容读取。
9. **测试大面积失效是删除信号**：现有 `travel-store.test.ts` 大部分覆盖旧 map patch、legacy upgrade、skeleton expansion、route decisions 和 daily task 状态，应重写而不是让新实现继续满足旧断言。
10. **`index.ts` 过度集中**：约 83 KB 文件同时处理认证、Codex workflow、地图、API、WebSocket 和重试。后续可以按文档职责重写，但不得借机增加新的核心 Agent、stage、Patch/Repair 或兼容层。

## 架构文档中的已采用解释

Phase 0 发现 detailed stage 的文字冲突：

- 第 4.5 节和第 16.1 节要求：`stage=detailed` 时所有 Day 都必须为 `detailLevel=detailed`。
- 第 4.5 节末尾和第 7.5 节又要求：进入 detailed 生命周期后，局部修改可把 Day 降为 draft，但整体 `itinerary.stage` 不回退。
- 第 18 节则写成“该 Day 和整体 stage 按规则降级”。

用户于 2026-08-24 启动 Phase 1 后，按 Phase 0 已明确建议采用以下解释，并已写入合同：

1. **生命周期不回退**：进入 detailed 后允许 `stage=detailed` 与 draft Day 混合；“所有 Day detailed”只作为首次进入 detailed 的转换条件。

这避免增加第四业务 stage 或绕回旧 partial/repair 模型。后续 UI 测试应按 `Day.detailLevel` 表达局部未完成状态。

2. **最小 `update_fields`**：为同时满足 Structured Output 的“所有对象属性 required”和最小 mutation，单条 `update_fields` 只修改一个明确白名单字段；同一轮需要修改多个字段时返回多条 mutation，并由 Phase 2 服务端原子应用。操作类型仍严格保持架构文档规定的六类，没有增加字段级业务动作类型。

## Phase 1 准确实施范围

### 范围内

1. 重写 `apps/server/contracts.ts`：
   - `Itinerary`、`TripFacts`、`Place`、`Day`、`Stop`、`Verification`
   - `PlannerMutation` 六类通用操作，以及逐实体明确字段白名单
   - `PlannerOutput`
   - `DetailCanonicalFeedback`、`DetailBatchOutput`
   - `ResolvedPlace`、`MapVisit`、`MapEdge`、简化 Map snapshot/event 基础合同
   - `CandidateDecisionOutput`
   - 通用 AI Task / message 类型（含 generation 取代结果的可见取消语义）
   - 严格 Codex JSON Schema 输出，所有对象属性 required/null 显式化
2. 实现 itinerary 业务校验：
   - 日期 `YYYY-MM-DD`、时间 `HH:mm`、ISO countryCode、枚举 period/mode
   - ID 唯一、Place 引用完整、Stop 首尾角色、中间 visit、首 Stop 无交通
   - dayNumber 服务端标准化、日期连续性和日期范围天数
   - planning/draft/detailed 与 Day.detailLevel 约束
   - verification 的 `verified + checkedAt` 规则
3. 重写 `apps/server/travel-store.ts` 为全新数据库：
   - 最小表：`trips`、`itinerary_revisions`、`messages`、`ai_tasks`、`ai_progress_events`、`map_state`
   - 新旅行立即创建合法 planning itinerary
   - `trips.title` 仅作同事务派生索引
   - `content_generation` 乐观并发保护；过期写入零落库
   - canonical itinerary 原子读写、复制、回收站、永久删除
   - 用户可见 revision 的创建/读取/恢复原语
   - message 与通用 AI Task 持久化
   - `map_state` 只保存当前 generation 的派生 JSON/状态，不实现 Phase 4 算法
   - 数据库版本/表形状校验；旧版或未知版停止写入，不迁移、不重建
4. 重写直接相关测试：
   - 合同阶段、格式、引用、verification 和严格 JSON Schema
   - 新旅行、generation CAS、事务回滚、title 投影、复制/回收/恢复、revision 策略
   - 未知/旧数据库拒绝写入
   - 通用 AI Task 与消息的必要保留能力
5. 只为新 Store 的直接编译依赖做最小适配，例如 `ai-task-monitor.ts` 的类型签名；不进入 Planner、地图、API 或 UI workflow。

### 范围外

- 不改 Prompt 或 `prompt-contract.ts`。
- 不实现 Planner mutation applicator、依赖失效、Place GC 或聊天保存链路；这些属于 Phase 2。
- 不实现 01 两日批处理、临时 ID 正式化和 canonical feedback；这些属于 Phase 3。
- 不实现 geofingerprint、query builder、候选评分、02 调用或路线复用；这些属于 Phase 4。
- 不改 API、WebSocket 或前端；这些属于 Phase 5。
- 不做全仓 legacy cleanup；这些属于 Phase 6。
- 不启动应用，不读取/修改/删除 `private_data/`。
- 不添加兼容导出、legacy reader、双写表、旧数据迁移或第二 Store。

### Phase 1 完成判定

- 新合同只表达目标架构，不再导出 requirements、skeleton、TripPlan V1/V2、Detail Patch/Repair、TransportVerification、MapAgentOutput/MapResolution 等旧核心合同。
- 新 Store 在临时空数据库中创建目标 Schema；旧/未知数据库被明确拒绝。
- 所有 canonical itinerary 写入在一个 SQLite 事务中完成，并以 expected generation 防止陈旧覆盖。
- Store 不把 map 派生状态或 `trips.title` 当作旅行事实来源。
- 新合同和 Store 的定向测试覆盖架构文档 Phase 1 验收项。
- 不通过保留旧导出来追求全仓 typecheck 通过；全仓消费者按后续 Phase 切换。

## Phase 1 已完成内容

- 采用“detailed 是生命周期、不因局部重新细化回退”的解释；`stage=detailed` 可包含后续 mutation 降为 `draft` 的 Day，首次切入 detailed 仍由全日完成流程控制。
- `apps/server/contracts.ts` 已整体替换为 `itinerary:v1`：Itinerary、TripFacts、Place、Day、Stop、Verification、六类 PlannerMutation、PlannerOutput、两日 DetailBatch/Feedback、ResolvedPlace、Visit/Edge、候选消歧和简化地图事件。
- 新合同已增加日期、时间、ISO 国家代码、ID/引用、Stop 角色、日期连续、阶段、详细 Day 和 verification 约束；模型输出 JSON Schema 继续采用关闭对象字段的生成方式。
- `apps/server/travel-store.ts` 已整体替换为新数据库 Schema：`trips`、`itinerary_revisions`、`messages`、`ai_tasks`、`ai_progress_events`、`map_state`。
- 新旅行直接创建 planning itinerary；canonical itinerary 写入使用 SQLite `BEGIN IMMEDIATE` 和 `content_generation` 比较，陈旧写入返回 `CONTENT_GENERATION_SUPERSEDED` 且不落库。
- `trips.title` 从 canonical itinerary 同事务投影；重命名写入 itinerary，复制也创建标题一致的新 itinerary。
- 新 Store 只创建或验证新表形状。任何旧/未知 SQLite 文件都会被拒绝，不迁移、不兼容读取、不重建。
- 保留每旅行 itinerary language 作为非事实 UI 偏好；保留 messages、通用 AI Tasks、任务 metadata、版本历史、复制、回收站和 map_state 存储原语。
- `ai-task-monitor.ts` 现在把 `cancelled_by_generation` 识别为非失败的终态。
- 已重写 `location-contract.test.ts`、`travel-store.test.ts`、`trip-language.test.ts` 为新合同和临时数据库覆盖。

## Phase 1 Review 修复

- 拆分无 refinement 的 Stop 对象基底，消除对带 refinement Schema 调用 `.omit()` 导致的模块加载崩溃。
- `PlannerMutationSchema` 改为严格 union，消除重复 `type` discriminator；仍只保留六类通用操作。
- `TripChanges`、`PlaceChanges`、`DayChanges`、`StopChanges` 改为逐字段封闭 union，避免 JSON Schema 把全部可选字段强制为一次完整实体重写。
- 抽出独立 detailed Day 校验；DetailBatch 现在校验请求/返回 Day ID 集合完全相等，并对批次中的每个 Day 执行时间、停留时长、交通和 verification 校验；canonical feedback 同样要求已应用 ID 与回灌 Day 精确对应。
- 精确开始日期存在时始终校验 Day 日期连续；完整日期范围存在时拒绝冗余 `requestedDurationDays`。
- ISO 8601 核验时间允许 `Z` 或明确时区偏移；`verified` 仍强制 `checkedAt`，`estimated/unverified` 按架构允许其为空。
- Store 在确认数据库为空或已是完整 v1 形状前不启用 WAL；version 0 但含任意未知对象时直接拒绝。新 Schema 在事务中创建，初始化失败会关闭数据库句柄。
- v1 形状校验扩展到六张业务表及其完整列集合；旧版、未知版本、未知空版本形状和残缺 v1 均不迁移、不重建。
- `TripSummary.title` 只返回 `itinerary.trip.title`；派生索引不一致时停止读取并报告损坏状态。
- 合同测试补充日期/格式/detailed Day/DetailBatch/Mutation/Structured Output 场景；Store 测试补充 version 0 安全拒绝、未知新版本、标题投影、消息、AI Task、map generation 与级联删除场景。

## Phase 1 关键修改文件

- `apps/server/contracts.ts`
- `apps/server/travel-store.ts`
- `apps/server/ai-task-monitor.ts`
- `apps/server/location-contract.test.ts`
- `apps/server/travel-store.test.ts`
- `apps/server/trip-language.test.ts`
- `docs/IMPLEMENTATION_STATUS.md`

## 已执行测试 / 检查

Phase 0 只分析并写状态文档。Phase 1 未执行 Vitest、typecheck、build 或 Playwright。

已执行的只读检查：

- `git status --short --branch`
- `git diff --stat` / `git diff --name-status`
- 最近 12 个 `git log` 及最近相关提交 `--stat`
- `rg --files` 文件盘点（排除 `private_data`、`node_modules`、`dist`）
- 旧合同、状态、API、WebSocket、Prompt 和模块引用搜索
- TravelStore SQLite 表/迁移/方法搜索
- 现有测试用例名称盘点

Phase 1 初次 Review 前执行过一次合同导入检查，发现并定位了带 refinement 的 `StopSchema.omit()` 模块加载崩溃。

Review 修复后执行一次直接相关的 `tsx --eval` 轻量检查：成功导入合同与 Store、生成 `PlannerOutputJsonSchema`、解析最小 `update_fields`，并在系统临时目录创建/读取/关闭一个 planning trip；结果通过。未读取或修改 `private_data/`。

用户授权后执行 Phase 1 定向 Vitest：

```text
npm test -- apps/server/location-contract.test.ts apps/server/travel-store.test.ts apps/server/trip-language.test.ts
```

结果：3 个测试文件通过，17 个测试全部通过；耗时约 1.23 秒。首次启动因工作区沙箱拒绝测试配置解析所需的父目录读取而未进入测试，随后在相同命令和相同文件范围内获批重试成功。未运行其他测试、typecheck 或 build。

## 已知问题 / 风险

- Phase 1 严格删除旧合同后，旧 workflow 直到后续 Phase 完成前不会具备完整集成编译条件；不得用兼容层掩盖。
- 服务端 typecheck、全仓 typecheck/build 尚未执行；旧 workflow 在后续 Phase 切换前预计仍有 legacy 引用错误。
- 当前真实数据库仍是旧 Schema，且本轮未检查其内容。新 Store 应安全拒绝它，最终只按独立授权步骤处理。
- `itineraryLanguage` 是明确保留的显示能力，但目标最小 `trips` 字段清单未写出其持久化位置。Phase 1 建议把它保留为 `trips` 上的非事实 UI 偏好；若用户要求改成全局 UI 设置，应在 Phase 1 前确认。
- 目标的手工“重命名旅行”能力必须更新 `itinerary.trip.title` 并同事务投影到 `trips.title`；根据文档列举的 revision 时机，建议只增加 generation、不额外创建用户可见 revision。
- Phase 4 之前地图仅保留 `map_state` 读取边界；draft/mutation 保存会广播 trip 更新，但不会调用已删除的旧地图 Agent 或 patch 链路。
- Phase 2 已移除旧 Planner API/状态入口。现有前端仍引用旧 requirements/outline/detail 类型和接口，必须在 Phase 5 按统一 itinerary 重写；不得在 Phase 2 添加兼容层。

## 下一阶段

Phase 4 Review 修复 — Map Pipeline

开始条件：

1. 重新检查 Git 状态、架构文档与本文件，保护本次及用户已有修改。
2. 只修复本次 Review 已确认的 6 个问题并补足直接回归测试，不增加地图 Agent、业务 stage、Patch/Repair、手工候选或兼容层。
3. 修复验证通过后再进入 Phase 5 — API + WebSocket + Frontend，并将前端改为快照刷新。

下一阶段推荐模型：Terra High

## Phase 6 实施（2026-08-24）

### 已完成内容

- 按固定交接流程重新完整读取 README、唯一架构文档、本状态文件，并检查 `git status`、`git diff` 与最近相关提交；保留工作区已有的 Phase 1–5 修改，未接触 `private_data/`。
- 全仓引用搜索确认旧 Prompt、RouteSkeleton、TripPlan、MapPatch、MapCoordinator、outline projector、requirements、route decision、daily repair、旧地图候选/手选/重试 API 与旧 WebSocket patch 事件均无有效执行链。前述源码、Prompt、组件与测试删除已由前置阶段完成，本阶段不恢复任何兼容层。
- 删除 Phase 5 后仍残留的 Requirements、旧地图候选、路线决策、旧日程 banner、旧 map day status、旧密码快捷入口、旧 workspace third-panel 以及 map-spider 的无引用样式；重写 `styles.css` 仅保留当前 canonical itinerary、地图 snapshot、聊天、任务、认证、设置、版本历史、主题和工作区控件的样式。
- 删除不被当前 `Itinerary`/`MapPanel` 使用的 `itinerary-language.css` 和 `map-label-overrides.css`，并移除两处 import；当前地点语言切换和地图标签样式已完全由仍在使用的组件/CSS 处理。
- 删除 WebSocket 连接建立时遗留的 `codex.status` 私有事件推送；服务端现在只广播 `travel.turn.updated`、`travel.trip.updated`、`ai-task.updated` 和 `travel.map.changed`，前端也只消费这四类。
- 清理旧流程测试措辞：Codex 协议测试只使用 planner/draft/detail batch/map candidate 当前业务术语；配置测试不再构造已删除的 requirements 状态；认证、语言和非 v1 数据库拒绝测试保留原有安全行为但不再标记为 legacy compatibility。
- 引用检查剩余的旧术语只出现在架构约束型 Prompt（明确禁止建立旧模型）、实施历史文档或仍属当前架构的 `remainingDetailDayIds`。这些不是可执行 legacy 状态或调用链。

### 关键修改文件

- `apps/server/index.ts`
- `apps/server/auth.test.ts`
- `apps/server/codex-client.test.ts`
- `apps/server/config.test.ts`
- `apps/server/travel-store.test.ts`
- `apps/web/src/styles.css`
- `apps/web/src/main.tsx`
- `apps/web/src/MapPanel.tsx`
- 已删除：`apps/web/src/itinerary-language.css`、`apps/web/src/map-label-overrides.css`
- `docs/IMPLEMENTATION_STATUS.md`

### 已执行测试 / 检查

- `rg` 复核确认没有有效旧 API、旧 WebSocket patch、旧合同/状态机、旧组件 import 或已删除 CSS import；认证、缓存、语言偏好、地图标签/分类、工作区控件和版本历史未被误删。
- `git diff --check` 通过；仅保留工作区既有 LF/CRLF 转换提示。
- 本阶段唯一轻量检查通过：使用 PostCSS 解析重写后的 `styles.css`，并确认两个已删除 CSS 文件不存在且其 import 均已移除。
- 用户授权后执行 Phase 6 定向 Vitest；首次启动因沙箱禁止 esbuild 读取父目录元数据而未进入测试，按授权在沙箱外用相同命令重试后，18 个测试文件、77 个测试全部通过，耗时约 1.16 秒。
- 用户授权后执行 `npm run typecheck`，web 与 server TypeScript 检查全部通过。
- 用户授权后执行 `npm run build`；首次启动同样因沙箱限制未进入 Vite，按授权在沙箱外重试后 web 与 server 构建全部通过。CSS 产物从此前约 118.70 kB 降至 108.58 kB；Vite 仅提示 MapLibre 动态 chunk 约 988 kB 超过默认 500 kB 阈值，不影响产物正确性。
- 未执行 Playwright、真实服务或真实 Codex/地图 Provider。
- 未读取、修改、迁移、重置或删除 `private_data/`。

### 已确认架构决策

- 历史实施记录和 Prompt 中的“不得建立旧状态”约束不属于运行时代码，必须保留作为交接与模型安全规则；不以清理为由篡改唯一架构依据或实施历史。
- 无引用 CSS 属于 Phase 6 dead code，即使之前已经删除相应组件，也必须一起移除；保留的样式只服务于当前 canonical itinerary UI 和文档要求保留的基础能力。
- WebSocket 初始状态不另行发 `codex.status` 事件；模型状态仍通过已保留的显式 `/api/codex/status` 查询获得，避免增加第五种推送事件。
- 非 v1 SQLite 必须继续被拒绝且不得迁移；这是新 Schema 的安全保护，不是 legacy compatibility。

### 已知问题 / 风险

- 真实服务、浏览器布局和外部 Codex/地图 Provider 未启动验证；最终 Review 后应按架构第 10.3 节单独执行 `private_data` 安全重置，不能在当前阶段提前操作。
- CSS 被收敛为当前组件集合；生产 build 后仍建议在最终端到端验收中检查桌面/移动布局，但不为未证实问题重引入旧样式或抽象。

### 验证结果

已执行：

```text
npm test -- apps/server/auth.test.ts apps/server/codex-client.test.ts apps/server/config.test.ts apps/server/prompt-contract.test.ts apps/server/planner-workflow.test.ts apps/server/detail-workflow.test.ts apps/server/map-pipeline.test.ts apps/server/map-service.test.ts apps/server/travel-store.test.ts apps/server/location-contract.test.ts apps/server/trip-language.test.ts apps/web/src/assistant-actions.test.ts apps/web/src/map-presentation.test.ts apps/web/src/itinerary-language.test.ts apps/web/src/map-interactions.test.ts apps/web/src/map-label-layout.test.ts apps/web/src/password-change.test.ts apps/web/src/workspace-controls.test.ts
npm run typecheck
npm run build
```

结果：18 个定向 Vitest 文件、77 个测试全部通过；全仓 web/server typecheck 通过；web/server 生产构建通过。验证没有启动真实服务，也没有读取或修改 `private_data/`。

### 下一阶段

Phase 6 已关闭。下一轮进入 Phase 7 — 最终 Review；不得在最终 Review 结束前执行 `private_data` 清理。

下一阶段推荐模型：GPT-5.6 Sol XHigh

## Phase 5 实施（2026-08-24）

### 已完成内容

- 按固定交接流程重新完整读取 README、唯一架构文档、本状态文件，并检查 `git status`、`git diff` 和最近相关提交；保留 Phase 1–4 及用户已有工作区修改。
- 将前端运行时类型收敛到 canonical `Itinerary`、`Day.detailLevel`、`Verification`、单数 `suggestion`、`ResolvedPlace` 和简化 `MapState`，不保留 V1/V2、MapPatch 或 Requirements 别名。
- 重写 `App.tsx` 为单一旅行状态、单一 `/turns` 聊天调用和快照刷新流；WebSocket 前端只处理 turn updated、trip updated、AI task updated、map changed，地图变化只重新 GET 当前快照。
- 服务端 WebSocket 只广播上述四类通用事件；移除额外 Codex 状态广播。旅行标题或显示语言变化不再触发不必要的地图重算。
- AI Chat 恢复可收起交互并成为唯一规划入口；合同只可产生“开始实施初稿”“开始细化方案”“采用”“不采用”四种快捷按钮，按钮均向同一 `/turns` 发送自然语言。
- 重写日程展示：右栏顶部固定三阶段轨道“开始 → 初稿 → 完整行程”；planning 显示 canonical 已知事实与透明假设；draft 按 `Day.detailLevel` 混合渲染；详细 Day 显示时间、交通、时长、费用说明、注意事项和结构化核验状态。
- 重写地图展示为 MapLibre 快照消费者：同一 Place 只显示一个标记但保留多次 Visit；保留全程/按日联动、地点分类、分类颜色、图例、全屏、主题和路线悬停；未定位/大致定位只显示非阻塞警告；无候选、手选、重试或地图 AI 入口。
- 删除前端 MapPatch reducer、旧地图状态 reducer、Requirements 组件/草稿及其测试；移除地图颜色和认证的旧 window CustomEvent 桥接。
- 保留本机登录/退出/修改密码、Codex 浏览器与设备码登录、模型/reasoning effort、新建/重命名/复制/回收站/恢复/永久删除、版本历史恢复、语言、主题、分栏、侧栏、地图颜色、公开 AI 进度和通用停止能力。
- 从 UI 配置合同、默认值、加载和更新 API 中删除 `requirementsPanelOpen`；旧配置中该字段会被确定性忽略，不建立兼容状态。
- 新增纯展示回归测试，覆盖四类聊天按钮、三阶段索引、地图 Place 标记去重、按日 Visit/路线范围和未定位提示输入。

### 关键修改文件

- `apps/server/config.ts`
- `apps/server/config.test.ts`
- `apps/server/index.ts`
- `apps/web/src/types.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/AssistantDrawer.tsx`
- `apps/web/src/Itinerary.tsx`
- `apps/web/src/MapPanel.tsx`
- `apps/web/src/AiTaskTopbar.tsx`
- `apps/web/src/SettingsDrawer.tsx`
- `apps/web/src/VersionDrawer.tsx`
- `apps/web/src/main.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/assistant-actions.test.ts`
- `apps/web/src/map-presentation.test.ts`
- `apps/web/src/itinerary-language.test.ts`
- 已删除：`RequirementsDrawer.tsx`、`requirements-draft.ts` 及测试、`map-patch-reducer.ts` 及测试、`map-status.ts` 及测试
- `docs/IMPLEMENTATION_STATUS.md`

### 已执行测试 / 检查

- 引用搜索确认有效前端代码不再调用 Requirements API、旧独立细化/路线决策 API、地图候选/手选/重试 API，也不再读取复数 `suggestions` 或消费 MapPatch 事件。
- 广播/监听复核确认服务端只发出、前端只处理四类通用 WebSocket 事件。
- `git diff --check` 通过；仅有工作区既有 LF/CRLF 转换提示。
- 本阶段唯一轻量检查通过：使用本地 TypeScript 转译器对 12 个本阶段关键 TS/TSX 文件执行只读语法转译，syntax diagnostics 为 0。
- 用户授权后执行 Phase 5 定向 Vitest；首次启动因沙箱禁止 esbuild 读取父目录元数据而未进入测试，按授权在沙箱外用相同命令重试后，7 个测试文件、16 个测试全部通过，耗时约 2.89 秒。
- 用户授权后执行 `npm run typecheck`，web 与 server TypeScript 检查全部通过。
- 用户授权后执行 `npm run build`；首次启动同样因沙箱限制未进入 Vite，按授权在沙箱外重试后 web 与 server 构建全部通过。Vite 仅提示动态 MapLibre chunk 约 988 kB 超过默认 500 kB 警告阈值，不影响产物正确性。
- 未执行 Playwright、真实服务、真实 Codex、真实地图 Provider 或端到端验收。
- 未读取、修改、迁移、重置或删除 `private_data/`。

### 已确认架构决策

- 地图 changed 事件只通知客户端重新获取当前 snapshot，不承载 patch，也不在前端维护第二套地图状态机。
- AI Chat 的四类合同按钮只是自然语言输入快捷方式，不对应新的独立业务 API。
- `Day.detailLevel` 是 draft 阶段逐日混合显示的唯一依据；公开 AI Task metadata 不决定日程完成度。
- `requirementsPanelOpen` 随 Requirements UI 一并从当前配置模型删除；读取旧配置时忽略该键不是 legacy compatibility layer。
- 标题、显示语言和地图分类颜色不改变 Place/Edge 身份，不能无故触发 geocode 或路线重算。

### 已知问题 / 风险

- 未启动真实应用，因此 MapLibre 图层、响应式布局、Codex 登录跳转和 WebSocket 重连仍需最终浏览器/端到端验证。
- MapLibre 动态 chunk 约 988 kB；当前已通过生产构建，架构文档没有要求为体积警告引入额外分块抽象，Phase 5 不扩展处理。
- `styles.css` 中仍有已删除 Requirements、旧候选/路线决策等无引用样式；它们不再有运行时入口，按 Phase 6 的引用搜索和 dead code 范围统一删除，避免本阶段扩成无边界样式清理。
- API 服务入口目前集中在单文件；本阶段没有为测试引入新 router 抽象，以避免偏离“删除复杂度优先”。真实 API 集成将在最终安全重置并启动新 Schema 后验证。
- `private_data/` 仍完全未接触；不得在 Phase 6 或测试期间提前启动会读取/创建真实数据库的服务。

### 验证结果

已执行：

```text
npm test -- apps/web/src/assistant-actions.test.ts apps/web/src/map-presentation.test.ts apps/web/src/itinerary-language.test.ts apps/web/src/map-interactions.test.ts apps/web/src/map-label-layout.test.ts apps/web/src/workspace-controls.test.ts apps/server/config.test.ts
npm run typecheck
npm run build
```

结果：7 个定向 Vitest 文件、16 个测试全部通过；全仓 web/server typecheck 通过；web/server 生产构建通过。验证没有启动真实服务，也没有读取或修改 `private_data/`。

### 下一阶段

Phase 5 已关闭。下一轮进入 Phase 6 — Legacy Cleanup；本轮停止，不提前执行。

下一阶段推荐模型：Terra High

## Phase 4 已完成内容

- 删除 legacy `MapCoordinator`、outline map projector、Map Patch/manifest/repair 服务端链路及其定向测试；没有保留兼容导出或手工地点选择入口。
- 重写 `map-service.ts` 为仅访问公开 Nominatim/OSRM 与公开缓存 SQLite 的 provider：地点候选和路线几何不会写入 canonical itinerary。
- 新增 `map-pipeline.ts`：从 canonical `Day.stops` 确定性派生 stable Visit/Edge；同一 Place 复用一个 `ResolvedPlace`，同一 Place 的相邻 Edge 仍保留且 geometry 为 null。
- 实现 local/en/zh 加 city、再加 region、countryCode 的稳定去重查询；国家与明显地点类型硬过滤；具名 65/15 自动选择阈值、确定性评分和同日邻近辅助分。
- 仅在候选仍歧义时启动短生命周期的 02 候选消歧线程。输入最多五个已过滤候选，输出再次限制为候选集合中的 providerPlaceId 或 null；没有地图 Agent、query rewrite、手工确认或 repair/retry 状态机。
- 无可靠精确候选时，城市/住宿可退化为可信城市中心 `approximate`；具体地点保持 `unresolved`，不伪造坐标。
- 路线缓存键为 `mode + coordinates + routing profile version`；已复用的 Edge 不重新请求。步行/骑行/驾车调用对应路线服务；飞行使用跨日期变更线安全的直连；公共交通、铁路和水路仅显示未实时核验的建议线。
- Planner 保存、每个 DetailBatch 保存、最终 detailed 切换、旅行标题更新和历史恢复都会触发 generation 绑定的地图同步。旧 generation 结果在写入前检查 token 与 canonical generation，不能覆盖新数据。
- 新增 `DerivedMapSnapshot` 合同，并通过 `travel.map.changed`（`syncing | ready | attention`）通知客户端重新读取 `/api/trips/:id/map`；不再广播 Map Patch。
- 保留 `MapTileCache`、认证、配置、Codex 受控只读线程、公开缓存和通用 AI Task 能力。未读取、修改、迁移、重置或删除 `private_data/`。

## Phase 4 关键修改文件

- `apps/server/contracts.ts`
- `apps/server/map-service.ts`
- `apps/server/map-pipeline.ts`
- `apps/server/map-pipeline.test.ts`
- `apps/server/index.ts`
- 删除：`apps/server/map-coordinator.ts`、`apps/server/outline-map-projector.ts`、对应 legacy 测试
- `docs/IMPLEMENTATION_STATUS.md`

## Phase 4 已执行测试 / 检查

- 完整重读架构文档、README、项目规则、实施状态、Git 状态/差异和最近相关提交；未读取 `private_data/`。
- 服务端引用搜索确认不再有 `MapPatch`、`MapCoordinator`、`OutlineMapProjector`、`MapAgentOutput`、`MapResolutionOutput`、手工候选或 manifest 调用链。
- `git diff --check` 通过；仅显示工作区既有 LF/CRLF 转换提示。
- 本阶段唯一轻量检查通过：`tsx --eval` 导入 map pipeline 与 contracts，验证空 itinerary 产生空图、Place 产生两个稳定查询。未启动服务、访问网络或打开真实数据库。
- 用户授权后执行 Phase 4 及其 generation 触发回归：

```text
npm test -- apps/server/map-pipeline.test.ts apps/server/detail-workflow.test.ts apps/server/planner-workflow.test.ts apps/server/travel-store.test.ts
```

首次尝试因工作区沙箱无法读取 Vitest 配置解析所需的父目录而在启动前失败；在相同命令、相同文件范围并获准读取该元数据后重试成功。结果：4 个测试文件通过，26 个测试全部通过，耗时约 0.73 秒。未运行 typecheck、build、Playwright、真实服务、真实 Codex 或真实地图 Provider。

## Phase 4 已知问题 / 风险

- 前端仍保留旧 `MapPatch`、map job 和 legacy `MapSnapshot` 消费代码；这是 Phase 5 的明确重写范围。当前服务端不再发送这些事件，因此不能在 Phase 4 宣称 UI 已完成。
- 02 的真实 app-server 通知顺序和实际 provider 返回尚未集成验证；候选运行超时、输出无效或生成过期都会安全降级为 unresolved/approximate，且不能写回旧 generation。
- `geoFingerprint` 以 local name、其次 English、最后中文作为地点身份名，避免只有显示语言变动时无故重新地理编码；地点类型、城市、区域、国家和 approximate 变化仍严格失效。
- public-data-cache SQLite 的现有瓦片缓存与新 geocode/route cache 共用同一公开缓存文件；未启动或检查该文件。它不保存 canonical itinerary 或凭据。
- 本轮尚未执行 typecheck/build；前端旧引用预期要到 Phase 5 才能消除，不能通过兼容层掩盖。

## Phase 4 Review 结论

Review 依据：架构文档第 3、8、9、11.2、13、16.3 和 17 节；逐行检查 `map-pipeline.ts`、`map-service.ts`、02 Prompt、`index.ts` 的触发/通知链路、map_state 持久化边界和现有 Phase 4 测试。

已确认正确：

- canonical itinerary 是地图唯一输入；Place 不写入坐标、候选或 provider ID。
- Visit/Edge 由 Stops 确定性派生，旧 Map Agent、manifest、patch、repair、手工候选 API 和专用事件在服务端已无引用。
- `placeId + geoFingerprint` 和 route key 复用已建立；写入同时检查 map token 与 canonical generation，旧结果不能覆盖新 generation。
- 02 输入已限制为一个 Place 和最多五个候选，输出经过 CandidateDecisionOutput Schema 并再次检查 providerPlaceId 属于候选集合。
- 飞行、重复地点、route provider 失败都保持可见，未写回 canonical itinerary。

必须修复的问题：

1. **高：02 实际仍获准实时网页搜索。** `index.ts` 的候选线程复用 `web_search: live` 和“允许实时网页检索”的 developer instructions，与 02 明确“不得搜索网页”和架构最小权限边界冲突。候选线程必须使用禁用 web search 的独立受控配置/指令，但不能新增 Agent 类型或业务状态。
2. **高：国家身份与精确候选安全不足。** `geoFingerprint` 在 countryCode 为空时完全忽略 `Place.country`，因此国家变化可错误复用旧坐标；同时 countryCode 为空时，候选国家未知也能通过过滤，并可能因“只剩一个”被标记 exact，违反“无法确认候选国家时不自动选择精确位置”。
3. **高：歧义候选交给 02 前没有按确定性分数排序。** 管线虽然计算评分，但 ambiguous 分支直接把跨查询插入顺序的前五项交给 02；更高分、后出现的候选可能被截掉，破坏“先评分，再把最多五个候选交给 02”的顺序。
4. **高：`transport mode=none` 被当成未核验公共交通/水路线。** 它会生成直线 geometry、`attention` 和“公共交通或水路”警告；明确无交通的边应保持可解释的 null geometry/ready，不得制造错误交通提示。
5. **中：复制旅行后不会自动生成地图。** duplicate API 创建带完整 itinerary 的新旅行，但没有触发 generation 0 地图同步；复制品在下一次 itinerary 修改前 `/map` 始终为空，与“地图自动同步”和复制后重新派生要求不符。
6. **中：HTTP route 失败缓存时间错误且会被快照无限复用。** 非 2xx 或 provider 返回无路线当前按成功路径缓存 7 天；随后同 route key 又从 map snapshot 永久复用 attention/null 结果，后续 generation 也不会重试。瞬时服务失败不能被当成长期成功 geometry 缓存。

测试缺口：现有 5 个 Phase 4 测试未覆盖国家为空/国家变化、歧义候选排序与 02 输入、mode=none、duplicate 初始同步、旧 generation 并发取代、route HTTP 失败 TTL。修复时应直接补入 `map-pipeline.test.ts` 和必要的 provider/API 边界测试。

## Phase 4 Review 修复已完成内容

- 02 候选消歧线程改用禁用 `web_search` 的独立受控配置和最小指令；它只能处理当前单个 Place 与已注入候选，不能搜索、读取文件、执行工具或访问其他旅行状态。
- `geoFingerprint` 在 `countryCode` 缺失时纳入规范化的 `Place.country`；候选缺少国家仍可供 02 判断，但绝不自动成为 exact。
- 02 前的候选现在总是按确定性分数和稳定 provider ID 排序，再仅发送前五项。
- `mode=none` 与同一 Place 的 Edge 都生成 geometry 为 `null` 的 ready 路线；前者不制造公共交通提示。旧 generation 的 attention 路线不再从快照永久复用，因此会重新请求 provider。
- 复制 API 在新旅行含 Day 时立即触发 generation 0 的确定性地图派生。
- OSRM HTTP/网络瞬态失败只缓存一小时；正常 provider 响应（包括明确无路线）继续采用七天缓存。
- 已补充地图管线回归：国家缺失身份、未知候选禁止 auto-exact、候选排序/前五、`mode=none` 与 attention 重试；另新增 `map-service.test.ts`，直接断言 HTTP 503 的缓存过期时间落在短失败 TTL 内。

## Phase 4 Review 修复验证结果

- `git diff --check` 通过；只有工作区既有 LF/CRLF 提示。
- 用户授权后执行：

```text
npm test -- apps/server/map-pipeline.test.ts apps/server/map-service.test.ts apps/server/detail-workflow.test.ts apps/server/planner-workflow.test.ts apps/server/travel-store.test.ts
```

首次启动前被沙箱拒绝读取 Vitest/esbuild 配置解析所需的父目录；在同一命令、同一文件范围获批重试后，5 个测试文件、30 个测试全部通过，耗时约 0.76 秒。修复 `TravelStore` 的两个 SQLite 参数类型收窄后，再次执行相同命令，仍为 5 文件、30 测试全部通过。
- 用户授权后执行 `npm run typecheck:server`，通过。其首次结果暴露 `TravelStore` 中两处来自 SQLite 查询 `unknown` 值直接传入 `.run()` 的类型错误；已仅用 `String(...)` 收窄 `id`、`trip_id`、`agent`，不改变 SQL、数据或存储策略，随后 typecheck 通过。
- 未运行 build、Playwright、真实服务、真实 Codex 或真实地图 Provider；未读取、修改、迁移、重置或删除 `private_data/`。
- duplicate 初始同步与 02 的 no-search 配置已作静态调用链复核；它们属于服务入口边界，后续 API 集成测试应覆盖，不能通过启动真实服务或访问 `private_data/` 验证。

## 下一阶段

Phase 5 — API + WebSocket + Frontend（仅在本次 Review 修复验证通过后开始）。

下一阶段推荐模型：Terra High

## Phase 2 已完成内容

- Prompt 体系只保留三个经过 prompt-id、prompt-version 和 SHA-256 校验的文件：`00-旅行规划Agent.md`、`01-行程细化Agent.md`、`02-地图候选消歧Agent.md`；旧地图标注、每日 repair、交通核验和路线修复 Prompt 已删除。
- `00` 已重写为 `PlannerOutput` 合同：planning 每轮一个必要问题、明确确认后才 `create_draft`、已有 itinerary 只返回最小 mutation、细化确认只返回 `start_detailing`。
- 新增 `planner-workflow.ts`：严格解析 Planner 输出；首次 draft 为 Place/Day/Stop 分配正式随机 ID 并重写引用；mutation 在内存中整体应用，任一失败即不写入。
- mutation 保存前执行 Day/Stop 规范化、精确日期连续化、日期/顺序/地点/方式的确定性核验失效、detailed Day 降级和无引用 Place 垃圾回收；随后以一次 `contentGeneration` CAS 写入并创建用户可见 draft/mutation revision。
- `index.ts` 已收敛为单一 Planner `/turns` 链路：持久化白名单消息历史最多约 48k 字符、canonical itinerary/generation 注入、同一线程恢复、一次同 Prompt 合同修正、15/30/60 秒瞬时服务重试、通用 AI Task/turn/trip WebSocket 事件和 generation 取代可见取消。
- 删除 requirements、outline、route decision、daily repair/stop/resume、交通核验、旧地图 AI/手工候选/重试 API 入口及其服务端调用链；`/api/trips/:id/map` 暂只读取 `map_state`，等待 Phase 4 的确定性派生管线。
- 新增 Planner workflow 与 Prompt contract 的定向测试文件，并已完成 Phase 1/2 关联测试验证。

## Phase 2 关键修改文件

- `prompts/00-旅行规划Agent.md`
- `prompts/01-行程细化Agent.md`
- `prompts/02-地图候选消歧Agent.md`
- `apps/server/prompt-contract.ts`
- `apps/server/planner-workflow.ts`
- `apps/server/index.ts`
- `apps/server/prompt-contract.test.ts`
- `apps/server/planner-workflow.test.ts`
- `docs/IMPLEMENTATION_STATUS.md`

## Phase 2 已执行测试 / 检查

- 只读引用搜索确认：新的 Planner 入口不再引用 RouteSkeleton、DetailDayPatch/Repair、TransportVerification、旧 outline/detail/map API 或旧 Prompt loader。
- `git diff --check` 通过。
- 轻量 `tsx --eval` 检查通过：加载三个新 Prompt、导入 Planner workflow，在系统临时目录创建新 v1 Store，并应用一条 planning `update_fields` mutation；结果为 3 个 Prompt、标题成功更新、generation 从 0 增至 1。
- 未读取、修改、删除或重置 `private_data/`。
- 用户授权后执行 Phase 1/2 定向 Vitest：

```text
npm test -- apps/server/prompt-contract.test.ts apps/server/planner-workflow.test.ts apps/server/location-contract.test.ts apps/server/travel-store.test.ts apps/server/trip-language.test.ts
```

结果：5 个测试文件通过，23 个测试全部通过；耗时约 0.78 秒。首次启动因工作区沙箱拒绝测试配置解析所需的父目录读取而未进入测试，随后在相同命令和相同文件范围内获批重试成功。
- 未执行 typecheck、build、Playwright 或真实服务启动。

## Phase 3 已完成内容

- 新增 `detail-workflow.ts`，由服务端按 canonical itinerary 中尚未完成的 `Day.detailLevel` 顺序选择每批两个 Day，最后一批允许一个 Day；批次 ID 和 dayIds 均由服务端决定。
- 01 批次只替换指定 Day：禁止修改日期、dayNumber、既有正式 Stop 的顺序及 Place 引用；允许新增 Place/Stop 临时 ID，由服务端统一分配随机 UUID 并原子重写引用。
- 每批严格校验 `DetailBatchOutput`、batchId/dayIds、baseGeneration、detailed Day 字段、正式 ID 所有权和完整 canonical itinerary；任一失败不写入，generation 过期返回 `CONTENT_GENERATION_SUPERSEDED`。
- 每批成功后原子保存当前 canonical itinerary、执行 Place 垃圾回收，并生成经过合同校验的 `DetailCanonicalFeedback`：正式 ID 映射、canonical Days、Place 变化、依赖失效摘要和新 generation。
- 同一 01 Codex 线程首轮只注入一次完整 canonical itinerary；后续轮次只注入上一批服务端实际保存的 canonical feedback 和下一批 dayIds。已回灌的临时 ID 在后续批次禁止再次使用。
- 中间批次不创建用户可见历史；全部 Day 完成时切换/保持 `stage=detailed`，并在同一最终写入中创建一条 `detail` 历史版本。已进入 detailed 生命周期后出现 draft Day 时可再次细化，整体 stage 不回退。
- 01 使用现有通用 AI Task：metadata 只保存 baseline generation、全部 dayIds、从 canonical 重新计算的 completed dayIds 和当前 batch ID；它不作为旅行阶段或第二事实来源。
- 同一旅行的 00/01 写任务串行；细化运行期间聊天被拒绝。用户停止时保留已成功批次、丢弃当前未完成批次；再次确认时创建新线程并从 canonical `Day.detailLevel` 重新计算剩余日期。
- 应用重启时不恢复旧 Codex 线程；Store 把遗留 starting/running/waiting/reconnecting 通用任务和活动 turn 标记为 stopped/interrupted，保留 canonical itinerary 供下一次确认恢复。
- 01 合同错误只用同一 Prompt 定向重试一次；瞬时服务错误沿用 15/30/60 秒最多三次退避；旧 generation、重复/乱序 turn 和停止竞态不能覆盖或复活任务。
- 00/01 Prompt 版本已递增，并明确 detailed 生命周期中 draft Day 的再次细化，以及 canonical feedback 后只能使用正式 ID。

## Phase 3 关键修改文件

- `apps/server/detail-workflow.ts`
- `apps/server/detail-workflow.test.ts`
- `apps/server/index.ts`
- `apps/server/planner-workflow.ts`
- `apps/server/planner-workflow.test.ts`
- `apps/server/travel-store.ts`
- `apps/server/travel-store.test.ts`
- `apps/server/ai-task-monitor.ts`
- `apps/server/prompt-contract.ts`
- `prompts/00-旅行规划Agent.md`
- `prompts/01-行程细化Agent.md`
- `docs/IMPLEMENTATION_STATUS.md`

## Phase 3 已执行测试 / 检查

- 完整重读架构文档、README、项目规则、实施状态、Git 状态/差异和最近相关提交；未读取或接触 `private_data/`。
- 只读引用检查确认服务入口没有重新引入 daily patch/repair、partial/detailing 业务 stage、独立 detail API 或旧地图细化链路。
- `git diff --check` 通过；仅显示工作区既有 LF/CRLF 转换提示。
- 本阶段唯一轻量检查通过：导入 Detail workflow、加载全部三个 Prompt 合同、验证服务入口 TypeScript 语法转译无诊断，并确认剩余 Day 按 itinerary 顺序组成两日批次。
- 用户授权后执行 Phase 1–3 定向 Vitest：

```text
npm test -- apps/server/detail-workflow.test.ts apps/server/planner-workflow.test.ts apps/server/prompt-contract.test.ts apps/server/location-contract.test.ts apps/server/travel-store.test.ts apps/server/trip-language.test.ts
```

首次测试实际进入用例后为 30/31 通过；唯一失败的测试夹具把“只改中文显示名且当地名不变”误当成地点身份变化，与架构的显示语言不失效规则冲突，并因断言提前退出连带产生临时 SQLite 文件锁。把夹具改为真实城市变化后，在相同命令和文件范围内重跑，结果为 6 个测试文件、31 个测试全部通过，耗时约 0.76 秒。
- 未执行 typecheck、build、Playwright、真实服务或真实 Codex 线程。

## Phase 3 已知问题 / 风险

- Phase 4 前每个成功细化批次只广播 canonical trip 更新，尚不能执行架构要求的即时地图差异同步；不得临时接回旧 MapCoordinator。
- 真实 Codex app-server 的多轮通知顺序、interrupt 和瞬时断线尚未做集成验证；当前通过 generation、attempt token、turn ID 去重和 canonical CAS 防止错误落库。
- 旧 `map-coordinator.ts`、`map-service.ts`、outline projector 及其 legacy 类型仍留在仓库，等待 Phase 4 重写及 Phase 6 引用清理；它们未被新 `index.ts` 调用。
- 服务端 typecheck 仍可能报告这些尚未迁移的旧地图消费者；不得添加兼容合同掩盖，应该在 Phase 4/6 删除或重写真实引用。
- 当前真实数据库仍未检查、迁移、重置或启动；`private_data/` 继续保持完全未接触状态。

## Phase 3 定向验证结果

已执行以下定向 Vitest，覆盖 Phase 1–3 合同、Store、Planner 和两日细化回归：

```text
npm test -- apps/server/detail-workflow.test.ts apps/server/planner-workflow.test.ts apps/server/prompt-contract.test.ts apps/server/location-contract.test.ts apps/server/travel-store.test.ts apps/server/trip-language.test.ts
```

最终结果：6 个测试文件通过，31 个测试全部通过。

暂不建议在 Phase 4/6 旧地图消费者清理前运行全仓 typecheck/build；若现在运行，预期会混入尚未迁移模块的 legacy 引用错误，不能通过兼容层修复。

## Phase 4 再验收（2026-08-24）

### 已完成内容

- 重新完整读取唯一架构文档、本状态文件、README，并检查当前 `git status`、`git diff` 与最近相关提交；Phase 5 的现有半成品修改保持原样，没有回退或覆盖。
- 重新逐项审查 `map-pipeline.ts`、`map-service.ts`、地图合同/Store 边界、02 Prompt、`index.ts` 的候选线程与同步触发、现有地图测试和 legacy 服务端引用。
- 确认 canonical itinerary 仍是地图唯一输入；ResolvedPlace/map_state 只保存派生状态；Visit/Edge、query、候选评分、路线键和 generation 防陈旧写入均由确定性代码完成。
- 修复单一候选的可信度漏洞：硬过滤后只剩一个候选时也必须达到既有 `AUTO_SELECT_MIN_SCORE=65`，不能仅因数量为一就写成 `exact`。
- 当目标 Place 缺少 `countryCode` 时，代码不再自动选择 exact；候选转入 02，由有限上下文消歧或安全降级。
- 修复 02 返回值边界：服务端只接受实际注入 02 的排序后前五项，不再错误地在全部 provider 候选中接受未注入 ID。
- 02 输入补齐已有 Place 的 `country` 与 `approximate` 字段；仍不提供网页搜索、文件、Shell、MCP、其他旅行状态或新增 query 能力。
- 补充/收紧回归用例：低分单候选、缺少目标 countryCode、未注入候选 ID、非地图 generation 不重新 geocode，以及旧 generation 网络结果不能覆盖新快照。

### 关键修改文件

- `apps/server/map-pipeline.ts`
- `apps/server/map-pipeline.test.ts`
- `apps/server/index.ts`
- `docs/IMPLEMENTATION_STATUS.md`

### 已执行测试 / 检查

- `git diff --check` 通过；只有工作区既有 LF/CRLF 转换提示。
- 服务端引用搜索未发现旧 MapCoordinator、OutlineMapProjector、MapPatch、MapAgentOutput、MapResolutionOutput、手工候选 API 或旧地图专用事件的有效调用链。
- 本轮唯一轻量运行检查通过：导入当前 map pipeline，确认低分单候选和缺少目标 `countryCode` 的候选都不会被自动标为 exact。
- 首次轻量命令因 Windows `.cmd` 参数引用在模块执行前转译失败；改用同一本地 tsx CLI 直接执行后通过。这不是业务代码或测试失败。
- 用户授权后执行 Phase 4 定向 Vitest。首次启动因沙箱无法读取 Vitest/esbuild 配置解析所需的父目录元数据而未进入测试；按授权在相同命令和相同文件范围内重试后，5 个测试文件、31 个测试全部通过，耗时约 0.89 秒：

```text
npm test -- apps/server/map-pipeline.test.ts apps/server/map-service.test.ts apps/server/detail-workflow.test.ts apps/server/planner-workflow.test.ts apps/server/travel-store.test.ts
```

- 用户授权后执行 `npm run typecheck:server`，通过。
- 未运行 build、Playwright、真实服务、真实 Codex 或真实地图 Provider。
- 未读取、修改、迁移、重置或删除 `private_data/`。

### 已确认架构决策

- “过滤后只有一个可信候选”中的“可信”不是仅指数量为一；仍须满足架构已规定的确定性分数阈值。
- 02 的服务端二次校验集合必须等于实际注入模型的最多五个候选，而不是 provider 返回的完整候选集合。
- 没有目标 `countryCode` 时，确定性代码无法证明国家一致，不自动写入 exact；这不是新增状态或额外 Agent。

### 已知问题 / 风险

- duplicate API 初始地图同步和 02 禁用网页搜索仍是静态入口复核；当前没有可在不启动真实服务/数据库的独立 API 集成测试。
- 真实 Nominatim/OSRM 与真实 02 Codex 通知顺序仍未做集成验证；失败路径会保留最后合法 canonical itinerary，并把地图标为 attention/unresolved，而不会伪成功。
- Phase 5 前端改写仍处于半完成状态；本轮没有推进、回退或验收 Phase 5，也没有进入 Phase 6。

### 下一阶段

Phase 4 验收已关闭。下一轮恢复 Phase 5 — API + WebSocket + Frontend；不得直接进入 Phase 6。

下一阶段推荐模型：Terra High

## Phase 7 最终 Review（2026-08-24）

### 已完成内容

- 按固定交接流程重新完整读取 README、1158 行唯一架构文档、本状态文件，并检查干净的 Phase 6 基线、`git status`、`git diff` 和最近相关提交；未读取或接触 `private_data/`。
- 以架构第 16、17 节和用户最终 Review 清单逐项复核 contracts、TravelStore、Planner、两日细化、Prompt、地图派生、API、WebSocket、前端、测试和遗留引用。
- 确认运行时只有一份 canonical `itinerary:v1`；业务阶段只来自 itinerary 的 `planning | draft | detailed`，Day 完成度只来自 `detailLevel`/可选 `detailStatus`；Store 中的 revision、AI Task metadata 和 map_state 分别只是历史、操作恢复与派生状态。
- 确认只保留 00/01 两个核心 Prompt 和短 02 候选消歧 Prompt；没有恢复 Patch、Repair、Requirements、RouteSkeleton、TripPlan、Map Agent、手工候选、独立细化 API 或额外业务 stage。
- 修复 detailed 生命周期约束：首次进入 detailed 仍只能由全部 Day 完成触发；进入生命周期后，即使后续修改使全部 Day 需要重新细化，stage 也不回退。删除了不可能从当前聊天链路到达的第二套“最终完成”写入函数，最终 revision 仍只由最后一个成功 DetailBatch 原子创建。
- 修复 Planner 依赖失效：日期变化现在只把日期相关 verification 设为 `unverified`，保留仍可复用的时间/时长内容，并把已细化 Day 标记为 `needs_review`；不再因日期变化机械删除交通时长。
- 补上 Planner 对 Place 身份字段/全名称身份变化的确定性失效：只清理连接该 Place 的入站/出站交通及相关 schedule/cost verification，不影响无关 Day；仅修改仍有稳定 local/English 身份的中文显示名不会触发失效。
- Stop 跨 Day 移动时补充日期相关 verification 失效；新创建的 Stop/Day 不再因为“此前不存在”而被当作旧路线事实清空。
- 每个成功 01 批次由服务端把 canonical Day 的 `detailStatus` 设为 `ready`，不让模型决定操作完成度；临时 ID 映射、canonical Days/Places、失效摘要和 generation 回灌链保持不变。
- 修复同一旅行 Planner 写入串行化窗口：用户消息和 AI Task 创建后立即登记 pending run，再异步创建/恢复 Codex 线程；并发 `/turns` 不能在等待线程期间同时通过。停止或失败也不能让 pending run 在异步返回后复活。
- Planner 的允许列表对话历史现在排除单独注入的当前用户消息，避免同一消息同时出现在 `userMessage` 和 `messageHistory`。
- 收紧地图 approximate 降级：城市/住宿区域中心必须使用确定性构造的 center Place、已确认 countryCode 和既有 65 分可信阈值；不再因只有一个低分候选就写入 approximate 坐标。
- 删除仅被测试引用、当前 UI 完全未使用的旧 `DayPathRole`/`labelRole` 代码与测试，以及已由 App/MapPanel 当前实现取代的 `workspace-controls.ts` 和测试；未删除认证、配置、缓存、语言、地图交互或版本历史能力。

### 关键修改文件

- `apps/server/contracts.ts`
- `apps/server/planner-workflow.ts`
- `apps/server/detail-workflow.ts`
- `apps/server/map-pipeline.ts`
- `apps/server/index.ts`
- `apps/server/location-contract.test.ts`
- `apps/server/planner-workflow.test.ts`
- `apps/server/detail-workflow.test.ts`
- `apps/server/map-pipeline.test.ts`
- `apps/web/src/map-label-layout.ts`
- `apps/web/src/map-label-layout.test.ts`
- 已删除：`apps/web/src/workspace-controls.ts`、`apps/web/src/workspace-controls.test.ts`
- `docs/IMPLEMENTATION_STATUS.md`

### 已执行测试 / 检查

- 全仓运行时引用搜索确认旧 DayPath、Requirements、Skeleton、TripPlan、Detail/Map Patch、Repair、MapCoordinator、Outline projector、旧 API 和旧状态名没有有效调用链；旧术语剩余匹配只有 Prompt 禁止性约束、实施历史或 TypeScript 的 `Partial<T>`/测试局部变量。
- Prompt 文件数量和名称确认严格为 00、01、02 三个；WebSocket 广播确认严格为 `travel.turn.updated`、`travel.trip.updated`、`ai-task.updated`、`travel.map.changed` 四类。
- `git diff --check` 通过；只有工作区 LF/CRLF 转换提示。
- 本阶段唯一轻量运行检查通过：用本地 TypeScript 转译器检查 11 个本阶段修改的 TS/TSX 源码和测试文件，syntax diagnostics 为 0。
- 用户授权后执行完整 Vitest：18 个测试文件、81 个测试全部通过，耗时 7.17 秒。首次沙箱运行仅因 esbuild 无权读取配置解析所需的父目录元数据而未启动测试；按同一授权范围受控重试后通过。
- 用户授权后执行 `npm run typecheck`：Web 与 Server 全仓 TypeScript 检查全部通过。
- 用户授权后执行 `npm run build`：Web 生产构建与 Server TypeScript 编译全部通过；Vite 转换 1754 个模块，Web 构建耗时 15.51 秒。首次沙箱运行同样在加载配置前被父目录元数据权限阻止，受控重试后通过。
- 未执行 Playwright、真实服务、真实 Codex、真实地图 Provider 或端到端验收。
- 未读取、修改、迁移、重置或删除 `private_data/`。

### 新增/收紧的回归覆盖

- detailed 生命周期在所有 Day 后续都变为 draft/needs_review 时不回退 stage。
- 日期变化使 verification 失效但保留交通/停留时长，并标记 Day 需要复核。
- Place 显示名修正不失效；Place 身份变化只失效连接边和相关 Day，无关 detailed Day 保持不变。
- 每个 DetailBatch 的 canonical feedback 中 Day completion 由服务端确定为 `ready`。
- 低可信单候选不能进入 approximate；可信且国家已确认的住宿城市中心可以安全 approximate。

### 已确认架构决策

- `detailed` 是进入后不回退的生命周期；“所有 Day detailed”只决定首次进入和再次全部完成时的历史版本，不要求生命周期中始终至少保留一个 detailed Day。
- 日期相关事实失效的核心是 verification 失效，不是删除用户已确认或仍可复用的时间/时长内容；坐标和同端点/同方式路线继续复用。
- `detailStatus` 是由服务端确定的 UI/恢复辅助：成功 01 批次为 `ready`，确定性依赖失效可设为 `needs_review`；它不是第四业务 stage。
- approximate 仍必须是可信城市/区域中心；“只有一个候选”不等于可信，也不能绕过 countryCode 和既有分数阈值。
- 同一旅行的写入串行化必须在任何异步线程创建/恢复之前生效；generation CAS 继续作为最终陈旧结果保护，但不能代替运行中任务互斥。

### 已知问题 / 风险

- 服务入口仍是启动即打开受控数据库的单文件，因此没有在不触碰真实 `private_data` 的前提下运行 HTTP/WebSocket 集成测试；Planner pending 互斥、duplicate 初始地图同步和 02 no-search 已作逐行静态调用链复核。
- 未运行真实浏览器、Codex app-server、Nominatim/OSRM 或 Playwright；这些必须在 Phase 7 验证通过并按架构第 10.3 节单独安全重置 `private_data` 后执行。
- MapLibre 动态 chunk 的既有约 988 kB 警告不是架构正确性问题；不为该提示增加新抽象。

### 最终验证结果

1. `npm test`：通过，18 个测试文件、81 个测试全部成功。
2. `npm run typecheck`：通过，Web 与 Server 均无类型错误。
3. `npm run build`：通过，Web 与 Server 均成功；仅保留既有 MapLibre 大分块提示。

### 下一阶段

Phase 7 已关闭。下一步不是继续业务重构，而是按架构第 10.3 节作为单独步骤执行 `private_data` realpath + 非 symlink + sentinel 三重保护检查；任何条件不能确认都停止删除。之后才启动新 Schema 并做真实端到端验收。本阶段没有执行该步骤。

下一阶段推荐模型：GPT-5.6 Sol High（安全重置与端到端验收）

## Phase 7 Follow-up — 地图定位缺陷修复（2026-08-24）

### 已完成内容

- 对用户当前行程及公开地图缓存进行了只读诊断；没有写入、重算或复制 canonical itinerary、`map_state`、聊天、凭据或用户旅行内容到仓库。
- 确认大量 unresolved 的共同原因是确定性 query 重复地点名/城市名、Provider 完整地址无法命中短名称精确评分、Unicode 变音符未折叠，以及同一物理候选因不同 provider ID 形成虚假并列。
- query builder 保持架构规定的 local/en/zh 与 city/region 顺序，但会消除规范化后重复的名称/区域组件，并追加不改写地点身份的 `name + countryCode` 回退。
- 地理文本改为 NFKD 并移除组合音标；国家和地点类型硬过滤、65 分最低阈值及 15 分领先阈值保持不变。
- `MapCandidate` 保存 Provider 短名称，完整 `displayName` 只作为地址/包含匹配和 02 上下文；公开 geocode cache 合同升级为 v4，旧 v3 缓存保留但不再命中。
- 相同国家、规范化短名称、类型和六位坐标的候选在评分前确定性合并；邻近但不同坐标的实体不会合并。
- 每个确定性 query 返回后立即尝试可信自动选择，成功即停止后续查询；全部 query 后仍真实歧义时才把去重排序后的最多五项交给既有 02。
- 地理指纹当前为 `MAP_RESOLUTION_VERSION=v3`；不修改 itinerary、ResolvedPlace/MapState Schema 或数据库迁移。下次 canonical 保存触发地图同步时，旧解析结果将按派生缓存规则重新生成。
- 按用户选择，本轮不修改或立即重算当前行程的 `map_state`，也不新增重试 UI、HTTP API、地图 Agent、手工选点或兼容层。

### 关键修改文件

- `apps/server/map-service.ts`
- `apps/server/map-pipeline.ts`
- `apps/server/index.ts`
- `apps/server/map-service.test.ts`
- `apps/server/map-pipeline.test.ts`
- `docs/IMPLEMENTATION_STATUS.md`

### 新增/收紧的回归覆盖

- 消除 `name == city` 重复 query，并保留确定性裸名称回退顺序。
- 使用真实 Nominatim 形态的短名称与完整地址，验证名称评分和 v4 缓存合同。
- Unicode 变音符等价匹配、同物理候选去重及邻近不同实体不误合并。
- 首个可信确定性候选立即停止 query 且不调用 02；真实歧义继续受限进入 02。
- 旧 resolver fingerprint 在下一次地图同步时失效，当前版本 exact/approximate 继续按指纹复用。

### 已执行测试 / 检查

- 轻量语法检查通过：用本地 TypeScript 转译器检查 5 个修改的服务端源码/测试文件，syntax diagnostics 为 0。
- 用户授权后执行地图定向 Vitest：首次沙箱启动因 esbuild 无权读取配置解析所需的父目录元数据而未进入测试；按相同命令范围受控重试后实际运行，首次发现并修复了自动选择未防御性去重、以及完整地址中的城市名造成错误包含加分两项边界。相同测试范围最终为 2 个测试文件、16 个测试全部通过，耗时 1.28 秒：

```text
npm test -- apps/server/map-pipeline.test.ts apps/server/map-service.test.ts
```

- 用户授权后执行 `npm run typecheck:server`，通过。
- 尚未执行全量 Vitest、Web typecheck 或生产 build。
- 未启动真实服务、Codex、Nominatim/OSRM 或浏览器端到端流程。
- 本轮没有写入或修改 `private_data/`。

### 已知问题 / 风险

- 当前已持久化地图快照按用户选择保持原样；只有下一次 canonical 行程保存触发地图同步后才会采用 v3 解析指纹和 v4 geocode 缓存。
- Provider 实时结果仍可能使少数真正歧义或不存在的具体地点安全降级为 approximate/unresolved；不会为追求全定位而放宽国家或类型硬过滤。

### 下一阶段

地图定向 Vitest 与服务端 typecheck 已通过。下一步建议执行全量 Vitest、全仓 typecheck 和生产 build，再进行真实地图同步验收。

下一阶段推荐模型：GPT-5.6 Sol High（地图修复验证与端到端复核）

## Phase 7 Follow-up — 地图展示与港口回退修复（2026-08-25）

### 已完成内容

- 确认地点标签重复日号来自同一 Place 在同一天被多个 Stop 引用；marker 仍保留全部 Visit，但标签改为按首次出现顺序显示唯一 Day。
- 保持港口精确候选的严格类型过滤；仅当 `port` 的中文名称与 `city` 相同时，才允许使用本地名/英文名解析同名城镇中心，并明确保存为 approximate。
- resolver fingerprint 升级为 v3；不修改 itinerary 或数据库 Schema，旧地图派生结果只会在下一次 canonical 保存触发同步时失效。
- 地点与路线警告改用可读名称并去重，不再向界面暴露内部 Place ID；渡轮继续显示直线建议连线和未核验警告。
- 前端将普通路线与 flight/ferry 分为共享数据源的实线和虚线图层，两个图层共用颜色、按天筛选和悬停交互。
- 旅行规划 Prompt 升级为 v6，明确聚落实体不能因港口活动被标成 `port`，具体码头才使用独立港口 Place。
- 按用户选择，本轮不重算或写入当前 `private_data` 中的 map_state。

### 验证状态

- 已补充服务端港口回退/友好警告/渡轮几何、前端日期去重/路线分层及 Prompt v6 合同的定向测试。
- 本轮测试、typecheck 与 build 尚未执行，等待用户按项目验证规则授权。

## Phase 7 Follow-up — 国家公园定位改进（2026-08-25）

### 已完成内容

- 只读确认 Nominatim 已为奥拉基/库克山国家公园和汤加里罗国家公园返回名称及国家完全匹配的候选，但 Provider 将两者表达为 `boundary/protected_area`，旧 attraction 类型硬过滤在评分和 02 消歧前错误丢弃了候选。
- 国家代码继续硬校验；同国家且 Provider 短名称与 Place 的中文、当地或英文名称之一规范化后精确一致时，不再由 category/type 否决，包括此前只能回退为 approximate 的同名港城候选。非精确名称仍受既有类型兼容规则约束，类型继续参与同名候选排序；具体码头名称仍不能由不同名城镇候选冒充。
- 唯一物理同名候选可确定性采用；多个同名实体仍需要既有分数领先阈值，否则进入受控 02 消歧。
- resolver fingerprint 升级为 v4；unresolved 结果不再跨同步复用。下一次 canonical 行程保存触发地图同步时会重新解析旧失败地点，当前 `private_data` 未被写入或重算。
- 不修改 Place、ResolvedPlace、MapState、数据库 Schema、API、前端、Prompt 或国家公园作为出发/结束端点的现有语义；渡轮直线和未实时核验提示保持不变。

### 验证状态

- 已补充同国家精确名称越过类型不匹配、跨国同名拒绝、非精确错误类型拒绝、多同名歧义、两个真实国家公园候选端到端解析、v3 unresolved 失效及当前指纹 unresolved 重试覆盖。
- 用户授权后执行 `npm test -- apps/server/map-pipeline.test.ts`：沙箱内首次因 esbuild 无权读取配置解析所需的父目录元数据而未启动，按相同范围受控重试后实际运行。首次运行发现上一轮“同名港城只能 approximate”的旧预期与本轮名称优先规则冲突；按已确认规则改为 exact，同时保留具体码头不得由不同名城镇冒充的负例。最终 1 个测试文件、18 个测试全部通过，耗时 792 ms。
- 用户授权后执行 `npm run typecheck:server`：首次发现上一轮渡轮测试对 `state.map` 缺少测试侧结构收窄，补齐后服务端 TypeScript 检查通过；未修改生产 Schema。
- 尚未执行全量 Vitest、Web typecheck、生产 build、真实 Nominatim/OSRM 或浏览器端到端验收。

## Phase 7 Follow-up — 聊天快捷按钮互斥修复（2026-08-25）

### 已完成内容

- 只读确认新西兰初稿回复同时持久化了 `nextAction="start_detail"` 和复述相同动作的 `suggestion`，导致界面同时显示“开始细化方案”与“采用 / 不采用”。
- 前端对历史重叠 reply 优先显示阶段动作；PlannerOutput v1 字段形状保持不变，但新输出增加 `nextAction` 与 `suggestion` 互斥校验，违规输出进入既有一次合同修正流程。
- Planner Prompt 升级为 v7；suggestion 仅允许表示尚未执行的具体可选行程变更，不得复述阶段动作、进度、核验提醒或一般说明。
- 不修改或迁移历史消息、canonical itinerary、数据库 Schema 或其他 `private_data`。

### 验证状态

- 已补充历史重叠回复 UI 降级、合法独立按钮模式、服务端互斥合同及 Prompt v7 合同覆盖。
- 用户授权后执行 3 个定向 Vitest 文件：沙箱内首次因 esbuild 无权读取配置解析所需的父目录元数据而未启动，按相同范围受控重试后 3 个文件、13 个测试全部通过，耗时 5.04 秒。
- 用户授权后执行 `npm run typecheck`，Web 与 Server TypeScript 检查全部通过。
- 尚未执行全量 Vitest、生产 build 或真实浏览器/Codex 端到端验收。
