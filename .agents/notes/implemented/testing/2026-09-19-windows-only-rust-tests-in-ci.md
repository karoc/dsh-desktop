# Agent Note: windows-only-rust-tests-in-ci

Status: implemented

## Problem

G-2 的目的是让 `#[cfg(windows)]` 的 Rust 逻辑（`path_under`、`strip_verbatim`、dump、job object）在 Windows 上真被测试——因为 ubuntu 的 `check` job 编译的是**另一个 cfg 分支**，平台逻辑等于零覆盖。落地时踩了两个坑，都是"CI 上才暴露、本地全绿"的类型。

## Decision

G-2 在 windows job 增加 `cargo test --manifest-path src-tauri/Cargo.toml --lib`，位置在 `npm run bundle` **之前**（快速失败，不烧 20 分钟打包），但**必须在 `node scripts/fetch-node.mjs && node scripts/sync-resources.mjs` 之后**——`tauri-build` 在编译期校验 `bundle.resources`，资源未物化时任何 cargo 命令都会 `failed to run custom build command`（本会话实测：run 35406290067 的 windows job 因此失败）。同时，**断言 Windows 路径语义的测试必须加 `#[cfg(windows)]`**：ubuntu 的 `check` job 会编译并运行 `#[cfg(not(windows))]` 变体，而 Linux 的 `Path::components()` 把 `C:\Users\u\…` 当作**单个组件**（反斜杠不是分隔符），盘符/大小写/`\\?\` 语义在 Linux 上不成立——本会话 run 35405677478 的 `check` job 正是因此红灯，修复是给两个测试加 cfg 门控（`strip_verbatim_removes_windows_prefix` 是纯字符串操作，保持跨平台运行）。

## Consequences

代价与收益：① 平台语义的测试必须在对应平台运行——G-2 加的 windows job 步骤现在真的覆盖 `path_under`/`strip_verbatim`/dump/job-object，Ubuntu job 覆盖跨平台逻辑，两边互补而非重复。② windows job 因此多花约 1–2 分钟（fetch-node 下载 + sync-resources 拷贝），但换来"编译期资源缺失"在测试步骤就暴露，而不是烧完 20 分钟打包才报错。③ 未来新增 `#[cfg(windows)]` 代码时，**必须同时补 windows job 能跑的测试**，否则重演"零覆盖"；新增平台相关测试时，**若它断言平台语义就必须 cfg 门控**，否则 ubuntu job 会红。④ 仍未纳入 CI 的：`verify-*.ps1` 系列（需要真实旧版残留/交互桌面，不适合 CI），以及 NSIS 钩子的六场景 harness（需 makensis + 真实插件 dll，仅在本地跑）。

