# TravelPlanner 分阶段 AI 对话与动作 Agent 重构计划

> 状态：已复审修订，待实施  
> 日期：2026-08-30  
> 适用范围：TravelPlanner v3 右侧工作区、AI 提示词、任务编排、对话持久化与性能诊断  
> 产品基线：不改变 Candidate-first、受控 Proposal、地图 Provider 负责坐标与路线的既有边界；不扩展 canonical `TripStage`；本次数据库切换不迁移旧数据

## 1. 目标与已确认决策

本次重构解决两个问题：

1. AI 入口缺少阶段确定性，用户不容易判断当前对话能做什么；
2. 简单对话仍加载完整规划提示词、完整计划和 reasoning，导致不必要的延迟。

已确认的产品与技术决策：

- 用户可见流程固定为 `需求 → 目的地 → 兴趣点 → 行程` 四个 `ConversationStage`；
- `ConversationStage` 只是右侧工作区、对话、消息、线程和动作的命名空间，不写入 `TravelPlanDocument`，也不替换现有 canonical `TripStage`；
- canonical `TripStage` 保持现有三阶段模型，不新增 `requirements / destinations / interests / itinerary`；
- 四个 ConversationStage 分别拥有独立对话、独立提示词、独立消息历史和独立 Codex 线程；
- 新建旅行默认进入“需求”，并默认展开需求对话；
- 所有 AI 交互入口集中在右侧工作区，不在地图、弹窗或其他区域再创建第二套 AI 输入入口；
- 页面主 CTA 仍是生成与推进流程的主要入口，对话是阶段内的自然语言入口；
- 阶段对话只负责回答、澄清、判断是否需要联网和识别动作，不直接修改计划；
- 对话模型使用 `reasoning.effort: none`，普通对话不联网；
- 需要时效性核验的咨询先返回 `web_required`，由服务端执行第二次联网调用后再产生最终回答；
- 动作统一进入 `AiAction` 状态机，但动作执行器分为 `ai` 与 `deterministic`；
- 只有需要模型推理、研究或语义重组的动作调用动作 Agent；精确删除、preference、拖拽、明确移动等确定性动作不再重复调用 AI；
- 每个 AI 操作动词使用独立提示词，不再使用一个大提示词通过 `taskMode` 包办所有动作；
- AI 动作按复杂度使用 `low / medium / high` reasoning；
- AI 生成的修改类结果必须生成可预览 Proposal，用户 Apply 后才写入正式计划；
- 明确的主 CTA 本身视为用户确认：点击后直接创建并执行对应 Action，不再额外弹一次“确认生成”卡；
- 由自然语言识别出的动作先展示 Action Card，用户确认后才执行；需求阶段的 `requirements.update / requirements.clear` 是例外，识别并通过受控参数校验后直接执行确定性 Action；
- 目的地阶段在 UI 上可以表达“城市 / 区域 / 岛屿 / 独立停留地”，但本次不扩展 `PlaceKind`；后台 Macro 目的地仍统一使用现有 `kind=city` 表达；
- 行程阶段只能使用 canonical 中已经存在且允许参与规划的地点，不允许行程 Agent 偷偷创建 `newPlaces` 或 `newCandidates`；需要新地点时必须返回兴趣点阶段；
- 本次数据库升级采用破坏性 cutover：**不实现 v2 → v3 数据迁移，不保留现有本地旅行、对话、线程、任务或 Proposal 数据**；
- 运行时代码不得因为版本不匹配而静默删除、覆盖或自动重建旧数据库；旧库清理属于明确的 cutover 步骤；
- 所有提示词重新命名为“分类目录 + 中文语义文件名”，不再依赖数字编号。

## 2. 两套 Stage 的边界

### 2.1 ConversationStage

新增：

```ts
type ConversationStage =
  | "requirements"
  | "destinations"
  | "interests"
  | "itinerary";
```

它只用于：

- 右侧工作区当前页签/步骤；
- 对话 Prompt；
- 消息历史；
- Codex thread；
- Action 所属阶段；
- 阶段白名单输入；
- UI 草稿、快捷提示和状态显示。

### 2.2 canonical TripStage

现有 `TravelPlanDocument` 的 `TripStage` 保持不变。`ConversationStage` 不得：

- 写入 canonical `stage` 字段替换现有值；
- 改变已有 PlanCommand 的阶段语义；
- 迫使现有 Candidate / Day / Refinement 状态机变成四阶段；
- 作为 canonical 事实来源。

需求、目的地和兴趣点主要操作 TripFacts、Macro/Micro Candidate 与 Place；行程阶段主要操作 Day、Stop、Anchor 与 Refinement。用户可以返回更早的 ConversationStage，但实际动作是否允许执行仍由 canonical 前置条件、Scope Policy 和 generation 校验决定。

## 3. 总体架构

