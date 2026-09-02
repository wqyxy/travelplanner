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

当前用户流程：

```text
1 旅行需求
2 想去哪些地方
3 路线和天数
4 补充景点（可选）
5 每日行程
```

产品最高原则之一：

> **内部模型可以复杂，但普通用户不需要理解工程状态和术语。**

包含 Planning Area / Core Visit / Detail Interest、preference 语义、右侧唯一控制台、Stay Block、增量更新、未定位和 Provider 边界。

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
Step 3 SkeletonEditDraft + 原子保存
Macro fingerprint + 派生 macroDirty
Planning Area / Core / Detail unresolved readiness
Step 4 capacity-aware interests 且可跳过
patch-only Detailed update
applySkeletonPlanV3 避免 100 PlanCommand 上限
Phase 0–7 实施顺序
Phase 6 必须完成 Complexity Downshift
```

## 3. UI 设计规范

[`五步 UI 交互规范.md`](./五步%20UI%20交互规范.md)

回答：

> 用户实际怎么操作？

重点规则：

```text
Step 2 是愿望清单，Step 3 才是最终路线
Step 4 明确可选
四级 preference 留在数据层，主 UI 主要操作“必去 / 想去”
重要游览地保留，但不做 planningRole 编辑器
Step 3 只告诉用户“还差 N 天”，不暴露 Draft / canonical 等术语
Update Card 默认紧凑、原因按需展开
跨步骤请求自动切换到正确工作区
未定位按是否真正阻塞分级展示
地图 / 时间轴仍只展示和选择
```

## 4. 当前实施状态 / 下一步入口

[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)

回答：

> 现在代码做到哪里，下一次开始开发先做什么？

当前结论：

```text
五步产品设计：已确认
五步 UI 设计：已确认
用户复杂度下沉规则：已确认
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
Skeleton atomic Save
Impact Analyzer
Action ownership
UI ownership
工程状态是否直接暴露给用户
```

确认 gap 后才进入正式修改。
