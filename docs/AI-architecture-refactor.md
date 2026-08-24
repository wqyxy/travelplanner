# AI 旅行规划架构整体重构设计

> 文档状态：已确认的目标设计，尚未实施  
> 版本：v2（已合并架构复审确认项）  
> 编写日期：2026-08-24  
> 适用项目：AI Travel Planner  
> 重要说明：本文只描述后续重构方案。当前 Prompt、源码、SQLite、UI 和 `private_data/` 均未因本文而修改。  
> 本版确认变更：删除地图标注 Agent；采用 Day 级细化状态、Planner Mutation、细化批次 canonical 回灌、结构化核验状态、依赖失效、ResolvedPlace 派生状态、严格时间/时段格式、旅行天数去冗余、Place 垃圾回收。

## 1. 重构目标

项目最终只保留一条清晰的产品链路：

```text
用户和 AI 对话
  → 收集必要信息
  → 用户确认生成初稿
  → 00 生成完整路线初稿
  → 自动同步地图
  → 用户继续通过聊天修改
  → 用户确认开始细化
  → 01 每批细化两天并立即同步地图
  → 完成整趟详细行程
```

本次重构不是兼容旧架构的增量修改。旧 Prompt、旧合同、旧状态机、旧数据结构和旧 UI 只要与本设计冲突，就应删除或重写，不增加兼容层。

核心目标：

- `itinerary JSON` 是唯一活动旅行方案事实来源。
- 业务阶段只有 `planning`、`draft`、`detailed`。
- AI Chat 是唯一规划入口。
- 初稿必须包含完整旅行线路、每日主要地点、每日开始节点和结束节点。
- 细化继续更新同一份 itinerary，不产生另一套详细行程模型。
- 地图、日程 UI、版本历史都从 itinerary 或其派生结果读取。
- 能由代码确定的地图结构、ID、差异和复用逻辑不交给 AI。
- 优先删除代码、状态和合同，而不是增加抽象。
- AI 输出遵循最小化原则：首次 draft 可输出完整 itinerary；已有 itinerary 的后续修改输出语义 mutation，由服务端原子应用。
- Codex 线程只作为推理上下文，服务端保存的 canonical itinerary 才是唯一状态真相。

## 2. 当前架构需要移除的问题

当前实现同时维护了多套旅行数据和调用链：

- `requirements`
- `RouteSkeleton`
- 服务端机械展开的 outline TripPlan
- TripPlan V1/V2
- daily detail patch
- daily repair patch
- transport verification
- route decisions
- map patch V3/V4
- map resolution
- daily detail task、map day run、partial、waiting、repairing 等业务化状态

当前初稿不是 AI 直接生成的完整日程，而是服务端把 skeleton 展开成“自由探索”“返程”等占位活动；这不满足“完整路线和每天主要地点”的要求。

当前地图还存在以下多层流程：

- outline map projector
- 逐日 Map Agent
- map manifest patch
- Nominatim 候选
- 第二次 AI 坐标判断
- 手工“请选择地点”
- V3/V4 兼容、实体/访问/路径多套别名

这些机制虽然能工作，但已经超过产品需要，应由统一 itinerary、稳定 ID、代码差异计算和小型候选判断取代。

## 3. 不可突破的产品与安全边界

- 本项目仍是单用户、本地优先的旅行规划助手。
- AI 不得代用户下单、付款、预订、办理签证或声称完成线下操作。
- 价格、时刻、营业时间、签证、医疗、天气和安全信息必须标明核验状态，不得伪造实时性。
- 外部网页、地图结果、用户粘贴内容和模型输出都是不可信输入。
- 所有 AI 输出必须经过服务端 JSON Schema 和业务约束校验后才能写入。
- 不扩大 Codex、模型或地图服务权限；仍使用只读沙箱、禁止 Shell、MCP、文件写入和创建 Agent。
- 密码、Cookie、Token、API Key、私钥和私人旅行数据不得写入日志、Prompt、测试 fixture 或 Git。
- `private_data/` 继续保持 Git 忽略。
- 登录、签名 Cookie、密码修改、会话和可信局域网边界不因旅行逻辑重构而削弱。

## 4. 唯一 itinerary 数据模型

### 4.1 顶层结构

目标合同名称为 `itinerary:v1`。业务阶段直接放进 itinerary，不在数据库另一列中重复维护。

```ts
type Itinerary = {
  schemaVersion: 1;
  stage: "planning" | "draft" | "detailed";
  trip: TripFacts;
  places: Place[];
  days: Day[];
  warnings: string[];
};
```

`itinerary.stage` 是唯一业务阶段来源。服务端、API 和 UI 都从这里读取，不再维护 `planning_stage` 的第二份状态。

### 4.2 TripFacts

```ts
type TripFacts = {
  title: string;
  originPlaceId: string | null;
  destinationPlaceIds: string[];
  dates: {
    start: string | null;
    end: string | null;
    requestedDurationDays: number | null;
  };
  travelers: {
    summary: string;
    adults: number | null;
    children: number | null;
  };
  budget: {
    amount: number | null;
    currency: string | null;
    note: string | null;
  };
  pace: string | null;
  themes: string[];
  preferences: string[];
  constraints: string[];
  assumptions: Array<{
    text: string;
    source: "user" | "ai" | "system";
    confidence: "low" | "medium" | "high";
  }>;
};
```

设计规则：

- 开始阶段收集的结构化需求直接写入 `trip`，不再建立 requirements 表或需求侧栏工作稿。
- 尚未确认的字段使用 `null` 或空数组，不使用“待确认”字符串冒充结构化状态。
- `assumptions` 必须透明、用户可见；不能把假设写成事实。
- 每条 assumption 必须记录来源和置信度，避免 AI 假设逐轮传播成为事实。
- `requestedDurationDays` 只表示用户在尚未确定完整日期时提出的期望天数；当 `start` 和 `end` 都存在时，实际旅行天数由代码计算，不再持久化第二份 `durationDays`。
- `start`、`end` 使用 `YYYY-MM-DD`；存在完整日期范围时，服务端校验日期顺序和 Day 数量一致性。
- 旅行标题以 itinerary 为权威来源；允许 `trips.title` 作为同事务维护的派生索引字段，用于列表、搜索和排序，但不得成为第二事实来源。

### 4.3 Place

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

设计规则：

- Place 是 itinerary 内的用户可见地点事实，不保存坐标、地图候选、路线几何或地图服务 ID。
- 同一物理地点在一份 itinerary 中只保留一个 Place；多次到访由多个 Stop 表示。
- `countryCode` 有值时必须是两位 ISO 代码。
- 地点名称或行政区发生实质变化时，服务端计算新的地理编码指纹；只改显示语言或活动说明不应使坐标失效。
- 替换为不同物理地点时必须创建新 Place ID，不能把旧 Place ID 改造成另一个地点；对同一物理地点的名称纠正可以保留 ID，但必须重新计算地理编码指纹。
- 每次 itinerary 原子更新成功后，服务端执行 Place 垃圾回收：只保留被 `trip.originPlaceId`、`trip.destinationPlaceIds` 或任一 Stop 引用的 Place；无引用 Place 自动删除。