```text
右侧阶段对话 Agent
  - reasoning = none
  - 普通回答 / 澄清
  - 判断是否需要 web
  - 识别一个明确动作
  - 不生成 PlanCommand
          │
          ├─ reply / clarification
          │
          ├─ web_required
          │      └─ 服务端第二次联网调用 → 最终回答
          │
          └─ action
                 │
                 ├─ 需求对话确定性 Action → 直接执行
                 ├─ 其他对话来源 → 待确认 Action Card
                 └─ 主 CTA → 点击本身即确认
                              │
                              ▼
                       AiAction Registry
                              │
              ┌───────────────┴────────────────┐
              ▼                                ▼
      deterministic executor               ai executor
      - 精确命令                            - 独立 AI 提示词
      - 不再调用模型                        - 临时独立线程
      - Schema / Scope / CAS                 - 分级 reasoning / web
              │                                │
              │                         ┌───────┴────────┐
              │                         ▼                ▼
              │                    生成/发现结果       修改 Proposal
              │                         │                │
              └───────────────┬─────────┘                │
                              ▼                          ▼
                    Canonical / Candidate Store      Apply / Reject
```

服务端是唯一调度者。模型不能自行创建 Agent、选择其他提示词、执行命令、调用文件/Shell/MCP 或绕过确认流程。

## 4. 用户交互设计

### 4.1 四阶段固定入口

| 阶段 | 对话名称 | 用户看到的边界 | 内部主要对象 | 主要按钮 |
|---|---|---|---|---|
| 需求 | 旅行需求 AI | 旅行事实、偏好和约束 | TripFacts | 生成目的地建议 |
| 目的地 | 目的地 AI | 城市、区域、岛屿、独立停留地 | Macro Candidate，内部统一 `kind=city` | 生成详细兴趣点 |
| 兴趣点 | 兴趣点 AI | 现有目的地下的具体地点 | Micro Candidate / Place | 生成行程与路线 |
| 行程 | 行程 AI | Day、Stop、Anchor、顺序、细化、动态核验 | Days / Stops / Route status | 更新路线、细化行程 |

交互规则：

- 新建旅行后固定进入需求阶段，对话框默认展开并聚焦输入框；
- 所有 AI 输入、Action Card、Proposal 和主要推进 CTA 都只存在于右侧工作区；
- 地图继续负责展示、选择和 Provider 交互，不增加独立 AI 对话入口；
- 切换阶段时同步切换助手名称、边界提示、消息历史、输入草稿和阶段线程；
- 每个阶段未发送草稿只保存在该阶段页面内存中，不跨阶段复用；
- 删除现有全局“对话 / 调整”双模式；
- Proposal 和动作状态显示在触发它们的对应消息下；CTA 触发的动作显示在当前阶段任务区；
- AI 公开任务进度与底部阶段 AI Dock 共用同一标题行，折叠或展开对话都不再额外占用顶部任务条；
- 目的地和兴趣点共用紧凑 Candidate Panel：不重复显示阶段标题与说明，全选和手动添加位于同一工具行；
- 地点名称语言是旅行级设置，固定放在应用顶部 AI 模型选择左侧，并在四个 ConversationStage 保持可用；
- 阶段外请求不执行。例如在行程阶段要求发现新景点时，只解释应返回兴趣点阶段，并提供唯一的右侧阶段切换入口；
- CTA 与对话识别出的动作必须进入同一个 `AiAction` 执行服务，不能维护两套执行逻辑。

### 4.2 动作确认规则

除需求阶段的受控确定性更新外，**自然语言识别出的动作**先显示 Action Card：

```text
动作：替换目的地
范围：目的地阶段 · 陶波
请求：用罗托鲁瓦替换陶波
影响：可能移除陶波及其下属兴趣点，并影响现有行程
执行：AI · 允许联网
[取消] [确认并生成方案]
```

规则：

- `requirements.update / requirements.clear` 在对话识别、参数 Schema 和 generation 校验通过后直接启动确定性执行器，不显示二次确认卡；
- 其他对话 Action 在用户确认前不启动执行器；
- AI 发现、推荐和首次生成类动作，确认后可在服务端校验通过时保存结果；
- AI 删除替代方案、重新规划、优化、修复、细化等修改类输出只能生成 Proposal；
- Proposal 必须显示 diff，用户再次 Apply 后才修改 canonical plan；
- 确定性动作在用户已经明确表达目标并完成确认后直接执行受控命令，不再调用第二个 AI；
- 页面主 CTA（例如“生成目的地建议”“生成行程”）的点击行为本身就是确认，不再额外弹重复确认卡；
- 旅行需求仍为空时，“生成目的地建议”保持禁用，服务端也拒绝创建对应 Action；
- 页面卡片中的 preference、拖拽、地图选择、明确删除等现有精确交互继续走确定性代码。

## 5. 提示词目录与注册表

旧的 `00-旅行规划Agent.md`、`01-行程细化Agent.md`、`02-地图候选消歧Agent.md`、`03-兴趣点发现Agent.md` 最终全部删除，不保留兼容别名。实施中允许新旧结构短暂并存，但在最终 cutover 前旧 Runtime 仍必须可用；最终验收时不得存在旧文件引用。

### 5.1 新目录

只为真正调用模型的职责保留 Prompt：

