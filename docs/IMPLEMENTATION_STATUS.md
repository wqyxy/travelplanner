# TravelPlanner Implementation Status

更新时间：2026-08-31  
实施分支：`refactor/stage-dialogue-actions-v3`  
目标文档：`docs/AI_STAGE_DIALOGUE_AND_ACTION_REFACTOR_PLAN.md`

## Current Gate

Phase 1–7 staged-v3、cutover、A–I hardening、Prompt Registry 修复以及 itinerary refine / Resolution 边界 hardening 已完成。

最近一次完整 Codex 验收在上一轮代码上确认：

- strict Prompt Registry：PASS；
- Review A–I：全部 PASS；
- fresh-v3 / cutover：PASS；
- `npm run typecheck`：PASS；
- 全量 Vitest：PASS；
- `npm run build`：PASS；
- real Codex structured-output smoke：PASS。

Browser E2E 随后发现并已修复：

- `itinerary.refine` 改为 patch-only `dayUpdates`，模型不再能表达 Anchor / Day identity / Candidate / Place 改动；
- itinerary 中任何 Anchor / Stop Place，包括 `kind=city`，都必须具有当前有效 Resolution。

这些修复尚待与本轮地点定位调度改造一起重新验收，因此当前仍不能标记 `READY FOR MERGE`。

## Latest Location Finding

实际使用中发现：目的地生成后很长时间只出现极少数定位结果，其他地点看起来像完全没有开始定位。

核对当前 V3 后，问题由三部分构成：

1. 最新 Runtime 已存在 destination.generate 后的 best-effort Resolver 调用，但旧实现只处理 `addedPlaceIds`，无法保证本轮所有经 `idMappings` 正式化的生成地点（包括与已有 Place 去重/复用的地点）都进入自动定位；
2. `TravelPlannerRuntimeV3.resolveChangedPlaces()` 与 `PlaceResolverV2.resolveMany()` 都逐 Place 严格串行。单个地点最多需要 4 次 Provider 搜索，存在合理歧义时还可能进入 1–2 次 AI 消歧，因此一个慢地点会阻塞后面的所有地点；
3. V3 `workspace()` 过去只返回 `status=resolved` 的 Resolution。数据库即使已经写入 `resolving` 或 `unresolved + errorMessage`，右侧 UI 也看不到，因此用户会误以为“根本没有定位”。

注意：`MapService` 对 Nominatim 的约 1.1 秒全局请求间隔是有意的 Provider 限速，不应删除或并发打穿。

## Location Scheduling Hardening

### 1. 保留 Provider 限速，改为 3 个 Place worker 协作推进

`PlaceResolverV2.resolveMany()` 已从逐 Place 严格串行改为有界 worker pool：

- `PLACE_RESOLUTION_BATCH_CONCURRENCY = 3`；
- 最多同时推进 3 个 Place 的解析状态机；
- 每个 Place 仍保留最多 4 次 Provider 搜索预算；
- 实际 Nominatim HTTP 仍全部经过 `MapService` 原有全局 serial/rate limiter；
- 当某个 Place 等待 AI 消歧时，其他 worker 可以继续取得 Provider 搜索机会；
- 一个歧义地点不再阻塞整批地点。

这提高的是调度公平性和首批结果速度，不提高对地图 Provider 的请求频率。

### 2. Resolution 状态实时可见

`PlaceResolverV2.resolve()` 现在对状态变化提供回调：

- 开始时先持久化 `resolving`；
- 成功后持久化 `resolved`；
- 无法确认时持久化 `unresolved + errorMessage`；
- 每次变化都通知 Runtime。

Runtime 对每个变化广播：

`travel.resolution.changed`

前端已有 WebSocket 监听，会立即重新读取 workspace，因此地点卡能逐个显示：

- 定位中；
- 已定位；
- 未定位及具体错误。

### 3. workspace 不再隐藏失败和进行中状态

`TravelPlannerRuntimeV3.workspace()` 现在返回所有 fingerprint 当前有效的 Resolution：

- resolving；
- resolved；
- unresolved。

地图和 coverage 仍只把 `resolved` 当作可用地理事实，因此不会把无坐标状态误画到地图或误当作可路由地点。

### 4. 自动生成覆盖全部本轮正式化地点

`destination.generate` 现在根据本轮 Candidate 的 `placeTemporaryId -> idMappings` 获取全部 canonical Place ID，再进入自动定位，而不是只依赖 `addedPlaceIds`。

因此：

- 新增 Place 会定位；
- 被语义去重并复用的已有 Place 也会检查/补定位；
- 每个本轮生成的 Candidate 都有明确的 canonical Place 定位去向。

