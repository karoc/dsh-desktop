# Agent Note: plugin-management-moves-to-dsh

Status: implemented

## Problem

壳原本自建了一整套插件管理：一个独立窗口（`src/plugin-console.*`，走环回桥 `/plugins/*`，dsh 崩溃时也能用）、一个注入 dsh 页面的面板插件（`@dsh-desktop/plugin-console`）、以及 manager 侧的预装插件安装/更新/恢复出厂流水线。dsh 0.1.6-alpha.2 自带了插件管理（Web 侧边栏 Plugins 页 + `@deepseek-ai/dsh-plugin-manager` 服务 + `plugin_manager` agent 工具），两套管理器会写同一份 profile 状态（`dsh.profile.bundles` 与 `cordis.patch.yml`），而 dsh 的实现带文件锁、HMR 重载、安装回滚与构建脚本审批——壳的粗粒度实现没有这些，继续保留既是重复又是不一致来源。

## Decision

壳把插件管理整体交给 dsh 自己。dsh 0.1.6-alpha.2 新增 `@deepseek-ai/dsh-plugin-manager`（宿主服务）与 `@deepseek-ai/dsh-client-ui-plugin-manager`（Web 侧边栏 Plugins 页），后者已挂在 `dsh-web-app` bundle 的 `cordis.patch.yml` 里，因此壳用 `dsh web` 组合出的 profile 自带该页面（`plugin-manager` / `hmr` / `ui-plugin-manager` 三行的启用条件 `ctx.get('profileContext')` 在 CLI 启动路径下成立）。据此删除：`src/plugin-console.{html,js}`、`plugins/dsh-plugin-console/` 及其 resources 副本、lib.rs 的 9 个 `/plugins/*` 桥端点 + `open_plugins_window` + `inject_plugins_preamble` + `preinstalled_updates` 状态、shell-chrome 的「插件管理…」菜单与 ACTIONS 项、manager 的 `runPluginOp`/`runDshPlugin`/`normalizeGitHubSpec`/`checkPreinstalledUpdates`/`updatePreinstalled`/`resetPreinstalled` 与 `dsh.json.updates`，以及 2 套控制台测试。

壳侧只保留两处新增，都是**必需品而非功能**：① `MIN_DSH_VERSION = '0.1.6-alpha.2'` 版本地板——npm `latest` 仍是 `0.1.5-rc.2`（不含插件管理），安装/升级目标取 `max(latest, 地板)`，启动时低于地板先升到地板（`dsh.json` 的 `devMode` 冻结该自动升级），失败如实上报且**不阻塞启动**；② `dsh web` 子进程的 PATH 前置壳内置 pnpm 的 shim 目录——新插件管理器默认 `pnpmCommand: 'pnpm'` 走 PATH，而 launcher facts 的 `packageManager` 只能由进程内调用方注入（`apps/desktop-host` 走 argv），spawn CLI 的第三方壳拿不到。

唯一净新增的用户可见功能是安全网菜单项「停用全部第三方插件…」→ `disable_third_party_plugins`（Rust 命令 + `/shell/disable-third-party-plugins` 桥端点）：把 profile `dsh.profile.bundles` 回退到 dsh 自带两层（`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app`），**先备份** `package.json`（`package.json.bak-disable-plugins-<epoch>`，备份失败即中止），返回 `removed` / `shellShipped` / `userInstalled` / `backup` 供界面如实展示。负向保证：它不删除任何插件文件，只改启用列表。预装插件继续随壳复制进运行时（实测在 alpha.2 新增的 `runtime`+`enforce` 解析模式下仍能解析并加载），版本随壳锁定。

## Consequences

代价：① 用户失去"dsh 起不来时用图形界面管理插件"的能力，只剩「停用全部第三方插件…」这一条全量回退路径（无法只停某一个）；② 插件"更新到新版本"在图形界面里没有了（新管理器只有安装/启用/停用/卸载），需要 `dsh plugin --profile web update <pkg>`；③ 预装插件不再能"从 npm 升级/恢复出厂"，版本回到随壳锁定；④ `dsh.json` 的 `updates` 字段与 manager 的插件操作流水线（含 `normalizeGitHubSpec`、`runDshPlugin`、`installedVersionOf`）被删除，`activeOp`/`emitOpStatus` 保留给壳的 dsh 更新弹窗。收益：壳不再与 dsh 的插件管理器双写 profile 状态（后者带文件锁 + HMR 重载 + 安装回滚 + 构建脚本审批），删掉约 1500 行壳侧代码与 2 套测试。回滚边界：dsh 回滚到 alpha.1 会让插件页消失而壳已无自建 UI —— 回滚必须同时回滚壳版本，这条写进了发布说明。覆盖缺口：客户端插件（4 个预装 + 通知插件）在 alpha.2 客户端模块图里的挂载只做了源码级推断（`dsh.client.inject` 是加载顺序约束而非存在性要求），已立卡要求实机浏览器逐项确认。