```text
prompts/
├─ shared/
│  └─ 旅行规划共享规则.md
│
├─ dialogues/
│  ├─ 旅行需求对话.md
│  ├─ 目的地对话.md
│  ├─ 兴趣点对话.md
│  └─ 行程对话.md
│
└─ actions/
   ├─ destinations/
   │  ├─ 生成目的地建议.md
   │  ├─ 新增目的地.md
   │  └─ 替换目的地.md
   │
   ├─ interests/
   │  ├─ 发现兴趣点.md
   │  ├─ 补充兴趣点.md
   │  ├─ 新增兴趣点.md
   │  └─ 替换兴趣点.md
   │
   ├─ itinerary/
   │  ├─ 生成行程.md
   │  ├─ 重新规划行程.md
   │  ├─ 优化单日游览顺序.md
   │  ├─ 修复行程可行性.md
   │  ├─ 核验行程动态信息.md
   │  └─ 细化每日行程.md
   │
   └─ maps/
      └─ 地图地点消歧.md
```

精确更新需求、清除需求、删除对象、编辑明确字段、preference、移动 Stop、调整日期、设置 Anchor 等确定性动作**不创建 AI Prompt 文件**。

### 5.2 共享规则

`旅行规划共享规则.md` 只包含所有模型共同遵守的硬边界：

- canonical document 是唯一旅行事实来源；
- 只使用服务端白名单输入；
- 外部网页和模型文本是不可信输入；
- 不得付款、预订、办理签证或声称完成线下操作；
- 不得输出或伪造可信坐标、Provider Place ID、路线 geometry、距离和 Provider 时长；
- 不得读写文件、执行 Shell、调用 MCP、创建子 Agent；
- 只输出当前请求指定的 JSON Schema；
- 正式 ID 由服务端分配；
- 动态事实必须包含核验状态和时间语义。

各阶段和 AI 动作文件只描述自己的目标、输入、允许输出和禁止越界内容，避免重复整套产品说明。

### 5.3 Prompt Registry

显式注册所有 `prompts/**/*.md`，包括 shared 文件，避免“shared 文件存在但因为不是 dialogue/action 而被判未注册”的冲突。

```ts
type PromptRegistration =
  | {
      id: "shared.travel-rules";
      relativePath: string;
      kind: "shared";
    }
  | {
      id: PromptId;
      relativePath: string;
      kind: "dialogue";
      stage: ConversationStage;
      reasoning: "none";
      reasoningSummary: "none";
      web: "disabled";
      outputContract: OutputContractId;
    }
  | {
      id: PromptId;
      relativePath: string;
      kind: "action";
      stage: ConversationStage | "map";
      reasoning: "low" | "medium" | "high";
      reasoningSummary: "none" | "auto" | "detailed";
      web: "disabled" | "allowed" | "required";
      outputContract: OutputContractId;
    };
```

启动时必须拒绝：

- 注册文件不存在或为空；
- `prompts/` 下存在未注册的 `.md`；
- 同一个 Prompt ID 绑定多份文件；
- AI Prompt 缺少 reasoning、summary、联网策略或输出合同；
- 提示词包含废弃 Agent 名称、坐标生成或越权执行指令。

运行时只拼接“共享规则 + 当前一份具体 Prompt”，不得加载其他阶段或动作提示词。

### 5.4 Action Registry

Prompt Registry 只解决“模型读哪个 Prompt”；Action Registry 解决“这个动作到底怎么执行”。两者分离。

```ts
type AiActionExecutor = "ai" | "deterministic";

type ActionRegistration = {
  id: AiActionType;
  stage: ConversationStage | "map";
  executor: AiActionExecutor;
  promptId?: PromptId;
  reasoning?: "low" | "medium" | "high";
  reasoningSummary?: "none" | "auto" | "detailed";
  web?: "disabled" | "allowed" | "required";
  inputContract: InputContractId;
  outputContract: OutputContractId;
  scopePolicy: ScopePolicyId;
  resultPolicy: "save_result" | "proposal_required" | "deterministic_apply";
};
```

注册完整性规则：

- `executor=ai` 必须且只能绑定一个 action Prompt；
- `executor=deterministic` 不得绑定 Prompt、reasoning 或 web 策略；
- 每个动作必须有固定输入合同、输出合同、Scope Policy 和 resultPolicy；
- 同一 Action ID 不允许根据调用入口偷偷切换 executor；
- UI 主 CTA 与聊天动作只能决定是否需要确认，不能改变动作的 executor 或 Scope。

## 6. 对话 Agent 合同、联网与线程

四个对话 Agent 统一：

- `reasoning.effort: none`；
- `reasoning summary: none`；
- 首次调用禁用网页搜索；
- 持久化阶段专属 Codex thread；
- 精简阶段白名单输入；
- 不输出 PlanCommand、Proposal 或正式 mutation。

如果底层模型不支持 `effort=none` 或 `summary=none`，服务端必须根据模型能力安全降级，不能发送不支持的参数。Structured AI Runner 必须允许调用方显式传入 reasoning summary，不能继续被全局 `summary=detailed` 覆盖。

### 6.1 StageDialogueOutput

```ts
type StageDialogueOutput = {
  schemaVersion: 1;
  result:
    | {
        type: "reply";
        assistantMessage: string;
      }
    | {
        type: "clarification";
        assistantMessage: string;
      }
    | {
        type: "web_required";
        queryIntent: string;
        reason: string;
      }
    | {
        type: "action";
        assistantMessage: string;
        actionType: AiActionType;
        parameters: Record<string, unknown>;
        targetIds: string[];
        impactSummary: string;
      };
};
```

重要规则：