### 4.4 Day、Stop 与核验状态

不再使用 `startPlaceId + activities + endPlaceId` 三段结构。每天只维护一个有序 `stops` 数组，第一项和最后一项自然构成开始和结束。

```ts
type Period = "morning" | "afternoon" | "evening" | "night" | "all_day";
type VerificationStatus = "verified" | "estimated" | "unverified";

type Verification = {
  status: VerificationStatus;
  checkedAt: string | null; // ISO 8601；estimated/unverified 可为 null
};

type Day = {
  id: string;
  dayNumber: number;
  date: string | null;       // YYYY-MM-DD
  title: string;
  detailLevel: "draft" | "detailed";
  // UI 和恢复使用的逐日完成度，不属于新的业务 stage
  detailStatus?: "ready" | "needs_review";
  stops: Stop[];
};

type Stop = {
  id: string;
  role: "start" | "visit" | "end";
  placeId: string;
  activity: string;
  period: Period | null;
  startTime: string | null;  // HH:mm，当地时间
  endTime: string | null;    // HH:mm，当地时间
  durationMinutes: number | null;
  scheduleVerification: Verification | null;
  transportFromPrevious: {
    mode: "walk" | "drive" | "bike" | "transit" | "rail" | "flight" | "ferry" | "none";
    durationMinutes: number | null;
    note: string | null;
    verification: Verification;
  } | null;
  costNote: string | null;
  costVerification: Verification | null;
  notes: string | null;
};
```

设计规则：

- `stops[0].role` 必须为 `start`，最后一项必须为 `end`，中间项必须为 `visit`。
- 一天至少有开始和结束两个 Stop；它们允许引用同一个 Place，但 Stop ID 必须不同。
- `transportFromPrevious` 绑定到“到达当前 Stop 的交通”。首个 Stop 必须为 `null`。
- 地图访问顺序严格等于 `stops` 顺序，不再由 AI 生成另一套 dayPath。
- 相邻 Stop 引用同一 Place 时保留两次访问，但不请求路线几何。
- 初稿和详细行程使用完全相同的 Day/Stop Schema；区别由 Day 的 `detailLevel` 和字段完整度表达。
- `period` 只允许固定枚举，UI 负责显示中文；不允许模型写入“上午偏晚”“约九点”等自由文本作为结构化时段。
- `startTime` / `endTime` 只允许 `HH:mm` 24 小时格式；“大约”“待确认”等语义进入 verification 或 notes，不污染时间字段。
- 时间表示地点当地时间。地图派生层可为已解析地点保存 IANA timezone，用于跨时区显示和校验，但 timezone 不作为用户旅行事实强塞进 Place。
- 价格、营业/时刻、交通时长等可能变化的事实必须使用结构化核验状态；`verified` 表示已核验并应带 `checkedAt`，`estimated` 表示合理估算，`unverified` 表示尚未核验。

### 4.5 三阶段与 Day 级细化校验

#### planning

- `days` 可以为空。
- Place、Day、Stop 的已有 ID 和引用必须合法。
- 允许日期、人数、预算、目的地等尚未完整。
- 00 一次只能提出一个必要问题。

#### draft

- `days` 必须非空，并覆盖完整旅行天数。
- `dayNumber` 必须由服务端标准化为从 1 连续递增。
- 有精确开始日期时，每天 `date` 必须连续；没有精确日期时允许为 `null`。
- 每天必须包含开始、主要访问地点和结束节点。
- 相邻日期必须形成可理解的连续线路，例如前一天住宿或终点与次日开始关系明确。
- 新生成的初稿中所有 Day 的 `detailLevel` 必须为 `draft`。
- 细化进行期间 itinerary.stage 仍可为 `draft`，此时允许部分 Day 为 `detailed`、其余 Day 为 `draft`。
- `detailLevel=detailed` 的 Day 必须独立满足 detailed Day 的全部校验，不能只靠 itinerary.stage 判断渲染或恢复状态。
- `period` 应提供枚举时段；精确时间、停留时长和交通时长允许为 `null`。
- 初稿不能是推荐列表或城市骨架。

#### detailed

- 满足 draft 的全部线路和引用约束。
- 所有 Day 的 `detailLevel` 必须为 `detailed`；只有全部日期都达到 detailed 后，`itinerary.stage` 才能切为 `detailed`。
- 每个 Stop 必须提供可执行的时间信息；需要开放式安排时应通过 notes 与 verification 明确表达，而不是伪造精确事实。
- 非首 Stop 必须提供 `transportFromPrevious`。
- 可合理估算的停留时长和交通时长必须填写；无法核验时使用 `estimated` / `unverified`，不得伪装成已核验。
- 00 在 detailed 阶段新增或修改 Stop 时，受影响 Day 必须继续满足 detailed 校验；如果修改导致 Day 不再满足 detailed 字段要求，则该 Day 降为 `draft`。整体生命周期 stage 不回退，只通过 Day.detailLevel 和 completion 状态表达未完成部分。

## 5. 稳定 ID、最小修改与依赖失效

### 5.1 ID 所有权

稳定 ID 最终由服务端拥有，不能依赖模型记忆。

- 已存在的 `Place.id`、`Day.id`、`Stop.id` 不允许 AI 修改。
- AI 新增实体时可返回本轮临时 ID，例如 `new-place-1`。
- 服务端为新实体分配正式稳定 ID，并在同一事务中重写所有引用。
- 服务端拒绝重复 ID、未知引用、删除后仍被引用的 Place，以及用已有 ID 表示不同物理实体的输出。
- 保存成功后的 canonical itinerary 是唯一状态真相；模型线程中的旧副本不具备权威性。

ID 可以使用随机 UUID 或稳定前缀加随机值；不要根据可变名称直接生成永久 ID。

### 5.2 最小修改约束

00 和 01 必须遵守：

- 用户只调整日期顺序时，尽量保留 Day、Stop、Place ID 和不依赖日期的详细内容。
- 用户只改活动文案时，不改 Place ID 和地理编码指纹。
- 用户移动一个 Stop 到另一日时，保留 Stop ID 和 Place ID。
- 用户替换为不同物理地点时，使用新 Place ID；不能把旧 Place ID 改造成另一地点。
- 未变化部分不应由模型重新输出或无意义重写；已有 itinerary 的修改默认通过最小 mutation 表达。

服务端在应用 mutation 或 01 批次前后计算结构差异，并记录：新增、删除、移动、内容变化、地点身份变化、依赖失效和受影响路线边。

### 5.3 依赖失效规则

“最小修改”不等于机械保留所有旧事实。只要上游条件变化，依赖其成立的动态事实必须失效或重新核验。

