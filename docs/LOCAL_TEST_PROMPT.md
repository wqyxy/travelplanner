# TravelPlanner staged v3 本地验收提示词

> 用途：把下面整段提示词交给本地 Codex。  
> 默认模式：**只测试、只记录，不修改代码，不提交。**  
> 当前专项标准：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`。  
> 产品基础标准：`docs/PRODUCT_PLAN.md` 与 `docs/AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md` 的非冲突部分。  
> 当前实现说明：`docs/IMPLEMENTATION_STATUS.md`。  
> 数据策略：fresh v3 database，绝不迁移旧 v2。

```text
你正在对 TravelPlanner staged v3 做本地验收。

先读取：
1. AGENTS.md
2. README.md
3. docs/README.md
4. docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md
5. docs/PRODUCT_PLAN.md
6. docs/AI_LED_PLACE_DISCOVERY_AND_RESOLUTION.md
7. docs/IMPLEMENTATION_STATUS.md
8. package.json
9. 当前 git status / git diff / git log -10

本任务只测试和报告，不修复代码，不修改源码、Prompt、文档、数据库 Schema、配置或 Git 历史，不提交，不 push。

数据安全规则：
- 不读取、修改、迁移或删除旧 private_data/travel.sqlite3。
- 不自动删除、移动、覆盖或迁移现有 private_data/travel-v2.sqlite3。
- 当前 staged v3 要求该固定路径不存在，或已经是完整 PRAGMA user_version=3 数据库。
- 如果该路径仍存在旧 version 2 / 未知 / 损坏数据库，应验证启动 fail closed，然后停止真实 Smoke，报告需要用户明确决定是否人工备份/移走旧库。
- 自动化数据库测试只使用临时目录。
- 不打印 Cookie、Token、密码、Codex 凭据、Prompt 全文或旅行私人数据。

按以下顺序执行。

# A. 环境与 Git 基线

记录：
- 当前 commit SHA；
- git status / git diff；
- Node / npm 版本；
- 操作系统；
- 是否存在未提交修改；
- private_data 只列文件名、大小和 SQLite user_version（不要读取业务内容）。

要求 Node.js >= 24。环境不满足时停止后续运行，只报告阻断项。

# B. 静态、类型与构建

依次运行并记录退出码与错误摘要：
- git diff --check
- npm run typecheck
- npm run build

确认最终活动入口：
- package.json dev/dev:server 指向 apps/server/index-cutover-v3.ts；
- package.json start 指向 dist/server/index-cutover-v3.js；
- run.cmd / run.ps1 / run.command 也指向 index-cutover-v3.js；
- apps/web/src/main.tsx 渲染 AppV3 并加载 stage-ai-v3.css；
- 不存在旧 00–03 Prompt；
- prompts/ 只包含 shared / dialogues / actions 注册结构。

# C. 自动化测试

运行：
- npm test

重点确认以下测试或代码边界通过：
1. ConversationStage 只有 requirements / destinations / interests / itinerary，且不接受 canonical TripStage 值。
2. canonical TravelPlanDocument.schemaVersion 仍为 2；TripStage 仍为 place_selection / itinerary_planning / itinerary_refinement。
3. PlaceKind 没有 region / island / area；Macro 仍统一 kind=city。
4. Prompt Registry 显式注册所有新 Prompt，缺失、额外、重复、空 Prompt 会失败。
5. deterministic Action 没有 Prompt / reasoning / web 配置。
6. Stage Dialogue structured-output schema 是 closed schema，不存在自由 additionalProperties；parameters 不接受未注册键。
7. Dialogue 普通首轮 web=disabled、effort=none、summary=none；协议不支持时允许服务端安全降级。
8. web_required 第一轮不保存未经核验最终回答；第二次 live web 后才持久化 WebDialogueOutput 和 verification。
9. 同一 trip + stage 的并发 turn 被拒绝/串行化，不同 stage 消息互不混用。
10. Stage thread 分 stage 保存，Prompt hash/version/turn 上限可轮换；canonical generation 变化后旧 Stage thread 被清除。
11. fresh 空 DB 创建完整 user_version=3；v2/未知/损坏 DB fail closed，不迁移、不删除、不重建。
12. ai_actions confirm 使用原子条件更新，重复 confirm/CTA requestKey 不重复启动任务。
13. deterministic Action 成功最终状态为 applied；AI save-result 为 completed；AI mutation 进入 awaiting_apply，Apply 后为 applied。
14. duplicate 只复制 canonical plan，不复制 Message、Stage Thread、Action、Task 或 Proposal。
15. itinerary active AI output contract 不包含 newPlaces / newCandidates；需要新地点返回 requiresStage=interests。
16. itinerary.refine 生成 Proposal，不直接覆盖 Day。
17. Place Resolver、Route Provider、Proposal Scope、generation CAS、Candidate-first 主链仍工作。
18. AI 不输出可信坐标、Provider Place ID、route geometry、Provider 距离/时长。

