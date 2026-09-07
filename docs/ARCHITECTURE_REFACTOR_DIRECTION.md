# 进度
- 已完成：规则、README、产品/技术/计划文档、启动/HTTP/API/会话、V3 Store/Runtime、最终线路派生与 AI、地图/定位/路线、主要前端链路静态阅读。
- 已确认：当前主链是 finalRoute 两工作区；旧 Phase 3 测试数字不能视为当前 HEAD 验证结果。
- 已确认：未发现需立即阻断发布的 P0；重点是并发写入、作用域保护、会话失效和跨层转换。
- 本文只保留结论与实施顺序；未运行测试、构建、应用或外部服务。

# P0 / P1 / P2 问题
- **P0：暂无。**
- **P1｜详细安排可能显示保存成功却丢字段，或改动其他节点。** planned Day 仅改 activity / duration 时，写回桥不把它判为详细内容，字段恢复 null。
  - 原因：`stopHasExplicitDetail` 漏这两项；桥重建全部 Day，其他 detailed Day 中原为空的 activity 也可能被地点名填入，Scope 检查发生在桥之前。
  - 建议：先保住显式编辑字段，再把详情写入收敛到目标 route node；预览与持久化共用同一转换，转换后检查范围外内容不变。
  - 关键文件：`apps/server/final-route-v3.ts`、`apps/server/plan-commands-v2.ts`、`apps/server/travel-store-v3.ts`。
- **P1｜旧编辑页面可覆盖较新的修改。** 需求和详细安排走 CTA，不提交页面 generation；服务端改用接收请求时的 generation。
  - 原因：交互式编辑与“此刻启动 AI”共用创建 Action 合同，原有 CAS 无法识别陈旧编辑稿。
  - 建议：人工编辑携带 expectedGeneration 并在创建 / 执行时校验；统一检查 Action 最终状态再提示保存成功。
  - 关键文件：`apps/server/travel-api-v3.ts`、`apps/web/src/AppFinalRouteV3.tsx`、`apps/web/src/FinalRouteEditorDrawerV4.tsx`。
- **P1｜切换旅行会被旧旅行刷新抢回。** 点击 B 后 A 的事件可调用 loadTrip(A)，使 B 的请求 token 过期。
  - 原因：selectedTripId 直到响应渲染才改变；后台刷新和主动导航共用 loadToken，部分保存回调直接 setWorkspace。
  - 建议：点击时固定目标 tripId；导航、刷新和保存响应均验证目标与请求版本，退出 / 回收站同步失效旧请求。
  - 关键文件：`apps/web/src/AppFinalRouteV3.tsx`。
- **P1｜较晚返回的自动定位可覆盖人工选点。** 两者只比较旅行 generation，而人工坐标保存不增加 generation。
  - 原因：PlaceResolution 没有本轮定位请求的条件写入；同一地点的并发任务共享相同有效性条件。
  - 建议：按地点区分定位请求版本，人工确认使旧请求失效；统一通知定位变化并触发对应 dirty Route 更新。
  - 关键文件：`apps/server/place-resolver-v2.ts`、`apps/server/travel-store-v3.ts`、`apps/server/planner-runtime-v3.ts`。
- **P1｜核心 AI 权限依赖全局原型补丁。** 普通类实例是否保护最终线路取决于是否先导入 cutover，类型系统无法约束。
  - 原因：通过 `prototype as any` 替换私有方法，并用全局 Map 向 Store 传递本轮 AI 输出。
  - 建议：把现有转换与限制接回显式、带类型的 Action handler；保留现有算法和持久化事务。
  - 关键文件：`apps/server/final-route-ai-cutover-v3.ts`、`apps/server/planner-runtime-v3.ts`。
- **P1｜退出登录后，已连接的 WebSocket 仍能收取更新。** 连接只在 upgrade 时验证；logout 撤销 HTTP 会话，广播不复核。
  - 原因：clients 只保存 socket，未关联会话；撤销记录仅存内存，重启后旧 token 又可通过校验。
  - 建议：让连接随会话撤销 / 到期关闭；另确认跨重启注销策略后实施，保留既定改密码行为。
  - 关键文件：`apps/server/index-v3.ts`、`apps/server/auth.ts`。
- **P2｜协作规则与现状冲突。** AGENTS 仍强制五步流程、引用已删除文档，当前入口已是 finalRoute 两工作区。
  - 原因：产品切换后规则入口未同步，README 的测试结果也停在 Phase 3。
  - 建议：统一当前事实入口，历史测试明确标明覆盖 HEAD，保留安全与用户控制约束。
  - 关键文件：`AGENTS.md`、`README.md`、`docs/PLAN_PROGRESS.md`。

# 暂时不要动
- 不重写 canonical 三阶段、PlaceKind、Action/Dialogue 合同；它们是当前安全边界。
- 不做 v2→v3 迁移、自动删除旧库、全量重写 finalRoute UI 或引入新的规划合理性 blocker。
- 不把路线、坐标、Provider ID 或实时事实移入 AI 生成链。

# 实施顺序
1. 先拆除 AI cutover 的全局原型补丁，建立显式、带类型的 Action handler；保持现有 Scope、Proposal、CAS 和事务。
2. 为人工编辑、AI Action、定位任务补齐 expected generation / per-place request version，并统一处理 stale、superseded、失败结果。
3. 绑定 WebSocket 与会话生命周期，明确重启后的撤销策略，再处理旅行切换的请求目标校验。
4. 收敛 Day/Route 转换：保留显式 activity、duration 等字段，只写目标节点，并让预览与持久化共用转换。
5. 最后同步 AGENTS、README、进度文档的当前入口和验证口径。

# 最优先 3 件事
1. 去掉 `final-route-ai-cutover-v3.ts` 的全局 prototype/Map 桥接。
2. 建立跨人工编辑、AI、定位的版本条件写入，防止旧响应覆盖新决定。
3. 修复 WebSocket 会话失效与 finalRoute 跨层 Day 转换的数据保留。
