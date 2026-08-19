# Agent Note: preinstalled-dsh-turn-navigator

Status: implemented

## Problem

dsh-desktop 需要把第三个插件 dsh-turn-navigator（会话轮次导航胶囊条，纯 client bundle）随壳预装，与既有预装插件（dsh-model-reasoning / dsh-kanban）完全同模式：bundle 进 resources/preinstalled、启动时拷进 runtime node_modules、默认关闭、可启停/更新/重置。

## Decision

按 dsh-kanban（D9）的既有做法落地：1) 新增 plugins/preinstalled/dsh-turn-navigator/，内容为源仓库 HEAD 的 tsdown 构建产物 lib/index.js + lib/client.js + cordis.patch.yml + LICENSE + 裁剪 README.md，package.json 按预装惯例裁剪（files 只留运行期文件、scripts 去掉 release:check/prepack/postpublish 等发布闸门，保留 bundle/prepare/prepublishOnly，版本锁定 0.1.1）；README.md 裁掉双语切换行与 docs/turn-nav-rail.png 图片引用（bundle 不携带 docs/）。构建产物已通过在 workspace 内复制仓库重建并与既有 lib 逐字节对比验证一致。2) scripts/sync-resources.mjs 预装列表加 dsh-turn-navigator，把 bundle 同步进 src-tauri/resources/preinstalled/（tauri resources glob 已含该目录，无需改 tauri.conf.json）；3) scripts/server-manager.mjs 的 PROTECTED 列表加 dsh-turn-navigator，使 `npm install --prefix runtime` 更新 dsh 时不会剪掉它；4) test-control-plane.mjs 增加 dsh-turn-navigator 落盘与 preinstalled-updates 断言，test-plugin-console.mjs 的 fixture 扩为三个预装行。Rust 侧无改动：preinstalled_names/preinstalled_details 从 runtime dsh.json 动态下发，console 的简介读拷贝包的 package.json description。插件控制台的 DESC 双语简介 map 不加 dsh-turn-navigator 条目（与 dsh-kanban 一致，用包自带 description 兜底）。
## Alternatives considered

把 dsh-turn-navigator 直接写进 dsh.profile.dependencies（会被 dsh plugin reconcile 视为用户插件而可删可改，违背随壳锁定版本——沿用既有拒绝理由）；在 Rust 里硬编码插件名（预装列表本就由 runtime dsh.json 动态下发，Rust 侧无需改动）；bundle 携带 README.zh.md/CHANGELOG/docs 图片（既有预装 bundle 惯例只带单语 README + LICENSE，保持最小化）。
## Consequences

启动时 ensurePreinstalled 会把 dsh-turn-navigator@0.1.1 拷进 <runtime>/node_modules/dsh-turn-navigator，dsh.json 的 preinstalled 列表随之包含三个 bundle；插件控制台渲染三行预装插件，启用即写入 web profile 的 dsh.profile.bundles。六个测试脚本全部通过（test-control-plane 版本断言从 resources 实际 bundle 动态读取，版本升级不需改测试）。后续 dsh-turn-nav 发新版只需更新 plugins/preinstalled/dsh-turn-navigator 并重跑 sync:resources。