典型规则：

- Day 日期变化：营业时间、预约日期、票价、班次、天气、日期限定活动等相关 verification 失效为 `unverified`，但不依赖日期的地点说明可保留。
- Stop 顺序或上下游地点变化：受影响相邻交通的时长、路线和 verification 失效；未受影响边继续复用。
- transport mode 变化：该边交通时长、路线几何和 verification 失效。
- Place 身份或地理编码指纹变化：坐标解析结果失效，所有连接该 Place 的路线边失效。
- 只改显示语言、活动说明或备注：不应使坐标、路线或无关 verification 失效。
- 服务端负责确定性失效；AI 不能通过保留旧字段绕过这些规则。

### 5.4 Place 垃圾回收

每次 canonical itinerary 原子保存成功后，服务端扫描全部引用：

- `trip.originPlaceId`
- `trip.destinationPlaceIds`
- 所有 Day/Stop 的 `placeId`

未被任何有效引用使用的 Place 自动删除。删除后再计算地图差异，避免历史替换地点长期堆积在 `places[]` 和地图派生状态中。

## 6. Prompt 与 Agent 职责

最终只保留 2 个核心 Prompt 和 1 个极小辅助 Prompt：

```text
prompts/00-旅行规划Agent.md
prompts/01-行程细化Agent.md
prompts/02-地图候选消歧Agent.md
```

删除原 `01-地图标注Agent.md`。地图查询词、别名组合、候选硬过滤、评分、地点指纹和路线图结构全部由代码确定；AI 只在代码仍无法从有限候选中确定地点时介入。

旧每日修复、关键交通核验和路线修复 Prompt 删除。合同修复复用原 Prompt，不再建立专用 Agent。

### 6.1 00-旅行规划Agent

职责：

- 与用户聊天和回答旅行问题。
- planning 阶段一次只收集一个必要信息。
- 维护当前唯一 itinerary 的语义修改意图。
- 在用户明确确认后首次生成完整 draft。
- 根据聊天反馈对 planning、draft 或 detailed itinerary 输出最小 mutation。
- 判断何时可以展示“开始实施初稿”或“开始细化方案”。
- 输出一条可选的具体建议，但不建立 recommendation 数据模型。

输入：

- 当前用户消息。
- 持久化对话中最近的允许列表字段，只包含 role/content；按完整消息边界从新到旧截取，总长度不超过约 48k 字符。
- 当前 canonical itinerary。
- 当前 `contentGeneration`。
- 严格 JSON Schema。

因为已确认需求都在 itinerary 中，即使早期聊天被截断，也不会丢失旅行事实。

#### Planner Mutation

已有 itinerary 的普通修改不再要求模型重吐完整 JSON，而是返回受限的语义 mutation。运行时 JSON Schema 必须逐项枚举允许字段，不能使用开放式 JSON Patch，也不能允许模型修改正式 ID。

建议 mutation 类型必须保持极小集合，避免重新形成 Patch 系统。
运行时 Schema 不允许无限增加业务动作类型，只允许以下通用语义操作：

```ts
type PlannerMutation =
  | { type: "update_fields"; entity: "trip" | "place" | "day" | "stop"; id: string | null; changes: object }
  | { type: "add_entity"; entity: "place" | "day" | "stop"; parentId: string | null; value: object }
  | { type: "remove_entity"; entity: "place" | "day" | "stop"; id: string }
  | { type: "move_entity"; entity: "day" | "stop"; id: string; targetParentId: string | null; position: number | null }
  | { type: "replace_reference"; entity: "place" | "stop"; id: string; newReferenceId: string }
  | { type: "invalidate_dependencies"; entity: string; id: string; reason: string };
```

禁止增加 `MoveStopMutation`、`UpdateDayMutation` 等针对具体业务动作的无限类型。
所有可修改字段必须由 Schema 显式列出，并排除正式 ID、dayNumber、generation 等服务端维护字段。

其中 `TripChanges`、`PlaceChanges`、`DayChanges`、`StopChanges` 在真实 Schema 中必须明确列出可修改字段，并排除正式 ID、`dayNumber` 等由服务端维护的字段。

建议输出合同：

```ts
type PlannerOutput = {
  schemaVersion: 1;
  operation: "reply" | "mutate_itinerary" | "create_draft" | "start_detailing";
  assistantMessage: string;
  baseGeneration: number;
  mutations: PlannerMutation[] | null;
  draftItinerary: Itinerary | null;
  nextAction: "none" | "start_draft" | "start_detail";
  suggestion: {
    id: string;
    text: string;
  } | null;
};
```

服务端规则：

- `reply`：`mutations` 和 `draftItinerary` 必须均为 `null`。
- `mutate_itinerary`：必须提供非空 `mutations`，`draftItinerary=null`；服务端在当前 canonical itinerary 上原子应用全部 mutation，任一 mutation 失败则整次拒绝。
- `create_draft`：只能在当前 stage=planning 且用户当前消息明确确认生成初稿时返回；此时 `draftItinerary` 必须是完整 stage=draft itinerary，所有 Day 初始 `detailLevel=draft`，`mutations=null`。
- `start_detailing`：只能在当前 itinerary 为 draft 且用户当前消息明确确认细化时返回；`mutations` 和 `draftItinerary` 通常均为 `null`。
- 所有写操作都必须匹配 `baseGeneration`；过期结果拒绝应用。
- `nextAction` 只控制聊天中的快捷按钮，不是持久化业务状态。
- 初稿生成只能发生在用户点击“开始实施初稿”或用自然语言明确确认后。
- 不用服务端关键词匹配判断自然语言确认，由 00 在合同中表达操作意图，服务端再校验阶段是否合法。
- 普通问答不返回完整 itinerary；已有行程修改也不返回完整 itinerary，以降低 Token、合同失败和无意义重写风险。

### 6.2 01-行程细化Agent

职责：

- 首轮读取一次完整 draft，理解全程顺序和跨日连续性。
- 在同一个 Codex 线程中每批细化两个 Day。
- 填充时间、活动顺序、停留时长、交通、费用提示、核验状态和说明。
- 保留路线结构、Day/Stop/Place ID 和未处理日期。
- 允许在确有必要时新增 Place/Stop，但必须使用临时 ID，并由服务端正式分配。
- 每个成功批次都把指定 Day 的 `detailLevel` 设为 `detailed`。

首轮输入：

- 当前完整 canonical itinerary。
- 第一批两个 `dayId`。
- 当前 generation。

后续轮次不重复注入完整 itinerary，但必须把上一批**服务端实际应用后的 canonical 结果**回灌线程，至少包含：

```ts
type DetailCanonicalFeedback = {
  appliedDayIds: string[];
  idMappings: Record<string, string>; // 临时 ID -> 正式 ID
  canonicalDays: Day[];               // 上一批最终落库版本
  canonicalPlaceChanges: Place[];     // 新增/修正后最终 Place
  invalidatedFacts: string[];         // 服务端依赖失效摘要
  currentGeneration: number;
};
```

