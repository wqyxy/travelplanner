你现在需要根据项目 `docs/PLAN.md` 对当前项目进行修改。

项目中有三个核心现状 / 目标文档：

- `docs/PRODUCT.md`：当前产品实际上是什么样；
- `docs/TECHNICAL.md`：当前代码和技术架构实际上是什么样；
- `docs/PLAN.md`：下一步准备把项目修改成什么样。

你的任务不是机械执行 `PLAN.md`，而是：

> 理解现状 → Review PLAN → 和用户对齐 → 制定最小可验证实施方案 → 分阶段施工 → 每个阶段交给用户本地 Codex 独立测试。

---

# 一、总体原则

1. `PRODUCT.md` 和 `TECHNICAL.md` 是当前状态参考。
2. `PLAN.md` 是目标方向，但其中的实施细节不一定绝对正确。
3. 实际代码是当前实现事实的最终依据。
4. 如果文档与代码不一致：
   - 明确指出；
   - 判断是文档过期还是代码偏离设计；
   - 不要擅自猜测用户意图。
5. 用户是最终决策者。
6. 不为了代码结构漂亮而扩大重构范围。
7. 优先完成 PLAN 真正要求的行为变化，不顺手重构无关代码。
8. 尽量减少施工阶段数量，也尽量减少用户需要本地测试的次数。
9. 每个 Phase 应尽可能形成一个完整、可运行、可独立验证的状态。
10. 不要一次性完成所有 Phase 后才让用户验证。
11. 所有执行型测试都由用户在本地完成，施工 Agent 只负责代码修改、静态 Review 和生成测试 Prompt。

---

# 二、测试铁律：禁止施工 Agent 和 GitHub 执行测试

这是最高优先级施工规则之一。

## 绝对禁止

施工 Agent 不得自己执行任何测试或运行验证，包括但不限于：

- GitHub Actions；
- GitHub CI；
- workflow_dispatch；
- 新建或修改临时 workflow 来跑测试；
- 新建测试分支并利用 push / PR 触发测试；
- 利用、等待或查询 CI 结果作为本阶段验收依据；
- 在容器、远程机器、施工 Agent 自己的本地环境运行测试；
- `npm test` / `vitest` / `jest` / `pytest`；
- lint；
- typecheck / `tsc`；
- build；
- migration test；
- API test；
- 启动应用自行做 UI 验证；
- 任何其他具有“验证代码是否通过”性质的执行命令。

即使仓库已经存在 CI、测试脚本或自动验收流程，也不要触发、创建、修改或利用它们完成本次施工测试。

施工 Agent 可以：

- 阅读代码；
- 阅读现有测试代码；
- 检查 diff；
- 静态检查调用关系；
- 静态检查数据流和接口是否一致；
- 编写或修改测试代码，供用户本地执行。

但不能把静态判断写成“测试通过”。

没有用户返回的本地测试结果时，只能写：

> 尚未由用户本地验证。

---

# 三、本地测试必须绑定 Git Branch + HEAD

任何一次用户本地测试，都必须绑定到**唯一、明确的 Git 分支和 HEAD commit**。

测试结果只对该 `branch + HEAD SHA` 有效。

## 施工 Agent 的责任

每个 Phase 代码施工结束、准备交给用户测试时，施工 Agent 必须确定并记录：

```text
Test Branch: <branch>
Test HEAD: <完整 40 位 commit SHA>
```

这两个值必须同时写入：

1. `docs/PLAN_PROGRESS.md` 当前 Phase；
2. `docs/PLAN_EXECUTION.md` 当前 Phase 的 Codex 本地测试 Prompt；
3. 直接发给用户的测试 Prompt。

如果施工发生在 GitHub 上，以**实际包含本阶段全部待测代码的分支和最新提交 SHA**为准。

如果代码修改后又产生任何新的提交，即使只改了一行代码：

- 旧 `Test HEAD` 立即失效；
- 之前针对旧 HEAD 的 PASS 不能继续作为当前代码的 PASS；
- 必须更新 `PLAN_PROGRESS.md`；
- 必须重新生成测试 Prompt；
- 用户必须针对新的 HEAD 重新测试。

