# TravelPlanner 文档索引

> 更新日期：2026-09-02

`docs/` 只保留当前开发真正需要读取的文档。

原则：

> 已完成、已被替代、仅用于历史解释或旧验收的文档不长期保留在 `docs/`；历史追溯使用 Git history。

## 当前必须保留的文档

### 1. 产品总纲

[`PRODUCT_PLAN.md`](./PRODUCT_PLAN.md)

回答：

> 产品最终应该是什么？

包含当前五步产品流程、规划层级、右侧唯一控制台、地图事实边界和总体产品原则。

### 2. 当前正式设计 / 下一步施工图

[`TravelPlanner 五步规划流程重构实施方案.md`](./TravelPlanner%20五步规划流程重构实施方案.md)

回答：

> 下一步具体要怎么改？

这是当前五步重构的最高优先级技术与实施设计，包含 PlanningRole、Core Visit、Stay Block、WorkflowStep、ConversationStage 映射、Prompt / Action / Context、Macro Fingerprint、增量更新、兼容规则、实施 Phase 与验收场景。

### 3. UI 设计规范

[`五步 UI 交互规范.md`](./五步%20UI%20交互规范.md)

回答：

> 用户实际怎么操作？

定义五步用户体验、地图 / 时间轴与右侧控制台职责、唯一业务入口、主 CTA、需更新提示、局部更新、未定位和删除确认等 UI 规则。

### 4. 当前实施状态 / 下一步入口

[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)

回答：

> 现在代码做到哪里，下一步从哪里开始？

它只记录当前实际代码状态、五步设计尚未实施的差异、下一步实施顺序和未来验收要求。

---

## 文档优先级

发生冲突时：

```text
当前用户明确决定
→ TravelPlanner 五步规划流程重构实施方案.md
→ 五步 UI 交互规范.md
→ PRODUCT_PLAN.md
→ IMPLEMENTATION_STATUS.md（仅用于判断实际完成状态）
```

其中：

- `PRODUCT_PLAN.md` 定义产品；
- 五步实施方案定义当前目标架构与施工方法；
- UI 规范定义用户交互；
- `IMPLEMENTATION_STATUS.md` 不定义未来产品，只说明代码当前做到哪里。

## 当前状态

2026-09-02：

```text
五步产品设计：已确认
五步 UI 设计：已确认
五步代码实施：尚未开始
下一步：review 当前代码与五步施工图差异，然后按施工图 Phase 实施
```

本次文档整理没有修改代码，也没有运行测试。
