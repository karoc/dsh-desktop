# Agent Note: release-draft-sweep-gh-json

Status: implemented

## Problem

v0.9.0 发布时 release job 红灯（run 35410220073），但**发布其实成功了**——三个安装包已挂载、说明正文已刷新，失败发生在之后的"清扫 draft"步骤：`gh release list --json` 在 runner 的 gh 版本里不提供 `id` 字段（Available fields 只到 tagName），于是 `[.id, .tagName]` 取值报 `Unknown JSON field: "id"` 并 exit 1。该步骤由 `2fe1b6e`（2026-09-12）加入，v0.9.0 是它第一次实跑（0.8.0 早于它），所以这个"每次发版必红"的 bug 直到这次才暴露。

## Decision

`build.yml` 的 release job 里"清扫 draft/untagged 残留 release"步骤，从 `gh release list --limit 100 --json id,tagName,isDraft` 改为 REST 列表 `gh api "repos/${GITHUB_REPOSITORY}/releases?per_page=100" --jq '.[] | select(.draft == true or (.tag_name | startswith("untagged-"))) | [.id, .tag_name] | @tsv'`。过滤条件（draft 或 `untagged-` 前缀）与删除行为（`gh api -X DELETE …/releases/${LEFT_ID}`）完全不变，只换取数通道——REST payload 同时提供 `id` 与 `draft`。修复经 PR #31 合入（main `c49c910`），本仓库首次走"建 PR → 自动跑 check+test → 合并"的完整正规流程。**未做**：不追溯重跑 v0.9.0 的 tag run（tag 指向修复前提交，重跑仍用旧 workflow，无意义）。

## Consequences

代价与收益：① 改用 REST 后多一次 API 调用（per_page=100），但字段齐全、不依赖 gh 版本的 CLI 视图。② v0.9.0 那次 run 的历史结论仍是 failure（tag 指向修复前的提交，无法追溯变绿）——**发布本身完整**（3 个安装包 + 生成的说明正文），该红灯只是"job 状态"而非"产物缺失"；今后发版不再复现。③ 该步骤是唯一以"清扫"为目的的破坏性 API 调用（DELETE release），修复只动了取数方式，删除条件与范围未变。④ 教训：CI 里调用 `gh` 时，**凡是依赖字段的都要先验证该字段在当前 gh 版本存在**——本地 gh 与 runner 的 gh 版本不同，`--json` 的可用字段集也不同；REST + `--jq` 比 CLI 视图更稳。