## 本地测试 Agent 的第一步

测试 Prompt 必须要求本地 Codex 在运行任何测试前先执行只读检查：

```bash
git branch --show-current
git rev-parse HEAD
git status --short
```

然后严格比较：

```text
实际 Branch == Test Branch
实际 HEAD   == Test HEAD
```

任意一个不匹配：

> 立即停止，不运行任何测试，输出 `TEST_BASE_MISMATCH`。

## 测试 Agent 禁止自行修正 Git 状态

如果 branch 或 HEAD 不匹配，测试 Agent 不得为了继续测试而执行：

- `git checkout`；
- `git switch`；
- `git pull`；
- `git merge`；
- `git rebase`；
- `git reset`；
- `git cherry-pick`；
- 任何会改变当前分支、HEAD 或工作树代码版本的 Git 操作。

测试 Agent 只报告不匹配，让用户决定如何处理。

## 工作树要求

开始测试前：

- 已跟踪生产代码不应存在未提交修改；
- 如果 `git status --short` 显示修改，测试 Agent 必须先判断是否会改变待测代码；
- 如果存在会影响待测结果的本地修改，立即停止并报告 `TEST_WORKTREE_DIRTY`；
- 不允许把带本地生产代码修改的结果记为正式 PASS。

## PASS 必须回报测试基线

用户本地 Codex 的最终报告必须包含：

```text
Test Branch: ...
Test HEAD: ...
Phase N: PASS / FAIL
```

施工 Agent 收到结果后，必须先核对返回的 Branch 和 HEAD 是否与 `PLAN_PROGRESS.md` 中记录的一致。

不一致时，不接受 PASS。

---

# 四、第一阶段：Review PLAN，不修改业务代码

首先完整阅读：

- `docs/PRODUCT.md`
- `docs/TECHNICAL.md`
- `docs/PLAN.md`

并结合当前代码进行必要检查。

这一阶段不要修改任何业务代码。

先用人话输出：

## 1. 当前状态

说明现在用户实际上怎么使用这个功能。

## 2. PLAN 修改后会变成什么样

重点解释用户体验和业务逻辑，不要先堆技术名词。

优先使用：

> 现在是……
>
> 修改以后会……
>
> 用户操作时会……

## 3. PLAN 的核心变化

归纳成少量几个真正的业务变化。

## 4. 发现的问题

如果存在以下情况必须指出并向用户提问：

- PLAN 描述不明确；
- 两个要求冲突；
- PRODUCT / TECHNICAL / PLAN / 当前代码互相矛盾；
- 存在两种以上明显不同的产品行为；
- 必须由用户做产品决定。

只问真正影响产品行为或架构方向的问题。

可以通过查看代码确定的问题不要问用户。

## 5. 初步实施判断

简单说明：

- 预计几个 Phase；
- 高风险点；
- 是否涉及旧数据兼容 / 迁移；
- 哪些步骤可以合并施工和合并测试。

完成 Review 后停止。

**用户明确确认需求前，不开始修改业务代码。**

---

# 五、第二阶段：创建实施文档

需求确认后创建 / 更新：

```text
docs/PLAN_EXECUTION.md
docs/PLAN_PROGRESS.md
```

## `PLAN_EXECUTION.md`

描述如何从当前状态走到 PLAN 的目标状态，而不是重复 PLAN。

至少包含：

1. 目标；
2. 与本次改造直接相关的当前状态；
3. 已确认的关键设计决定；
4. 尽可能少但安全可验证的 Phase；
5. 每个 Phase 的：
   - 目标；
   - 修改范围；
   - 主要修改；
   - 代码施工完成条件；
   - 本地测试要求；
   - Codex 本地测试 Prompt。

不要为了形式强拆很多 Phase。

优先把强相关的数据模型、后端、API、前端、Prompt 修改放在同一个业务闭环里，减少用户重复测试。

## `PLAN_PROGRESS.md`

用于记录实时施工状态，使新 Codex 会话只读这三个文件就能继续：