然后再发送下一批 `dayId`。Codex 线程只保留推理连续性，不能被当作状态数据库；服务端 canonical itinerary 永远优先。

输出：

```ts
type DetailBatchOutput = {
  schemaVersion: 1;
  baseGeneration: number;
  batchId: string;
  dayIds: string[];
  placeUpserts: Place[];
  days: Day[];
  assistantMessage: string;
};
```

服务端决定 dayIds；每批正常为两个，最后一批可以只有一个。输出必须恰好替换指定日期，不能修改其他日期或 trip facts。

每批流程：

1. 校验输出 Schema、dayIds、ID 引用、`detailLevel=detailed` 和 detailed 字段。
2. 检查 baseGeneration，拒绝过期结果。
3. 服务端分配新实体 ID 并重写引用。
4. 执行依赖失效和 Place 垃圾回收。
5. 原子更新当前 canonical itinerary。
6. generation 加一。
7. 立即计算地图差异并同步受影响地点和路线。
8. 把 canonical Days、正式 ID 映射、Place 变化、失效摘要和新 generation 回灌同一 Codex 线程。
9. 启动下一批。

全部日期 `detailLevel=detailed` 后，把 `itinerary.stage` 从 draft 改为 detailed，并保存一个用户可见历史版本。

### 6.3 02-地图候选消歧Agent

这是唯一地图 AI Prompt，也是非核心高效率辅助 Prompt。它不负责生成查询词、访问顺序、路径、路线边、坐标或旅行建议。

调用前，代码已经完成：

1. 根据 Place 字段确定性生成多组地图查询词。
2. 调用地图 Provider 获取候选。
3. 按国家、类型等规则硬过滤。
4. 对剩余候选评分。
5. 只有仍然存在歧义时，才把最多 5 个候选交给 02。

输入：

- 单个目标 Place 的必要上下文。
- 代码筛选后最多 5 个候选。
- 每个候选只包含 providerPlaceId、显示名、类别、城市、区域、国家代码和坐标。

输出：

```ts
type CandidateDecisionOutput = {
  schemaVersion: 1;
  providerPlaceId: string | null;
  reason: string;
};
```

规则：

- 只能选择输入中的 providerPlaceId 或返回 null。
- 不得改写 itinerary、搜索网页、生成新 query 或自造坐标。
- 没有明显匹配时返回 null。
- reason 保持一句话，避免额外推理和 Token。

## 7. 初稿、聊天修改和细化流程

### 7.1 planning

- 新旅行立即拥有一份 stage=planning 的空 itinerary。
- 00 根据用户消息通过最小 mutation 更新 trip facts 或 Place，并一次追问一个必要问题。
- 信息足够形成完整路线时，00 返回 `nextAction=start_draft`。
- UI 在该条 AI 消息下显示“开始实施初稿”。
- 未经确认，00 不得生成 days，也不得启动地图解析。

### 7.2 生成 draft

- 按钮只发送自然语言“开始实施初稿”，不调用独立业务 API。
- 自然语言确认也走同一个 `/turns` 聊天接口。
- 00 使用 `operation=create_draft` 输出首次完整 stage=draft itinerary。
- 所有 Day 初始 `detailLevel=draft`。
- 服务端校验、分配正式 ID、原子保存、增加 generation、保存历史快照并自动启动地图同步。
- draft 必须从第一天开始地点一直连到最后一天结束地点。

### 7.3 draft 聊天修改

- 用户继续通过 AI Chat 提出移动日期、增删地点、改变节奏等修改。
- 00 返回语义 mutation，不再重吐整份 itinerary。
- 服务端在 canonical itinerary 上原子应用 mutation、执行依赖失效、Place 垃圾回收和完整校验。
- 每次合法更新自动同步地图。
- 路线稳定时，00 返回 `nextAction=start_detail`。

### 7.4 detailed 细化

- “开始细化方案”按钮仍只发送自然语言指令。
- 00 返回 `operation=start_detailing` 后，服务端启动 01。
- 01 在同一线程中每批两天。
- 每批成功后，对应 Day 立即变成 `detailLevel=detailed`，日程 UI 和地图立即显示已细化结果。
- 全部完成前 itinerary.stage 仍为 draft；UI 和恢复逻辑按每个 Day 的 `detailLevel` 展示真实进度，不增加 partial、detailing、waiting_service 等业务阶段。
- AI Task 可以显示“已完成 2/10 天”等操作进度。
- 每批服务端应用后的正式 ID 与 canonical Day 必须回灌 01 线程，避免线程状态和数据库状态分叉。

### 7.5 detailed 后聊天修改

- 00 通过 mutation 直接修改当前 detailed itinerary，不与 01 建立另一套修改入口。
- 未变化的日程和地点不由模型重写。
- 新增内容必须直接满足 detailed 校验，或把受影响 Day 明确降为 `detailLevel=draft`。
- 服务端根据日期、地点、顺序、交通方式等变化执行依赖失效；失效 verification 不等于删除用户已确认内容。
- itinerary.stage 只表达旅行生命周期，不因局部修改反复回退。所有 Day 均完成 detailed 后进入 detailed 生命周期；若后续修改产生未完成 Day，由 Day.detailLevel 和 completion 状态表达。

## 8. 地图生成、自动消歧和复用

### 8.1 代码生成地图图结构

服务端从 itinerary 直接派生：

```ts
type MapVisit = {
  id: string;       // 由 stopId 稳定派生或直接等于 stopId
  dayId: string;
  dayNumber: number;
  stopId: string;
  placeId: string;
  order: number;
};

type MapEdge = {
  id: string;
  dayId: string;
  fromVisitId: string;
  toVisitId: string;
  mode: string;
  order: number;
};
```

- 每个 Stop 生成一次 Visit。
- 相邻 Visit 生成一条 Edge。
- 同一 Place 的多次 Visit 共享一个地图标记。
- 相邻 Visit 指向同一 Place 时保留 Edge 实例，但 geometry 为 null，并显示“同一地点内移动”。
- 不再让 AI 输出 dayPaths、route IDs、remove IDs 或 patch 基线。

### 8.2 ResolvedPlace 与地理编码指纹

地图解析结果是 itinerary 的派生缓存，不写回 Place，也不是第二套旅行事实模型。
ResolvedPlace 可以独立持久化，但不能被业务逻辑作为旅行事实来源。Place fingerprint 变化时旧 ResolvedPlace 直接失效并重新生成。

```ts
type ResolvedPlace = {
  placeId: string;
  geoFingerprint: string;
  provider: string;
  providerPlaceId: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string | null; // IANA timezone，可由可信地图结果派生
  resolution: "exact" | "approximate" | "unresolved";
  confidence: number | null;
  resolvedAt: string | null;
};
```

建议指纹内容：

