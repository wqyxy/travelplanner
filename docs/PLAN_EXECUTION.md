# TravelPlanner PLAN 实施方案

> 对应目标：[`PLAN.md`](./PLAN.md)  
> 当前产品：[`PRODUCT.md`](./PRODUCT.md)  
> 当前技术：[`TECHNICAL.md`](./TECHNICAL.md)  
> 施工进度：[`PLAN_PROGRESS.md`](./PLAN_PROGRESS.md)

---

# 1. 目标

本次改造最终要把当前五步规划流程收敛成两部分：

```text
规划：旅行需求
行程：最终线路
```

完整体验应当是：

```text
填写旅行需求
→ 进入最终线路
→ AI 生成主要地点并直接加入最终线路
→ 用户排序、待定、不去、住 / 不住 / 多一晚
→ AI 生成详细地点并直接插入最终线路
→ Day、地图、交通路线都根据最终线路自动变化
→ 只有用户明确要求“优化”时，AI 才能重排已有地点
```

用户最终只维护一份线路：**最终线路**。

旧的 Candidate、Skeleton、stayDays、Step 4 兴趣点池和 Step 5 DayStop 不再分别承担用户线路编辑职责。

---

# 2. 与本次改造有关的当前状态

施工开始前，产品仍是五步：

```text
Step 1 旅行需求
Step 2 想去哪些地方
Step 3 路线和天数
Step 4 补充景点
Step 5 每日行程
```

代码中同时存在：

```text
Place
Candidate
Skeleton / Stay Block / stayDays
Day / Anchor / Stop
Macro Route
Detail Route
itineraryUpdateState
```

主要问题不是页面多，而是同一趟旅行的信息被拆成多份：

- Step 2 先生成 Candidate；
- Step 3 再生成住宿和天数；
- Step 4 又生成详细地点 Candidate；
- Step 5 再把这些地点安排进 Day；
- 地图和路线还分别依赖不同层级的数据。

这次改造的核心就是把这些需要同步的用户线路收成一份。

数据库当前 `user_version = 3`。旅行计划和历史 Revision 都直接保存完整计划 JSON，因此旧旅行和旧 Revision 的兼容必须一起处理。

---

# 3. 已确认的关键设计决定

## 3.1 最终线路节点

最终线路是一个有稳定顺序的线路节点数组。

一个线路节点表示：

> 一个现实地点在这趟线路中的一次出现。

同一个 Place 可以出现多次，每次有不同的线路节点 ID。

例如陶波多住一晚：

```text
A
→ 陶波 #1【日程分界】
→ 陶波 #2【日程分界】
→ B
```

因此不再用地点级 `stayDays=2` 表达“住两晚”。

## 3.2 Place 和地图定位继续保留

Place 继续表示现实地点。

PlaceResolution 继续保存地图定位结果。

线路节点只引用 Place，不复制地图 Provider 返回的坐标、距离、时长或路线 geometry。

同一个 Place 可以被多个线路节点引用，但仍只需要一份地点定位结果。

## 3.3 每个线路节点至少保存

```text
id
placeId
status: normal / tentative / no_go
endsDay
transportFromPrevious
```

详细规划已有的活动、时间、费用、备注等信息也允许随线路节点保留，避免功能倒退。

## 3.4 正常 / 待定 / 不去

三个状态：

```text
正常
待定
不去
```

待定和不去：

- 仍保留在线路原位置；
- 仍显示在地图；
- 暂时不参与当前有效 Day；
- 暂时不参与当前交通路线。

恢复正常后，直接在原位置重新生效。

只有“移除”才真正删除线路节点。

## 3.5 已确认：待定 / 不去时住宿分界暂时失效

例如：

```text
A → B【住】 → C
```

B 改成待定或不去后，有效线路变成：

```text
A → C
```

B 原来的日程分界仍然保存，只是暂时不参与 Day 划分。

B 恢复正常后，原分界自动恢复。

## 3.6 已确认：交通方式属于“到达当前节点”

例如：

```text
A —自驾→ X —步行→ B
```

X 改成不去以后：

