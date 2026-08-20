# Agent Note: preinstalled-plugin-sync-v030

Status: implemented

## Problem

全量复查三个预装插件（dsh-model-reasoning / dsh-kanban / dsh-turn-navigator）是否有新版本需要同步，并在同步后发布 dsh-desktop 新版本。

## Decision

同步基准再次确认为「源仓库 HEAD 提交态」，而非 npm 已发布版：dsh-model-reasoning@0.1.4 与 dsh-turn-navigator@0.1.1 的 bundle 与各自仓库 HEAD 构建逐字节一致（无需改动）；dsh-kanban 由 0.1.0 升级到仓库 HEAD @0.1.2（含 npm 0.1.2 未含的卡片操作行重设计两个提交）。dsh-kanban 仓库还有未提交的 0.1.3 WIP（卡片详情弹窗、静默自动刷新、两行截断）——未提交 ≠ 版本，明确不打包进壳。发布流程：package.json / tauri.conf.json / Cargo.toml / Cargo.lock 四处版本 0.2.0→0.3.0，提交推 main，打 tag v0.3.0 推送（CI 按 refs/tags/v* 自动出 Windows NSIS + Linux AppImage/deb 并建 GitHub Release）。
## Alternatives considered

按 npm latest 同步（kanban 取 0.1.2 tarball）——被拒绝：会丢掉仓库 HEAD 上未发布的卡片操作行重设计，且与既有惯例（bundle=仓库 HEAD）冲突。打包 kanban 仓库未提交 WIP——被拒绝：未提交改动不是稳定版本，且属于另一仓库的在途工作。
## Consequences

v0.3.0 将随 dsh-kanban 0.1.2（+卡片操作行）、dsh-model-reasoning 0.1.4、dsh-turn-navigator 0.1.1 发布；kanban 的 0.1.3 WIP 需等其提交+发布后另一次同步。

