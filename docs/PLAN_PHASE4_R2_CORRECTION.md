# Phase 4 r2：最终线路视觉模型纠正

> 日期：2026-09-06
>
> 本文件纠正并覆盖 `PLAN.md` 第 31–47 节中与“Day 大卡片 / Day Header”有关的旧描述。
> `finalRoute`、派生 Day、Route Provider、用户控制权等基础原则不变。

## 1. 为什么需要 r2

Phase 4 r1 的自动化代码测试全部通过，但真实浏览器验收未执行。随后产品 Review 发现更重要的问题：r1 的视觉表达虽然技术上使用同一份 `finalRoute`，但又把 Day 做成了包住地点的一级大容器，并允许派生 Day 文案接近地点名称区域。

这与产品核心原则相背：

> **地点永远只是地点；Day 只是最终线路上的时间分界，不应该变成第二套包住地点的结构。**

因此 r1 不再作为待浏览器验收的最终产品方案，直接进入 Phase 4 r2 返工。

---

## 2. 最终线路的唯一视觉语法

最终线路固定为：

```text
地点卡

交通连接

地点卡

──────── 第 1 晚 ────────

交通连接

地点卡

...
```

只有三种核心视觉对象：

```text
地点 = 地点卡
交通 = 两个当前有效地点之间的连接线
住宿 / Day = 地点之间的“第 N 晚”分隔线
```

禁止重新引入：

```text
Day 大卡片
Day Header 包住一组地点
“Day 2 前往 xxx”作为地点名称
“当天终点 xxx”替代地点名称
派生 Day title 冒充 Place 名称
```

Day 仍然存在于派生数据中，用于日期、AI scope、Route scope 等内部和辅助功能，但**线路主体不再以 Day 容器组织地点**。

---

## 3. 地点卡必须完全统一

无论一个节点是：

```text
第一天第一个地点
当天中途地点
当天最后一个住宿地点
下一天第一个地点
连续住宿产生的同 Place 新 route node
```

它都使用同一种地点卡组件。

地点主标题只能来自 Place 名称展示逻辑：

```text
中文名 / 英文名 / 当地名
```

Place 缺失时只允许显示类似：

```text
未命名地点
```

禁止使用：

```text
node.activity
Day.title
“前往 xxx”
```

作为地点名称 fallback。

地点的 activity / 时间 /备注仍属于详细安排，只能作为次级信息或编辑内容，不能取代地点身份。

---

## 4. Day 用“第 N 晚”分隔，而不是 Day 容器

`normal && endsDay` 的线路节点之后插入：

```text
──────── 第 1 晚 ────────
```

下一有效地点自然属于下一天。

例如：

```text
奥克兰

🚗 自驾 · Provider 距离 · Provider 时间

Hobbiton

🚗 自驾 · Provider 距离 · Provider 时间

罗托鲁瓦   [住]

──────── 第 1 晚 ────────

🚗 自驾 · Provider 距离 · Provider 时间

Wai-O-Tapu
```

用户不需要维护 Day 编号。`第 N 晚` 根据当前有效 `finalRoute` 的住宿分界自动重新编号。

待定 / 不去节点保存的 `endsDay` 暂不生效，因此不显示当前有效的夜晚分隔线，只显示“住宿分界暂不生效”的异常提示。

---

## 5. 多一晚

“多一晚”继续使用现有 `add_final_route_night` 语义：在同一 Place 后增加一个独立的 normal route node，并设置新的 `endsDay`。

因此同一 Place 可以连续出现多次，但每一次都仍然只是普通地点卡。

示意：

```text
陶波   [住]
──────── 第 3 晚 ────────
陶波   [住]
──────── 第 4 晚 ────────
下一地点
```

这不是地点上的 `住 2 晚` 属性，也不是新建 StayBlock。

连续同 Place 的合成连接不是一段真实交通，不允许显示“交通待定”并诱导用户修改虚假的交通方式。真实距离 / 时间仍只来自 Route Provider。

---

## 6. 拖动排序

桌面端只有拖动把手可以启动排序：

```text
⠿  地点名称
```

但用户抓住把手后，视觉上被拖动的是**整张地点卡**：

```text
按住把手
→ 整张地点卡作为 drag image 跟随鼠标
→ 经过目标地点时显示明确的“插到前面 / 插到后面”位置线
→ 松开
→ 自动提交 move_final_route_node
→ finalRoute 重排
→ Day / 第 N 晚分隔 / 有效交通 / Route 自动重新派生
```