```text
normalized(nameZh|nameLocal|nameEn) + kind + city + region + countryCode + approximate
```

以下变化不使坐标失效：

- Day 顺序变化。
- Stop 移动到另一日。
- 时间、活动、费用或备注变化。
- 只改显示语言但地点身份不变。

以下变化需要重新解析：

- Place 名称代表的物理地点改变。
- 城市、区域、国家或地点类型改变。
- approximate 从区域变为具体地点，或反向变化。

### 8.3 代码生成地图查询词

删除地图标注 Agent 后，地图 query 完全由代码从 Place 生成。建议按可用字段依次尝试并去重：

```text
1. nameLocal + city + countryCode
2. nameEn    + city + countryCode
3. nameZh    + city + countryCode
4. nameLocal + region + countryCode
5. nameEn    + region + countryCode
6. nameZh    + region + countryCode
```

规则：

- 缺失字段自动省略，不生成 `null` 字符串。
- 已有 `countryCode` 时优先加入查询，降低跨国同名误匹配。
- 代码可以做 Unicode/空白/标点规范化，但不得自行把一个地点改写成另一个地点。
- 第一版不增加 AI query rewrite；多组确定性查询都无可信候选时直接进入 approximate/unresolved 降级。

### 8.4 代码候选筛选与评分

先执行硬过滤：

- 有 countryCode 时，候选国家不符直接拒绝。
- 机场不能选择机场酒店、机场道路或普通商户。
- station、port、lodging、attraction 等明显类型不兼容时拒绝。
- 无法确认候选国家时不自动选择为精确位置。

建议评分：

- 规范化名称精确匹配：+50。
- 当地名或英文别名精确匹配：+45。
- 名称包含且长度足够：+25。
- 城市匹配：+20。
- 区域匹配：+10。
- 地点类型匹配：+15。
- 与同日已定位相邻节点处于合理区域：最多 +10，仅作为辅助，不能覆盖国家或类型冲突。

自动选择条件：

- 过滤后只有一个可信候选；或
- 第一名分数至少 65，并且比第二名至少高 15。

否则调用 02。阈值应写成具名常量并由单元测试覆盖，避免散落魔法数字。

### 8.5 02 回退和最终降级

- 02 选择后，服务端再次检查候选确实属于输入集合且国家/类型未冲突。
- 02 返回 null 或输出无效时，不重试复杂推理，也不调用另一个地图 Agent。
- approximate 城市、住宿区域等可以使用可信城市/区域中心，并明确标记 `resolution=approximate`。
- 具体景点无法确认时使用 `resolution=unresolved`，不自动使用可能错误的同名地点。
- UI 只显示状态或警告，不出现“请选择地点”。

### 8.6 路线复用

路线几何缓存键应包含：

```text
mode + fromCoordinate + toCoordinate + routingProfileVersion
```

复用规则：

| itinerary 变化 | 坐标处理 | 路线处理 |
| --- | --- | --- |
| 只改标题、时间或活动说明 | 全部复用 | 全部复用 |
| 改日期但地点和邻接关系不变 | 坐标复用 | geometry 复用；日期相关动态事实 verification 失效 |
| Stop 移到另一日但邻接关系不变 | 全部复用 | geometry 复用，只更新实例归属 |
| Stop 顺序变化 | 全部复用 | 仅新出现的相邻边查缓存或重算 |
| 新增 Stop，引用已有 Place | 复用地点坐标 | 只处理新增/断开的相邻边 |
| 新增 Place | 只解析新 Place | 只处理与其相连的边 |
| 删除 Stop | 无需重新解析地点 | 删除相关边，处理新形成的相邻边 |
| Place 身份变化 | 只重新解析该 Place | 重算所有连接该 Place 的边 |
| transport mode 变化 | 坐标复用 | 该边路线和交通 verification 失效并重算 |

飞行仍可使用跨日期变更线安全的直连几何；步行、骑行和驾车使用对应路线服务。公共交通无可靠路线服务时可显示建议线并明确 `estimated` 或 `unverified`，不得伪装成实时核验。

## 9. 地图任务调度

- 每次 itinerary generation 变化后，服务端计算 Place、Stop、Edge 和依赖失效差异。
- 没有地点身份或邻接关系变化时，不启动地理编码或路线请求。
- 只有新增/变化 Place 时运行代码 query builder 和 geocoder。
- 候选足够明确时由代码自动选择；只有代码评分后仍歧义的地点调用 02。
- 只有新增 Edge 或端点/方式变化时查询路线缓存或服务。
- 地图任务运行中又出现新 generation 时，不让旧结果覆盖新数据。
- 可以完成当前可复用子任务后合并到最新 generation，也可以取消过时网络请求。
- 地图繁忙时合并待同步范围，但应尽快提交已完成的 01 批次结果。

不重新实现复杂 Map Patch 协议。推荐 WebSocket 只发送：

```ts
type MapChangedEvent = {
  tripId: string;
  generation: number;
  changedDayIds: string[];
  status: "syncing" | "ready" | "attention";
  summary: string;
};
```

客户端收到事件后读取当前 `/api/trips/:id/map` 快照。这样断线重连和顺序错误都由快照解决。

## 10. 持久化设计

### 10.1 新旅行数据库

由于用户已决定删除全部旧私人数据并从头开始，不实现旧 Schema 迁移或 V1/V2 兼容读取。

建议最小表：

#### trips

- `id`
- `state`：仅旅行管理需要的 active/trashed
- `current_itinerary_json`
- `title`：从 itinerary 同事务投影的派生索引字段，不是第二事实来源
- `content_generation`
- `codex_thread_id`：仅保存当前可恢复任务上下文，不作为旅行长期状态；线程生命周期按单次 AI workflow 管理，结束后通过 canonical itinerary 恢复。
- `created_at`
- `updated_at`

#### itinerary_revisions

- `trip_id`
- `version`
- `itinerary_json`
- `source`
- `summary`
- `created_at`

#### messages

保留用户/助手消息、公开回复 JSON、运行状态、错误和 Codex turn ID。删除旧 TravelAgentOutput 兼容解析。

#### ai_tasks / ai_progress_events

保留通用任务状态、公开进度、统一服务重试信息。允许增加一个小型 metadata JSON，用于 01 保存：

- baseline generation
- 全部 dayIds
- completed dayIds（操作恢复辅助；真实逐日完成度仍以 `Day.detailLevel` 为准）
- 当前 batch ID

这只是操作恢复信息，不是旅行阶段。

#### map_state

每趟旅行只保存当前派生地图状态，而不是第二套旅行计划：

- `generation`
- `resolved_places_json`：当前 Place 对应的 `ResolvedPlace[]`
- `map_json`：由 itinerary + ResolvedPlace + 路线结果派生的当前地图快照
- `status`
- `warnings`
- `updated_at`

`resolved_places_json` 用 `placeId + geoFingerprint` 判断坐标是否可复用。路线几何继续使用稳定缓存键复用，不按每个 itinerary 版本复制全部地图实体、访问、路线和运行表。