如果现有自动化没有覆盖某项，只标记“缺少自动化覆盖”，不要现场补测试。

# D. 启动 / 数据库 Cutover Smoke

只有在用户已经明确准备好一个 fresh v3 数据库路径后执行。

先验证旧库保护：
- 使用临时 version 2 数据库启动 index-cutover-v3，应在监听 HTTP 前 fail closed；
- 数据库 user_version 和内容不得被修改。

然后使用临时空目录或用户已确认的 fresh 路径：
- 启动 npm run dev；
- 确认 strict Prompt Registry 成功；
- 确认创建完整 v3 DB；
- 确认 runtime invariant triggers 已存在；
- 打开浏览器并完成首次本机账号设置；
- 确认登录、退出、重新登录；
- 确认页面无 React 致命错误或持续网络失败。

# E. 四阶段 UI 与唯一入口

新建旅行后验证：
- 默认 requirements；
- 右侧工作区是唯一 AI 输入入口；地图没有第二套 AI 输入；
- 四个阶段依次为 需求 / 目的地 / 兴趣点 / 行程；
- 每个阶段的助手标题、边界提示、消息历史、未发送草稿独立；
- 不存在旧“对话 / 调整”双模式；
- 切换 stage 不修改 canonical TripStage；
- 主 CTA 点击本身即确认，不再弹重复确认卡；
- 聊天识别出的 Action 显示在对应消息下，必须用户确认才执行；
- CTA Action 显示在当前阶段任务区；
- Proposal 显示 diff，可 Apply / Reject；已 Apply 且无后续写入时可 Undo。

# F. Requirements Dialogue

输入：
“新西兰 20 天自驾，两大一小，节奏不要太赶，喜欢自然风景。”

验证：
- 普通 Dialogue 本身不直接修改 TripFacts；
- 如果识别为 requirements.update，先产生 pending_confirmation Action Card；
- 确认后才由 deterministic executor 更新 canonical；
- deterministic executor 不启动 AI Action Task；
- 成功后 Action 状态为 applied；
- 重复 confirm 不再次增加 generation；
- 询问当前天气/交通等动态信息时，第一轮只触发 web_required，再由第二轮联网回答。

# G. Destination 阶段

点击“生成目的地建议”：
- 点击本身就是确认；
- destination.generate 使用 AI Action、medium reasoning、required web；
- 输出只生成 Macro Candidate，后台全部 kind=city；
- UI 文案可自然显示城市/区域/岛屿/独立停留地语义；
- 不生成 Micro、Day、坐标或路线；
- 新结果通过 Schema/generation 校验后进入 Candidate Pool；
- preference 默认 optional；
- AI 推荐度为 0–100，不标成地图评分。

聊天测试：
- “把陶波删掉” → destination.remove deterministic Action，确认前不删，确认后级联按现有 PlanCommand 规则执行；
- “罗托鲁瓦替换陶波” → destination.replace AI Proposal，Apply 前 canonical 不变；
- preference / 明确字段编辑 → deterministic，不重复调用 AI。

