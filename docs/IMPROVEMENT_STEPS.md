# TravelPlanner v3 改进步骤

更新时间：2026-08-28
产品依据：`docs/PRODUCT_PLAN.md`  
测试依据：`docs/LOCAL_TEST_PROMPT.md`

## 1. 固定决策

1. V3 只使用 `private_data/travel-v2.sqlite3`。
2. 不实现旧数据库迁移、旧数据库兼容读取或 v1/v2 双写。
3. `TravelPlanDocument schemaVersion=2` 是唯一 canonical 旅行事实。
4. AI 不输出可信坐标、Provider 路线、距离或交通时间。
5. 用户基础编辑只使用固定 `PlanCommand`。
6. AI 修改必须先形成带 Scope 的 Proposal，用户 Apply 后才写正式计划。
7. Route Dirty 由输入 fingerprint 派生，不保存可任意修改的布尔事实。

## 2. 本轮 P0 修复

### 2.1 Place Resolution 一致性

- Workspace、Plan Generation 和 Route 只使用与当前 Place `geoFingerprint` 匹配的 Resolution。
- 修改 Place 语义身份后，旧坐标不再显示为“已定位”，也不能继续参与排程。
- 新增或修改 Place 后，服务端自动重新触发受控地图解析。
- 批量重试自动跳过已 resolved 且 fingerprint 未变化的地点。

### 2.2 Plan Generation

- Micro 初次发现默认每个 Macro 只保留 1–2 个高价值、具体且当前存在的地点。
- AI 草稿先经过非写入式地图预检，无法唯一定位的候选不写入 canonical 数据。
- 抽象区域、活动概念和整条线路必须具体化为游客中心、入口、集合点或单一可访问场所。
- AI 输入包含当前有效 Resolution、地址、坐标、Candidate preference 和建议时长。
- 服务端提供按城市 / 位置生成的地理分组，帮助 AI 降低折返。
- Day 数量按日期范围或 `requestedDurationDays` 硬校验。
- `must_go` 必须排入。
- `want_to_go` 不能静默进入未排程列表；用户需先调整天数或 preference。
- `optional` 可以未排入，但必须返回原因。
- 任意未定位的具体 Candidate 都不得进入 Day Stop。

### 2.3 Proposal Scope

- Candidate Pool Scope 不能修改 preference、Day、Anchor 或 Stop。
- Candidate Scope 不能直接修改任何 Day。
- Place Scope 只能修改目标 Place 的语义字段，不能修改坐标或 Day。
- Day Scope 只能修改目标 Day；跨日移动和 Day 重排必须使用 Trip Scope。
- Apply 时重新执行同一套 Scope 校验，不能依赖生成阶段或 Prompt 自觉。

### 2.4 Refinement

- 01 行程细化 Agent 已接入 v2 Runtime 和 API。
- 每批最多细化两个 Day，并继续使用同一 Trip Codex Thread。
- 细化不能改变 Day ID、日期、Anchor、Stop ID、地点、Candidate 引用或顺序。
- P0 细化不能新增 Place、Candidate 或 Stop。
- 每批成功后只更新 canonical 细化字段；路线因 fingerprint 变化进入 dirty，不自动请求 Route Provider。
- 用户对已细化 Day 做结构编辑时，该 Day 转为 `planned / needs_review`，顶层 Stage 保持 `itinerary_refinement`。

### 2.5 Deterministic Editing

- 用户可以从地点池重复添加同一地点，对应不同 DayStop。
- 排除已排程 Candidate 前显示确认，并原子删除相关 DayStop。
- 用户可以手动创建 Place + Candidate，保存后自动进入 Place Resolver。
- 用户可以编辑地点名称及地区信息，保存后自动使旧 Resolution 失效并重新定位。
- 用户可以删除单个 Micro；删除 Macro 时预览并级联删除下属 Micro、Stop、Anchor 与 Trip 引用。
- 同日拖拽、跨日拖拽、删除、添加、Anchor、Day 和 Stop 编辑继续使用固定 Command。

### 2.6 Route

- 新增批量更新全部 dirty Day 的 API 和 UI。
- dirty Day 不再把旧距离 / 时间显示为当前结果。
- 地图上的旧路线改为弱化虚线，并明确标注“旧路线，仅供参考”。
- 单日和批量刷新都以当前 generation 和 route input fingerprint 为准。

### 2.7 Map / List Synchronization

- Candidate 模式显示全部已定位 Candidate。
- 选择 Day 时切换为当天 Anchor / Stop 节点和当天路线。
- Day Marker 使用起点、序号、终点标记。
- 点击 Stop Marker 会定位到右侧对应 DayStop。
- 选中 Stop 后地图高亮并定位。
- Day 变化后地图重新 fit 当天节点。

## 3. 本地验证后的处理顺序

### 第一步：阻断故障

优先处理以下问题：

- 应用无法启动；
- TypeScript 或生产构建失败；
- 新旅行无法创建；
- Candidate Discovery 无法落库；
- Place Resolution 无法恢复；
- Plan Generation 覆盖地点池或生成非法 Day；
- Command / Proposal generation 冲突覆盖；
- Route stale 结果覆盖新计划；
- Refinement 修改了未指定 Day 或地点顺序。

### 第二步：完整闭环

按顺序验证：

```text
创建旅行
→ 输入自然语言需求
→ 生成 Candidate Pool
→ 处理 unresolved
→ 设置 preference
→ 生成 Day
→ 地图与行程联动
→ 拖拽 / 添加 / 删除
→ 更新 dirty 路线
→ Day Scope Proposal
→ Apply / Undo
→ 分批细化
```

### 第三步：可用性问题

- 列表滚动和 Marker 定位是否稳定；
- 30–80 个 Candidate 时页面是否可操作；
- 长行程和多日路线是否清晰；
- 异步任务、错误、停止和 generation 冲突提示是否可理解；
- 移动端 / 小屏仅修复阻断问题，不扩大为完整移动端 P2。

## 4. P1 后续改进

以下功能不应阻塞当前 P0 本地验证：

1. Google Maps 链接解析。
2. 更正式的地理聚类和距离矩阵。
3. 路线优化建议与“太赶 / 太松”规则引擎。
4. 营业时间、预约和费用来源聚合。
5. 酒店自动识别为 Anchor。
6. 地点详情页和候选替换向导。
7. 自动路线更新开关。
8. 真实公共交通 / 铁路 Provider。
9. 更完整的 Hover 双向高亮和同一 Place 多日访问菜单。
10. 将旧 v1 未引用源码和旧测试从仓库中物理删除。

开始任何新的第三方 Provider 前，必须先确认 API、费用、限额、地区覆盖、Key 保存方式和隐私边界。

## 5. P2 暂不实施

- 天气自动改行程；
- 门票、酒店、航班价格或购买；
- 餐厅预订；
- 多人协作；
- 自动记账；
- 实时公共交通状态；
- 完整移动端旅行助手。

## 6. 代码修改原则

- 不恢复 v1 canonical 运行链。
- 不加入数据库迁移。
- 不使用开放式 JSON Patch。
- 不因测试失败放松 Zod 合同或 generation 校验。
- 不把 AI 推荐度伪装成地图评分。
- 不把 unresolved 伪装为近似成功。
- 不让拖拽或普通编辑调用 AI。
- 不让 dirty 旧路线冒充当前路线。
- 不在 P0 顺手接入付费 Provider 或 P2 功能。