### 10.2 历史版本策略

用户可见历史只在以下时机写入：

- 首次生成 draft。
- 一次 00 mutation 原子应用完整成功。
- 01 完成全部日期并进入 detailed。
- 用户恢复历史版本。

01 的每个两日批次只更新当前 canonical itinerary 和 generation，不产生用户可见历史版本，避免版本列表被内部批次污染。

恢复历史版本时：

- 把历史快照复制成新的当前 itinerary。
- generation 加一。
- 新增一条“从 vN 恢复”的历史记录。
- 地图根据稳定 ID 和指纹复用可用坐标/几何，其余自动重建。

### 10.3 private_data 重置

用户已明确授权后续实施时删除 `private_data/` 内全部文件并从头开始，不保留备份。

这将同时删除：

- 旧旅行和聊天。
- 登录用户名、密码配置和会话。
- UI、模型和地图颜色设置。
- 公共地图、路线和瓦片缓存。
- 旧版本历史。

安全执行顺序：

1. 先完成代码重构和不依赖真实 private_data 的临时数据库检查。
2. 在首次启动新 Schema 前，对项目根目录和 `private_data` 都执行 realpath，确认 `private_data` 严格位于项目根目录内且目标名称正确。
3. 确认 `private_data` 本身不是 symlink，并校验专用 sentinel 文件（例如 `.travel-planner-private-root`）存在且内容符合预期。
4. 仅在 realpath、非 symlink、sentinel 三项同时通过时删除该目录内全部内容；不使用未解析变量、通配路径或跨 Shell 删除。
5. 重新启动后进入首次设置登录流程。

本文档编写阶段绝不执行该删除。

## 11. 并发、停止、失败和恢复

### 11.1 同一旅行的写入串行化

- 同一旅行同一时刻只能有一个 00 或 01 itinerary 写任务。
- 地图派生任务可以并行，但每次应用结果必须校验 generation。
- 01 运行时聊天输入可以禁用；用户可先停止任务再发送修改，避免维护复杂的 deferred message 队列。
- 不再持久化“排队等每日任务完成后自动处理”的业务流程。

### 11.2 合同错误

- 00、01 或 02 输出首次未通过 Schema 时，允许复用同一个 Prompt进行一次定向合同重试。
- 重试只注入原输出和精简后的校验错误。
- 不调用独立 repair Prompt，不增加 repairing 业务状态。
- 第二次仍失败时保留最后一个合法 itinerary/map，并把当前 AI Task 标记失败。

### 11.3 服务错误

- 当新 generation 替代运行中的旧任务时，旧 AI Task 标记为 `cancelled_by_generation`，不视为失败。
- 瞬时 Codex 服务错误统一使用 15/30/60 秒最多三次退避。
- 认证、协议、模型不可用等确定错误不盲目重试。
- 用户可以通过现有 AI Task 停止能力停止长任务。

### 11.4 01 中断

- 已成功应用的批次保留。
- 当前未完成批次不写入。
- itinerary.stage 保持 draft。
- 不尝试跨应用重启恢复旧 Codex 线程。
- 用户再次确认细化时创建新线程，读取当前完整 canonical itinerary，并以 `Day.detailLevel` 重新计算仍需细化的 dayIds；metadata 只作为任务恢复辅助。
- 若用户在中断后通过 00 改变结构，由新 canonical itinerary 和 `Day.detailLevel` 重新计算需要细化的日期，并清理不再有效的 completed dayIds metadata。

## 12. UI 设计

### 12.1 唯一规划入口

AI Chat 是唯一规划入口。删除：

- “推荐”入口和推荐卡。
- “调整路线”独立操作。
- “请选择地点”。
- 需求侧栏的编辑、保存和同步流程。
- “确认路线并细化”日程横幅。
- 独立停止/恢复每日细化业务按钮。
- 地图重试这种会另行启动 AI 的入口。
- 当前通用快捷 Prompt，例如“直接做方案”。

### 12.2 允许的聊天快捷按钮

只允许以下由 AI 回复合同驱动的按钮：

- `开始实施初稿`
- `开始细化方案`
- `采用`
- `不采用`

按钮不直接调用另一套业务 API，只把自然语言指令发送到同一个聊天 `/turns` 接口。

建议按钮文案：

```text
采用建议：<建议文本>
不采用建议：<建议文本>
```

不保存 recommendation 表或 accept/reject 状态机。

### 12.3 日程栏

右侧顶部固定显示：

```text
开始 → 初稿 → 完整行程
```

根据 `itinerary.stage` 高亮当前节点，不创建新的模式或弹窗。

日程渲染：

- planning：显示聊天引导和已确认旅行摘要，不伪造日程。
- draft：同一 stage 下允许逐日混合显示；`detailLevel=draft` 的 Day 显示粗略时段，`detailLevel=detailed` 的 Day 显示已细化内容。
- detailed：所有 Day 均显示精确时间、交通、停留时长、费用说明、注意事项和核验状态。
- 地点名称继续支持中文、英文和中英显示，但不改变 itinerary 或地图身份。

### 12.4 地图栏

- 保留地图分类、日/全程联动、全屏和地图样式设置。
- 删除候选按钮和手工选择 API。
- 未定位或大致定位只显示非阻塞警告。
- 地图自动同步，不提供独立 AI 启动按钮。

### 12.5 保留的非 AI 基础能力

- 登录、退出、修改密码。
- 模型和 reasoning effort 设置。
- 新建旅行、重命名、复制、回收站和永久删除。
- 版本历史和恢复。
- 地图与日程选择联动。
- 地图分类颜色和主题。
- AI 公开进度与停止任务。

## 13. API 与事件调整

保留或简化：

- `GET/POST /api/trips`
- `GET/PATCH/DELETE /api/trips/:id`
- 复制、回收站和版本历史 API
- `GET /api/trips/:id/messages`
- `POST /api/trips/:id/turns`
- 聊天 turn 中断
- AI Tasks 查询和通用停止
- `GET /api/trips/:id/map`

删除：

- `/api/trips/:id/requirements`
- `/api/trips/:id/outline/confirm`
- `/api/trips/:id/route-decisions/:decisionId`
- `/api/trips/:id/detail-status`
- `/api/trips/:id/details/stop`
- `/api/trips/:id/details/resume`
- `/api/trips/:id/map/retry`
- `/api/trips/:id/map/locations/:entityId/select`

WebSocket 保留通用事件：

- turn updated
- trip updated
- AI task updated
- map changed

删除 outline、route decision、daily detail day、旧 map patch 等专用事件。

## 14. Prompt 与源码清理范围

### 14.1 Prompt