- `web_required` **不是最终回答**，不得同时带未经核验的最终结论；
- 服务端收到 `web_required` 后，在同一 ConversationStage 发起第二次联网调用；
- 第二次调用才生成用户可见最终回答；
- 时效性回答必须带服务端记录的核验时间与核验状态；
- 如果用户请求的是操作，对话 Agent 只识别动作，不代替 Action executor 做研究。

建议联网回答合同：

```ts
type WebDialogueOutput = {
  schemaVersion: 1;
  assistantMessage: string;
  verification: {
    status: "verified" | "partially_verified" | "unverified";
    checkedAt: string;
  };
};
```

### 6.2 阶段线程生命周期

每个 `(tripId, ConversationStage)` 最多存在一个当前可写 thread。同一阶段对话 turn 必须串行化，禁止两个并发 turn 同时写入同一个 thread。

`stage_conversation_threads` 除 `thread_id` 外记录：

- `prompt_hash` / `prompt_version`；
- `context_generation`；
- `turn_count`；
- `created_at` / `updated_at`。

以下情况轮换新 thread，但数据库消息历史继续保留：

- Prompt hash/version 改变；
- 阶段输入结构版本改变；
- thread 失效或服务端无法继续；
- `turn_count` 达到配置上限（建议初始 `STAGE_THREAD_MAX_TURNS=40`）；
- 明确触发上下文重置。

模型 thread 是可轮换缓存，不是真实消息历史来源。

## 7. Action 分类、Reasoning 与联网策略

### 7.1 需求动作

| Action ID | Executor | Prompt | Result |
|---|---|---|---|
| `requirements.update` | deterministic | 无 | `deterministic_apply` |
| `requirements.clear` | deterministic | 无 | `deterministic_apply` |

对话 Agent 负责把自然语言解析成受控参数；确认后由 TripFacts 确定性服务执行 Schema、generation CAS 和版本修订。

### 7.2 目的地动作

| Action ID | Executor | Reasoning | Web | Result |
|---|---|---|---|---|
| `destination.generate` | ai | medium | required | save_result |
| `destination.add` | ai | low | allowed | proposal_required |
| `destination.remove` | deterministic | - | - | deterministic_apply |
| `destination.replace` | ai | medium | allowed | proposal_required |
| `destination.edit` | deterministic | - | - | deterministic_apply |
| `destination.preference` | deterministic | - | - | deterministic_apply |

边界：

- 目的地动作只处理 Macro Candidate；
- 本次不扩展 `PlaceKind`，后台 Macro 统一继续使用 `kind=city`；
- UI 可以把某个 Macro 显示为城市、岛屿、区域或独立停留地，但这只是产品文案，不引入 `region / island / area` 新 kind；
- 不得生成或修改 Micro、Day、Stop、坐标或路线。

### 7.3 兴趣点动作

| Action ID | Executor | Reasoning | Web | Result |
|---|---|---|---|---|
| `interest.discover` | ai | medium | required | save_result |
| `interest.supplement` | ai | medium | required | save_result |
| `interest.add` | ai | low | allowed | proposal_required |
| `interest.remove` | deterministic | - | - | deterministic_apply |
| `interest.replace` | ai | medium | allowed | proposal_required |
| `interest.edit` | deterministic | - | - | deterministic_apply |
| `interest.preference` | deterministic | - | - | deterministic_apply |

兴趣点 AI 动作必须绑定一个现有且允许参与推荐的 Macro Candidate。发现与补充可以联网研究；不得输出可信坐标、Provider ID、Provider 评分或路线数据。

### 7.4 行程动作

| Action ID | Executor | Reasoning | Web | Result |
|---|---|---|---|---|
| `itinerary.generate` | ai | high | disabled | save_result |
| `itinerary.replan` | ai | high | disabled | proposal_required |
| `itinerary.stop.add` | deterministic | - | - | deterministic_apply |
| `itinerary.stop.remove` | deterministic | - | - | deterministic_apply |
| `itinerary.stop.replace` | deterministic | - | - | deterministic_apply |
| `itinerary.stop.move` | deterministic | - | - | deterministic_apply |
| `itinerary.day.reorder` | deterministic | - | - | deterministic_apply |
| `itinerary.edit` | deterministic | - | - | deterministic_apply |
| `itinerary.anchor.set` | deterministic | - | - | deterministic_apply |
| `itinerary.day.optimize` | ai | high | disabled | proposal_required |
| `itinerary.repair` | ai | high | disabled | proposal_required |
| `itinerary.verify` | ai | medium | required | proposal_required |
| `itinerary.refine` | ai | medium | allowed | proposal_required |

强制合同：

- 行程 AI 只能引用 canonical 中已存在、未排除且允许参与规划的 Candidate/Place；
- 行程输出 Schema 删除 `newPlaces` / `newCandidates` 能力；
- 如果用户的目标必须新增地点，返回结构化 `requiresStage: "interests"`，不能静默创建新 Place；
- `itinerary.refine` 也属于修改类 AI 动作，必须 Proposal → Apply，不再保留模糊的“Detail preview 但不是 Proposal”第三种机制；
- AI 只决定语义安排；结构变化应用后由 Route Provider 重新计算真实路线。

### 7.5 地图动作

