# AI 主导的兴趣点发现与地图定位 — V3 实施基线

> 更新日期：2026-09-02  
> 本文继续约束 Candidate-first、save-first 与地图定位边界；五步 Workflow / PlanningRole 以 `TravelPlanner 五步规划流程重构实施方案.md` 为准。  
> **本次只更新文档，五步代码尚未实施。**

---

# 1. 核心流程

```text
AI 决定地点与数量
→ 服务端只做结构 / 安全校验
→ canonical 合并并立即保存 Candidate
→ 对新增或 unresolved 地点做 best-effort 定位
→ Provider 返回全部结构有效候选
→ AI 最多两轮消歧
→ resolved 或 unresolved
```

定位失败不得导致已经结构合法并保存的 Candidate 消失。

---

# 2. 五步规划角色下的地点发现

五步设计区分：

```text
planning_area
core_visit
detail_interest
```

## Step 2 Backbone Discovery

`destination.generate` 可以研究并生成：

```text
Planning Area
Core Visit
```

它不生成普通 Detail Interest。

## Step 4 Interest Discovery

`interest.discover / supplement` 只能自动生成：

```text
detail_interest
```

不能在 Step 4 自动偷偷生成 Core Visit，因为 Core Visit 会影响上游 Skeleton。

如果用户认为某 Detail Interest 应升级为 Core Visit：

```text
Step 4 只导航 Step 2
→ Step 2 确认 role change
```

---

# 3. Step 4 兴趣点数量

单个 Planning Area、单次调用最多 9 个普通详细地点；这是请求上限，不是总地点上限。

AI 根据：

```text
当前 Stay Block / stayDays
arrival transfer burden
已有 Core Visit 占用
pace / theme / preference
已有 Detail Interest
```

决定实际数量 `0–9`。

允许空结果。

不能为了凑数量生成。

普通 Detail Interest 允许所有当前合法非 `city` Place kind：

```text
attraction
lodging
meal
airport
station
port
stop
waypoint
```

`targetCount` 如继续保留在当前 Action contract 中，应满足：

```text
targetCount = places.length = candidates.length
```

它只表示本轮实际输出数量，不是硬目标。

---

# 4. 服务端保留的结构 / 安全校验

服务端继续保留：

```text
Schema
临时 ID 唯一
Place / Candidate 一一引用
合法 parent Planning Area
Step 4 输出必须是 detail_interest + non-city
单次上限 9
content generation / CAS
禁止来源链接进入持久化结构化数据
```

服务端不恢复：

```text
固定推荐数量
可靠数量下限
显著性 / 多样性业务硬门槛
名称正则业务过滤
地图预检淘汰
定位失败自动补位
```

canonical 重复正常合并，不算失败。

区域失败彼此隔离；已保存区域不回滚。

---

# 5. 保存与定位顺序

结构合法的 AI 输出：

```text
先保存
再定位
```

地图定位失败：

```text
不移除 Place / Candidate
不触发补位
不让 Discovery 整批失败
保留 unresolved
允许重试 / 手工定位
```

历史有效 resolved Place 默认保持原定位，不因为 Candidate 研究字段变化而重新解析。

---

# 6. 地图 Resolver

代码不得基于以下旅行语义过滤 Provider 候选：

```text
type / class / category
国家 / 城市 / 行政区
名称相似度
highway / footway / waterway / waterfall / aerialway / station 等类别
```

只允许机械结构检查：

```text
Provider ID
坐标可解析
经纬度范围
Provider 数据结构
```

自动搜索不使用 Nominatim `countrycodes` 作为业务硬过滤。

国家 / 城市 / 区域可以进入搜索文本。

---

# 7. Provider Candidate 去重

只做保守技术去重：

```text
1 同 Provider ID
2 技术标准化后同名且坐标相同的明显物理重复
```

不得仅因为：

```text
fuzzy name 相似
距离很近
```

就认定同一地点。

