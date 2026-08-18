# Agent Note: preinstalled-dsh-kanban

Status: implemented

## Problem

dsh-desktop 需要把第二个插件 dsh-kanban（跨会话看板：board_* 工具 + Web 看板页）随壳预装，与现有预装插件 dsh-model-reasoning 完全同模式：bundle 进 resources/preinstalled、启动时拷进 runtime node_modules、默认关闭、可启停/更新/重置。

## Decision

按 D8（dsh-model-reasoning）的既有做法落地：1) 新增 plugins/preinstalled/dsh-kanban/，内容为发布构建产物 lib/index.js + lib/client.js + cordis.patch.yml + LICENSE，package.json 按预装惯例裁剪（files 只留运行期文件、scripts 去掉发布闸门，版本锁定 0.1.0），README.md 裁剪为自包含介绍；2) scripts/sync-resources.mjs 的预装列表加 dsh-kanban，把 bundle 同步进 src-tauri/resources/preinstalled/（tauri 打包目录）；3) scripts/server-manager.mjs 的 PROTECTED 列表加 dsh-kanban，使 `npm install --prefix runtime` 更新 dsh 时不会剪掉它；4) test-control-plane.mjs 增加 dsh-kanban 落盘与 preinstalled-updates 断言，test-plugin-console.mjs 的 fixture 扩为两个预装行以覆盖多行渲染。dsh-kanban 的 host 半依赖 @deepseek-ai/dsh-tools（dsh CLI 直接依赖）、client 半注入 @deepseek-ai/dsh-client-* 与 dsh-client-ui-primitives（经 dsh-web-app / apps/web 随 dsh 安装），与 model-reasoning 的解析路径一致，无需额外打包依赖。
## Alternatives considered

不采用：把 dsh-kanban 直接写进 dsh.profile.dependencies（会被 dsh plugin reconcile 视为用户插件而可删可改，违背"随壳锁定版本"）；也不在 Rust 里硬编码插件名（预装列表本就由 runtime dsh.json 动态下发，Rust 侧无需改动）。
## Consequences

启动时 ensurePreinstalled 会把 dsh-kanban@0.1.0 拷进 <runtime>/node_modules/dsh-kanban，dsh.json 的 preinstalled 列表随之包含两个 bundle；插件控制台会渲染两行预装插件，启用即写入 web profile 的 dsh.profile.bundles。六个测试脚本全部通过。后续 dsh-kanban 发新版只需更新 plugins/preinstalled/dsh-kanban 并重跑 sync:resources。