`interest.discover / supplement` 同样使用本轮正式化后的 canonical Place ID 集合进行定位。

仍保持 save-first：

- Candidate / Place 先保存；
- 地图定位失败不回滚、不补位、不删除 Candidate；
- 最终 unresolved 继续留在右侧供重试或人工定位。

### 5. 自动定位任务显示整体进度

对于 destination / interest AI Action，定位阶段会继续复用当前 Action Task，并更新摘要，例如：

`正在定位地点 4/9 · 已定位`

因此 Action 不会在 AI 刚生成 Candidate 后就表现为“全部结束”；只有本轮 best-effort 定位批次结束后才进入 completed。

手动批量重新定位继续使用原 API，但现在同样使用 cooperative `resolveMany()`，并通过 WebSocket 逐 Place 刷新卡片状态。

## Regression Coverage Added

新增/扩展正式测试覆盖：

- `resolveMany()` 同时最多推进 3 个 Place worker；
- 每个 Place 都产生 `resolving -> resolved/unresolved` 状态流；
- batch progress 最终 `completed === total`；
- 一个等待 AI 消歧的慢 Place 不阻塞其他简单 Place 先完成；
- destination.generate 会对全部本轮 canonical Place 映射触发自动定位；
- Action resultRef 记录 resolved/total；
- V3 workspace 可以读取 current `resolving` 与 `unresolved + errorMessage`；
- Web helper 将 resolving 与 unresolved 分开计数。

此前的 refine、unresolved itinerary、A–I、Prompt Registry、Store/Route regression 仍需在最终全量测试中保持通过。

## Verification Status

地点定位调度改造对应的完整建议验收仍未运行；本轮浏览器反馈相关的 targeted Runtime / Web helper 测试已经通过。

## Destination / Interest Compact UI

最新目的地页面反馈已同步到目的地与兴趣点共享布局：

- 阶段顶部只保留五步单行导航，移除说明工具行和独立任务进度条；
- 目的地 / 兴趣点 Candidate Panel 移除重复标题与说明；筛选、搜索、全选和手动添加在桌面合并为同一紧凑工具行，空间不足时最多换为两行；
- 地点名称语言移动到全局顶部 AI 模型选择右侧，五步持续可用；
- AI 公开任务进度移动到底部阶段 AI Dock，折叠态和展开态均与助手标题同一行；
- 服务端 API、canonical 数据结构、Action 合同和私人数据路径均未改变。

验证状态：`npm run typecheck:web` 与 `git diff --check` 已通过。浏览器已实测目的地 / 兴趣点在 1495×1039 使用单行工具栏，850px 降级为两行且无页面横向溢出；筛选数量、取消全选及无结果状态正确。`ai-task-topbar.test.ts` 仍被当前执行环境的 esbuild 目录访问限制阻断，待环境允许后补跑。

最新浏览器反馈另补充了两项 requirements 阶段约束：

- 对话识别出的 `requirements.update / requirements.clear` 通过受控参数校验后直接执行确定性 Action，不再显示二次确认卡；
- 空白旅行需求下禁用“生成目的地建议”，服务端同时拒绝创建空需求的 `destination.generate` CTA Action。

已执行：

- `planner-runtime-v3.test.ts`；
- `planner-runtime-v3-ai-actions.test.ts`；
- `requirements-readiness-v3.test.ts`；
- 共 3 个测试文件、15 个用例，全部 PASS。

下一轮需要由 Codex 执行：

1. targeted Place Resolver / Runtime / Web helper tests；
2. `git diff --check`；
3. `npm run typecheck`；
4. `npm test`；
5. `npm run build`；
6. 上述全部 PASS 后再运行 isolated fresh-v3 real Browser E2E；
7. 实际观察 9 个左右目的地生成后的自动定位触发、逐个状态出现、慢歧义地点不阻塞其他地点；
8. 再继续 itinerary.generate → refine → Proposal → Apply 的最终闭环。

## Data Safety

真实固定数据库仍为：

`private_data/travel-v2.sqlite3`

本轮 GitHub 修改没有读取、删除、移动、覆盖或迁移真实数据库。

正常启动仍要求内部 `PRAGMA user_version=3`，旧 v2 / unknown / corrupt DB 在 HTTP listen 前 fail closed，不自动迁移或删除。

## Do Not Do

- 不取消 MapService / Nominatim 全局限速；
- 不因定位失败回滚或删除 Candidate；
- 不让 unresolved Place 进入 itinerary；
- 不恢复旧全局 AI Conversation / Adjustment / 00–03 Prompt；
- 最终自动化与 isolated Browser E2E 未全部 PASS 前，不宣称 `READY FOR MERGE`。
