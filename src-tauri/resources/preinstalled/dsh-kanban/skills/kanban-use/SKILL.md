---
name: kanban-use
skill-version: 1
description: Use when creating, updating, or closing kanban board cards (board_list / board_add / board_update / board_remove), when the user states a multi-step plan or list of tasks that should outlive this turn, when resuming work in a workspace that has an open board, or when asked how the board should be used. Teaches the card-completeness discipline: every card carries why (rationale), rejected alternatives when a decision was made, and a done card is self-explanatory with all three what/why/rejected fields so the next session can pick the work up without asking.
---

# kanban 使用纪律（dsh-kanban 插件配套技能）

本技能与 dsh-kanban 插件同一仓库维护（`skills/kanban-use/SKILL.md`），是
「卡片怎么写才完整」的深度手册。插件的系统提示只给摘要，本技能给语义、
示例、好/坏对比和检查清单。看板是跨会话的持久记忆：**下一会话不问你，
只看卡片** —— 卡片写得不完整，记忆就是坏的。

## 1. 三件套怎么分工

| 工具/机制 | 用途 | 寿命 |
|---|---|---|
| `todo_write` | 当前回合内的步骤清单，随回合消失 | 回合 |
| `board_*` 看板 | 跨会话、跨分支的计划与待办；每条卡片是交接记录 | 工作区（KANBAN.json） |
| `note_add`/`note_list` | 非平凡变更的深度决策档案（为什么做、放弃了什么、代价） | 工作区（.agents/notes） |

界线：**计划与进度** → 看板；**完成后的决策档案** → Agent Note。一个
非平凡变更通常两者都有：看板卡片记「做了什么、进行到哪」，Agent Note 记
「为什么这样做、放弃了什么、代价是什么」。

## 2. 卡片解剖：六个字段的语义

| 字段 | 语义 | 何时写 |
|---|---|---|
| `title` | 具体、可行动的一步（非空） | 创建时必填 |
| `description` | 自由补充细节 | 需要时 |
| `rationale`（为什么） | 这张卡为什么存在、为什么现在做 —— 让下一会话不问你也能接上 | **创建时必写** |
| `rejected`（放弃了什么） | 试过或考虑过但放弃的方案，以及为什么放弃 | **有取舍决策就写**（含"明确决定不做 X"） |
| `summary`（做了什么） | 实际完成了什么（相对 title 的承诺） | 完成时写 |
| `status` + `tags` | 生命周期 + 分组 | 随进度更新 |

**规则**：任何卡片缺 `rationale` 都是不完整卡；`done` 卡片必须三字段
（`summary` + `rationale` + `rejected`）齐备 —— 做到"自解释"才算关闭。
缺字段会在工具输出、会话开始注入和 Web 看板页上被标注（⚠️缺 / 缺字段），
看到了就补上。

## 3. 好卡 vs 坏卡

坏卡（只写标题，下一会话只能猜）：

> board_add(title: "修复侧边栏角标")

好卡（为什么、取舍一目了然）：

> board_add(
>   title: "修复：侧边栏角标随工作区切换更新",
>   rationale: "角标 resolved workspace 用的是 recentWorkspaceId（最近更新的会话的工作区），切换工作区后不更新，误导用户；侧边栏是最常驻的入口，计数必须跟随当前会话 cwd",
>   rejected: "方案B（订阅 workspaces feed 用最近工作区）被否：feed 会钉在最近更新的工作区，切换后依然滞后；改用当前会话 cwd 同规则 + 订阅 sessions feed",
>   tags: ["dsh-kanban", "bugfix"],
> )

完成时再补（收尾三字段齐备）：

> board_update(id: "card-…", status: "done",
>   summary: "角标改为优先取当前会话 cwd 并订阅 sessions/workspaces feed，切换即时更新；3080 实测 jiuta→4、karoc→隐藏、切回→4",
>   rationale: "……（如创建时已写则不必重写）",
>   rejected: "……（如创建时已写则不必重写）",
> )

## 4. 创建（board_add）

- 用户提出多步计划/任务清单 → 把**每一步**记成一张卡，不是整件事一张卡。
- 每张卡：`title` + `rationale` 必写；有取舍决策时写 `rejected`；`tags` 便于
  分组；`summary` 留到完成时写。
- `sourceSessionId` 由工具自动记录（Web 页"打开处理会话"按钮靠它跳回）。
- 创建后注意工具返回里的 `⚠️缺:` 标注 —— 缺 `为什么` 就立刻补。

## 5. 推进（board_update）

- 开始做某步 → 移 `in_progress`；完成 → 移 `done`；被取代/废弃 → 移 `done`
  或 `board_remove`（说明原因写进 rejected 或 description，别无声删除）。
- 决策途中出现取舍（"决定不做 X，因为 Y"）→ 随时补进 `rejected`。
- 一律先 `board_list` 拿真实 id 再 update；id 精确匹配，不要凭记忆。

## 6. 收尾（Close the loop，会话结束必做）

每轮工作结束（任务完成或到达明确停点）：

1. `board_list` 读当前状态。
2. 完成的卡 → `done` + 三字段齐备（`summary` 写实际做了什么，含验证结果；
   `rationale`/`rejected` 缺失则补）。
3. 留下后续工作 → 新增 todo 卡（同样带 `rationale`）。
4. 别留"僵尸卡"（没有工作却 in_progress）。

**关闭检查清单**：这张 done 卡，下一个会话不问任何人，能回答——
做什么了？为什么做？放弃/排除了什么？三问任一答不出 → 卡还没写完。

## 7. 恢复会话

- 会话开始时系统已自动注入开放卡（含 `(缺:…)` 标注），但以 `board_list`
  的实时结果为准。
- 看到带缺字段标注的卡 → 主动补 `rationale`（以及能补的 `rejected`），再开
  始干对应的活 —— 补字段本身就是推进。

## 8. 与 Web 看板页的配合

- 看板页每 15s 自动刷新：模型写入后页面自动可见。
- 缺字段的卡在页面上显示「缺字段：…」警告行 —— 用户侧也能看到不完整，
  所以别指望"没人看见"。
- 人的 `/kanban` 命令输出同样带 `⚠️缺` 标注。
- 想确认工作区卡片整体质量，可运行仓库脚本 `node scripts/audit-cards.mjs <workspace> --fail`。

## 9. 模板速查

创建模板：

    board_add(
      title: "<可行动的步骤>",
      rationale: "<为什么存在、为什么现在>",
      rejected: "<放弃的方案 + 原因（有则写）>",
      tags: ["<分组>"],
    )

收尾模板：

    board_update(
      id: "<board_list 拿到的真实 id>",
      status: "done",
      summary: "<实际做了什么，含验证/结果>",
      rationale: "<为什么（缺失才补）>",
      rejected: "<放弃了什么（缺失才补）>",
    )