```text
A —步行→ B
```

B 自己保存的交通方式继续用于新的上一有效地点 A。

X 恢复以后，原来的两段交通设置也一起恢复。

## 3.7 住 / 不住 / 多一晚

### 住

给当前正常线路节点增加日程分界。

### 不住

只取消当前节点的日程分界：

- 不删除地点；
- 不自动移动地点；
- 不自动让 AI 重排。

### 多一晚

在当前节点后面增加一个新的线路节点：

- 引用同一个 Place；
- 新节点形成新的日程分界；
- 不自动搬动其他景点。

例如：

```text
A → 陶波【住】 → B
```

变成：

```text
A → 陶波【住】 → 陶波【住】 → B
```

## 3.8 Day 是最终线路自动生成的结果

用户不直接维护 Day 编号。

系统根据：

```text
旅行起点
+
所有 normal 节点
+
normal 节点中当前生效的日程分界
```

自动生成 Day。

规则：

- tentative / no_go 节点跳过；
- 最后一天可以没有住宿分界；
- Day 编号连续重算；
- Day 可以继续作为地图和路线代码的读取结果，但不能再成为另一套独立线路。

## 3.9 Candidate 的过渡定位

Candidate 在改造过程中可以暂时保留，用于：

```text
旧旅行兼容
旧五步流程过渡
AI 研究过程
```

但新流程中的：

```text
生成主要地点
生成详细地点
手动新增地点
```

最终都必须直接进入最终线路。

## 3.10 旧旅行兼容

### 已有 Day 的旧旅行

优先从旧 Day 中保留：

- Stop；
- 当天终点；
- 每天之间的日程分界；
- 详细活动、时间、备注、费用信息。

最后一天不强制增加住宿分界。

### 只有 Candidate、还没有 Day 的旧旅行

按旧 Candidate 顺序转换：

```text
must_go / want_to_go → normal
optional              → tentative
excluded              → no_go
```

不因为迁移而默认每个地点住一晚。

### 历史 Revision

旧 Revision 必须继续能读取和恢复。

恢复旧 Revision 时，在读取过程中补出最终线路；不原地改写旧 Revision 内容。

## 3.11 过渡期旧入口规则

Phase 2 移除旧五步编辑入口之前，需要保证不会出现两份不一致线路。

因此：

- 最终线路尚未正式接管时，旧 Day / Candidate 写入可以同步更新过渡线路；
- 一旦最终线路已经接管，Day 必须重新由最终线路生成；
- 旧 Step 3 / Step 5 不能再覆盖已经接管的最终线路。

## 3.12 Provider 事实边界不变

继续保留：

```text
地点可以先保存、后定位
定位失败不删除地点
定位失败不自动补位
normal / tentative / no_go 都可以显示定位结果
坐标、距离、时长、路线 geometry 只能来自地图 Provider
```

## 3.13 AI 权限边界

### 生成

AI 可以新增地点，并决定新地点插入的位置。

“生成详细地点”不能：

- 重排已有节点；
- 删除已有节点；
- 改已有节点状态；
- 改已有住宿分界；
- 改动用户没有授权的范围。

### 优化

只有用户明确触发：

```text
优化这一天
优化这一段
优化全程
```

AI 才能在对应范围重排已有节点。

## 3.14 唯一业务操作入口

继续遵守：

```text
地图 = 展示 / 选择 / 定位辅助
右侧 = 业务操作
```

地图 Popup 不再发展第二套删除、状态、住宿、生成或优化入口。

---

# 4. 测试方式调整记录

原方案曾计划由施工 Agent 自己运行自动测试。

用户在 2026-09-05 明确修改施工规则：

> 不允许在 GitHub、GitHub Actions、CI 或施工 Agent 所在环境执行测试、类型检查、构建、迁移、应用启动等执行型验证。
>
> 每个 Phase 的全部验证都必须整理成 Codex 本地测试 Prompt，由用户在自己的本地环境执行。

因此从现在开始：

