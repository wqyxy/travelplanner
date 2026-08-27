# TravelPlanner 文档索引

## 当前有效文档

1. [`PRODUCT_PLAN.md`](./PRODUCT_PLAN.md)  
   唯一产品需求依据。功能范围、用户流程、P0/P1/P2 和产品边界以此为准。

2. [`IMPROVEMENT_STEPS.md`](./IMPROVEMENT_STEPS.md)  
   当前代码改进内容、后续本地验证顺序和 P1/P2 计划。

3. [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)  
   当前 main 的实际实现状态、关键决策、已知风险和本轮检查状态。

4. [`LOCAL_TEST_PROMPT.md`](./LOCAL_TEST_PROMPT.md)  
   可直接交给本地 Codex 的只测试提示词。

## 数据库决策

TravelPlanner v3 直接使用：

```text
private_data/travel-v2.sqlite3
```

明确不实现：

- 旧 `travel.sqlite3` 迁移；
- v1 数据兼容读取；
- v1/v2 双写；
- 启动时静默 reset 或覆盖旧数据库。

旧数据库和旧 `private_data` 不属于当前 V3 运行链。

## 历史文档

以下文档保留用于理解历史架构或此前实施过程，但不再作为产品需求源：

- `AI-architecture-refactor.md`
- `TRAVEL_WORKBENCH_V3.md`

当历史文档与 `PRODUCT_PLAN.md` 冲突时，以 `PRODUCT_PLAN.md` 为准；数据库迁移相关内容全部由当前“直接新数据库”决策覆盖。
