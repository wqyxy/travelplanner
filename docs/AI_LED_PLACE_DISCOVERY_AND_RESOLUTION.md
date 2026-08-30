# AI 主导的兴趣点发现与地图定位 — V3 实施基线

> 本文记录 2026-08-30 已确认的 V3 行为。与旧文档中的“固定 3/5/7/9、地图预检淘汰、可靠兴趣点下限、自动补位、仅 attraction、代码评分自动选择、countrycodes 硬过滤”等规则冲突时，以本文和当前 V3 实现为准。旧 V1 `map-pipeline` 不在本次改造范围。

## 核心流程

```text
AI 决定地点与数量
→ 服务端只做结构/安全校验
→ canonical 合并并立即保存候选
→ 对新增或 unresolved 地点做最佳努力定位
→ Provider 返回全部结构有效候选
→ AI 最多两轮消歧
→ resolved 或 unresolved
```

## 兴趣点发现

- 单个 Macro、单次调用最多 9 个详细地点；这是请求上限，不是城市总地点上限。
- AI 根据停留时间、主题、偏好和已有地点决定实际数量 `0–9`。
- `targetCount` 表示 AI 本轮实际输出数量，必须满足 `targetCount = places.length = candidates.length`。
- 允许空结果。
- Micro 允许所有当前合法非 `city` Place kind：`attraction/lodging/meal/airport/station/port/stop/waypoint`。
- `prominence`、`experienceTypes`、`researchBasis` 等仍由 AI 输出，但不再是代码准入门槛。
- 服务端保留：Schema、临时 ID 唯一、一一引用、Macro 父级、Micro 非 city、generation CAS、单次 9 个、禁止来源链接进入持久化数据。
- 删除：固定数量、可靠数量下限、显著性/多样性硬门槛、名称正则、Place kind 语义拒绝、地图预检后补位。
- canonical 重复正常合并，不算失败。统计区分“AI 建议 / 实际新增 / 合并重复”。
- AI 区域失败彼此隔离；已保存区域不回滚。
- `CONTENT_GENERATION_SUPERSEDED` 记为 `cancelled_by_generation`，不是 AI failed。

## 保存与定位顺序

结构合法的 AI 输出先保存，再定位。地图定位失败：

- 不删除 Place/Candidate；
- 不触发补位；
- 不让 Discovery 任务失败；
- 保存/显示为 unresolved，可重试。

历史当前有效的 resolved Place 默认保持原定位，不因为候选研究字段变化而重新定位。

## 地图 Resolver

代码不得基于以下内容拒绝 Provider 候选：

- type/class/category；
- 国家、城市、行政区；
- 名称相似度；
- highway/footway/waterway/waterfall/aerialway/station 等类别。

只允许机械结构检查：Provider ID、坐标可解析、经纬度范围和 Provider 数据结构。

自动搜索不使用 Nominatim `countrycodes` 硬过滤。国家/城市/区域只进入搜索文本。

“全部候选”指 Provider 本次请求实际返回的全部结构有效、保守去重结果。Provider 和统一技术资源上限允许存在，但应用层不得按旅行语义截断。

去重只做：

1. 同 Provider ID；
2. 技术标准化后同名且坐标相同的明显物理重复。

不得 fuzzy name 或“距离很近所以同一地点”。

## 两轮 AI 消歧

Round 1：`choose_candidate / retry_with_hints / unresolved`。

- 初始搜索为空也必须调用 AI，让 AI 有机会生成搜索提示。
- 单一候选也必须经过 AI，不允许代码自动 resolved。

Round 2：补充搜索后把新旧候选全集再次给 AI。

- 选择则 resolved；
- 仍不确定、AI 不可用、非法选择或再次请求搜索时，最终保存 unresolved；
- 不允许第三轮。

AI 选择后服务端只验证 `providerPlaceId` 确实来自本轮候选，并使用 Provider 原始坐标。AI 不输出/修改坐标。

Provider 选择统一 `method=provider_choice`，`confidence=null`。

用户地图点选/手工坐标只校验数值、范围和 generation；反向地理只作地址提示，不因国家/行政区不一致拒绝用户坐标；`confidence=null`。

## Macro / Micro 规划边界

Macro `city` 是规划区域，不是必须先解析成路线点的 Micro。

- Macro `must_go` 不因为城市下面没有 resolved Micro 而阻止生成行程，也不触发自动补充兴趣点。
- Micro `must_go + unresolved` 阻止生成，并要求用户先完成定位。
- Micro `want_to_go/optional + unresolved` 不阻止生成，但不得进入 Day/Route；保留在地点池并显示“未定位/未排程”。
- 永远不使用城市中心、区域中心或猜测坐标把 unresolved 伪装成 resolved。

## UI 文案

兴趣点区域使用“AI 推荐的详细地点”，说明可以包括景点、餐饮、住宿、交通节点等。

未定位地点继续提供唯一右侧操作入口：重新识别、选择地图地点、地图点选、手工坐标。

Discovery 完成摘要围绕：

- AI 建议；
- 实际新增；
- 合并重复；
- 已定位；
- 待定位；
- AI 失败区域；
- 被新 generation 取消。

不再出现“地图预检接受”“可靠数量门槛”“自动补位”。

## 数据与兼容性

- 不做数据库迁移。
- TravelPlanDocument / Resolution 表结构不变。
- 保持历史 resolved fingerprint 版本兼容，不进行全量重定位。
- 历史 unresolved 在用户重试或正常解析时使用新 AI Resolver。
- 旧流程中在保存前被地图预检丢弃的数据无法自动恢复，用户可重新运行“补充兴趣点”。
- 不修改未启用旧 V1 `map-pipeline`。

## 验收重点

- Discovery 接受 0–9；所有非 city kind 通过；非法父级/引用/数量/generation 仍失败。
- highway/footway、waterway/waterfall、aerialway/station、跨行政区候选全部进入 AI。
- 单一候选也没有代码自动选择。
- 覆盖第一轮选择、空结果搜索提示、第二轮选择、最终 unresolved、AI 异常、非法 Provider ID。
- 全部 AI 推荐先落库；全部定位失败时 Discovery 仍完成且全部显示 unresolved；不补位。
- 覆盖 canonical 重复、区域 AI 超时部分保存、generation superseded 取消。
- 回归 Queenstown Skyline、Kea Point Track、Humboldt Falls、Taranaki Falls 和国家公园行政区不一致场景。
- unresolved optional 不进入 Day；unresolved Micro must_go 阻止；Macro must_go 不要求 resolved Micro。

## 测试执行规则

完成修改后先列出建议的相关 Vitest、typecheck、build 和真实 Nominatim smoke 范围与外部调用成本。获得用户确认前不执行这些测试。
