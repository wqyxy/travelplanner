# TravelPlanner v3 本地测试提示词

> 用途：把下面整段提示词交给本地 Codex。  
> 默认模式：**只测试、只记录，不修改代码，不提交。**  
> 产品标准：`docs/PRODUCT_PLAN.md`。  
> 当前实现说明：`docs/IMPLEMENTATION_STATUS.md`。  
> 数据策略：只测试全新 `travel-v2.sqlite3`，不迁移旧数据库。

```text
你正在对 TravelPlanner v3 做本地验收。

先读取：
1. AGENTS.md
2. README.md
3. docs/README.md
4. docs/PRODUCT_PLAN.md
5. docs/IMPROVEMENT_STEPS.md
6. docs/IMPLEMENTATION_STATUS.md
7. package.json
8. 当前 git status / git diff / git log -5

本任务只测试和报告，不修复代码，不修改源码、Prompt、文档、数据库 Schema、配置或 Git 历史，不提交，不 push。
所有功能判断以 docs/PRODUCT_PLAN.md 为准；旧架构文档仅作历史参考。

数据安全规则：
- 不读取、修改、迁移或删除旧 private_data/travel.sqlite3。
- 不尝试 v1→v2 迁移。
- 如果仓库已有 private_data/travel-v2.sqlite3，不覆盖、不删除；先报告并要求我决定是否使用临时副本或人工备份。
- 自动化测试必须使用临时目录或测试 fixture。
- 真实浏览器 Smoke 需要新数据库时，先给出安全步骤，等我明确确认后再启动。
- 不打印 Cookie、Token、密码、Codex 凭据或完整账户信息。

按以下顺序执行。

# A. 环境与基线

记录：
- 当前 commit SHA；
- git status；
- Node / npm 版本；
- 操作系统；
- 是否存在未提交修改；
- private_data 中有哪些文件（只列文件名和大小，不读取内容）。

要求 Node.js >= 24。环境不满足时停止后续运行，只报告阻断项。

# B. 静态检查

运行：
- npm run typecheck
- npm run build
- git diff --check

逐条记录命令、退出码和错误摘要。失败后继续执行不依赖该结果的检查，不自动修复。

# C. 自动化测试

运行：
- npm test

另外确认测试覆盖或通过代码审查核对以下关键边界：
1. Candidate / Place / DayStop 是独立实体。
2. 正式 ID 由服务端分配，客户端和 AI 只提供临时 ID。
3. AI 输出 Schema 不包含可信坐标、路线 geometry、Provider 距离或时间。
4. requestedDurationDays 和日期范围会约束 Day 数量。
5. must_go 必须排入，excluded 不得排入。
6. want_to_go 不能静默未排入。
7. 当前 Place fingerprint 变化后，旧 Resolution 不再视为 resolved。
8. 已 resolved 且 fingerprint 未变化的地点不会被批量重复解析。
9. Candidate Pool Scope 不能修改 Day 或用户 preference。
10. Candidate Scope 不能修改 Day。
11. Place Scope 不能修改坐标或 Day。
12. Day Scope 不能跨日移动或重排 Day。
13. Trip Scope 才允许跨 Day 调整。
14. Proposal Apply 前不写 canonical；Apply 原子执行；过期 generation 变 superseded；Undo 可恢复。
15. 用户 Command 使用 expectedGeneration CAS。
16. 修改详细 Day 后顶层 Stage 不回退，但该 Day 会进入 planned / needs_review。
17. Refinement 每批最多两个 Day，不能改变地点、顺序、Anchor、ID 或未指定 Day。
18. Route Dirty 由 fingerprint 派生。
19. stale route 结果不能覆盖新 generation。
20. unsupported transport 不伪造真实路线。

如果现有测试没有覆盖某一项，只在报告中标记“缺少自动化覆盖”，不要补测试。

# D. 启动与基础 Smoke

在我确认安全使用一个全新 travel-v2.sqlite3 后：
- 启动开发服务；
- 记录启动地址和端口；
- 打开浏览器；
- 完成首次本机账号设置；
- 确认登录、退出和重新登录；
- 确认局域网绑定行为符合当前配置；
- 确认页面无 React Error Boundary、控制台致命错误或持续网络失败。

不要使用旧数据库，不执行迁移。

# E. 核心产品 E2E

使用下面的旅行需求：
“国庆从上海去日本关西 7 天，夫妻带一个 3 岁孩子，不想太累，东京已经去过了，想玩大阪、京都和奈良。”

## E1. 创建与需求理解

验证：
- 创建旅行；
- 自然语言需求被保存为 TripFacts；
- 日期 / 7 天 / 人数 / 节奏能被识别或通过一次必要追问补齐；
- 普通对话不直接生成 Day，不直接覆盖已有结构化计划。

## E2. Candidate Pool

验证：
- 首次 AI 地点发现返回 10–80 个具体 Candidate；
- 每个 Candidate 有 Place、理由、AI 推荐度、建议时长和标签；
- AI 推荐度没有被标成地图平台评分；
- 默认 preference 为 optional；
- 地点列表支持全部 / 必去 / 想去 / 可选 / 不去 / 未定位；
- 搜索、单选、多选和全选当前筛选结果可用；
- 批量 preference 可用；
- 手动新增一个具体地点后，创建 Place + Candidate(source=user)，并自动进入地图解析；
- 同名或多语言同一地点不会静默生成重复 Candidate。

## E3. Place Resolution

验证：
- Candidate 逐个出现 resolving / resolved / unresolved；
- resolved Marker 出现在地图；
- unresolved 保持可见且不伪装成功；
- 单个重新识别；
- 批量重新识别；
- 选择 Provider Candidate；
- 地图点选；
- 手工坐标；
- 修改 Place 名称、城市或国家后，旧坐标立即不再视为当前 resolved，并重新解析；
- AI 消歧只能选择 Provider Candidate 或返回 searchHints，不能返回经纬度。

## E4. 地点筛选与排程

设置至少：
- 3 个 must_go；
- 5 个 want_to_go；
- 若干 optional；
- 2 个 excluded。

验证：
- 已选地点存在 unresolved 时，生成行程按钮被阻止；
- 所有已选地点 resolved 后可以生成；
- AI 输入包含当前有效坐标和地理分组；
- 生成恰好 7 个 Day；
- must_go 全部进入 Day；
- excluded 全部不进入；
- want_to_go 若无法容纳，系统明确拒绝静默保存并要求调整天数或 preference；
- optional 未排入时有原因；
- 每天有独立 startAnchor / endAnchor；
- 未知酒店时不伪造具体酒店；
- 不强制上一天结束地点等于下一天起点；
- 完整 Plan 保存后 Stage 才变为 itinerary_planning。

## E5. 地图与列表双向联动

验证：
- 地点 Tab 点击 Candidate，地图 Marker 高亮并定位；
- 点击 Candidate Marker，列表滚动到对应卡片；
- 点击 Day，只显示或突出当天 Anchor / Stop 节点和当天路线；
- Day Marker 使用起点 / 序号 / 终点；
- 点击 Stop Marker，右侧滚动到对应 DayStop；
- 点击 Stop，地图高亮并定位；
- 切换 Day 后地图重新 fit 当天节点；
- 同一 Place 多次到访时，每个 DayStop 仍可独立选中。

## E6. Deterministic Editing

验证所有操作都不调用 AI：
- 同 Day 拖拽排序；
- 跨 Day 拖拽；
- Stop 上移 / 下移；
- Day 重排；
- 添加地点；
- 同一地点重复添加一次到访；
- 删除 Stop；
- 修改 Day 标题；
- 修改 start / end Anchor；
- 修改活动、停留时长和交通方式；
- generation 冲突时不覆盖，重新加载当前 Workspace。

把一个已排程 Candidate 标为 excluded：
- UI 必须先提示受影响 Day；
- 确认后 preference 和相关 DayStop 原子更新；
- 取消确认时零写入。

## E7. Route

验证：
- 初始 Plan 成功后自动计算一次路线；
- walk / drive / bike 使用 Provider 结果；
- transit / rail / ferry / flight 明确 attention/unsupported；
- 拖拽、添加、删除、Anchor 或坐标变化后，不自动请求 Route；
- 受影响 Day 显示 dirty；
- dirty Day 不把旧距离和时间显示为当前数据；
- 地图旧路线是弱化虚线，并标注“旧路线，仅供参考”；
- 更新单日路线只更新目标 Day；
- 更新全部 dirty 路线只处理 dirty Day；
- 更新成功后 fingerprint 匹配，dirty 消失；
- 在 Route 请求期间再修改计划，旧结果不得覆盖新 generation。

## E8. AI Proposal

依次测试：
1. Candidate Pool Scope：“再推荐一些适合 3 岁孩子的京都室内地点。”
2. Candidate Scope：“把当前候选换成一个更适合孩子的类似地点。”
3. Place Scope：“把当前地点的语义名称和城市信息修正准确。”
4. Day Scope：“这一天太赶了，清水寺必须保留，放松一点。”
5. Trip Scope：“京都多一天，大阪少一天。”

验证：
- Scope 在请求中结构化传递；
- AI 只生成受限 PlanCommand；
- Preview 展示增删移动、原因、影响 Candidate / Place / Day 和 route dirty 影响；
- Apply 前 canonical、地图和路线零变化；
- Reject 零写入；
- Apply 原子成功或原子失败；
- 生成 Proposal 后先做其他编辑，旧 Proposal 变 superseded；
- Apply 后在没有后续写入时可以 Undo；
- Undo 恢复 Apply 前 Revision；
- Candidate / Place / Day Scope 的越界命令被服务端拒绝。

## E9. Refinement

验证：
- 点击“细化下一批”，每批最多两个 Day；
- 也可以只细化指定单日；
- 使用同一 Trip Codex Thread；
- 输出补充时间、时长、交通语义、费用、核验和提醒；
- 不改变 Day 数量、日期、Anchor、Stop ID、Stop 顺序、Place 或 Candidate 引用；
- 不修改未指定 Day；
- 不新增 Place、Candidate 或 Stop；
- 无可靠来源的动态事实不能标为 verified；
- 每批成功后 Stage 为 itinerary_refinement；
- 细化本身不自动刷新路线；
- 对已细化 Day 添加、删除、移动或修改地点后，该 Day 变为 planned / needs_review，顶层 Stage 仍为 itinerary_refinement；
- 再次细化后恢复 detailed / ready。

## E10. Revision、复制和删除

验证：
- 每个 canonical 写入有 Revision；
- 版本历史可以预览和恢复为新版本；
- 复制旅行保留 canonical 计划，但不会复用错误的 stale route/resolution；
- 回收站、恢复和永久删除；
- 永久删除同时清理该 Trip 的 Message、Task、Resolution、Route、Proposal 和 Revision；
- 不影响其他 Trip。

# F. 安全与错误处理

验证：
- 未登录 API 和 WebSocket 被拒绝；
- Cookie 为 HttpOnly / SameSite=Strict；
- 登录限速存在；
- 请求体必须为 JSON object；
- 未知 ID、非法坐标、非法 countryCode、非法时间和错误 generation 返回明确错误；
- AI Task 可以停止；
- 应用重启后遗留 running Task 变为 stopped/interrupted；
- 日志和 UI 不泄露密码、Token、Cookie 或账户标识；
- Codex Runner 保持 read-only、approval=never、Shell/MCP/Plugins/Multi-Agent disabled。

# G. 性能观察

在 30–80 个 Candidate、7–14 个 Day 下观察并记录：
- Candidate 列表筛选和搜索；
- 地图 Marker 更新；
- Day 切换和 fit bounds；
- 拖拽；
- Workspace 刷新次数；
- WebSocket 是否造成重复请求；
- Place Resolution 队列是否遵守节流；
- Route 批量更新是否串行且可理解；
- 是否存在明显内存增长或 React 重复挂载副作用。

只记录观察，不做性能重构。

# H. 最终报告格式

按以下结构输出，不修改仓库：

## Test Baseline
- Commit
- OS / Node / npm
- Git status
- Database used

## Commands Run
| Command | Exit code | Result | Key output |

## P0 Acceptance Matrix
| Area | Scenario | Pass / Fail / Blocked / Not tested | Evidence |

## Defects
每个缺陷包含：
- Severity：P0 / P1 / P2
- Title
- Reproduction
- Expected（引用 docs/PRODUCT_PLAN.md 章节）
- Actual
- Suspected files
- Data safety impact

## Missing Automated Coverage
列出没有现成自动化测试覆盖的合同和流程。

## Browser / Provider / Codex Smoke
分别说明是否执行、使用什么环境、结果和限制。

## Final Verdict
只能选：
- P0 Ready
- P0 Ready with non-blocking issues
- Not P0 Ready
- Blocked by environment

停止，不修复，不 commit，不 push。等待我下一步指令。
```