| Action ID | Executor | Reasoning | Web | Result |
|---|---|---|---|---|
| `map.disambiguate` | ai | low | disabled | save_result |

地图 Agent 只能在服务端给出的 Provider candidates 中选择、请求更好的搜索提示或保持 unresolved，不得自行搜索或生成坐标。

### 7.6 UI 原生确定性动作

以下操作不需要额外 AI：

- Apply、Reject、Undo Proposal；
- 页面卡片 preference 修改；
- 拖拽产生的明确移动/排序命令；
- 手工添加已完整填写的地点；
- 手工地图选择和坐标输入；
- Route Provider 距离、时间和 geometry 计算；
- 页面 ConversationStage 切换；
- 已知对象的精确删除确认。

对话 Agent 可以把对应自然语言识别为确定性 Action，但确认后必须调用同一确定性服务，不能为了“流程统一”再浪费一次模型调用。

## 8. 阶段输入白名单与上下文预算

每个 Agent 只接收必要状态：

- 需求对话/动作：TripFacts、必要的阶段摘要、用户消息；
- 目的地对话/动作：TripFacts、Macro Candidate 与对应 Place 精简摘要、当前选中 Macro；
- 兴趣点对话/动作：Macro 列表、相关 Micro Candidate/Place 摘要、Coverage、当前选中 Macro/Micro；
- 行程对话：Day 索引、Stop/Place 精简引用、路线状态、当前选中 Day/Stop；
- 单日行程 AI 动作：目标 Day 完整结构、必要候选摘要、相邻 Day 摘要；
- 整体行程 AI 动作：参与规划的 Candidate、有效 Resolution、规划区域与必要地理聚类；
- 地图消歧：单个语义 Place 和服务端候选列表。

禁止把“Prompt 文件很短”误当作“请求上下文一定很小”。必须同时控制：

- Prompt bytes；
- 序列化 Stage State bytes；
- Candidate / Place / Day 条目数量；
- 单条文本字段最大长度。

超过预算时优先按当前 selection、目标 Day、相关 Macro 做窗口化，再使用服务端生成的结构化摘要；不得重新退回“把完整 canonical plan 全塞给对话 Agent”。可在 `AiTask.metadata` 记录 `inputBytes`、条目计数等非内容型诊断信息，但不得记录用户正文或 Prompt 全文。

## 9. API 与公共数据合同

```ts
type AiActionStatus =
  | "pending_confirmation"
  | "executing"
  | "awaiting_apply"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded"
  | "applied"
  | "rejected";

type AiTaskAgent = "dialogue" | "action" | "map";
```

旧的 `running_agent` 改为通用 `executing`，因为确定性 Action 也使用同一状态机。

`AiActionType` 必须是第 7 节 Action ID 的封闭枚举，并由 Action Registry 保证每个动作唯一对应 executor、输入/输出合同、Scope Policy、resultPolicy；只有 `executor=ai` 的动作才绑定 Prompt、reasoning 与 web 策略。

新增/调整接口：

```text
POST /api/trips/:tripId/conversations/:stage/turns
POST /api/trips/:tripId/actions/:actionId/confirm
POST /api/trips/:tripId/actions/:actionId/cancel
```

主 CTA 可以调用现有生成端点的适配层，也可以直接创建 Action，但最终必须进入同一个 Action execution service；不得另写一套 Macro/Micro/Plan 执行逻辑。

对话请求包含 `message` 和当前 `selection`。服务端必须重新验证 selection 是否属于当前阶段，不能信任前端提供的 Scope 或 ID。

修改类 AI 动作继续使用统一 Proposal Apply/Reject/Undo 接口。整体重新规划必须使用受控 itinerary replacement Proposal，不直接覆盖 Days。

## 10. Action 持久化、消息关联与状态机

### 10.1 ai_actions 最小字段

`ai_actions` 至少包含：

- `id`；
- `trip_id`；
- `stage`；
- `action_type`；
- `executor`；
- `origin`：`conversation | cta`；
- `source_message_id`：聊天触发时必填，CTA 触发时为 null；
- validated parameters；
- target IDs；
- server-derived Scope；
- `base_generation`；
- `status`；
- `task_id`；
- `proposal_id`；
- result reference；
- started/updated/completed timestamps；
- error summary。

`source_message_id` 是 UI 刷新后把 Action Card / Proposal 恢复到正确消息下的持久关联，不能只存在前端内存。

### 10.2 状态机

```text
conversation action:
  pending_confirmation
    ├─ cancel → cancelled
    └─ confirm ─┐
                ▼
cta action: ─→ executing
                ├─ deterministic mutation → applied
                ├─ ai generation result → completed
                ├─ ai mutation result → awaiting_apply
                ├─ generation changed → superseded
                └─ error → failed

awaiting_apply
  ├─ apply → applied
  ├─ reject → rejected
  └─ generation changed → superseded
```

约束：

- 每个 Action 保存 `baseGeneration`；
- confirm、开始执行、结果保存和 Proposal apply 都重新检查 generation；
- canonical plan 变化后，受影响的 pending/executing Action 与 pending Proposal 必须按 Scope 判断失效；
- 同一旅行同时只允许一个执行中的 **AI Action**；确定性 Action 可以执行，但任何 canonical 改动都必须让冲突中的 AI Action 在结果落库前变为 superseded；
- 用户可以停止运行中的 AI Task；
- 自动修复结构化输出最多沿用现有两次修复上限；
- 任何失败必须保留可见任务状态，不制造伪成功。

