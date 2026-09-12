# Agent Note: detailed-release-notes

Status: implemented

## Problem

用户反馈 GitHub Release 的 What's Changed 潦草：release job 用 `gh release create --generate-notes`，只把整个版本压成 2-3 条 PR 标题（如 v0.8.0 只有 PR #29/#28 两行），看不到 dsh/插件版本变化和完整提交清单；且 delete+create 会让发布短暂消失。

## Decision

发布说明生成已改为确定性自动化：新增 `scripts/release-body.mjs <version>`，输出 markdown body = 版本概要（发版时从 npm registry fetch `@deepseek-ai/dsh` 的 dist-tags latest/next，离线降级为 unknown 且不失败；预装插件版本读 `plugins/preinstalled/*/package.json`）+ 该版本 CHANGELOG.md 完整 section（含每提交链接）+ Full Changelog 对比链接（从 section 标题行提取）。`.github/workflows/build.yml` 的 release job 不再使用 `--generate-notes`：先 `node scripts/release-body.mjs "${GITHUB_REF_NAME#v}"` 生成 body 文件，release 已存在（release-please 建的或 re-cut 残留）时 `gh release upload --clobber` + `gh release edit --notes-file` 原地刷新，不存在才 create；删除逻辑移除，发布不再有窗口期。注意边界：脚本必须在 tag 指向的提交里存在（v0.8.0 的 body 修复因此采用移 tag 到包含脚本的提交 + 重跑 release job，而非直接 PATCH——本环境 PAT 无 Releases 写权限，403 实测，PATCH 只能由 workflow 的 GITHUB_TOKEN 或用户在 Web 做）。人工「本次亮点」叙述不在自动化内，需要时在 GitHub 页面手动补充。
## Alternatives considered

**保留 --generate-notes + 发布后人工改 body**：PAT 无 Releases 写权限（403），只能靠用户在 Web 粘贴，不满足「以后自动详细」；且不解决 delete+create 的发布窗口期。**脚本只提取 changelog section 不加版本概要**：缺少用户点名的 dsh/插件版本信息，无法满足「更新了 dsh xx → xx、xx 插件到 xx」的要求。**release job 继续 delete + create**：发布有短暂消失窗口，且 re-cut 时 body 来源不稳；upload --clobber + edit 原地刷新对 re-cut 同样正确（资产覆盖、body 重生成），更稳。**把 tag 留在 b384e4c 重推**：新脚本不在该提交里，release job 会失败，v0.8.0 body 无法自动化修复。
## Consequences

买到：今后每个 release 的 What's Changed 自动包含 dsh latest/next、预装插件版本、完整提交清单与对比链接，无人值守也详细；v0.8.0 借此得到修复（移 tag 重跑）。代价：① release job 依赖 tag 提交里存在 scripts/release-body.mjs——未来若有人手工建 tag 指向旧提交会失败（workflow 注释已说明）；② 移 tag 使 v0.8.0 指向新提交（ci/chore 类改动，应用产物内容不变，changelog 不变，可接受）；③ 发布 body 的「亮点」叙述仍需人工（自动化只保证确定性部分），流程上由发版 agent 在发布后核对，必要时请用户在 Web 补充。