- 重写 00。
- 删除原 `01-地图标注Agent.md`。
- 将旧 `02-行程细化Agent.md` 重写并收敛为新的 `01-行程细化Agent.md`。
- 将旧 `03` 覆盖为新的短 `02-地图候选消歧Agent.md`。
- 删除旧 04、05 以及不再使用的旧编号 Prompt。
- 更新 `prompt-contract.ts`，只加载和校验三个 Prompt。
- 每个 Prompt 继续保留唯一 prompt-id、prompt-version 和 SHA-256 校验。

### 14.2 服务端

删除或重写以下逻辑：

- RequirementsSchema、Requirements 表和保存方法。
- TripPlan V1/V2、legacy alias 和兼容解析。
- RouteSkeleton、RouteStop、RouteLeg、RouteDecision。
- DetailDayPatch、DetailDayRepairPatch。
- TransportVerification。
- MapAgentOutput V3/V4、旧地图标注合同、MapResolution AI 坐标合同。
- skeleton expand、outline projector。
- daily detail task、repair、stop/resume、deferred message。
- transport verification 和 route decision 调用链。
- 旧 MapCoordinator 的逐日 manifest/resolution/repair 队列；重写为 generation 驱动的 query/geocoder/scorer/resolution 调度器。
- map candidate 手工选择。
- 旧 SQLite 1–13 迁移和 legacy map upgrade。

保留并简化：

- Codex app-server 客户端、统一通知解析和瞬时错误重试。
- 认证、配置、地图瓦片/公开缓存。
- AI Task 公开进度。
- 地理编码、反向国家验证和路线服务的安全部分。

### 14.3 前端

删除：

- `RequirementsDrawer.tsx`
- `requirements-draft.ts`
- 对应测试和样式
- 推荐/路线决策/确认细化/暂停恢复 UI
- 地图候选选择和地图重试 UI
- 对应 window CustomEvent 桥接
- 旧 PlanningStage、RouteDecision、Requirements、V1/V2 map alias 类型
- 不再使用的 import、fixture、CSS 和 reducer

重写：

- `types.ts` 为统一 itinerary 和简化 map snapshot 类型。
- `Itinerary.tsx` 为三阶段和 Day/Stop 渲染。
- `AssistantDrawer.tsx` 为合同驱动的四类快捷按钮。
- `App.tsx` 为单一聊天调用和简化事件流。
- `MapPanel.tsx` 移除候选逻辑，消费当前快照。

### 14.4 可删除模块候选

删除前必须用 `rg` 确认没有有效引用：

- `apps/server/outline-map-projector.ts`
- `apps/server/outline-map-projector.test.ts`
- 旧 `apps/server/map-coordinator.ts`，或将其彻底重写为小型 generation 调度器
- `apps/web/src/RequirementsDrawer.tsx`
- `apps/web/src/requirements-draft.ts`
- `apps/web/src/requirements-draft.test.ts`
- 若改为快照刷新后不再需要的 map patch reducer 及测试

认证、缓存、语言显示、工作区控制等公共模块不能因本次清理误删。

## 15. 推荐实施顺序

1. 再次检查 `git status`，保护用户已有修改。
2. 先重写统一 contracts：Itinerary、Day.detailLevel、Verification、PlannerMutation、ResolvedPlace，并完成阶段/字段校验测试。
3. 重写 TravelStore 为新建库 Schema，不接触真实 private_data；`trips.title` 只做派生索引。
4. 重写 00、把旧 02 重构为新 01、把旧 03 收敛为新 02，并彻底删除地图标注 Agent 与旧 04/05。
5. 重写 00 聊天保存链路：planning mutation、首次 create_draft、后续 mutation、generation 并发保护、依赖失效和 Place 垃圾回收。
6. 实现 01 同线程两日批处理，以及每批后的 canonical ID / Day / Place / generation 回灌。
7. 用代码实现 Visit/Edge 派生、地点指纹、确定性 query builder、ResolvedPlace、候选评分、02 回退、verification 失效和路线复用。
8. 简化地图持久化、API 和 WebSocket 快照刷新。
9. 重写前端 types、聊天按钮、阶段栏、Day.detailLevel 渐进显示、核验状态、日程和地图状态。
10. 删除旧 Prompt、合同、表逻辑、API、组件、样式、测试 fixture 和死代码。
11. 用 `rg`、Git diff 和引用检查确认删除安全，重点确认不存在旧 01 地图标注调用链和旧 02/03 编号残留。
12. 完成不依赖真实数据的轻量检查。
13. 按项目规则一次性列出相关 Vitest、typecheck 和 build 的范围、成本，并请求用户授权。
14. 在新代码准备完成、首次启动新 Schema 前，按第 10.3 节的 realpath + 非 symlink + sentinel 三重保护删除全部 private_data。
15. 启动新应用，重新设置登录并执行端到端验收。

## 16. 测试计划

### 16.1 合同测试

- planning itinerary 允许空 days。
- draft 拒绝缺失起点、终点、主要访问点、断裂日期和无效引用。
- 初始 draft 的所有 Day 必须为 `detailLevel=draft`。
- stage=draft 允许 mixed Day detailLevel，但每个 `detailLevel=detailed` Day 必须独立满足 detailed 校验。
- stage=detailed 要求所有 Day 均为 `detailLevel=detailed`。
- `period` 只能使用枚举；日期只能 `YYYY-MM-DD`；时间只能 `HH:mm`。
- `verified` 的动态事实必须满足 `checkedAt` 规则；estimated/unverified 不得伪装已核验。
- 所有正式 ID 唯一，临时 ID 经服务端原子重写。
- 00 reply 不携带 mutation 或 draft；mutation 必须带正确 generation；create_draft 只允许从 planning 明确确认后发生。
- 00 runtime mutation Schema 不允许模型修改正式 ID 或服务端派生字段。
- 01 只能替换指定的一个或两个 dayId，输出 Day 必须 `detailLevel=detailed`。
- 01 下一批收到上一批 canonical ID mappings 和 canonical Days 后，必须使用正式 ID。
- 02 只能选择输入候选或 null。

### 16.2 Store、mutation 与并发测试

- 新旅行创建 stage=planning itinerary。
- generation 防止旧 00、01 和地图结果覆盖新版本。
- 一组 PlannerMutation 原子应用：任一 mutation 失败则整组不落库。
- mutation 不触及的字段逐字段保持不变。
- 日期改变时，只失效依赖日期的 verification；地点坐标不应无故失效。
- Stop 调序只失效受影响交通边；未受影响路线继续复用。
- Place 身份变化使对应 ResolvedPlace 和连接边失效。
- 每次保存后无引用 Place 被垃圾回收；仍被 origin/destination/Stop 引用的 Place 不得误删。
- 01 每批应用后保留已完成日期，失败批次不污染当前 JSON。
- 用户可见版本不包含内部两日批次。
- 恢复历史版本生成新的活动版本。
- 复制旅行复制 itinerary，但地图可以重新派生或按稳定键复用。
- 未知数据库版本停止写入，不静默重建。

### 16.3 地图测试

