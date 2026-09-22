# Agent Note: release-pr-gate-and-asset-dispatch

Status: implemented

## Problem

合并 release-please 的发布 PR 时，`gh pr merge` 报 "base branch policy prohibits the merge"，而 `gh pr checks` **一条检查都看不到**——看起来像"门禁没跑"，实际是 release-please（bot）创建的 PR 触发的 build run 状态为 `action_required`：GitHub 要求人工批准 bot PR 的 workflow 才会启动。历史 run 列表证实这一点（所有 release-please 分支的 run 都是 `action_required` 或 workflow 级 failure，而人类分支的 run 全部 success）。于是发布 PR 永远等不到 `check`/`test`，分支保护恒为 BLOCKED，只有 admin 合并能过——这正是发布 PR 一直由人工在 Web 上合并的真实原因（此前没人说清过）。

第二个坑在同一流程的下游：release-please 是**用 GitHub API 创建 tag**，而 API 事件不触发 workflow，所以 `build.yml` 里 `if: startsWith(github.ref, 'refs/tags/v')` 的建 Release job 不会自动跑 —— 合并后确实生成了 tag 和 Release，但 **Release 的 assets 是空的**（v0.11.0 实测：`assets: []`），需要显式派发一次构建才会挂上安装包。

## Decision

发布 PR 的合并路径固定为：**先在发布分支上跑本地门禁，再 `gh pr merge --squash --admin`**，因为 release-please 的 bot PR 触发的 build run 状态是 `action_required`（GitHub 要求人工批准 bot PR 的 workflow），`check`/`test` 永不上报 → 分支保护恒为 `BLOCKED`。替代验证四条（写在 `CONTRIBUTING.md`「发布」一节）：四处版本一致（`package.json` / `.release-please-manifest.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`）、`CHANGELOG.md` 有该版本段、`npm test` 9 套、`node scripts/audit-preinstalled.mjs`。

合并后 release-please 会**用 GitHub API 创建 tag 与 Release**，而 API 创建的事件**不触发 workflow**，所以 tag 上不会自动跑出包：Release 创建出来时 `assets` 是空的。补法是显式派发一次（`build.yml` 开了 `workflow_dispatch`）：

```bash
gh workflow run build.yml --ref vX.Y.Z
```

该 run 跑 windows/linux 打包，并把安装包挂到 Release、用 `scripts/release-body.mjs` 重写说明。

负向保证：不改 release-please 的凭证或仓库 Actions 策略（不为了触发 workflow 引入长期 token）；不恢复"人手动打 tag"（tag 归 release-please 所有，手动 tag 已在 CONTRIBUTING 里废止）。
## Alternatives considered

**人工批准那个 `action_required` 的 run 让它跑完**：技术上可行（GitHub 的 "Approve and run"），但发布 PR 每次被 release-please 重写都会产生新的 run，等于每次发布都要手工点一次批准；而且批准后 `check`/`test` 通过也只证明"版本文件没破坏构建"，与我在本地跑的 `npm test` 覆盖面相同，多花 5-10 分钟只换来同一结论。**用 PAT/App token 让 release-please 的 PR 触发 workflow**：要改 release-please 的凭证与仓库的 Actions 设置（"Require approval for all outside collaborators" 类策略），为一条一次性流程引入长期凭证面，不划算。**改成"人手动打 tag"**（人 push 的 tag 会正常触发 CI，也就自动有 assets）：把 tag 的所有权从 release-please 手里拿回来，与「版本号/CHANGELOG 都由 release-please 生成」的既有决策冲突，且手动 tag 是 CONTRIBUTING 明确废止的做法。**接受"Release 没有安装包"**：等于把每次发布都变成半成品——用户从 Release 页下不到包，壳的自更新检查也会看到一个空壳 Release。
## Consequences

代价：① 每次发布多两步人工动作（本地门禁 + `workflow_dispatch`），且发布 PR 的合并必然带 `--admin`（绕过分支保护），所以"本地门禁"从"建议"变成"必须"——已写进 CONTRIBUTING 的发布一节，含可复制的四条命令；② 若忘了派发，Release 会停在"有 tag、无安装包"的状态（v0.11.0 就出现过几分钟），症状是 Release 页 assets 为空。买到：发布路径不再依赖"你记得手动合并"这种隐性知识——文档写清了为什么只有 admin 能合、替代验证是什么、以及补 assets 的确切命令；`release-body.mjs` 的修复也在这次真实发布里得到验证（Release 说明里的 dsh 版本行是真实查询结果，而非 `unknown`）。覆盖：v0.11.0 全流程实跑（合并 → tag → Release → 派发 → 3 个平台 assets + 说明）。未覆盖：release-please 若将来改变 tag 创建方式（例如改为 push tag 而非 API），第 4 步会变成多余动作——届时应删掉该步而不是留着。