禁止：

```text
只有一个小图标孤零零跟着鼠标
整张卡任意位置都可误触拖动
松开后还需要用户再点“保存顺序”
依赖上移 / 下移作为桌面主排序入口
```

实现可以复用旧版 `ItineraryPanelV2` 的 native drag / dataTransfer 思路，但目标索引必须符合当前服务端 `move_final_route_node` 的“移除后插入”语义。

---

## 7. 交通连接规则不变

交通继续是两个**当前有效地点**之间的非卡片连接条。

例如：

```text
A
X【待定】
B
```

有效线路仍然是：

```text
A → B
```

连接条必须从派生 Day + `routeStates.route.legs` 构建，不能使用 DOM 上下相邻关系。

Route dirty 时禁止展示旧距离 / 时间为当前事实；Provider 数据不可由 UI、AI 或调用方伪造。

---

## 8. Hover / Click / Edit 规则继续有效

```text
Hover 地点
= 只高亮地点卡 + Marker，不移动 / 缩放地图

Click 地点
= 显式 flyTo 当前地点，不打开编辑

Click 编辑
= 打开独立抽屉，不触发 flyTo

Click 交通条
= 修改真实有效连接的交通方式

Click 住 / 不住 / 多一晚
= 修改 Day 分界
```

地图 Marker Click 不自动打开业务编辑。

编辑抽屉继续覆盖地图，不回退成 inline 展开。

---

## 9. Day 级 AI 操作的位置

因为线路主体不再有 Day Header，Day 级 AI 操作不能依附在每个 Day 大卡片上。

现阶段放到统一 AI 辅助区，通过派生 Day 选择器选择作用范围：

```text
第 N 天
→ 补充详细地点
→ 完善这一天
→ 优化这一天
```

这只是操作 scope，不改变“线路主体只有地点 / 交通 / 夜晚分隔”原则。

后续 Phase 5 再做 AI 菜单折叠和界面减法。

---

## 10. Phase 4 r2 施工边界

本轮只修改最终线路前端展示、拖拽交互和对应测试：

```text
FinalRoutePanelV3.tsx
phase4-final-route-interaction.css
final-route-drag-v4.ts
final-route-drag-v4.test.ts
phase4-final-route-interaction.test.ts
```

不修改：

```text
server finalRoute 核心模型
Day 派生算法
Route Provider 事实边界
AI 权限边界
```

现有服务端在 `move_final_route_node` 后已经会重新派生 Day，`add_final_route_night` 已经支持同 Place 多 route node，因此不为这次 UI 纠正增加后端模型。

---

## 11. 冻结测试基线

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r2
Test HEAD: 99e0974f66f7e1ad189adc9c806cec4d9a85f181
```

r1：

```text
Test Branch: test/plan-phase4-final-route-interaction-20260906-r1
Test HEAD: 6ced10e9fb68d76d5587d14726b78f248852cfd2
```

已经被本产品纠正取代，不再作为 Phase 4 最终验收基线。

---

## 12. r2 必须人工验证的浏览器场景

1. 所有地点卡主标题永远是地点名；不能出现 `Day N 前往 xxx`、派生 Day title 或 activity 冒充地点名。
2. 最终线路主体不存在包住地点的 Day 大卡片 / Day Header。
3. normal + `endsDay` 后显示 `第 N 晚` 分隔线；改变住宿分界后编号自动更新。
4. 多一晚后同 Place 可以再次出现为相同结构的地点卡，并多出下一条 `第 N 晚` 分隔线；不能出现虚假的“交通待定”。
5. 只有拖动把手能启动拖动；拖动时整张地点卡跟随鼠标。
6. 拖动经过其他地点的上半 / 下半区域时，插入位置线清晰可见；松开自动重排。
7. 向上、向下、跨住宿分界拖动都正确；重排后夜晚分隔和交通连接自动更新。
8. Hover 只高亮，不改变地图中心 / zoom。
9. Click 地点才 flyTo；Click 编辑 / 住 / 状态 / 交通不误触 flyTo。
10. 编辑抽屉继续覆盖地图；地图选点保存 / 取消后恢复编辑上下文。
11. A → X【待定/不去】→ B 时，有效交通仍显示 A → B。
12. 窄屏编辑仍是覆盖式 Sheet，不回退 inline。

只有以上浏览器 Gate 和自动化回归都 PASS，Phase 4 才能标记 completed。