---

# 8. 两轮 AI 消歧

Round 1：

```text
choose_candidate
retry_with_hints
unresolved
```

初始搜索为空也允许 AI 给搜索提示。

单一候选仍经过 AI，不由代码直接认定 resolved。

Round 2：

```text
补充搜索
→ 新旧 Provider 候选全集再次交给 AI
```

两轮后仍不确定：

```text
unresolved
```

不允许无限重试。

AI 选择后服务端只验证：

```text
providerPlaceId 确实来自本轮候选
```

坐标必须使用 Provider 原始数据，AI 不修改坐标。

---

# 9. 用户手工定位

用户地图点选 / 手工坐标：

```text
校验数值
校验范围
校验 generation
```

反向地理结果只作为地址提示，不因国家 / 行政区不一致拒绝用户明确坐标。

受限 Google Maps 分享链接能力如现有代码已经提供，继续遵守：

```text
只提取明确坐标
短链只允许 Google 域内跳转
用户预览并确认后保存
链接名称只作提示
不把页面内容当作可信 Place 事实
```

---

# 10. Planning Area / Core / Detail 的定位边界

## Planning Area

```text
planningRole = planning_area
Place.kind = city
```

Planning Area 作为 Macro Anchor 的规划语义不依赖其下必须已经存在某个 resolved Detail Interest。

## Core Visit

Core Visit 即使 unresolved：

```text
仍可影响 Step 3 时间分配
```

因为 Step 3 只需要其语义时间需求。

但是 Core Visit 在 Step 5 成为真实 Stop 前必须 resolved。

因此：

```text
core_visit + must_go + unresolved
→ 不阻止 Step 3 Skeleton
→ 阻止 Step 5 把它成功排为真实 Stop
```

## Detail Interest

```text
detail_interest + must_go + unresolved
→ 对应 Step 5 排程不能假装成功

detail_interest + want_to_go / optional + unresolved
→ 不进入真实 Stop / Route
→ 保留在候选池显示待定位 / 未排程
```

永远不使用城市中心、区域中心或猜测坐标把 unresolved 伪装成 resolved。

---

# 11. UI 唯一入口

定位相关操作继续只存在于右侧对象归属步骤详情。

地图只负责：

```text
展示
选择
聚焦
```

不得在 Marker Popup 再放一套：

```text
重新定位
选择地点
修改 preference
加入行程
```

Step 2 / Step 4 对 unresolved 地点应提前显示状态，不等 Step 5 生成失败才提示。

---

# 12. Discovery 完成摘要

可以展示：

```text
AI 建议数量
实际新增
合并重复
已定位
待定位
AI 失败区域
被新 generation 取消
```

不再使用：

```text
地图预检接受
可靠数量门槛
自动补位
```

---

# 13. 数据与兼容性

本专项不要求数据库版本升级。

继续：

```text
PRAGMA user_version = 3
```

不因为五步文档更新自动迁移历史 Candidate / Resolution。

旧 Candidate planningRole 的运行时解释与新数据显式 planningRole 写入规则，以五步正式施工图为准。

---

# 14. 验收重点

未来五步实现后至少覆盖：

```text
Step 4 Discovery 接受 0–9
Step 4 只自动生成 detail_interest
Core Visit 不被重复生成为普通兴趣点
全部 AI 推荐先保存再定位
全部定位失败时 Candidate 仍存在
单一区域失败不回滚其他区域
单一 Provider 候选仍经过 AI 消歧
两轮后 unresolved 正常落库
unresolved optional 不进入 Day
unresolved must_go Core 不阻止 Step 3，但阻止 Step 5 真实 Stop
```

---

# 15. 测试执行规则

五步代码实施完成后，先列出建议的：

```text
相关 Vitest
typecheck
build
真实 Provider smoke
```

及外部调用成本。

获得用户确认前，不执行最终完整验收。

本次只更新文档，不运行测试。