- `PLAN.md`
- `PLAN_EXECUTION.md`
- `PLAN_PROGRESS.md`

推荐结构：

```markdown
# PLAN Progress

## Overall Status
当前阶段：
总体状态：
最后更新时间：

## 已确认的产品决定
- ...

## Phase 状态

### Phase 1
状态：pending / in_progress / awaiting_local_test / completed / blocked

完成：
- ...

未完成：
- ...

测试基线：
- Test Branch: ...
- Test HEAD: ...

本地测试：
- 尚未由用户本地验证 / 用户反馈 PASS / 用户反馈 FAIL

发现的问题：
- ...

## 当前已知问题
- ...

## 与原计划的偏差
- ...

## 下一步
- ...
```

特别注意：

- 施工 Agent 不得自己把测试状态写成 PASS；
- 代码完成但用户尚未测试时，Phase = `awaiting_local_test`；
- `awaiting_local_test` 必须同时存在明确 `Test Branch` 和 `Test HEAD`；
- 只有用户返回与该 Branch + HEAD 完全一致的 PASS 后，才能标记 completed。

---

# 六、第三阶段：按 Phase 顺序施工

每次只推进当前 Phase。

## A. 开始前检查

确认：

- 当前 Phase 目标；
- 前一个 Phase 是否已由用户本地测试 PASS；
- `PLAN_PROGRESS.md` 是否存在 blocker；
- 当前代码是否与实施计划预期一致。

如果实施方案需要调整，可以修改 `PLAN_EXECUTION.md`，但必须记录：

- 为什么改变；
- 原方案；
- 新方案。

不能悄悄偏离。

## B. 修改代码

原则：

- 只修改当前 Phase 必要代码；
- 避免无关重构；
- 尽量沿用已有架构；
- 不为理论完美破坏稳定逻辑；
- 旧数据和旧行为兼容按已确认规则处理。

如果发现新的产品决策问题：

- 停止该问题相关施工；
- 用人话告诉用户；
- 不擅自增加新产品规则。

## C. 静态 Review

代码完成后可以：

- 阅读修改代码；
- 检查 diff；
- 检查调用点；
- 检查类型、接口、数据流逻辑；
- 检查是否超出当前 Phase；
- 编写 / 修改测试代码供本地执行。

不能执行任何测试、构建、类型检查、应用启动或迁移。

## D. 固定本阶段测试基线

在交给用户测试前，必须记录实际待测版本：

```text
Test Branch: <branch>
Test HEAD: <40 位 SHA>
```

然后：

1. 更新 `PLAN_PROGRESS.md`；
2. 把 Phase 状态改成 `awaiting_local_test`；
3. 把 Branch + HEAD 写入 `PLAN_EXECUTION.md` 对应测试 Prompt；
4. 向用户输出同一份 Prompt；
5. 停止施工。

## E. Codex 本地测试 Prompt 必须包含的开头

每个 Phase 的测试 Prompt 都必须首先包含类似下面的内容：

```text
本次测试只允许针对以下 Git 基线：

Test Branch: <EXPECTED_BRANCH>
Test HEAD: <EXPECTED_FULL_SHA>

在任何测试前先运行：

git branch --show-current
git rev-parse HEAD
git status --short

如果当前 Branch 或 HEAD 与上面不完全一致：
立即停止，不要 checkout / switch / pull / merge / rebase / reset / cherry-pick，输出 TEST_BASE_MISMATCH。

如果存在会改变待测生产代码的本地未提交修改：
立即停止，输出 TEST_WORKTREE_DIRTY。
```

随后再要求测试 Agent：

- 阅读 `PLAN.md` / `PLAN_EXECUTION.md` / `PLAN_PROGRESS.md`；
- 独立检查本阶段代码；
- 在用户本地运行必要 typecheck / unit / integration / build / UI 等测试；
- 重点寻找功能遗漏、回归、边界、数据兼容、状态同步问题；
- 不相信施工 Agent 的结论；
- 不为了让测试通过而修改生产代码。

最终输出必须包含：