- Day stops 确定性生成 Visit 和 Edge。
- 同一 Place 多次访问只显示一个标记。
- query builder 按 nameLocal/nameEn/nameZh + city/region + countryCode 生成稳定去重查询，不调用 AI。
- 只改日期或活动说明不重新地理编码；日期相关 verification 按规则失效。
- Stop 调序只处理受影响的相邻边。
- 新增 Place 只解析该地点。
- `placeId + geoFingerprint` 正确决定 ResolvedPlace 复用或失效。
- 国家和类型硬过滤有效。
- 分数达到阈值自动选择，边界歧义进入 02。
- 02 无结果时按地点类型选择区域中心或 unresolved。
- 飞行跨日期变更线、重复地点和路线服务失败保持可见且不伪成功。

### 16.4 UI 测试

- planning、draft、detailed 三阶段栏显示正确。
- stage=draft 时，已细化 Day 和未细化 Day 根据 `detailLevel` 混合显示，不依赖 AI Task metadata 猜状态。
- AI 每次只显示合同允许的快捷按钮。
- 按钮发送自然语言，不调用旧独立 API。
- draft 显示每日开始、主要 Stop 和结束。
- 01 每完成两天，日程和地图即可看到更新。
- UI 对 verified / estimated / unverified 使用一致、非误导性的状态展示。
- detailed 聊天小改动保留未变 UI 元素和地图数据；若某 Day 降为 draft，阶段与渲染同步变化。
- 不存在需求侧栏、推荐卡、路线决策、地点候选或地图 AI 重试入口。

### 16.5 端到端验收场景

1. 新建旅行，AI 一次问一个必要问题，并用 mutation 持久化已确认事实。
2. 信息足够后出现“开始实施初稿”，但 AI 不自动进行长规划。
3. 点击或自然语言确认后，00 一次生成完整 draft。
4. draft 的每一天都有开始、主要地点和结束，地图由代码 query/geocoder/scorer 自动解析并显示完整线路。
5. 聊天调整两天顺序，00 只返回必要 mutation；未变内容和坐标保持不变，只更新必要路线边和依赖失效。
6. 出现“开始细化方案”，确认后 01 每批处理两天。
7. 第一批完成后，对应 Day 立即变为 detailed；服务端正式 ID 和 canonical Day 回灌同一线程，再处理下一批。
8. 全部 Day 完成后 stage=detailed。
9. detailed 阶段修改单个活动，其余日期、地点和地图保持不变；受影响动态事实按规则失效或重新核验。
10. 地点候选有歧义时先由代码筛选，必要时 02 快速判断；用户不需要点击候选。
11. 停止或失败不会覆盖最后合法 itinerary，也不会产生伪完成状态；再次细化按 Day.detailLevel 计算剩余日期。

## 17. 最终验收标准

重构完成后应满足：

- 仓库中只有 2 个核心 Prompt 和 1 个短地图候选消歧 Prompt。
- 不存在独立地图标注 Agent；地图 query、候选过滤、评分、Visit/Edge、指纹和复用全部由代码完成。
- 旅行方案只有一个 Itinerary Schema，没有 requirements、skeleton、route、recommendation、draft plan、detail plan 等并行核心模型。
- 业务阶段只有 itinerary 内的 planning、draft、detailed；逐日细化完成度由 `Day.detailLevel` 表达，不新增第四业务阶段。
- 所有规划、确认和修改通过聊天完成。
- 首次 draft 可以输出完整 itinerary；已有 itinerary 的普通修改使用受限 PlannerMutation，不重吐全量 JSON。
- 服务端 canonical itinerary 是唯一状态真相；01 每批后必须把正式 ID 和 canonical 结果回灌模型线程。
- 初稿是真正可浏览、可制图的逐日完整路线。
- 01 在同一线程中一次理解全程、每批返回两天，并能逐批显示。
- 动态事实具有 verified / estimated / unverified 结构化状态，日期、顺序、地点和交通方式变化会触发确定性依赖失效。
- 地图访问和路线图结构由代码从 stops 派生。
- ResolvedPlace 是明确的地图派生状态；地点未变化时复用坐标，边未变化时复用路线几何。
- 无引用 Place 会被自动垃圾回收。
- 不存在“请选择地点”或另一套推荐/调整流程。
- 旧 Prompt、旧 Schema、旧 API、旧 UI、旧迁移和无引用资源已删除。
- 登录、安全、私人数据边界、版本历史和基础地图能力保持有效。

## 18. 已确认决策汇总

- 开始阶段的结构化需求并入 itinerary。
- itinerary 从 planning 阶段即存在。
- 初稿和详细行程使用同一 Schema。
- 每日采用有序 Stop 模型，开始和结束也是 Stop。
- 业务 stage 只保存在 itinerary，仍然只有 planning / draft / detailed。
- Day 增加 `detailLevel=draft|detailed`，用于表达两日批处理期间的真实逐日完成度。
- 00 在 planning 和已有行程修改时输出受限语义 mutation；只有首次明确确认生成 draft 时输出完整 itinerary。
- 00 可以直接最小修改 detailed itinerary；若修改导致某 Day 不再满足 detailed，则该 Day 和整体 stage 按规则降级。
- 稳定 ID 最终由服务端控制。
- 服务端 canonical itinerary 是唯一状态真相；模型线程不能替代数据库状态。
- 01 同一线程读取一次完整上下文，每批细化两天。
- 01 每批应用后必须把临时 ID 映射、canonical Days、Place 变化、依赖失效摘要和新 generation 回灌同一线程。
- 每批完成后立即同步日程和地图。
- 动态价格、时间、交通等事实使用 verified / estimated / unverified 结构化核验状态。
- 日期、Stop 顺序、Place 身份、交通方式等变化由服务端执行确定性依赖失效。
- `requestedDurationDays` 只表示未确定完整日期时的用户期望；实际旅行天数由 start/end 代码计算，不重复持久化。
- `period` 使用固定枚举；日期使用 YYYY-MM-DD；时间使用当地时间 HH:mm。
- 保存后自动清理无引用 Place。
- 地图图结构由代码生成。
- 删除原地图标注 Agent；不再使用 AI 生成地图查询词或地点别名。
- 地图查询词由代码从 Place 确定性生成，多 query 尝试后再做候选过滤与评分。
- ResolvedPlace 明确作为地图派生状态保存，并用 `placeId + geoFingerprint` 控制复用。
- 代码优先筛选地图候选。
- 只保留一个极短的地图候选消歧 Prompt 处理剩余歧义。
- 地图候选消歧 Agent 不能搜索、生成 query 或自造坐标。
- 删除手工地点选择和独立地图 AI 操作入口。
- `trips.title` 可作为从 itinerary 同事务投影的派生索引字段，但不是事实来源。
- 实施时删除全部 private_data、无备份、从头开始；仅在新代码准备完成后执行，并加入 realpath、非 symlink、sentinel 三重保护。
