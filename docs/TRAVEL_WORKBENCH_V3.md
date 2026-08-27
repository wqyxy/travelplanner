# TravelPlanner v3：候选地点优先旅行工作台

> 状态：已确认目标设计
> 产品依据：用户提供的《AI 旅行计划网页版产品方案》
> 实施依据：用户提供的《AI 大型项目重构实施工作流》

## 1. 产品定义

TravelPlanner v3 是一个以地图和结构化计划为核心的旅行规划工作台。用户先发现并筛选地点，再由 AI 排程；坐标和路线由地图服务产生；拖拽、增删、换天与 Anchor 调整由确定性程序执行；AI 调整必须先形成 Proposal，用户 Apply 后才写入正式计划。

```text
旅行需求
  → AI Candidate Pool
  → Place Resolver
  → 用户设置 必去 / 想去 / 可选 / 不去
  → AI 根据已选且已定位地点生成 Day Plan
  → 初始路线计算
  → 用户确定性编辑
  → Route Dirty
  → 用户手动更新路线
  → AI Scope Proposal
  → Preview / Apply / Undo
  → 行程细化
```

## 2. 不可突破的边界

- 单用户、本地优先；`private_data/` 不进入 Git、日志、提示词、测试夹具或便携包。
- 不削弱认证、签名 Cookie、会话和可信局域网边界。
- AI 不下单、付款、预订、办理签证或声称完成线下操作。
- 动态事实不得伪装成实时已核验事实。
- AI 不直接产生可信坐标、路线 geometry、距离或 Provider 交通时长。
- 所有 AI 输出必须经 Zod 与业务规则校验。
- 正式 ID 由服务端分配；canonical 写入使用 `contentGeneration` CAS。
- 不引入开放式 JSON Patch、平行事实源、额外业务 stage 或未经确认的新 Agent。
- **不支持旧行程或旧数据库迁移。** v3 只创建和读取全新的 TravelPlan v2 数据库；遇到旧或未知数据库必须明确停止，不得兼容读取、双写或静默重建。

## 3. 三个产品阶段

```ts
type TripStage =
  | "place_selection"
  | "itinerary_planning"
  | "itinerary_refinement";
```

- `place_selection`：收集 TripFacts、发现 Candidate、解析地点、用户筛选。
- `itinerary_planning`：生成 Day、Anchor、Stop，编辑顺序并维护路线。
- `itinerary_refinement`：补充时间、停留、交通、费用、营业与预约信息。

阶段不因局部修改自动回退；逐日完成度由 Day 字段表达。

## 4. Canonical 与派生边界

Canonical Travel Plan Document v2 保存：

- TripFacts
- 语义 Place
- TripCandidate 与用户 preference
- Day、startAnchor、endAnchor、DayStop
- 用户明确设置的交通方式
- 约束、假设和 warnings

派生或可重建状态独立保存：

- PlaceResolution、Provider Place ID、坐标、地址
- DayRoute、geometry、距离、Provider 时长
- 地图 Marker / Route presentation
- `routeDirty`（由当前 Day fingerprint 与已有 Route fingerprint 比较得出）
- AI Proposal Diff

操作记录独立保存：

- Chat Message
- AI Task
- AI Proposal
- Revision

## 5. Travel Plan Document v2

```ts
type TravelPlanDocument = {
  schemaVersion: 2;
  stage: TripStage;
  trip: TripFacts;
  places: Place[];
  candidates: TripCandidate[];
  days: Day[];
  warnings: string[];
};
```

### 5.1 Place

Place 只描述语义身份，不保存坐标：

```ts
type Place = {
  id: string;
  nameZh: string;
  nameLocal: string | null;
  nameEn: string | null;
  kind: "city" | "attraction" | "lodging" | "meal" | "airport" | "station" | "port" | "stop" | "waypoint";
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  approximate: boolean;
};
```

### 5.2 TripCandidate

```ts
type CandidatePreference = "must_go" | "want_to_go" | "optional" | "excluded";

type TripCandidate = {
  id: string;
  placeId: string;
  preference: CandidatePreference;
  source: "ai" | "user";
  aiReason: string | null;
  aiScore: number | null;
  suggestedDurationMinutes: number | null;
  tags: string[];
};
```

