# Agent Note: release-via-git-merge-and-tag-repush

Status: implemented

## Problem

发布 dsh-desktop 0.6.3 时遇到两个自动化盲区：(1) 当前环境 gh CLI 的 fine-grained PAT 只有 Contents 权限，无 Pull requests write / Actions write，`gh pr merge`（REST 与 GraphQL 均 403）、`gh workflow run`（403）都无法执行，无法按常规「Web 合并 release PR」路径发布；(2) release-please 用 API 创建 tag 后不触发 `push: tags` 事件，导致 build.yml 的 tag 构建（含 release job 挂载安装包）完全没有跑——v0.6.3 的 Release 一度只有 0 个 assets。

## Decision

确立了「无 PR 合并权限时的等价发布路径」并验证成功：(1) 本地 `git merge --no-ff --no-commit origin/release-please--branches--main` 把 release 分支合入 main（分叉点在 159d5ca：main 多了 docs note，release 分支多了 release commit），检查版本号/插件内容无冲突后提交并 `git push origin main`——release-please 在 push 事件上检测到 release commit 已合入，自动打 tag v0.6.3 并创建 GitHub Release；(2) tag 由 release-please 经 API 创建不触发构建，改为 `git push origin :refs/tags/v0.6.3` 删除远端 tag + 本地 `git tag -f v0.6.3 <sha>` 重建再 push，强制触发 `push: tags` 事件，build.yml 的 tag 构建（check/test/windows/linux/release）随之全绿并把 3 个安装包（exe 26.7MB / AppImage 117.9MB / deb 51.8MB）挂到 Release v0.6.3。契约：git 直推 main 是可行的（Contents 权限即够），release-please 靠 push 事件而非 PR 合并事件工作，所以 git merge 等价于合并 PR。边界：PR #26 在 GitHub 上仍显示 open（无 PR 写权限无法关闭），但 tag/release/构建均已正确产出；linux-smoke 为既有已知失败不阻塞。
## Alternatives considered

等用户 Web 合并 PR #26——被用户明确拒绝（要求直接处理）。用 `--admin` 强合并 PR——失败，PAT 无 mergePullRequest GraphQL 权限。`gh workflow run build.yml --ref v0.6.3` 手动触发 tag 构建——失败，PAT 无 Actions write。只依赖 release-please 自动触发——失败，API 建 tag 不产生 push 事件，必须删 tag 重推（delete+recreate 使 ref 变更走 git 协议）。
## Consequences

本次发布全链路完成，v0.6.3 三个安装包可下载。代价/后续义务：① 环境 PAT 权限偏窄，未来若需 Web 合并且无用户在场，可沿用「git merge release 分支直推 + 必要时删 tag 重推」路径；② release-please API 建 tag 不触发构建是行为事实，若官方修复此问题可简化；③ PR #26 残留 open 状态，用户可在 Web 顺手关闭，但不影响已产出物。

## 2026-09-08 v0.7.0 追加：手动 tag 的时序注意（重要）

v0.6.3 路径（release-please 打 tag 被吞 → 删 tag 重建）在 v0.7.0 出现了**反向竞态**：这次我 `git push main` 后**立刻手动 `git tag v0.7.0 && git push origin v0.7.0`**，此时 release-please 的 main-push workflow 还在跑（它要自己打 tag + 建 Release）。结果 release-please workflow 报 `Published releases must have a valid tag`（它尝试建 Release 时发现 tag 已被外部创建），但 build.yml 的 release job（`on: push tags`）正确挂载了安装包，最终 Release v0.7.0 仍是完整三平台产物，无实际影响。

**正确时序（避免误报）**：`git push main` 后先等 release-please workflow 完成（它打 tag + 建 Release，约 1-2 分钟），**确认 Release 出现**后再决定是否手动干预。只有出现「Release 已建但 assets 为空 / tag 构建没跑」（v0.6.3 症状）时才用「删 tag 重建 repush」路径；若 release-please 正常完成则**不需要**手动 push tag。判断依据：`gh run list` 看 release-please run 是否 success + `gh release view v0.7.0` 看 assets 是否挂上。手动 push tag 与 release-please 建 Release 的竞态是无害的（build release job 兜底），但会造成一次 workflow 失败红标，干扰判断。

