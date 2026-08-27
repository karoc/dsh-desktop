# Agent Note: shell-menu-bar

Status: implemented

## Problem

DSH Desktop 主窗口用系统原生标题栏，壳级功能（代理设置、检查更新、开发者模式等）只存在于托盘菜单，窗口内没有任何壳菜单。用户要求自定义顶栏的最小化/最大化/关闭，并把代理设置等壳功能收进顶栏左侧「DSH Desktop」图标之后的可见菜单栏，作为后续壳独有菜单的定义点。

## Decision

主窗口改为无边框（tauri.conf.json main: decorations:false + shadow:true），壳自绘 36px 顶栏：左上角「DSH Desktop」应用菜单（检查更新…/有更新 vX、开发者模式 checkbox、退出），其后可见顶级条目一字向右（「代理设置…」直开设置窗口、「视图」「帮助」下拉），右上角窗口三键。壳菜单唯一定义点是 src-tauri/resources/ui/shell-chrome.js 顶部的 SHELL_MENUS 数组 + ACTIONS 双通道动作表（ipc 命令名 + 桥路径）。chrome 由 lib.rs 用 include_str! 编译期内嵌，on_page_load 中仅对 label=="main" 的 webview 注入（settings 窗口保持原生边框）；前缀写入 window.__DSH_SHELL_VERSION__ 与 window.__DSH_BRIDGE_PORT__。渲染用 Shadow DOM + MutationObserver 自愈（dsh SPA 重渲染 body 后自动重挂）。传输双通道：本地页（启动页，有 __TAURI__）走 tauri.core.invoke；远程 dsh 页（无 __TAURI__，tauri#11934）走环回桥新端点 POST /window/minimize|toggle-maximize|close|drag、GET /window/state、POST /shell/open-settings|dev-mode-toggle|open-data-dir|about|quit、GET /shell/state（复用已有 /refresh /restart /check-update /update-dsh）。新 Rust 命令 window_control / get_shell_state / toggle_dev_mode / open_settings / show_about 全部进 invoke_handler；dev-mode 切换抽成 toggle_dev_mode_impl 供托盘/IPC/桥三方共用。拖动窗口走 mousedown→桥 /window/drag→Window::start_dragging（不依赖只在本地页存在的 data-tauri-drag-region JS API），双击空白区切换最大化，resize/focus 时重查 /window/state 同步最大化图标（覆盖 Aero 拖拽漂移）。契约由 scripts/test-shell-chrome.mjs 守护（vm 沙箱加载 chrome 配置，断言菜单 id↔ACTIONS↔lib.rs 桥端点/命令注册三方不漂移），已接入 npm test。NOT done：Tauri 2 Menu 窗口菜单栏（Windows 不渲染）、子 webview 标题栏、键盘加速键、插件向菜单栏注册项、settings 窗口自绘。
## Alternatives considered

**Tauri 2 原生窗口菜单（Menu::set_menu）**：Windows 上 Tauri 2 只渲染托盘/上下文菜单，不渲染窗口菜单栏，故否决。**子 webview 标题栏（build_as_child）**：多 webview 的布局/命中测试/拖动跨平台（WebView2 vs WebKitGTK）复杂度高、新失败面大，否决。**全部收进「DSH Desktop」图标下拉（汉堡形态）**：用户追问后确认可见性不足、非严格菜单栏，改为通用桌面范式（应用菜单 + 可见顶级条目向右排开）。**CSS -webkit-app-region: drag**：在 WebView2/WebKitGTK 支持度不一且与 mousedown 拖动互斥，最终统一用桥 /window/drag→start_dragging（远程页唯一可靠路径），避免双机制冲突。**chrome 作为运行时 resource 文件读取**：增加资源探测失败面，改 include_str! 编译期内嵌（编辑即触发 cargo 增量重建）。
## Consequences

代价：顶栏为浮层式，盖住 dsh 页面顶部 36px（半透明+blur 减轻视觉冲突）；远程页动作全部经环回桥，新增 10 个桥端点需与 chrome 契约测试同步维护；无边框窗口失去系统标题栏的 Aero snap 拖动最大化等原生行为（最大化图标经 resize 轮询补偿，Aero 拖拽最大化本身依赖 WS_THICKFRAME 保留，需 Windows 实机验证）；拖动与双击最大化的兼容性（Windows 拖拽循环可能吞掉 dblclick）需实机确认。收益：壳菜单定义收敛到单一 JS 文件（SHELL_MENUS/ACTIONS），加菜单不改 Rust；启动页与 dsh 页面行为一致；托盘菜单保留为窗口隐藏时的持久入口；拖动/窗口控制不依赖页面 origin，本地/远程同构。遗留：cargo check 需 CI（本容器缺 webkit2gtk/gtk/dbus 系统包），Windows/Linux 实机验收清单已写入 README。