`aiScore` 是 AI 推荐度，不得冒充地图平台评分。非 `excluded` Candidate 可进入排程；`must_go` 必须排入。

### 5.3 Day、Anchor 与 Stop

```ts
type DayAnchor = {
  id: string;
  placeId: string | null;
  label: string | null;
  notes: string | null;
};

type Day = {
  id: string;
  dayNumber: number;
  date: string | null;
  title: string;
  detailLevel: "planned" | "detailed";
  detailStatus: "ready" | "needs_review" | null;
  startAnchor: DayAnchor;
  stops: DayStop[];
  endAnchor: DayAnchor;
};
```

- Stop 数组顺序是唯一顺序来源。
- Anchor 可以为空；酒店未知时不得伪造酒店。
- 不强制前一日末地点等于后一日首地点。
- 从 Candidate 生成的 Stop 保留 `candidateId`。

## 6. PlaceResolution

```ts
type PlaceResolution = {
  tripId: string;
  placeId: string;
  geoFingerprint: string;
  status: "resolving" | "resolved" | "unresolved";
  method: "provider_match" | "provider_choice" | "map_pick" | "manual_coordinates";
  provider: string | null;
  providerPlaceId: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  confidence: number | null;
  resolvedAt: string | null;
  errorMessage: string | null;
};
```

P0 允许 Provider 自动匹配、用户选择 Provider 候选、地图点选和手工坐标。AI 只能补充搜索提示或从已注入候选中选择，不能输出经纬度。

## 7. DayRoute 与 Route Dirty

```ts
type DayRoute = {
  tripId: string;
  dayId: string;
  version: number;
  inputFingerprint: string;
  status: "idle" | "calculating" | "ready" | "attention";
  distanceKm: number | null;
  durationMinutes: number | null;
  geometry: unknown | null;
  legs: RouteLeg[];
  warnings: string[];
  calculatedAt: string | null;
};
```

`routeDirty` 不持久化：

```ts
routeDirty = !dayRoute || dayRoute.inputFingerprint !== buildCurrentDayRouteFingerprint(day, resolutions);
```

初次生成计划后可以自动计算；用户拖拽、添加、删除、Anchor 或地点解析变化后只进入 dirty，必须由用户点击“更新路线”。

## 8. 确定性 PlanCommand

只允许固定业务命令，不使用 JSON Patch：

- `set_candidate_preference`
- `bulk_set_candidate_preference`
- `add_candidate`
- `remove_candidate`
- `update_candidate`
- `update_place`
- `set_day_anchor`
- `add_day_stop`
- `update_day_stop`
- `move_day_stop`
- `remove_day_stop`
- `move_day`
- `update_day`

请求必须携带 `expectedGeneration`。服务端在副本上原子应用、标准化、校验、GC、写 Revision，再递增 generation。把已排程 Candidate 改为 `excluded` 时，必须在同一事务中删除相关 Stop。

## 9. AI 合同

00 Planner 根据 `taskMode` 使用独立 Schema：

- `conversation`
- `discover_candidates`
- `generate_plan`
- `propose_adjustment`

不要构造一个包含全部模式的大 union。

- Candidate discovery 只生成语义 Place、推荐理由、AI 分数、建议时长、标签。
- Plan generation 只生成 Day/Anchor/Stop，不输出坐标或路线。
- Adjustment 只生成受限 PlanCommand Proposal，不直接写 canonical。
- 01 保留同线程、每批最多两天、canonical feedback；完成后只使路线 dirty，不自动重算。
- 02 只能选择已注入 Provider 候选、返回搜索提示或 unresolved；禁止网页搜索和坐标输出。
- 删除 03 地图坐标搜索 Agent。

## 10. AI Proposal

AI 普通调整必须先保存为 Proposal：

```ts
type AiProposal = {
  id: string;
  tripId: string;
  baseGeneration: number;
  scope: { type: "candidate_pool" | "candidate" | "place" | "day" | "trip"; id: string | null };
  status: "pending" | "applied" | "rejected" | "superseded" | "undone";
  title: string;
  explanation: string;
  commands: PlanCommand[];
  diff: ProposalDiff;
  createdAt: string;
  updatedAt: string;
  appliedRevisionVersion: number | null;
};
```

Apply 时重新校验 generation、Scope 和全部命令；任一失败则整份不应用。每次 canonical 写入都生成 Revision；Undo 只在 Proposal 之后没有新的 canonical 写入时恢复 Apply 前 Revision，避免覆盖用户后续修改。

