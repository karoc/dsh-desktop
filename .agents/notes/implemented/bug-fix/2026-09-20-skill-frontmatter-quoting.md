# Agent Note: skill-frontmatter-quoting

Status: implemented

## Problem

`.dsh/skills/` 下两个技能的 `description` frontmatter 值未加引号却含 ASCII `": "`，YAML 在 compact mapping 中把冒号后的内容读成嵌套 mapping，抛 `YAMLParseError: Nested mappings are not allowed in compact mappings`：

- `.dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md` —— `Triggers on: 检查/更新/同步…`
- `.dsh/skills/windows-desktop-shell-debugging/SKILL.md` —— `` `launch failed: not installed` ``

DSH 的 skill-filesystem provider 对解析失败的 SKILL.md 是**静默丢弃**：`parseSkillFile` 只写一条服务端 `logger.warn` 然后 `return undefined`，模型可用的技能目录与用户界面都没有任何提示。后果：在 dsh-desktop 工作区里这两个技能对模型和用户同时不可见；而 `dsh-preinstalled-plugin-sync` 还被 `~/.agents/skills/` 下的 symlink 全局暴露，所以它在任何工作区都不可见。

## Decision

两个 `description` 改为双引号 YAML 标量，内部双引号转义为 `\"`，文本逐字保留（与修复前的原文做全等比较验证）。

第三个技能 `.dsh/skills/dsh-desktop-shell-dev/SKILL.md` 经检查无此缺陷（其 description 用的是全角「：」，不触发 YAML 嵌套），本次未改。

**这次修复曾经丢失过，因此本 note 记录该事实**：第一次修复只留在工作区、没有提交，随后被同一 checkout 上的并发工作（分支切换 / 快进拉取 / PR 合入流程）覆盖，文件在 10:57 与 12:31 两次回到未加引号的 HEAD 内容；`git stash list` 为空、`git log --all -S` 无命中，证明它从未进入版本控制、不可恢复。教训：**跨仓库或共享 checkout 上的修复必须当次提交**，留在工作区的改动随时会被并发流程抹掉，而"技能被静默丢弃"没有任何报错面会提醒你。

未做的事：没有改 DSH 的解析器（输入本身是非法 YAML）；没有把一致性校验脚本收进本次提交（见后续的副本一致性门禁工作）。

## Alternatives considered

**把 ASCII `": "` 换成全角「：」**：改动最小，但 windows 那份 description 里引的是真实运行时错误串 `launch failed: not installed`，用户会按字面 grep，换字符会破坏这个可检索字符串；统一加引号以逐字保留文本。

**只在 `~/.agents/skills` 的 symlink 侧修**（不动仓库文件）：symlink 指向的就是仓库文件，改不了；且仓库副本才是随 dsh-desktop 版本控制、会分发给别人的那一份。

**给 DSH 提缺陷单要求解析失败时可见报错**：方向正确但不在本仓库范围内，且不能替代把非法 YAML 修对。

## Consequences

买了：两个技能在 dsh-desktop 工作区与全局都恢复可发现（`FileSystemSkillProvider` 实测 cwd=/home/karoc 与 cwd=/home/karoc/dsh-desktop 均 0 告警）。

代价与边界：这类缺陷**没有可见的失败面**——技能消失与"技能被正确停用"在目录里长得一模一样，只能靠解析器的 warn 或直接跑 provider 发现；因此本仓库的 `.dsh/skills/*/SKILL.md` 每次改 description 都要留意是否引入了 `": "`。

覆盖缺口：本次只修了 frontmatter。随壳分发的 kanban-use 技能（`plugins/preinstalled/dsh-kanban/`、`src-tauri/resources/preinstalled/dsh-kanban/`）仍带同类坏 frontmatter，需经 dsh-kanban 发版 + npm-tarball 同步才能更新；预装同步是版本门控的，不升 package 版本时 `scripts/audit-preinstalled.mjs` 会判 `up-to-date`。
