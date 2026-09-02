# TravelPlanner 文档索引

> 更新日期：2026-09-03

`docs/` 只保留当前开发、验收和交接真正需要读取的文档。

原则：

> 已完成、已被替代、仅用于历史解释或旧验收的专项文档不长期堆积；历史追溯使用 Git history。

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

## 2. 正式实施 / 验收施工图

[`TravelPlanner 五步规划流程重构实施方案.md`](./TravelPlanner%20五步规划流程重构实施方案.md)

回答：

> 五步重构按什么合同实施和验收？

这是当前最高优先级专项验收依据。

已经实施并在 Phase 1–6 逐阶段 Gate 中验证的核心合同包括：

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
Phase 6 Complexity Downshift / Map ownership
```

当前 Phase 7 仍需按该施工图执行最终综合回归。

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

Phase 6 Browser Gate 已验证 mounted UI 符合这些主要交互合同；最终综合回归仍需再次覆盖关键场景。

## 4. 当前实施状态 / 最终回归入口

[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)

回答：

> 现在代码做到哪里，下一步应该做什么？

当前结论：

```text
Phase 0 Gap Review：DONE
Phase 1：PASS
Phase 2：PASS
Phase 3：PASS
Phase 4：PASS
Phase 5：PASS
Phase 6：PASS
Phase 7：最终综合回归交接中
```

当前不能直接宣称专项最终完成。

下一步固定为：

```text
由 Codex 对当前 feature branch 做最终综合回归
→ PASS / FAIL / BLOCKED
→ 用户根据报告决定是否修复、合并或结束专项
```

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
= 五步重构合同、Phase Gate 与最终验收范围

五步 UI 规范
= 用户如何操作

IMPLEMENTATION_STATUS
= 当前代码实际上做到哪里、当前 Gate 是什么
```

设计文档头部如果仍带有 2026-09-02 设计冻结时的“尚未实施”历史描述，不再作为实时状态判断依据；实时状态以 `IMPLEMENTATION_STATUS.md` 为准。

---

# 当前下一步

不要继续增加产品功能，也不要直接合并 `main`。

当前唯一下一步：

```text
Phase 7 Final Codex Regression
```

至少重新验证：

```text
git diff --check
Phase 1–6 targeted tests 的必要并集
web/server typecheck
full Vitest
build
isolated Browser E2E
真实 AI smoke（仅环境和现有项目方法允许时）
第 29 节全部核心业务场景
```

发现失败先报告，不自动修复；由用户决定回到对应 Phase。
