# TravelPlanner Implementation Status

> 更新时间：2026-09-03
> 当前状态：**五步重构 Phase 1–6 已逐阶段通过；Final Regression 已执行三次。第三次除 production Browser MapLibre marker 外，其余可执行 Gate 全部通过。该 Map 集成问题已做最小 Repair #3，当前等待第四次 Final Regression Rerun。**

---

# 1. Current Gate

当前分支：

```text
feature/five-step-workflow-refactor
```

实施前 `main` / merge-base：

```text
b048c1980247443b5d6568ddd4302c41c9ce832b
```

Phase 6 PASS HEAD：

```text
0f8cdd2bdb58b248cc39aefbd05c8cdfd0ce2ae7
```

第一次 Final Regression HEAD：

```text
eb8ea96e54805284633fd429fc5f1d071ff5309b
```

第二次 Final Regression HEAD：

```text
bed89c96b2bad6b456a924d45c35150f232fced4
```

第三次 Final Regression HEAD：

```text
eeaa4390f754b49944624f0939575c1b01828b6c
```

三次最终回归结论均为：

```text
FINAL FIVE-STEP REGRESSION: FAIL
```

第三次失败只剩 production Browser MapLibre marker / GeoJSON rendered-feature 集成问题。Repair #3 已实施，但尚未重新验收，因此当前仍不能宣称专项最终完成，也不能直接合并 `main`。

---

# 2. Phase History

```text
Phase 0 Read-only Gap Review                  DONE
Phase 1 Role + Contract Foundation            PASS
Phase 2 Skeleton + Impact Consumer Foundation PASS
Phase 3 Backbone Producer                     PASS
Phase 4 Capacity-Aware Interests              PASS
Phase 5 Detailed Itinerary                    PASS
Phase 6 UI / Map + Complexity Downshift       PASS
Phase 7 Final Regression #1                   FAIL
Phase 7 Repair #1                             IMPLEMENTED
Phase 7 Final Regression #2                   FAIL
Phase 7 Repair #2                             IMPLEMENTED
Phase 7 Final Regression #3                   FAIL
Phase 7 Repair #3                             IMPLEMENTED / AWAITING RERUN
```

第三次 Final Regression 已确认以下项目在当时 HEAD 全部通过：Repair targeted、Phase 1–6 targeted、typecheck、full Vitest、build、F1–F14、Detailed Itinerary、Provider 边界和安全审计。唯一真实 FAIL 是 production Browser marker click。

---

# 3. Final Regression #1 的问题与修复

## 3.1 OpenAI structured output / stayBlockId

canonical `Day.stayBlockId` 保持 optional；Structured AI transport 对该字段使用 required + nullable bridge，`null` 在进入 canonical 前归一为字段缺省。

## 3.2 Detail → Core

用户在 Step 4 / Step 5 对当前普通景点说：

```text
这个地方很重要，要单独留一天
```

受控链路：

```text
自动路由到 Step 2 destinations
→ 保留当前普通景点 selection
→ destination.edit
→ request = promote_to_core
→ pending_confirmation
→ 用户确认
→ detail_interest → core_visit
→ 保留 planningAreaCandidateId
→ Macro dependency dirty
→ 所属区域 Detailed Day needs_review
```

CTA、generic command 和普通 destination.edit 都不能绕过这条确认路径。

## 3.3 Step 4 / public text / Resolver / diff hygiene

Repair #1 同时完成：

```text
Step 4 stop-after-save fixture 与 current Skeleton readiness 对齐
Proposal / error / task 共用 public-text 防泄漏边界
Picton city country-scope query 保持 provider-friendly English name
git diff --check trailing whitespace 清理
```

---

# 4. Final Regression #2 的问题与 Repair #2

## 4.1 TripCandidate OpenAI transport

`TripCandidateSchema.planningRole?` 是 canonical 旧数据兼容字段，不能通过第二个 nullable bridge 解决。

Repair #2：

```text
stayBlockId 仍是唯一 nullable bridge
planningRole 不允许 null
仅当 object 完整匹配 TripCandidate shape 且唯一 optional 字段是 planningRole
OpenAI transport 才要求 planningRole 为 required enum
其他 mixed required/optional object 继续 fail closed
```