## 11. Store 与数据库

TravelStore v2 只接受空数据库或结构完全匹配的 v2 数据库，核心表：

- `trips.current_plan_json`
- `plan_revisions`
- `place_resolutions`
- `day_routes`
- `ai_proposals`
- `messages`
- `ai_tasks` / `ai_progress_events`

约束：

- canonical 写入使用事务和 expectedGeneration CAS。
- 标题索引和 canonical plan 同事务维护。
- 每次 canonical 写入生成 Revision，并使其他 pending Proposal 进入 superseded。
- PlaceResolution / DayRoute 是派生数据，不递增 contentGeneration。
- 异步派生写入必须校验 expectedGeneration。
- canonical 删除 Place / Day 时，同事务删除失去引用的 Resolution / Route。
- 数据库中不得保存 `routeDirty` 布尔值。
- 不提供 v1 转换器、迁移 API、自动迁移、旧库兼容或双写。

## 12. API 方向

- `GET /api/trips/:id/workspace`
- `POST /api/trips/:id/candidates/discover`
- `PATCH /api/trips/:id/candidates/:candidateId`
- `POST /api/trips/:id/candidates/batch`
- `POST /api/trips/:id/resolutions/retry`
- `POST /api/trips/:id/resolutions/:placeId/select`
- `PUT /api/trips/:id/resolutions/:placeId/manual`
- `POST /api/trips/:id/plan/generate`
- `POST /api/trips/:id/commands`
- `POST /api/trips/:id/routes/:dayId/recalculate`
- `POST /api/trips/:id/proposals`
- `POST /api/trips/:id/proposals/:proposalId/apply`
- `POST /api/trips/:id/proposals/:proposalId/reject`
- `POST /api/trips/:id/proposals/:proposalId/undo`

WebSocket 至少广播 document、resolution、route、proposal、task 和 turn 的变化。

## 13. 前端

桌面工作区保持左地图、右内容；右侧为 `[地点] [行程]` 双 Tab，底部 AI Composer 带显式 Scope。

地点 Tab：

- 全部/必去/想去/可选/不去/未定位筛选
- 单个与批量 preference
- 重新定位、候选选择、地图点选、手工坐标
- 已选择数量与“根据选中地点生成行程”
- 地点卡与 Marker 双向定位

行程 Tab：

- Day、Anchor、Stop
- 同日拖拽与跨 Day 拖拽
- 添加、删除、换天、Anchor 设置
- 路线 dirty 提示与手动更新
- Day 与地图双向高亮

Proposal：

- 展示结构化 Diff、原因、受影响范围
- Apply / Reject
- Apply 后提供 Undo

## 14. 实施顺序

1. 目标冻结与仓库映射。
2. Contracts v2。
3. TravelStore v2；删除旧数据转换与迁移范围。
4. Candidate discovery 与 Place resolution 后端。
5. Candidate UI 与地图 Candidate 模式。
6. Plan generation 与 Day/Anchor UI。
7. 确定性编辑与 Route Dirty。
8. AI Scope Proposal / Preview / Apply / Undo。
9. 细化适配、旧链路删除与 UI 收尾。
10. 完整测试、build 和最终 Review。

## 15. P0 Definition of Done

- Candidate Pool 可生成、去重、打分、筛选和批量设置 preference。
- 每个地点有清晰的 resolving/resolved/unresolved 状态与手工修复路径。
- 只有非 excluded Candidate 进入 Plan；must_go 全部排入。
- Day Anchor 与 Stop 可编辑，不强制跨日首尾相等。
- 地图与 Candidate/Day/Stop 双向联动。
- 拖拽、跨日移动、增删、Anchor 修改不调用 AI。
- 修改后路线 dirty；只有用户点击更新才调用 Route Provider。
- AI 支持 Candidate/Place/Day/Trip Scope，并只生成 Preview Proposal。
- Apply 原子写入，generation 变化时 Proposal superseded，Undo 可恢复。
- 03 坐标 Agent、旧直接 draft 快捷动作、旧直接 mutation 写入和自动全路线重算入口删除。
- 不存在旧数据迁移或兼容读取路径。
- 定向测试、全量测试、typecheck 和生产 build 通过。