### 10.3 重复确认与幂等

不能使用“先 SELECT 状态，再 UPDATE”的非原子流程。

确认必须通过数据库条件更新或等价事务实现状态抢占，例如语义上：

```sql
UPDATE ai_actions
SET status = 'executing'
WHERE id = ?
  AND status = 'pending_confirmation'
  AND base_generation = ?;
```

只有成功抢到状态的请求可以启动 executor。重复 confirm、重复 CTA 请求、网络重试不得启动第二个 AI Task 或应用第二次 deterministic command。

## 11. 数据库 v3：全新建库，不做迁移

本次用户明确选择：**不迁移、不保留当前 v2 本地数据。**

将 `private_data/travel-v2.sqlite3` 的内部数据库版本升级为 3，但**不实现 v2 → v3 migration path**。

### 11.1 v3 Schema

新建 v3 数据库时包含：

- `messages.stage` 非空；
- `stage_conversation_threads`：
  - `trip_id`
  - `stage`
  - `thread_id`
  - `prompt_hash`
  - `prompt_version`
  - `context_generation`
  - `turn_count`
  - `created_at`
  - `updated_at`
  - 主键 `(trip_id, stage)`；
- `ai_actions`：按第 10.1 节字段；
- `AiTask.agent` 使用新的 `dialogue | action | map` 语义，并在 metadata 中记录 `stage` / `actionType`；
- Action Agent 使用临时独立 thread，不保存为阶段对话 thread；
- duplicate trip 只复制正式旅行计划，不复制对话、thread、Action、Task 或 Proposal；
- permanent delete 使用外键级联清理新增记录。

### 11.2 运行时数据库版本规则

Store 初始化只能有三种结果：

1. 数据库不存在：创建完整 v3 Schema；
2. 数据库为 version 3 且 Schema 完整：正常打开；
3. 任何其他版本、旧 v2 Schema、未知版本或损坏 Schema：**fail closed，停止读写并给出明确错误**。

运行时代码禁止：

- 自动迁移 v2；
- 因为版本不匹配而静默 DROP/DELETE；
- 静默创建空表后继续运行；
- 从旧库复制部分数据造成半迁移状态。

### 11.3 最终 cutover

最终切换时执行一次明确的破坏性步骤：

1. 停止使用旧 Runtime；
2. 明确删除或人工移走现有 `private_data/travel-v2.sqlite3`；
3. 启动新 Runtime；
4. 由 Store 创建全新 v3 Schema；
5. 验证数据库 version、Schema 和新建旅行流程；
6. 旧数据不进入新库，也不属于本次验收范围。

此破坏性步骤只能存在于明确的部署/本地 cutover 流程，不能隐藏在正常应用启动逻辑中。

不把任何数据库内容复制进 Git、日志、测试夹具或 Prompt。

## 12. 性能优化与耗时诊断

### 12.1 已确认的延迟来源

现有一次“处理旅行需求”实测约 22.583 秒：

- thread/turn 启动约 5.119 秒；
- 模型生成、结构化校验和落库约 17.463 秒；
- 本次没有结构化修复重试；
- 原实现发送约 8.7 KB 的完整多模式 Prompt 和完整 canonical plan；
- 原 conversation 开启 live web search，并使用全局 reasoning 设置。

### 12.2 加速规则

- 对话 Prompt 目标控制在约 30–50 行、3 KB 内；
- 对话只注入阶段精简状态；
- 同时控制 Stage State bytes 和对象条目数；
- 普通对话不联网、不 reasoning；
- 只有 `web_required` 才进行第二次联网调用；
- AI Action Prompt 只描述一个动词和一个输出合同；
- AI Action 使用临时 thread，避免阶段对话历史污染执行上下文；
- 阶段对话 thread 按第 6.2 节轮换，避免长期上下文无限增长；
- 原全局 reasoning 下拉改为“自动按动作”，避免和 Registry 策略冲突；
- Structured AI Runner 必须接受每次调用的 `effort`、`summary`、`web` 配置，不能由一个全局默认值覆盖。

不能承诺外部模型固定延迟上限。验收目标是消除可控开销，并准确展示剩余延迟来源。

### 12.3 分段耗时

对话任务和 AI Action Task 在 `AiTask.metadata.timing` 中记录：

```ts
type AiTaskTiming = {
  startupMs?: number;
  webMs?: number;
  generationMs?: number;
  validationMs?: number;
  persistenceMs?: number;
  totalMs: number;
  failedPhase?: "startup" | "web" | "generation" | "validation" | "persistence";
};
```

允许额外记录 `inputBytes`、输入对象计数、是否冷 thread、是否发生 thread rotation 等非内容诊断信息。

任务弹窗显示“启动 / 联网 / 生成 / 校验 / 保存 / 总计”，不得记录 Prompt 全文、用户消息、隐藏推理、Token、Cookie、账户信息或旅行私人数据。

## 13. Scope 与安全策略