- 施工 Agent 只做代码修改和静态 Review；
- 不运行任何测试命令；
- 每个 Phase 代码完成后状态只能是 `awaiting_local_test`；
- 用户本地 Codex 返回 PASS 后，Phase 才能标记 `completed`；
- 未收到 PASS 前不进入下一 Phase。

---

# 5. 实施阶段

本轮保持 3 个 Phase，不继续拆碎。

---

# Phase 1：最终线路、旧数据兼容与 Day / Route 基础

## 目标

底层能够只根据最终线路得到当前 Day 和路线输入，同时安全读取旧旅行和旧 Revision。

此阶段不要求新 UI 已上线。

## 修改范围

- 数据模型
- 后端合同
- 旅行计划读取 / 写入
- 旧数据兼容
- Day 自动生成
- Route 输入 / dirty 判断
- PlanCommand / Revision
- 过渡期旧入口同步
- 本地测试用例

## 主要修改

1. 增加最终线路节点结构。
2. 允许同一 Place 多次出现。
3. 增加 normal / tentative / no_go。
4. 增加 `endsDay`。
5. 保存 `transportFromPrevious`。
6. 最终线路自动生成 Day。
7. 支持底层操作：
   - 新增线路节点；
   - 移除；
   - 拖动；
   - 状态切换；
   - 住 / 不住；
   - 多一晚；
   - 修改交通方式。
8. Day 编号和日期自动重算。
9. 路线计算读取自动生成 Day，并正确使用到达终点的交通方式。
10. 旧计划读取时自动补出最终线路。
11. 旧 Revision 读取 / 恢复继续可用。
12. 保持数据库 `user_version = 3`，不做无必要表迁移。
13. 最终线路节点引用未知 Place、重复节点 ID 等继续硬拒绝。
14. 一旦最终线路接管，旧 Day 写入不能形成第二份线路。
15. 保留现有 generation / Revision / Provider 安全边界。

## 代码施工完成条件

- 上述底层代码全部落地；
- Phase 1 相关测试代码已准备好供本地执行；
- 施工 Agent 静态检查没有发现明显遗漏调用点；
- `PLAN_PROGRESS.md` 更新为 `awaiting_local_test`。

## 本地测试要求

由用户本地 Codex 至少验证：

```text
npm run typecheck
npm test
npm run build
```

并重点验证：

- 最终线路数据结构；
- 旧计划 → 最终线路转换；
- 旧 Revision 恢复；
- 同一 Place 多线路节点；
- 住 / 不住 / 多一晚；
- normal / tentative / no_go；
- inactive 节点的日程分界暂时失效、恢复后恢复；
- 跳过中间节点后的交通方式规则；
- 最后一天没有住宿分界；
- Day 编号 / 日期重算；
- Route dirty；
- generation / Revision 冲突；
- 最终线路接管后旧 Day 写入不能覆盖最终线路；
- Provider 事实边界未被破坏。

## 本阶段 Codex 本地测试 Prompt

