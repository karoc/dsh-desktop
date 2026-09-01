# Agent Note: shell-dialogs-and-inpage-plugin-console

Status: implemented

## Problem

用户第二轮 UI 反馈暴露两处方向性回归：1) #17 把插件管理改回壳内自研窗口（plugin-console.html 三卡片页），而用户明确要求保持原插件控制台 UI（此前 #14 已撤回过一次自研窗口）；2) 检查更新/关于只有瞬时提示，用户要求正规模态弹窗；另有两处缺陷：『检查更新』动态文本用 textContent 整体替换把下拉左对齐占位列清掉了；代理设置窗口"先闪一下居中、又跳回上次左边位置"。

## Decision

壳菜单动作现分两类（shell-chrome.js 顶部注释写明）：跨壳动作走 ACTIONS 双通道（ipc + 桥）；壳内就地动作（插件管理=globalThis.__DSH_PLUGIN_CONSOLE__.toggle() 就地触发原 dsh-plugin-console 面板；关于/检查更新=壳内 Shadow DOM 模态弹窗）不进 ACTIONS、不占桥，契约测试以 IN_SHELL_ACTIONS 豁免。自研窗口路线整体撤回：删除 src/plugin-console.html/js；lib.rs 移除 open_plugins_window/open_plugins/get_plugins_panel/plugins_set_enabled/plugins_install/plugins_remove/plugins_update/plugins_check_preinstalled_updates/plugins_update_preinstalled/plugins_reset_preinstalled 与 /shell/open-plugins、/shell/about 桥臂（is_dev_build 因只剩 show_about 使用而一并删除）；/plugins/* 桥与 plugins_panel_state 保留（面板唯一数据源）。检查更新弹窗：无已知 latest 时先 call('check-update') 再每 1.5s 轮询 /update-status（15s 超时如实提示），稳定版可升/预发布可升显示「立即更新」（预发布带 version 走桥、IPC 不传参），否则只有「确定」。关于弹窗展示软件名称/版本/构建日期/dsh 本体版本；构建日期由 build.rs 用 civil_from_days（无 chrono）输出 cargo:rustc-env=DSH_BUILD_DATE，注入前缀新增 window.__DSH_BUILD_DATE__。窗口状态：tauri_plugin_window_state 用 with_denylist(&["settings"]) 排除工具窗——根因是插件 on_window_ready 的 restore_state 覆盖 builder 的 .center()（先闪居中又跳回旧位），主窗口仍保留位置/大小/最大化记忆。下拉现代化：统一 30px 行高、18px 勾选列、dd-label 独立 span（动态文案只改 label 不再清对齐列）、品牌头（名称+版本副行）、focus-visible 焦点环、role=menu/menuitem(checkbox)、全键盘导航 ↑↓/Home/End/Enter/Esc、max-height 滚动、prefers-reduced-motion 降级。契约测试新增断言：弹窗标记、构建日期、denylist("settings")、!libRs.includes("/shell/open-plugins")。NOT done：未给检查更新/关于建原生窗口（用户要弹窗、窗内 UI 也不换）；未改 dsh-plugin-console 的 client.js（其 __DSH_PLUGIN_CONSOLE__.toggle 接口保持不变）；README 与 .dsh/skills 已同步。
## Alternatives considered

- **插件管理继续用自研窗口**（换皮/微调）：用户明确质问"为什么改 UI"，#14→#17 已证明该路线两次被打回，放弃。- **检查更新/关于继续用系统 toast**：用户明确要"弹窗+按钮"，toast 无按钮且易被系统吞，放弃。- **手动 builder 后调 .center() 修复闪跳**：与 window-state 插件 restore 存在时序竞态（on_window_ready 异步触发），不可靠；改用官方 with_denylist 确定性排除，放弃。- **给检查更新/关于建原生子窗口**（像 settings）：多余窗口管理面、与"壳内就地"原则冲突，放弃。- **构建日期用 chrono 或在 CI 注入 env**：为一行日期加依赖/改 CI 不值得，用 build.rs + civil_from_days 纯算法，放弃前两者。
## Consequences

买到了：插件管理回到原面板（原 UI 零改动、菜单只换入口），用户两轮抱怨的根因被移除；弹窗在启动页与 dsh 页双通道都可用；settings 窗口从此固定居中、不再记忆位置（代价：用户手动挪过 settings 窗口不会被记住）。代价：壳菜单多了一类"就地动作"，SHELL_MENUS/ACTIONS/契约测试三方约束多了一个豁免集合，后续加菜单需先判断归属；删除的 plugins_* IPC 若未来要再开自研窗口需从 git 历史恢复；Cargo.lock 至今未收录 tauri-plugin-window-state（仓库 lock 陈旧、cargo 构建时自动更新，CI 未用 --locked，属仓库卫生历史债务，未在本轮处理）；检查更新轮询上限 15s，若 npm 探测极慢会显示"检查超时"（如实而非谎报最新）。

