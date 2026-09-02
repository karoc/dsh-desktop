# Agent Note: plugin-console-global-window

Status: implemented

## Problem

上一轮（PR #18）把插件管理改为"就地触发 dsh 页内原插件控制台面板"，但面板由 dsh 插件渲染、只在 dsh 页面存在。用户实测：宿主机 dsh 崩溃后，点「插件管理」只能提示"需在 dsh 主页使用"——而插件出问题时恰恰最需要管理入口（卸载/禁用出问题的插件）。要求插件管理全局可用。

## Decision

插件管理从"页内就地触发"改为"壳内独立管理窗口"，以换取全局可用性。窗口 label `plugins`，页面 src/plugin-console.html + src/plugin-console.js（680×720 居中，window-state with_denylist(&["settings","plugins"]) 排除、固定居中，与 settings 一致）。窗口 UI 复用原插件控制台渲染核心：ZH/EN 文案、THEMES 四主题（深空/极光/月光/琥珀）、.dshc-* 视觉 token、卡片行/开关/升级箭头/恢复默认/安装/用户插件/dsh 更新/操作按钮/重启遮罩全部照搬（src/plugin-console.js 独立实现，非共享）。数据通道 = 环回桥 /plugins/*（list/enable/disable/install/remove/update/update-preinstalled/reset-preinstalled/check-preinstalled-updates/update-dsh/restart/refresh/devtools）——桥由 Rust 壳拉起、不依赖 dsh 进程，故 dsh 崩溃时窗口仍可读写 profile manifest 与 manager 命令。lib.rs：恢复 open_plugins_window/open_plugins 命令、/shell/open-plugins 桥臂、invoke_handler 注册，并新增 inject_plugins_preamble（on_page_load 对 label=="plugins" 注入 __DSH_BRIDGE_PORT__ 字符串 + __DSH_PRODUCT_NAME__）；页面脚本轮询等待桥端口就绪（最多 5s）再初始化。chrome：ACTIONS 恢复 plugins（ipc open_plugins / bridge /shell/open-plugins），runMenuAction('plugins') 改 call('plugins')，删除 togglePluginConsole（hideFabIfPresent 保留防御旧 fab）。契约测试：plugins 从 IN_SHELL_ACTIONS 豁免移除（仅 about 豁免），新增断言（/shell/open-plugins 桥臂、open_plugins_window、inject_plugins_preamble、src/plugin-console.* 文件存在、denylist 含 settings+plugins）。NOT done：capabilities 未给 plugins 窗口加条目（窗口页不用 IPC）；dsh-plugin-console/client.js 未改（页内面板保留无入口，__DSH_PLUGIN_CONSOLE__.toggle 接口仍在供兼容）；resources/plugin 跟踪拷贝滞后问题另立跟进卡。
## Alternatives considered

- **继续用 dsh 页内原面板（就地触发 __DSH_PLUGIN_CONSOLE__.toggle）**：面板由 dsh 插件渲染，dsh 崩溃/未启动时无面板——恰恰在插件出问题时无法管理（用户实测触发），放弃。- **页内面板 + 故障时降级提示**：只解决"有提示"，不满足"全局可管理"，放弃。- **自研全新管理 UI（#17 简版三卡片）**：用户两轮明确否决"改了 UI"，放弃。- **窗口页走 IPC（get_plugins_panel/plugins_* 命令 + capability 加 plugins）**：需恢复整套 IPC 命令与 capability，且与 dsh 页内面板的桥逻辑分叉；窗口页仅用 fetch 走环回桥即可满足（无 CSP、桥 CORS-open），放弃 IPC 路线。
## Consequences

买到：插件管理在 dsh 崩溃/未启动时可用（数据走环回桥，桥由壳拉起不依赖 dsh），卸载/禁用出问题的插件成为可能——这是用户本次的直接诉求。代价：a) src/plugin-console.js 与 plugins/dsh-plugin-console/client.js 是两份渲染实现，视觉/功能会漂移，未来改面板样式需同步两处（README/SKILL 已标注，暂无共享构建机制）；b) dsh 页内原面板保留但无入口（fab 已隐藏、chrome 不再调 toggle），成为兼容性死代码；c) 窗口页依赖 on_page_load 注入 __DSH_BRIDGE_PORT__，页面脚本用 5s 轮询等待就绪（注入晚于脚本执行时短暂显示"加载中"）；d) capabilities 未给 plugins 窗口加条目（窗口页不用 IPC，仅 fetch 桥，安全边界不变）。