> 你是独立测试 Agent。不要相信施工 Agent 的结论，直接从当前本地仓库代码和实际测试结果判断 Phase 1 是否完成。
>
> 先阅读：
>
> - `docs/PLAN.md`
> - `docs/PLAN_EXECUTION.md`
> - `docs/PLAN_PROGRESS.md`
>
> 本次只验收 **Phase 1：最终线路、旧数据兼容与 Day / Route 基础**，不要提前实现 Phase 2 或 Phase 3。
>
> 重点阅读这些文件及它们的调用关系：
>
> - `apps/server/contracts-v2.ts`
> - `apps/server/final-route-v3.ts`
> - `apps/server/plan-commands-v2.ts`
> - `apps/server/travel-store-v3.ts`
> - `apps/server/day-route-v2.ts`
> - `apps/server/planner-runtime-v3.ts`
> - `apps/server/structured-ai-v2.ts`
> - `apps/web/src/v2-types.ts`
> - `apps/server/final-route-v3.test.ts`
> - `apps/server/final-route-plan-commands-v3.test.ts`
> - `apps/server/travel-store-final-route-v3.test.ts`
> - `apps/server/day-route-v2.test.ts`
> - `apps/server/plan-route-order-v2.test.ts`
>
> 然后在用户本地环境执行：
>
> ```bash
> npm run typecheck
> npx vitest run --config vitest.config.ts apps/server/final-route-v3.test.ts apps/server/final-route-plan-commands-v3.test.ts apps/server/travel-store-final-route-v3.test.ts apps/server/day-route-v2.test.ts apps/server/plan-route-order-v2.test.ts
> npm test
> npm run build
> ```
>
> 除了现有测试，请独立检查下面这些行为；如果现有测试没有覆盖，可在本地增加临时测试验证，但不要为了让测试通过而擅自修改产品规则：
>
> 1. **同一地点重复出现**：同一个 Place 可以有多个线路节点，节点 ID 不同。
> 2. **多一晚**：`A → 陶波【住】 → B` 增加一晚后形成两个陶波线路节点，并产生“陶波 → 陶波”的新 Day，不移动其他地点。
> 3. **不住**：取消一个分界只合并 Day，不删除或重排线路节点。
> 4. **待定 / 不去**：节点保留原顺序，但退出当前有效 Day 和 Route；如果原来有日程分界，该分界暂时失效；恢复 normal 后原分界恢复。
> 5. **交通继承**：`A —drive→ X —walk→ B` 中 X 变为 tentative / no_go 后，A→B 使用 B 自己保存的 walk；恢复 X 后原两段交通恢复。
> 6. **最后一天**：最后一个 normal 节点没有 `endsDay=true` 仍然能形成合法最后一天。
> 7. **Day 重算**：修改分界、状态或顺序后 Day 编号连续，日期从旅行开始日连续推导。
> 8. **旧旅行兼容**：
>    - 有旧 Day / Stop 的计划能补出最终线路，并尽量保留 Stop 的活动、时间、费用、备注；
>    - 只有 Candidate 的计划按 `must_go/want_to_go → normal`、`optional → tentative`、`excluded → no_go` 转换；
>    - 不自动给每个旧地点增加住宿分界。
> 9. **旧 Revision**：旧 Revision 能读取并恢复；恢复时补出最终线路，但不要原地重写历史 Revision。
> 10. **过渡期唯一线路**：
>     - 最终线路尚未正式接管时，旧 Day / Candidate 编辑仍能同步过渡线路；
>     - 最终线路已经接管后，尝试通过旧 Day / Stop 写入修改线路时，保存结果必须重新由最终线路生成，不能出现第二份独立线路。
> 11. **线路终点交通**：路线 fingerprint 和实际 Route leg 使用最终线路节点保存的“到达当前地点”交通方式，包括 Day 的终点。
> 12. **数据安全**：重复线路节点 ID、未知 Place 引用应拒绝；数据库 `user_version` 不应因为本 Phase 被无必要升级。
> 13. **Provider 边界**：本 Phase 不得让 AI 或计划 JSON 伪造地图坐标、真实距离、时长或 geometry。
> 14. **并发 / Revision**：人工最终线路修改不能被旧 generation 的冲突提案静默覆盖。
>
> 如果发现失败，不要只报测试名称。请定位到具体文件、代码逻辑和可复现条件。
>
> 最终输出固定格式：
>
> ```text
> Phase 1: PASS / FAIL
>
> 实际执行的测试：
> - ...
>
> 发现的问题：
> 1. [严重程度] ...
>
> 未覆盖或无法验证：
> - ...
>
> 是否建议进入 Phase 2：是 / 否
> 原因：...
> ```

---

# Phase 2：右侧最终线路人工规划闭环 + 地图联动

## 目标

用户不依赖 AI，也可以只在右侧完成整趟线路的人工调整，并实时看到 Day、地图和交通路线变化。

## 修改范围

- 前端工作流
- 最终线路右侧 UI
- API
- 地图展示
- 路线展示
- 定位修复
- Advisory
- 旧五步正常入口移除

## 主要修改

1. 导航收敛为：

```text
规划：旅行需求
行程：最终线路
```