- 需求 Action 只能修改 TripFacts；
- 目的地 Action 只能操作 Macro Candidate 和对应语义 Place，Macro 内部继续统一 `kind=city`；
- 兴趣点 Action 只能操作现有 Macro 下的 Micro Candidate；
- 行程 Action 只能操作允许范围内的 Day、Stop、Anchor 和排程，并禁止生成新 Place/Candidate；
- preference、拖拽、精确删除等直接 UI 操作继续由确定性命令处理；
- AI Proposal 的 Scope 必须由服务端根据 Action Registration 重新确定，不能接受模型自报 Scope；
- 修改 Candidate 或 Place 后继续触发已有 Resolution 失效和重新解析机制；
- 行程结构变化继续触发 Route Dirty；
- AI 不生成地图 Provider 数据；
- 交通班次、营业时间、价格、签证、医疗、天气和安全信息必须显示核验时间与状态；
- 不实现预订、付款、票务购买、签证办理或外部账户操作。

## 14. 实施顺序与原子 Cutover

实施阶段允许在开发分支中暂时保留旧 Runtime，但任何中间阶段都不能让“新 Prompt 已删除、旧 Runtime 还依赖它”或“DB 已升级、Runtime/UI 还没完成”这种半切换状态进入可运行主路径。

### Phase 1：公共合同与 Registry 骨架

- 新增 `ConversationStage`、StageDialogueOutput、AiActionType、AiActionExecutor、AiActionStatus；
- 明确 `ConversationStage ≠ TripStage`，不修改 canonical Stage 枚举；
- 实现 Prompt Registry / Action Registry 类型和完整性校验；
- 将 deterministic 与 AI executor 分离；
- Structured AI Runner 支持每次调用指定 effort / summary / web；
- 此阶段不删除旧 Prompt、不切换 DB、不切 Runtime。

### Phase 2：新 Prompt 与输出合同

- 创建 shared、四个 dialogues 和仅 AI Action 使用的 Prompt；
- 为每个 AI Action 定义专用输出合同；
- 从 itinerary 输出合同移除 `newPlaces` / `newCandidates`；
- 定义 `requiresStage: "interests"` 等结构化越界返回；
- 实现 Prompt Registry 的递归校验；
- 更新根目录 `AGENTS.md` 和相关文档的新规则，但旧 Prompt 暂时保留给旧 Runtime 使用。

### Phase 3：v3 Store 与持久化代码

- 定义全新 v3 Schema；
- 增加 stage messages、stage threads、ai_actions；
- 增加 source_message_id、executor、origin、task/proposal 关联；
- 实现 thread rotation 字段和并发约束；
- 实现 v3 新库创建和“非 v3 fail closed”；
- **不实现 v2 migration，不删除当前实际数据库，不进行 cutover**；
- 同步 duplicate、permanent delete、workspace 与重启恢复逻辑。

### Phase 4：服务端编排

- 实现四阶段对话调用；
- 实现 `web_required → 第二次联网 → 最终回答`；
- 实现 Action 创建、确认、取消和 Registry 分发；
- 将 requirements、Macro、Micro、Plan、Refinement、Map 接入统一 Action execution service；
- deterministic Action 不进入模型；
- AI Action 使用专属 Prompt、reasoning、web 和临时 thread；
- 实现 generation CAS、幂等 confirm、停止、失败恢复、superseded；
- 实现分段耗时与输入体积诊断；
- 此阶段仍不做最终 DB cutover。

### Phase 5：右侧工作区 UI

- 将右侧 Assistant 改为当前 ConversationStage 的唯一 AI 对话组件；
- 默认展开需求对话；
- 阶段切换时隔离历史、草稿、标题和快捷提示；
- 内联显示 Action Card、Task 状态和 Proposal；
- CTA 点击本身直接确认对应 Action，不弹重复确认卡；
- 从聊天识别出的动作保留 Action Card 确认；
- 目的地 UI 可以显示城市/区域/岛屿语义，但后台不新增 PlaceKind；
- 显示自动推理策略和分段耗时。

### Phase 6：原子 Cutover

确认 Phase 1–5 代码完整后一次性：

- 停止旧 Runtime；
- 明确删除/移走现有 v2 本地数据库；
- 启用 v3 Store；
- 切换到新 Prompt loader / Prompt Registry；
- 切换到四阶段 Conversation Runtime 与统一 Action service；
- 切换右侧新 UI；
- 创建全新 v3 DB 并做最小启动验证；
- 删除旧 00–03 Prompt、旧 loader、旧全局 conversation route、旧 `taskMode` 分发和旧单线程假设。

### Phase 7：文档与清理

- 全仓检查不存在旧 Prompt 路径或未注册 Prompt；
- 删除不再使用的 mode/tab 代码和旧 Agent 名称；
- 更新产品方案、实施状态、本地验收说明；
- 明确记录本次为破坏性数据库重置，不提供旧数据迁移。

## 15. 测试计划

### 15.1 Prompt 与 Registry

- shared / Dialogue / AI Action Prompt 全部显式注册；
- 每个 Prompt ID 恰好映射一份文件；
- 递归加载中文 UTF-8 路径；
- 缺失、空白、额外和重复文件启动失败；
- deterministic Action 不绑定 Prompt；
- AI Action 必须具有固定 reasoning、summary、web 和输出合同；
- 全仓最终不存在旧 00–03 文件名引用。

