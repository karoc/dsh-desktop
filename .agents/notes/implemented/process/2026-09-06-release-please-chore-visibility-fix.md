# Agent Note: release-please-chore-visibility-fix

Status: implemented

## Problem

首次在 release-please 自动化下的预装插件同步（chore(plugins) commit 918673b）被静默丢弃：release-please 运行成功但 PR #26（0.6.3）的 head 仍是旧提交，不含同步。此前 0.3.0/0.3.9 的插件同步发布是手动「chore(release): bump」提交，早于 2026-08-27 引入的 release-please 自动化，因此这是该自动化首次遇到纯 chore/docs 提交的发布场景。

## Decision

根因：release-please v4 的 DefaultChangelogNotes 用 conventional-changelog-conventionalcommits preset，其默认 types 里 chore/docs/style/refactor/test/build/ci 全部 hidden——纯 chore/docs 提交生成的 changelog 为空，base.ts buildReleasePullRequest 里 changelogEmpty 检查直接 return undefined，release PR 既不创建也不更新（运行日志显示 success 但无 PR 变动）。修复：在 release-please-config.json 的包配置加 changelog-sections，显式列出全部类型，除 chore 外保持与原默认一致（feat/fix/perf/revert 可见，docs/style/refactor/test/build/ci 仍 hidden），chore 映射到 "Chores" 区。修复提交为 fix(release) 类型（159d5ca），推 main 后 release-please 用新配置重建 PR #26，918673b（chore(plugins) 同步）进入 changelog 的 Chores 区并随 0.6.3 发布。验证：git merge-base --is-ancestor 918673b origin/release-please--branches--main 为真；PR #26 body 的 Chores 区列出插件同步。边界：docs 仍 hidden（与默认一致），纯 docs 提交仍不会触发发布——这是有意的，避免文档/技能沉淀触发无意义发版。
## Alternatives considered

手工往 release-please 分支塞提交/强制改 PR——拒绝：对抗自动化且每次 push 会被 release-please 重建覆盖，不治本。改提交类型把 chore 改成 fix/feat——拒绝：语义不符（同步不是 bug/feature），且改动已推送、需改写历史。给插件同步提交加 Release-As footer 强制版本——拒绝：只能顶一次，后续同步仍会丢，且不能解决 docs 同源问题。直接把 changelog-sections 全放开（含 docs）——拒绝：会让 docs(skills) 等文档提交也触发发版，改变既有发布节奏。
## Consequences

此后 `chore(plugins)` 预装插件同步会正常进入 release-please 的发布 PR（Chores 区）；`docs` 仍不触发发版，与现状一致。本次修复本身以 fix(release) 进入 0.6.3 的 Bug Fixes 区。副作用：changelog-sections 现在显式锁定类型列表，release-please 升级改变默认 types 时不会静默影响本仓库（配置成了真源）；代价是需维护这份列表。已知边界：本次只解了 chore；若未来想让 docs 也发版需再改配置。