2. 右侧统一展示最终线路。
3. 支持：
   - 新增地点；
   - 编辑；
   - 删除；
   - 拖动排序；
   - 正常 / 待定 / 不去；
   - 住 / 不住；
   - 多一晚；
   - 交通方式；
   - 定位修复。
4. Day 根据分界直接展示。
5. 地图显示三种状态的全部地点。
6. 交通路线只连接当前 normal 节点。
7. 地图和 Day 随最终线路自动刷新。
8. 地图 Popup 只做展示 / 选择 / 定位辅助。
9. 旧 Candidate / Skeleton / Step 4 / Step 5 不再是正常业务入口。
10. 旅行合理性问题只提示，不阻止用户保存。

## 代码施工完成条件

人工规划闭环已经全部接入右侧，并且旧五步编辑入口不再能从正常流程制造第二份线路。

代码完成后状态设为 `awaiting_local_test`。

## 本地测试要求

用户本地 Codex 需要运行完整类型检查、测试和构建，并实际启动 UI 进行交互验收。

## 本阶段 Codex 本地测试 Prompt

> 你是独立测试 Agent。只验收 Phase 2，不相信施工 Agent 的完成声明。
>
> 阅读 `docs/PLAN.md`、`docs/PLAN_EXECUTION.md`、`docs/PLAN_PROGRESS.md` 后，先检查前后端实际代码，再在本地执行：
>
> ```bash
> npm run typecheck
> npm test
> npm run build
> npm run dev
> ```
>
> 实际在浏览器中创建或打开旅行，完整验证：
>
> - 正常用户流程是否只剩“旅行需求 + 最终线路”；
> - 右侧是否是唯一业务编辑入口；
> - 能否新增、编辑、删除、拖动线路节点；
> - normal / tentative / no_go 切换后排序是否保持；
> - tentative / no_go 是否仍显示在地图但不进入当前路线；
> - inactive 节点原住宿分界是否暂时失效，恢复 normal 后是否恢复；
> - 住 / 不住是否只机械切分 / 合并 Day；
> - 多一晚是否生成“同地点 → 同地点”的新 Day，且不搬动其他景点；
> - 跳过中间地点后，后一地点自己的交通方式是否用于新的上一有效地点；
> - 最后一天没有住宿分界是否正常；
> - Day 编号是否连续重算；
> - 地图是否显示全部三种状态，路线是否只连接 normal；
> - 未定位地点是否可以继续保存；
> - 刷新页面、切换旅行后最终线路是否保持；
> - 旧 Step 2/3/4/5 是否已经无法从正常入口改出第二份线路。
>
> 输出：PASS / FAIL、实际执行的测试、问题严重程度、是否建议进入 Phase 3。

---

# Phase 3：AI 生成 / 局部补充 / 优化 + 旧流程清理

## 目标

把主要地点生成、详细地点生成和显式优化全部接到最终线路，并彻底退出旧五步的用户线路职责。

## 修改范围

- AI Action
- Action Scope
- Prompt
- 主要地点生成
- 详细地点生成
- 局部生成
- AI 优化
- Proposal / Revision / Undo
- 前端 CTA
- 旧 Skeleton / Candidate / Detail 流程清理
- PRODUCT / TECHNICAL 最终同步

## 主要修改

1. “生成主要地点”直接新增最终线路节点。
2. 首次生成地点不等于默认住一晚。
3. AI 只有明确建议住宿分界时才增加分界。
4. “生成详细地点”直接插入最终线路。
5. 生成只允许插入新节点，不改变已有节点相对顺序。
6. 支持按 Day、线路区间、住宿点附近做局部详细生成。
7. 区分“生成”和“优化”的权限。
8. 只有显式优化才允许在授权范围重排已有节点。
9. 生成不得删除、改状态、改住宿分界或越界修改。
10. Proposal / Revision / Undo 覆盖最终线路修改。
11. 重写相关 Prompt 和 Action 合同。
12. 删除或隔离不再有产品职责的 Skeleton / stayDays / Step 4→Step 5 二次安排等旧逻辑。
13. 根据最终代码更新 PRODUCT / TECHNICAL。