# H. Interest 阶段与定位

从有效 Macro 生成/补充兴趣点：
- AI 每个 Macro 自主决定 0–9 个，不固定补齐 3/5/7/9，也不为凑数生成低价值地点；
- 允许所有现有非 city Place kind；
- 推荐结果先进入 Candidate Pool，再由地图 Provider best-effort 定位；
- 地图定位失败时 Candidate 仍保留并显示 unresolved，不触发补位或整批失败；
- AI 不返回坐标或 Provider ID；
- Provider category/placeType/city/region 只是弱参考，不做代码硬过滤；
- 地图消歧 AI 只能从服务端有限候选中 choose / retry hints / unresolved。

聊天测试：
- discover / supplement 对话 Action 一次只明确一个 Macro target；
- remove / preference / 明确编辑是 deterministic；
- add / replace 是 AI Proposal；
- Action/Proposal 不得越过目标 Macro Scope。

# I. Itinerary 阶段

点击“生成行程与路线”：
- itinerary.generate 使用现有 Candidate/Place/Resolution；
- 不允许输出或保存 newPlaces/newCandidates；
- 若确实需要新地点，返回 requiresStage=interests，不偷偷新增；
- 首次成功生成 Day 后 canonical TripStage 进入既有 itinerary_planning 语义；
- Route Provider 在保存后负责真实路线；AI 不伪造路线事实。

验证确定性编辑：
- Stop add/remove/replace/move；
- Day reorder；
- Anchor set；
- 明确 Day/Stop 字段 edit；
这些精确操作不调用 AI，并保留 generation CAS / Route Dirty / Resolution 规则。

验证 AI 修改：
- itinerary.replan → Proposal；
- itinerary.day.optimize → Proposal；
- itinerary.repair → Proposal；
- itinerary.verify → live web + Proposal；
- itinerary.refine → Proposal；
- Apply 前 canonical、地图、路线正式状态不变；
- Apply 时重新校验 Scope + generation；
- generation 变化导致旧 Action/Proposal superseded 或按现有 scope reconciliation 规则处理。

# J. Stage Thread / 重启

验证：
- requirements / destinations / interests / itinerary 各自独立 thread；
- 同 stage 连续对话可复用当前 thread；
- Prompt hash/version 变化或 turn_count 达上限会换新 thread；
- canonical generation 改变后旧 stage thread 不再复用；
- thread 轮换不删除数据库消息历史；
- 应用重启后遗留 running Task 变 stopped/interrupted，executing Action 不制造伪成功。

# K. 性能与任务可见性

至少观察一次 Dialogue、一次 required-web Action、一次 itinerary Action：
- AiTask.metadata 记录 timing.totalMs 及适用的 startup/generation/web/validation/persistence；
- 记录 inputBytes / 对象计数等非内容诊断，不记录 Prompt/用户正文；
- UI 能区分当前任务运行、失败、停止、superseded、awaiting_apply、applied；
- 普通 Dialogue 相比旧完整 canonical + live web + reasoning 路径没有再加载无关阶段 Prompt。

# L. 安全与回归

验证：
- 未登录 API / WebSocket 被拒绝；Cookie / 登录限速保持；
- private_data 不进入 Git/发布包；
- Candidate-first、Place Resolution、Route、Revision、回收站/恢复/永久删除仍工作；
- duplicate 不复制私有对话/线程/任务/Action；
- 地图点选与手工坐标仍是确定性 Provider/用户输入；
- AI 无 Shell、MCP、文件读写、子 Agent、付款/预订权限。

# M. 最终报告

输出：
1. commit / 环境；
2. typecheck / build / test 结果；
3. v2 fail-closed 与 fresh v3 启动结果；
4. 四阶段 E2E 逐项 PASS / FAIL / BLOCKED；
5. 发现的问题按 P0 / P1 / P2 排序，附复现步骤与证据；
6. 缺失自动化覆盖；
7. 是否可以进入 main / 本地真实数据库 cutover。

不要自动修复任何失败；先报告。
```
