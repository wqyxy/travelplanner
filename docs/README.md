# TravelPlanner 文档索引

> 更新日期：2026-09-02

`docs/` 只保留当前开发真正需要读取的文档。

原则：

> 已完成、已被替代、仅用于历史解释或旧验收的文档不长期保留；历史追溯使用 Git history。

---

# 当前必须保留的文档

## 1. 产品总纲

[`PRODUCT_PLAN.md`](./PRODUCT_PLAN.md)

回答：

> 产品最终应该是什么？

定义五步产品流程、Planning Area / Core Visit / Detail Interest、preference 语义、右侧唯一控制台、Stay Block、增量更新、未定位和 Provider 边界。

## 2. 当前正式设计 / 下一步施工图

[`TravelPlanner 五步规划流程重构实施方案.md`](./TravelPlanner%20五步规划流程重构实施方案.md)

回答：

> 下一步具体怎么改？

这是当前最高优先级实施依据。

已经最终定死：

```text
PlanningRole
must / want / optional / excluded 的 Skeleton 语义
稳定 stayBlockId
重复 Planning Area / 环线
移动日计入到达 Stay Block
requiresWorkflowStep
Step 3 SkeletonEditDraft + 原子 Apply
Macro fingerprint + 派生 macroDirty
Planning Area / Core / Detail unresolved readiness
capacity-aware interests
patch-only Detailed update
applySkeletonPlanV3 避免 100 PlanCommand 上限
Phase 0–7 实施顺序
```

## 3. UI 设计规范

[`五步 UI 交互规范.md`](./五步%20UI%20交互规范.md)

回答：

> 用户实际怎么操作？

定义唯一业务入口、五步导航、Preference UX、Stay Block 时间轴、Step 3 草稿编辑、Update Card、未定位提示和局部更新体验。

## 4. 当前实施状态 / 下一步入口

[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)

回答：

> 现在代码做到哪里，下一次开始开发先做什么？

当前结论：

```text
五步产品设计：已确认
五步 UI 设计：已确认
五步施工合同：已确认
五步代码：尚未实施
```

下一次用户明确要求开始实施时：

```text
先执行 Phase 0 只读代码差异 review
→ 输出逐文件 gap list
→ 再进入 Phase 1
```

不能直接跳过 Phase 0 修改代码。

---

# 文档优先级

发生冲突时：

```text
当前用户明确决定
→ TravelPlanner 五步规划流程重构实施方案.md
→ 五步 UI 交互规范.md
→ PRODUCT_PLAN.md
→ IMPLEMENTATION_STATUS.md（只说明实际完成状态）
```

职责：

```text
PRODUCT_PLAN
= 产品是什么

五步实施方案
= 下一步如何实现

五步 UI 规范
= 用户如何操作

IMPLEMENTATION_STATUS
= 当前代码实际上做到哪里
```

---

# 当前下一步

目前不要实施代码。

用户之后明确要求“开始实施”时，第一步固定为：

```text
Phase 0：只读 review 当前代码与五步施工图差异
```

重点检查：

```text
schema / contracts
PlanningRole
Stay Block / Day
Skeleton preference coverage
requiresWorkflowStep
Macro fingerprint
Resolution readiness
Skeleton atomic Apply
Impact Analyzer
Action ownership
UI ownership
```

确认 gap 后才进入正式修改。