### 15.2 Stage 与对话

- `ConversationStage` 不修改 canonical `TripStage`；
- 四阶段消息和 Codex thread 互不混用；
- 同阶段并发 turn 被串行化；
- Prompt hash/version、turn 上限或失效能触发 thread rotation；
- rotation 后数据库消息历史不丢；
- Dialogue Agent 不能返回 PlanCommand 或直接 mutation；
- 普通对话不联网；
- `web_required` 第一轮不产生最终未核验回答；
- 第二次联网后才生成最终回答与 verification metadata；
- 跨阶段操作被拒绝并提示唯一正确入口；
- 当前模型支持时发送 `effort=none` 和 `summary=none`。

### 15.3 Action 与 Proposal

- 每个 Action 只能使用 Registry 指定 executor；
- deterministic Action 不启动模型 Task；
- AI Action 只能生成允许的输出；
- Macro、Micro、Day、Place 和 Map Scope 不越界；
- 自然语言 Action 确认前不执行；
- 主 CTA 不重复要求二次 Action Card 确认；
- confirm 的状态抢占是原子且幂等；
- 重复 confirm / 网络重试不会启动第二个 Task；
- 取消、停止、失败、superseded 正确；
- AI 修改类动作必须 Proposal Apply；
- `itinerary.refine` 使用 Proposal，不存在独立的非 Proposal preview 路径；
- itinerary Schema 无 `newPlaces` / `newCandidates`；
- 需要新地点时返回 `requiresStage=interests`；
- Route Provider 数据不进入 AI 输出合同。

### 15.4 数据库

- 数据库不存在时直接创建完整 v3 Schema；
- version 3 + 完整 Schema 正常打开；
- v2 数据库明确拒绝启动，不尝试迁移；
- 未知版本或损坏 Schema 停止读写；
- 遇到旧库不会静默删除或自动重建；
- stage message、thread、Action 的外键与索引正确；
- source_message_id 能恢复聊天消息下的 Action / Proposal；
- duplicate / permanent delete 行为正确；
- 不存在任何 v2 → v3 migration test，因为本次明确不支持迁移。

### 15.5 UI 与性能

- 新建旅行默认展示需求对话；
- AI 交互入口只存在于右侧工作区；
- 四阶段历史、草稿、标题、快捷提示和动作卡独立；
- CTA 与对话动作进入同一个 execution service；
- 目的地 UI 可显示区域/岛屿语义但后台仍为 `kind=city`；
- Proposal 可 Apply / Reject / Undo；
- 旧 Task 没有 timing metadata 时页面不崩溃；
- 新 Task 正确显示分段耗时；
- 记录输入体积但不记录输入内容；
- 使用冷启动、暖 thread、thread rotation 三种场景分别进行需求/目的地/兴趣点/行程 smoke，对比改造前延迟。

## 16. 验收标准

- 用户始终能从右侧工作区看出当前 ConversationStage、当前 AI 能做什么以及下一步 CTA；
- 不存在第二套 AI 输入入口；
- `ConversationStage` 与 canonical `TripStage` 清晰分离，TravelPlanDocument 不新增四阶段状态；
- 四阶段对话在消息、thread、Prompt、状态输入和草稿上完全隔离；
- thread 可安全轮换且历史消息仍由数据库恢复；
- Dialogue Agent 不 reasoning，普通对话不联网；
- `web_required` 不泄露未核验最终答案；
- 每个 AI 操作动词拥有唯一 Prompt；deterministic Action 不拥有 AI Prompt；
- CTA 不重复确认，聊天识别 Action 必须确认；
- 所有 AI 修改遵守 Schema、Scope、generation CAS 和 Proposal 边界；
- Action confirm 幂等，重复请求不会重复执行；
- Macro 内部继续统一 `kind=city`，本次不新增 region/island PlaceKind；
- itinerary Agent 不能创建新 Place/Candidate；
- Prompt 名称不再依赖数字或模糊职责；
- 旅行私人数据不进入 Git、日志、测试夹具或 Prompt；
- v3 使用全新数据库，本次不迁移旧 v2 数据；旧 v2 DB 被明确拒绝且不会被运行时代码静默删除；
- 最终 cutover 后旧 Prompt / loader / conversation route / taskMode 分发全部删除；
- 性能面板能够区分启动、联网、模型、校验和保存耗时，并可观察输入体积；
- 相关测试、typecheck、build 和真实 Codex smoke 均通过后方可视为实施完成。

## 17. 验证执行规则

实施过程中遵守项目限制：每轮最多执行一个与当前改动直接相关的轻量检查，不自动运行完整测试、Playwright、typecheck 或 build。

全部修改完成后，先向用户一次性列出建议运行的测试、覆盖范围和成本，再取得明确许可，随后执行：

- Prompt Registry / Action Registry / 合同相关 Vitest；
- v3 新库创建、旧 v2 拒绝和持久化相关 Vitest；
- Runtime、Scope、Action 状态机、幂等和 thread rotation 相关 Vitest；
- Web 对话和 Action Card 相关测试；
- `npm run typecheck`；
- `npm run build`；
- 真实 Codex 对话与 AI Action smoke；
- 必要的浏览器端完整四阶段验收。

未获许可的检查必须在交付说明中明确标记为未执行。