```text
Test Branch: ...
Test HEAD: ...
Phase N: PASS / FAIL

实际执行的测试：
- ...

发现的问题：
- ...

未覆盖或无法验证：
- ...

是否建议进入下一 Phase：是 / 否
```

---

# 七、等待用户测试结果

用户本地测试完成前，不进入下一 Phase。

## 测试失败

如果用户返回 FAIL：

1. 核对 Test Branch + Test HEAD；
2. 阅读问题；
3. 修复代码；
4. 更新 `PLAN_PROGRESS.md`；
5. 新代码形成新 HEAD 后，旧测试基线立即失效；
6. 记录新的 Test Branch + Test HEAD；
7. 重新生成测试 Prompt；
8. 再次等待用户本地测试。

施工 Agent 仍然不自行运行测试。

## 测试通过

只有同时满足以下条件才接受 PASS：

- 用户报告 PASS；
- 返回的 Test Branch 与当前记录完全一致；
- 返回的 Test HEAD 与当前记录完全一致；
- 该 HEAD 之后没有新的待测代码提交。

满足后才可以：

```text
Phase N = completed
Phase N+1 = in_progress
```

如果 HEAD 已经变化，即使用户刚返回 PASS，也必须视为旧版本测试结果，不得直接进入下一阶段。

---

# 八、减少 Phase 和测试次数

不要采用：

> 改数据库 → 测一次
> 改后端 → 测一次
> 改前端 → 测一次
> 改 Prompt → 测一次

如果这些共同组成一个业务功能，优先完整施工后给用户一份综合本地测试 Prompt。

只有风险明显需要隔离时才拆开，例如：

- 数据迁移风险高；
- 基础架构必须先稳定；
- 前一步失败会导致后续大量作废；
- 两个模块确实可独立验证；
- 修改量大到无法合理 Review；
- 必须先确认某个产品行为。

目标是：

> 用最少 Phase 获得足够风险控制，并尽量减少用户本地测试次数。

---

# 九、完工阶段

所有 Phase 都已经针对各自记录的 Branch + HEAD 由用户本地测试 PASS 后，再进行最终整体 Review。

检查：

1. `PLAN.md` 目标是否全部实现；
2. 是否存在“代码完成但用户体验没完成”；
3. PRODUCT / TECHNICAL 是否过时；
4. 是否存在遗留兼容代码；
5. 是否存在 TODO / 临时方案；
6. 是否存在未覆盖边界；
7. 各 Phase 的测试基线和 PASS 是否一致。

如果需要最终全量验收：

- 不要自行运行；
- 固定最终 `Test Branch + Test HEAD`；
- 生成最终 Codex 本地验收 Prompt；
- 等待用户反馈。

只有最终 PASS 且 Branch + HEAD 完全匹配，才可更新：

```text
Overall Status: completed
```

然后根据最终真实代码状态更新：

- `docs/PRODUCT.md`
- `docs/TECHNICAL.md`

`PLAN.md` 保留作为本次改造目标和历史设计依据。

---

# 十、最重要的工作方式

```text
理解现状
↓
Review PLAN
↓
用人话和用户确认
↓
确定产品决策
↓
生成实施方案
↓
拆成最少必要 Phase
↓
实施当前 Phase
↓
静态 Review
↓
固定 Test Branch + Test HEAD
↓
更新 Progress = awaiting_local_test
↓
生成绑定 Branch + HEAD 的 Codex 本地测试 Prompt
↓
用户本地测试
↓
核对返回 Branch + HEAD
↓
PASS 后进入下一 Phase
↓
最终整体 Review
↓
固定最终 Branch + HEAD
↓
用户本地最终验收
↓
同步 PRODUCT / TECHNICAL
```

不要跳过需求确认。

不要在需求有明显歧义时直接施工。

不要在 GitHub 上进行任何测试。

不要由施工 Agent 自己运行任何测试。

不要接受与记录的 Git Branch / HEAD 不一致的测试结果。

**所有测试一律通过绑定明确 Branch + HEAD 的 Prompt，交给用户在本地 Codex / 本地项目环境执行。**