## 4.2 Detail → Core fixture 外键

测试改为通过 `TravelStoreV3.createUserMessage()` 建立真实 conversation message，再创建 Action；所有 SQLite fixture 使用 `try/finally` 关闭。

第三次 Final Regression 已验证：Repair Targeted 9/9、Phase Targeted 32/32、full suite 69 files / 406 tests、typecheck 和 build 全部通过。

---

# 5. Final Regression #3 的问题与 Repair #3

## 5.1 现象

第三次 Final Regression 使用 `dist/web` production build + 纯内存 API fixture 时：

```text
页面显示“已定位地点 N”
GeoJSON point 数据存在
MapLibre canvas 正常创建
但 rendered marker feature = 0
点击地图没有 candidate selection，也没有 popup
```

相同 `WorkspaceMapV2` 在 Phase 6 的 Vite dev Browser Gate 曾通过，因此问题被定位为 dev 与 production bundling 的 MapLibre worker 差异，而不是 candidate/popup 业务逻辑回退。

## 5.2 Repair #3

按 MapLibre v6 的 Vite bundler要求，在应用入口显式配置 production worker：

```text
import { setWorkerUrl } from "maplibre-gl"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
setWorkerUrl(workerUrl)
```

同时导入官方 MapLibre CSS，并增加标准 `vite/client` 类型声明。

Repair #3 只修改：

```text
apps/web/src/main.tsx
apps/web/src/vite-env.d.ts
```

未修改：

```text
WorkspaceMapV2 marker click / selection / popup 业务逻辑
candidatePointFeatures / itineraryPointFeatures
Provider / Resolver
后端
数据库
Prompt
canonical plan
```

本轮必须重点用 **fresh production build (`npm run build`) 的 `dist/web`** 重新验证 marker rendered feature、selection 和只读 popup；不能只用 Vite dev 证明通过。

---

# 6. 当前五步合同

用户流程：

```text
1 旅行需求
2 想去哪些地方
3 路线和天数
4 补充景点（可选）
5 每日行程
```

内部核心保持：

```text
PlanningRole = planning_area | core_visit | detail_interest
Core Visit 不成为 Macro Anchor
同一 Planning Area 可有多个稳定 Stay Block
Day.stayBlockId? backward-compatible
macroDirty 运行时派生
Step 3 原子 Skeleton save
Step 4 可完全跳过
Step 5 只更新真实 affectedDayIds
Detailed update sticky baseline / minimal diff
PRAGMA user_version = 3
```

不做 v3 → v4 migration，不自动 rewrite 私人数据库。

---

# 7. UI / Map 合同

地图 / 时间轴只负责：

```text
展示
选择
聚焦
```

Marker click 只改变 selection 并显示只读 popup，不产生业务 mutation；右侧控制台仍是唯一业务入口。

Map coordinate repair 只能由右侧地点卡先发起。

---

# 8. Private Data / Security

继续保持：

```text
private_data/ 不进入 Git
不使用真实私人旅行做 Browser E2E
不新增凭据
不扩大 AI / Codex 权限
不让 AI 产生可信 Provider facts
```

---

# 9. Current Next Step

下一步是第四次 Final Regression Rerun。

由于第三次回归除 Map production Browser 外其余 Gate 已全部通过，本轮可以先做 Repair #3 快速 Gate，但最终仍应在当前 HEAD 至少重新执行：

```text
git diff --check
npm run typecheck
npm test
npm run build
production dist/web isolated Browser marker test
必要的五步 Browser smoke
Provider / private-data boundary check
```

重点硬 Gate：

```text
fresh npm run build
→ serve fresh dist/web
→ memory API fixture
→ GeoJSON candidate marker 实际可见 / queryRenderedFeatures 可命中
→ marker click 只 selection
→ popup 只读
→ 无 API mutation
```

如果仍 FAIL，不宣称完成；继续只回 Phase 6 Map Integration 做最小修复。

如果所有可执行硬 Gate PASS，仅 Real AI smoke 因没有安全临时 v3 路径而 BLOCKED，则按最终 Gate 规则报告 PARTIAL，由用户决定是否接受该环境未验证项。