## 代码施工完成条件

PLAN 描述的完整新旅行流程已经落地，旧五步不再承担用户线路编辑职责。

代码完成后状态设为 `awaiting_local_test`。

## 本地测试要求

用户本地 Codex 执行最终全量回归、旧旅行兼容、AI 权限、UI 端到端验收。

## 本阶段 Codex 本地测试 Prompt

> 你是独立最终验收 Agent。不要相信施工 Agent 的结论。
>
> 阅读：
>
> - `docs/PLAN.md`
> - `docs/PLAN_EXECUTION.md`
> - `docs/PLAN_PROGRESS.md`
> - `docs/PRODUCT.md`
> - `docs/TECHNICAL.md`
>
> 在本地先运行：
>
> ```bash
> npm run typecheck
> npm test
> npm run build
> npm run dev
> ```
>
> 然后新建一趟旅行，从空白状态完整走一遍：
>
> 1. 填写旅行需求；
> 2. 生成主要地点，确认结果直接进入最终线路；
> 3. 确认生成地点不会自动等于“每个地点住一晚”；
> 4. 手工拖动、待定、不去、住 / 不住 / 多一晚；
> 5. 生成详细地点，确认新地点直接插入已有线路，不需要第二次安排进 Day；
> 6. 对单个 Day 或局部线路继续补充详细地点；
> 7. 比较生成前后已有节点，确认生成没有重排、删除、改状态或改住宿分界；
> 8. 明确执行“优化这一天 / 这一段 / 全程”，确认只有这时 AI 才能在授权范围重排；
> 9. 检查地图、Day、交通路线始终随最终线路变化；
> 10. 打开施工前的旧旅行，检查旧地点、旧 Day / Stop 信息和旧 Revision；
> 11. 检查 Provider 事实边界，定位失败可以保留地点，但 AI 不能伪造坐标、真实距离、时长或 geometry；
> 12. 检查旧 Step 2/3/4/5、Skeleton、stayDays、Candidate→DayStop 二次安排不能再从正常流程产生第二份线路。
>
> 同时阅读 Action / Scope / Prompt 实现，检查“生成”和“优化”的权限是否真的分开，局部操作是否越界。
>
> 最终输出：PASS / FAIL、实际执行的测试、发现的问题和严重程度、是否满足 `docs/PLAN.md`、是否建议结束本轮改造。

---

# 6. 高风险点

## 6.1 旧旅行和 Revision

不能只让新旅行工作。

必须由用户本地测试覆盖：

```text
旧 current_plan_json
旧 plan_revisions.plan_json
恢复旧 Revision
复制旧旅行
```

## 6.2 最终线路和 Day 变成两份可编辑内容

这是最需要避免的过渡风险。

最终线路接管以后，任何旧入口都不能把 Day / Stop 单独保存成另一条线路。

## 6.3 AI 借“生成”偷偷重排

生成和优化必须是不同权限。

验收时必须比较操作前后的已有节点顺序，而不是只看“结果是否合理”。

## 6.4 待定 / 不去的联动

状态切换必须同时检查：

```text
线路顺序
Day 划分
住宿分界是否生效
交通连接
地图点
地图路线
恢复状态后的还原
```

## 6.5 局部操作越界

局部生成 / 局部优化不能因为实现方便扩大到整趟旅行。

现有 generation、Revision、Scope 能力尽量复用。

---

# 7. 施工原则

- 只做 PLAN 需要的修改，不做无关重构。
- 用户是旅行方案的最终决策者。
- 旅行合理性问题优先提醒，不自动修改用户方案。
- 地图 Provider 事实不能由 AI 伪造。
- 每完成一个 Phase 的代码，立即更新 `PLAN_PROGRESS.md`。
- 施工 Agent 不运行任何测试、类型检查、构建、迁移或应用启动命令。
- 每个 Phase 都必须生成本地 Codex 测试 Prompt。
- 用户没有返回本地 PASS 前，不进入下一 Phase。
- 如果施工中出现新的、会改变产品行为的问题，停止相关施工并向用户说明，不偷偷新增规则。
