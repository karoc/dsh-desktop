# 官方 DSH 客户端（0.2.1-rc.2）对照与采用清单

> 一次性调研报告。目标不是综述，而是回答两个问题：官方桌面端**现在**怎么解决"壳层问题"，以及我们下一步**具体改哪几个文件**收益最大。每条外部事实都带证据标注；`[假设]` 不进入采用清单。

- **调研日期**：2026-10-23
- **官方 checkout**：`/srv/deepseek-harness`，HEAD `687f282e86`（Merge PR #6408，release `dsh 0.2.1-rc.2`）
- **官方客户端**：`apps/desktop`（Electron `^44.7.0` + `electron-updater ^6.8.9`，版本 `0.2.1-rc.2`；66 个 `src/*.ts`、260 个 `tests` 文件、170 个 `scripts`；渲染层为静态 HTML/JS，共 727 行）
- **我方基线**：`karoc/dsh-desktop` v0.20.0（Tauri 2.11 / WebView2 / 无边框自绘顶栏 + 注入式 chrome）
- **方法**：只读源码与 `git` 元数据；**未**在官方 checkout 内运行构建、测试或任何写操作（`git -C /srv/deepseek-harness status --porcelain` 输出为空）。我方未改任何代码。
- **相关**：[README](../README.md) · [上一轮定位 note](../.agents/notes/implemented/architecture/2026-09-24-official-desktop-0-1-7-positioning-and-adoptions.md) · [壳开发技能](../.dsh/skills/dsh-desktop-shell-dev/SKILL.md) · [文档索引](INDEX.md)
- **结论**：官方桌面端源码**可得**（Electron 线），上一份 0.1.7 定位结论仍成立；但 0.1.7 → 0.2.1 之间官方补了启动握手、更新状态机、键位注册表、托盘/首次隐藏提示、任务感知退出等一批机制。本轮筛出 **5 条可执行采用项**，全部不依赖 Electron 特性、不改上游契约、不破坏零 secret 约束。

## 0. 一页结论

| # | 采用项 | 一句话 | 工作量 |
|---|---|---|---|
| 1 | 恢复页面文件拖放 | Tauri 默认的原生拖放处理器把 Web 页的 HTML5 拖放**整个吃掉**，而 dsh 的输入框明确宣传"拖文件/图片到此处" | S |
| 2 | 外链/新窗口交系统浏览器 | 我们的壳没有 new-window 处理器，wry 对 `window.open`/`target=_blank` 一律 **deny**；官方是 `shell.openExternal` | S |
| 3 | 壳菜单的键盘连续性与焦点回还 | 官方注入的 Windows 菜单栏会记住并**恢复编辑器焦点/选区**，并有可配置加速键；我们点击菜单后光标丢失、无窗口级加速键 | S |
| 4 | 升级取证（JSONL）与失败分类 | 官方把更新状态写成白名单 JSONL 并分类失败原因；我们只有自由文本 manager 日志 | M |
| 5 | 壳 UI 跟随 dsh 语言 | 官方菜单/对话框/托盘随 `html[lang]` 实时切换；我们的壳 UI 硬编码中文 | M |

排序依据：**对"壳越来越好用"的边际收益**（第 1、2 条是当前**功能直接失效**，第 3 条是每天高频交互，第 4、5 条是可靠性与一致性），不按工作量。

---

## 1. 官方实现事实

### 1.1 窗口、顶栏与标题栏契约

- 主窗口在宿主启动**之前**创建，`width 1280 / height 820 / min 520×600`，`show=false` 直到进入工作区；`contextIsolation`、`sandbox`、`nodeIntegration:false`，`webviewTag` 只给主窗口。`[已验证: apps/desktop/src/main.ts:208-238]`
- Windows 用**原生**标题栏覆盖：`titleBarStyle:'hidden'` + `titleBarOverlay {height:40, color, symbolColor}`；macOS 用 `hiddenInset` + 交通灯内嵌 + `vibrancy:'sidebar'`。`[已验证: apps/desktop/src/main.ts:213-229, apps/desktop/src/windows-layout.ts:4]`
- 页面上注入的契约：`html[data-windows-titlebar]`、`--dsh-windows-titlebar-height:40px`、`html[data-platform]`（通用 platform 字符串）、`html[data-fullscreen]`。`[已验证: apps/desktop/src/preload-windows.ts:8-31, apps/desktop/src/preload-platform.ts:10-37]`
- 契约的**消费方在 Web 客户端**，且 0.2.1 比 0.1.7 多：`AppFrame` 让出顶栏带、dockkit 浮动层读取标题栏高度、`overlay-top-margin` 在 fullscreen 时去掉 clearance、右侧栏全屏面板；侧栏还自己设 `--dsh-windows-menu-start:84px` 给菜单栏让位。`[已验证: packages/client/ui-layout/src/client/AppFrame.module.css:26-54, packages/client/ui-dockkit/src/components/FloatLayer.tsx:90-94, packages/client/ui-primitives/src/overlay-top-margin.ts:12, packages/client/ui-sidebar/src/client/SidebarRoot.module.css:89]`
- 标题栏配色**不是写死的**：preload 用隐藏探针读 `--dsw-specific-sidebar-fill` 与 `--dsw-alias-label-primary`，经 canvas 归一化后随 `lang`/主题属性变化发给主进程更新 overlay。`[已验证: apps/desktop/src/preload-windows.ts:33-70]`

**我方对照**：`computeCaptionPlan` 已用同一个 40px 值，并能在 `titlebar-contract` 开关下写出同一组 marker；但没有 `data-fullscreen` 同步，也没有"从页面取色回写窗口"的链路（我们自绘顶栏，不需要后者的原样实现）。`[已验证: src-tauri/resources/ui/shell-chrome.js:85-103, 707-730]`

### 1.2 菜单放在哪、快捷键怎么组织

- 原生应用菜单在 macOS 上只保留少量项：关于、检查更新、CLI 命令、退出；开发态额外 reload/restart。**Windows 的应用菜单只有两个隐藏 devtools 项（F12）**，可见菜单是下面注入的 Application/Edit。`[已验证: apps/desktop/src/main.ts:957-985]`
- Windows 的**可见菜单栏是 preload 注入的 shadow DOM**，不是原生菜单栏：两个按钮 Application / Edit，定位 `left: var(--dsh-windows-menu-start, 48px)`，点击后把屏幕坐标发给主进程弹**原生 popup**。`[已验证: apps/desktop/src/preload-menu.ts:10-30, 96-105]`
- 菜单**不抢编辑器焦点**：`focusout` 捕获阶段记住 input/textarea/contenteditable 的选区，菜单打开前若焦点在壳 host 上则恢复焦点与 `selectionStart/End`，并对 `range` 同样恢复。`[已验证: apps/desktop/src/preload-menu.ts:31-51, 79-84]`
- 快捷键是**设备级可配置**的：定义/快照/编辑走 IPC，持久化到 `userData/keybindings.json`（原子写、revision 冲突检测），主进程用 `before-input-event` 拦截物理按键，并对 iframe/webview guest 做焦点与 frameName 校验；`page.close` 的加速键还会注册进应用菜单。`[已验证: apps/desktop/src/keybindings.ts:10-30, apps/desktop/src/keyboard.ts:31-60, 63-125]`
- Web 端只有在全局存在 `dshDesktop` 时才把快捷键运行时判为 `desktop`；若判为 desktop 却没有 `dshDesktop.keyboard`，插件会**直接抛错**。`[已验证: packages/client/shortcuts/src/client/dom.ts:19, packages/client/shortcuts/src/client/index.ts:44-46]`

**我方对照**：`SHELL_MENUS` 是单个应用菜单，功能面比官方多（代理设置、停用插件、GPU、清理、关于等）；下拉支持 ↑↓/Home/End/Enter/Esc，但**没有窗口级加速键**，菜单打开也不恢复页面编辑器焦点。`[已验证: src-tauri/resources/ui/shell-chrome.js:93-131, 1781-1827]`

### 1.3 会话与工作区导航

- 壳**不持有会话模型**：`apps/desktop/src/*.ts` 中没有 `sessionId`/`sessions` 引用（只有 Platform 登录会话）；会话列表、工作区切换、历史加载全部由同一套 Web 前端负责。壳只做三件事：窗口聚焦（二次启动、`dsh://open`）、首次欢迎/登录闸门、为每个 workspace 维护独立的浏览器 guest 分区。`[已验证: apps/desktop/src/main.ts:1235-1248, 1343, apps/desktop/src/browser-guests.ts:15-40]`
- 因此"官方桌面端的工作区导航更好"这个命题不成立——它和我们跑的是同一套前端；差别只在窗口/账号/浏览器 guest 的宿主能力。

### 1.4 插件与设置入口

- **设置**就是 Web 设置页；桌面壳自己的设置只有一个字段：`updates.allowTestAuthPopupWindow`，落在 `userData/desktop/settings.json`，读取失败回落默认值且不阻塞启动。`[已验证: apps/desktop/src/settings.ts:24-60]`
- **插件管理**也交给 Web 的 Plugins 页；桌面壳只增加了一个"把 `dsh` 命令安装到 PATH"的命令管理对话框（固定安装位置、SHA-256 指纹、占用检测、备份），以及恢复态的 profile 净化。`[已验证: apps/desktop/src/command-management.ts:1-40, apps/desktop/src/project-manager.ts:96-107]`
- 官方**不预装第三方插件**：profile 用 `PROFILE_TEMPLATES.web` 的 bundles 初始化，运行时里只有委身于内核的核心包。`[已验证: apps/desktop/src/project-manager.ts:29-31, 168-175]`

**我方对照**：插件管理同样已移交 dsh（2026-09-21 决策），但我们是 4 个版本锁定的预装插件 + 离线可用的资源副本；没有 PATH 命令安装器（也不打算要，见 §4）。`[已验证: README.md:278-281, plugins/preinstalled/]`

### 1.5 启动、就绪与错误展示

- 启动顺序是"**先窗口、后宿主**"：主窗口立即加载打包内的 Web 静态资源（`dsh-app://app`），index 的 `<head>` 被插入 `globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()`；Web 入口先 `await dshDesktopBoot.ready()`，拿到 Host 的 `injections` 与 `streamBaseUrl` 后才 resolve 闸门并渲染，避免"渲染到一半再注入"的闪变。`[已验证: apps/desktop/src/web-document.ts:10, 32, apps/web/src/main.ts:6-12, 22-38, apps/desktop/src/main.ts:690-696]`
- 页面侧启动失败会回调 `dshDesktopBoot.failed(message)`，主进程转成**原生**三选一恢复框：退出 / 重启 / 停用第三方插件；`EADDRINUSE` 只给退出/重启。`[已验证: apps/desktop/src/main.ts:697-703, apps/desktop/src/fatal-recovery.ts:61-108]`
- 弹框前先写崩溃报告（预算 1s，慢/失败则不带路径），对话框只显示最后 8 行 + 报告路径 + 重装建议；报告按固定命名保留最近 10 份、渲染器 console 只保留 64 KiB 错误级。`[已验证: apps/desktop/src/fatal-recovery.ts:34-60, 110-120, apps/desktop/src/crash-report.ts:30-52]`
- 另外三条失败路径都会进同一恢复流程：`did-fail-load`（主框架且非 -3）、`preload-error`、`render-process-gone`（非 clean-exit）。`[已验证: apps/desktop/src/main.ts:1104-1117]`
- 首次运行/登录是**独立原生窗口** 600×700（Windows acrylic、透明标题栏），在进入工作区前挡住主窗口；登录过期会重新拉起并带 `session-expired` 提示。`[已验证: apps/desktop/src/welcome-window.ts:13-46, apps/desktop/src/main.ts:1142-1200]`

**我方对照**：我们走"启动页 → `/alive` → 切远程页"的路径；启动页是独立的 `src/index.html`/`src/app.js`，chrome 的故障条幅提供原因、重试、证据目录与一键停用第三方插件，错误横幅有退避轮询。诊断信息对用户更可见，但没有"页面主动上报启动失败"的握手，失败判定仍以 `/alive` 与进程状态为主。`[已验证: src/app.js, src-tauri/resources/ui/shell-chrome.js:24-60, 786-903]`

### 1.6 更新机制

- 更新用 `electron-updater`，但**关掉自动下载与退出时安装**：`autoDownload=false`、`autoInstallOnAppQuit=false`、`allowDowngrade=false`，通道 `nightly|latest`，签名/校验由 updater 负责；状态机 `idle → checking → available → downloading → verifying → installing → ready → error`，下载进度以整数百分比对外。`[已验证: apps/desktop/src/update-coordinator.ts:24-31, 60-92, apps/desktop/src/ipc.ts:42-60]`
- 安装前先向 Host 询问"活跃任务/已排程提醒"，再 `lock` 准入、停 Host；任务在确认后发生变化会以 `tasks-changed` 拒绝安装，停不干净以 `stop-failed` 回滚并恢复 Host。`[已验证: apps/desktop/src/main.ts:593-640, apps/desktop/src/host-process.ts:243-260]`
- 更新状态可写成**可选** JSONL 取证：只允许 phase/version/percent/failedOperation/errorCode 白名单字段，errorCode 只从固定集合匹配，逐条 flush，绝不写原始错误文本/URL/请求数据。`[已验证: apps/desktop/src/update-journal.ts:11-30, 45-75]`
- 失败对用户是**分类文案**（check/download/install × network/stop-failed/tasks-changed/tasks-unavailable），原始诊断只进详情。`[已验证: apps/desktop/src/update-presentation.ts:12-52]`
- 轮询默认 10 分钟、失败指数退避至 1 小时、±20% 抖动，按"完成时刻"排下一次；用户手动检查可绕过 deadline；系统 resume 会触发一次自动检查。`[已验证: apps/desktop/src/update-schedule.ts:20-40, 55-105, apps/desktop/src/main.ts:920-930]`
- 下载完成且窗口不在前台时，用 `flashFrame`/Dock bounce + 静默通知提醒，但**不**自动恢复/聚焦窗口，也**不**授予安装授权。`[已验证: apps/desktop/src/update-attention.ts:25-70]`

**我方对照**：dsh 运行时升级由 `scripts/server-manager.mjs` 的 `check-update`/`update-dsh` 完成，壳自身更新是只读展示（一期负向保证）；没有结构化更新取证，也没有"升级前询问运行中任务"的能力（见 §4）。`[已验证: scripts/server-manager.mjs:8-18, 636-660, README.md:9, 281]`

### 1.7 原生能力

- **文件拖放/路径**：preload 暴露 `__DSH_HOST_PATHS__.pathFor(file)`（`webUtils.getPathForFile`），Web 端对非图片、非目录文件优先插入 `@路径` 引用而不是上传；目录也只能在有该桥时添加。`[已验证: apps/desktop/src/preload-app.ts:76-84, packages/client/ui-conversation/src/client/apply.ts:109-112, 486-529]`
- **目录选择**：preload 暴露 `__DSH_DIRECTORY_PICKER__.pick()`；Web 端插件在有桥时走桌面原生选择器，否则回落 Host 的 OS chooser。`[已验证: apps/desktop/src/preload-app.ts:76-78, packages/client/ui-directory-picker-native/src/client/index.ts:17-25]`
- **外链**：`setWindowOpenHandler` 对 http(s) 一律 `shell.openExternal` 并 deny 内嵌新窗；`will-navigate` 也把离开应用 origin 的 http(s) 导航转外部浏览器。`[已验证: apps/desktop/src/main.ts:241-249, 305-314]`
- **托盘/关窗**：Windows 常驻托盘（打开/退出）；关窗=隐藏到托盘，但**首次**隐藏前必须确认一次，标记落盘后不再打扰；Linux 无托盘则退化为最小化。`[已验证: apps/desktop/src/tray.ts:10-60, apps/desktop/src/background-notice.ts:22-70, apps/desktop/src/main.ts:1072-1102]`
- **退出**：先问 Host 是否有活跃/排程任务（2 秒超时，未知按"有任务"处理），按三种组合给不同文案；同一个确认只开一个，按钮顺序区分 Windows/macOS。`[已验证: apps/desktop/src/quit-confirmation.ts:26-96, apps/desktop/src/host-process.ts:46-50, 254-260]`
- **单实例/深链**：单实例回调聚焦已有窗口；`dsh://open` 同样只聚焦。`[已验证: apps/desktop/src/main.ts:1235-1248, 1343]`
- **通知**：整个桌面壳只发一种系统通知——更新已就绪（`update-attention.ts`）；**没有**任务完成/待交互通知。`[已验证: grep -rn "new Notification" apps/desktop/src → 仅 update-attention.ts:43]`
- **其他**：麦克风权限安装（客户端当前无 `getUserMedia` 调用）、本地化右键编辑菜单（undo/redo/cut/copy/paste/selectAll + editFlags）、按 workspace 分区的浏览器 guest（WebContentsView，独立 partition）、Platform 用量面板（懒创建 WebContentsView）。`[已验证: apps/desktop/src/main.ts:269-300, 684-688, apps/desktop/src/browser-guests.ts:15-40, apps/desktop/src/platform-view.ts:79, 138]`

**我方对照**：托盘、关窗首次确认、单实例、双击最大化、目录选择（Host 原生）都已具备；**任务完成/待交互通知是我们比官方强**；拖放与外链新窗是两处真实缺口（见 §2）。

### 1.8 性能做法

- 壳的渲染层是**静态资源、无前端框架**（welcome 的 React 只用于那个独立小窗）；主窗口只加载一个 WebView，Platform 面板与浏览器 guest 都按需创建。`[已验证: apps/desktop/renderer/ 12 个文件、727 行；apps/desktop/src/platform-view.ts:138]`
- 启动并行化：窗口创建/加载打包内静态页与 Host 启动并行，页面用 boot 闸门等待注入，避免"先渲染后注入"的二次布局。`[已验证: apps/desktop/src/web-document.ts:10, apps/desktop/src/main.ts:1290, 571-580]`
- 插件 bundle 响应被强制 `cache-control: no-store`：Host 给它们的是"每次启动变更 revision 的 immutable"，Chromium 磁盘缓存只会堆积无法复用的副本。`[已验证: apps/desktop/src/web-document.ts:84-98]`
- Web 侧的轮次导航条用 `@tanstack/react-virtual` 虚拟化；长会话的 transcript 本身分页加载。`[已验证: packages/client/ui-chat/src/client/chat/TurnNavigator.tsx:1-12, 110]`
- 诊断有界：渲染器 console 只留 64 KiB 错误级、崩溃报告只留 10 份、对话框详情 1200 字符 / 8 行。`[已验证: apps/desktop/src/crash-report.ts:30-52, apps/desktop/src/fatal-recovery.ts:34-60]`

**我方对照**：壳本身也是静态页 + 单 WebView，且 chrome 的探针已做退避（3s→15s、5s→30s），空闲成本低于早期版本；没有官方这种"启动并行 + boot 闸门"的等价物，但我们的启动页是独立页面，不存在二次注入问题。`[已验证: src-tauri/resources/ui/shell-chrome.js:24-60]`

---

## 2. 差距表

### 2.1 我们缺的（按对日常使用的实际影响排序）

| # | 能力 | 官方 | 我们 | 证据 | 判定 |
|---|---|---|---|---|---|
| G1 | 页面文件拖放 | Electron 原生拖放 + 真实路径桥 | Tauri 默认挂原生拖放处理器（`SetAllowExternalDrop(false)`），HTML5 拖放被关；我方未监听 `onDragDropEvent`，也没有 `dragDropEnabled:false` → 拖入**无声消失** | 官方 `[已验证: apps/desktop/src/preload-app.ts:82-84]`；我方 `[已验证: src-tauri/tauri.conf.json:12-31, Cargo.toml:14-19]`；机制 `[已验证: ~/.cargo/.../tauri-runtime-2.11.3/src/webview.rs:515, 622-627]`、`[已验证: ~/.cargo/.../wry-0.55.1/src/webview2/mod.rs:150-155]` | **缺（P1）** |
| G2 | 外链/新窗口 | `shell.openExternal`，内嵌一律 deny | 没有 new-window 处理器；wry 在无处理器时对 `NewWindowRequested` 直接 `SetHandled(true)`（deny）→ `window.open`/`target=_blank` 无声失败 | 官方 `[已验证: apps/desktop/src/main.ts:241-249, 305-314]`；我方 `[已验证: src-tauri/src/lib.rs:4638-4645 无导航拦截]`；机制 `[已验证: ~/.cargo/.../wry-0.55.1/src/webview2/mod.rs:793-795]`；使用点 `[已验证: packages/client/ui-chat/src/client/apply.ts:265-270, packages/client/ui-sidebar-browser/src/client/view/BrowserBody.tsx:100]` | **缺（P1）** |
| G3 | 菜单键盘连续性 | 记住并恢复编辑器焦点/选区；设备级可配置加速键 | 菜单打开后页面编辑器失焦；无 Ctrl+W / Ctrl+Q 等窗口级加速键 | 官方 `[已验证: apps/desktop/src/preload-menu.ts:31-51, apps/desktop/src/keyboard.ts:63-125]`；我方 `[已验证: src-tauri/resources/ui/shell-chrome.js:1781-1829]` | **缺（P2）** |
| G4 | 壳 UI 语言 | 菜单/对话框/托盘按 `html[lang]` + 系统语言实时切换 | chrome 菜单、确认窗、toast 均为硬编码中文 | 官方 `[已验证: apps/desktop/src/locale.ts:349-370, apps/desktop/src/preload-app.ts:104-109]`；我方 `[已验证: src-tauri/resources/ui/shell-chrome.js:93-131]` | **缺（P2）** |
| G5 | 更新取证/失败分类 | 白名单 JSONL + 稳定失败类型 + 实时状态 | `manager.log` 自由文本 + 横幅/托盘文案；失败原因不可机读 | 官方 `[已验证: apps/desktop/src/update-journal.ts:11-75, apps/desktop/src/update-presentation.ts:12-52]`；我方 `[已验证: scripts/server-manager.mjs:8-18]` | **缺（P2）** |
| G6 | 壳自更新与签名 | electron-updater + 平台签名 + 强制更新策略 | 壳更新只读；无签名、无自动下载（已知结构缺口） | 官方 `[已验证: apps/desktop/src/update-coordinator.ts:60-92, apps/desktop/src/mandatory-update-policy.ts:1-40]`；我方 `[已验证: README.md:9, 281]` | **缺（P1，本轮不采纳：需证书与发布链，见 §4）** |
| G7 | 退出前任务感知 | 询问 Host 活跃/排程任务后确认 | 只有静态确认文案，不感知运行中任务 | 官方 `[已验证: apps/desktop/src/quit-confirmation.ts:26-96, apps/desktop-host/src/quit-inspection.ts:26-50]`；我方 `[已验证: src-tauri/src/lib.rs:4417-4445]` | **缺（P2，需上游契约，见 §4）** |
| G8 | 首启离线可用 | 运行时随包物化，首启零安装 | 首启从 npm 装 dsh（网络/镜像依赖） | 官方 `[已验证: apps/desktop/src/project-manager.ts:29-31, 168-175]`；我方 `[已验证: README.md:9]` | **缺（已知权衡，不采纳）** |
| G9 | 原生浏览器 guest | 按 workspace 分区的 WebContentsView，独立 session | 用 Web 前端的 iframe 实现（同一 WebView） | 官方 `[已验证: apps/desktop/src/browser-guests.ts:1-40]` | **结构性差异，不采纳** |

### 2.2 我们做得更好的（诚实列出，不当卖点吹）

| # | 能力 | 我们 | 官方 | 证据 |
|---|---|---|---|---|
| B1 | 任务完成/待交互系统通知 | 有（toast 点击回到会话） | **没有**；壳只发"更新就绪"通知 | 我方 `[已验证: src-tauri/src/lib.rs:507-540]`；官方 `[已验证: apps/desktop/src/update-attention.ts:43]` |
| B2 | 内建逐主机正向代理 | CONNECT/HTTP + 按主机路由 + Basic 认证，12 场景测试 | 零用户可见代理配置（仅 updater 有 HTTP executor） | 我方 `[已验证: README.md:63, scripts/proxy.mjs]`；官方 `[已验证: apps/desktop/src/update-http-executor.ts]` |
| B3 | 预装插件 + 离线资源 | 4 个版本锁定插件随包分发 | 不预装第三方插件 | 我方 `[已验证: plugins/preinstalled/]`；官方 `[已验证: apps/desktop/src/project-manager.ts:168-175]` |
| B4 | 版本自由 | 用户可停任意 dsh 版本（含预发布），地板可冻结 | 运行时随包锁定，跟客户端发版 | 我方 `[已验证: README.md:9, 281]`；官方 `[已验证: apps/desktop/src/project-manager.ts:168-175]` |
| B5 | 私有 DSH_HOME | 默认 `<runtime>/dsh-home`，不碰浏览器版 `~/.dsh` | 与 Web/CLI 共用 `DSH_HOME` | 我方 `[已验证: README.md:300-303]` |
| B6 | Linux 产物 | AppImage/deb | 仅 Windows/macOS | 我方 `[已验证: src-tauri/tauri.conf.json:35-40]`；官方 `[已验证: apps/desktop/config/ 与 electron-builder 目标]` |
| B7 | Windows 深取证 | Job Object、MiniDump、manager guard、独立 guard、证据目录 | 崩溃报告 + 进程退出诊断 | 我方 `[已验证: src-tauri/src/job_object.rs, manager_guard.rs, web_dump.rs]`；官方 `[已验证: apps/desktop/src/crash-report.ts]` |
| B8 | 启动页可读诊断 + 重试 + 一键停用插件 | 启动页展示错误与取证入口 | 原生三选一对话框（更简洁，但信息在文件里） | 我方 `[已验证: src/app.js（启动页）, src-tauri/resources/ui/shell-chrome.js:786-903（错误条幅/停用插件/证据按钮）]`；官方 `[已验证: apps/desktop/src/fatal-recovery.ts:61-108]` |
| B9 | 更新自主权 | 不强制更新，预发布需用户确认 | 有强制更新策略（manifest policy） | 我方 `[已验证: README.md:9, 281]`；官方 `[已验证: apps/desktop/src/mandatory-update-policy.ts]` |

### 2.3 持平

托盘（Win）、关窗首次隐藏确认、单实例/二次启动聚焦、标题栏拖动/双击最大化、`data-windows-titlebar` 契约注入（我们已有开关）、目录选择（Host 原生）、右键编辑菜单（Chromium 默认，未本地化）、无缩放/无 find bar。

---

## 3. 采用清单（核心）

> 5 条，按边际收益排序。每条都给出"为什么值得 / 改哪 / 工作量 / 风险与回滚 / 怎么验证"。**不包含**任何以 `[假设]` 为唯一依据的项。

### A1. 恢复页面文件拖放（S）

**为什么值得**：dsh 的输入框在 UI 里明确写着"文件或图片拖动到此处即可添加"，并实现了 `attachment.dropTitle` 空态；官方 Electron 让拖放直接落到 Chromium，还能拿到真实路径。我们的 Tauri 壳默认把拖放**截走**，用户拖图片/文件到输入框没有任何反应——这是功能级失效，不是体验差异。`[已验证: packages/client/ui-conversation/src/client/locales.ts:35-37, 415-417; ~/.cargo/.../tauri-runtime-2.11.3/src/webview.rs:515, 622-627; ~/.cargo/.../wry-0.55.1/src/webview2/mod.rs:150-155]`

**具体改法（文件级）**
1. `src-tauri/tauri.conf.json`：在 `app.windows[0]` 增加 `"dragDropEnabled": false`（Tauri 文档原文："Disabling it is required to use HTML5 drag and drop APIs on the frontend on Windows"）。`[已验证: ~/.cargo/.../tauri-runtime-2.11.3/src/webview.rs:622-627]`
2. 在现有配置门禁里加一条**可失败**断言：`src-tauri/tauri.conf.json` 的 main 窗口必须存在 `dragDropEnabled:false`；把断言写进 `scripts/test-tauri-config*.mjs`（若已有配置测试则并入，没有就新建并挂到 `npm test`）。负向对照：临时删掉该键 → 套件必须红。
3. 文档同步：README「已知能力边界」补一句"页面内 HTML5 拖放可用；`@路径` 引用仍不支持（WebView2 无 Electron 的 `webUtils.getPathForFile`）"；`docs/INDEX.md` 已登记本报告，无需新增。
4. **不做**：不注入 `__DSH_HOST_PATHS__`，不伪造路径引用（见 §4）。

**工作量**：S（配置一行 + 门禁 + 文档）。

**风险与回滚**：Tauri 的 `tauri://drag-drop` 事件不再派发——我们当前没有任何监听，等于零损失；窗口拖动走 `start_dragging`，与拖放无关。若发现 Windows 上 HTML5 drop 仍不触发（WebView2 版本差异），回滚就是删掉这一行并关闭该门禁；不涉及代码回滚。

**验证方式**：① 静态门禁（可失败）；② Windows 实机：拖 1 张 PNG 到输入框 → 出现附件缩略图；拖 1 个 `.md` → 出现上传附件（不是 `@` 引用）；拖入时页面不导航、壳不崩溃；③ Linux 冒烟（WebKitGTK）同样验证一次。

### A2. 外链/新窗口交系统浏览器（S）

**为什么值得**：官方对 `window.open` 和跨 origin 导航统一 `shell.openExternal`，应用内永远不留外站。我们的壳没有 new-window 处理器：wry 在无处理器时直接 deny，因此 `window.open` 类的链接**点了没反应**；受影响的不只是聊天链接（默认 `linkOpening='sidebar'` 时走侧栏），还有设置页/关于页/更新页的 `target="_blank"`，以及侧栏浏览器的"在外部打开"。`[已验证: apps/desktop/src/main.ts:241-249, 305-314; ~/.cargo/.../wry-0.55.1/src/webview2/mod.rs:793-795; packages/client/ui-chat/src/client/apply.ts:265-270; packages/client/ui-sidebar-browser/src/client/view/BrowserBody.tsx:100]`

**具体改法（文件级）**
1. `src-tauri/resources/ui/shell-chrome.js`：
   - 在 `document` 上做捕获阶段 `click`/`auxclick` 监听：命中 `a[href]` 且 `new URL(href).protocol` 为 `http:`/`https:`，并且（`target === '_blank'` 或 `event.button === 1` 或带 Ctrl/Cmd）时 `preventDefault()`，走桥 `POST /shell/open-url`；
   - 覆写 `window.open`（保存原函数）：仅对 http(s) 转桥并返回 `null`；其余参数原样交回原函数。注意必须在 chrome 初始化早期执行，并保留原函数的 `this`。
2. `src-tauri/src/lib.rs`：新增桥端点 `POST /shell/open-url` 与 IPC 命令 `open_url`，两者共用一个纯函数 `validate_external_url`（只允许 http/https、长度上限、拒绝 userinfo、拒绝控制字符）；Windows 用已启用的 `Win32_UI_Shell`（`ShellExecuteW`），Linux 用 `xdg-open`。走桥时**不需要**确认窗（不是危险动作），但必须记录 `log_line`（含拒绝原因）。
3. 测试：`scripts/test-shell-chrome.mjs` 增加 URL 判定纯函数的正/负用例（`https` 通过，`javascript:`/`file:`/`data:`/空 host 拒绝）；Rust 侧加 `validate_external_url` 单测；负向对照：把协议白名单改成"全部放行" → 测试必须红。
4. 文档：README「安全说明」补"外链只允许 http(s)，交系统浏览器打开；壳不接受页面提供命令/路径"。

**工作量**：S（chrome ~40 行 + Rust ~60 行 + 测试）。

**风险与回滚**：风险点是误伤应用内导航（例如 dsh 自己的 OAuth 弹窗使用 `window.open('about:blank')` 再写 location——我们只拦截 http(s)，about:blank 原样放行）；以及侧栏浏览器的 `target=_blank` 行为变化（希望就是这个）。回滚：chrome 侧用 `__DSH_SHELL_OPEN_URL__` 开关包住，或直接撤回提交；Rust 端点保留也不影响其他路径。

**验证方式**：① 单测/负向对照；② Windows 实机：设置页帮助链接 → 默认浏览器打开；聊天里把 `linkOpening` 切到"新标签页"后点链接 → 浏览器打开；侧栏浏览器"在外部打开"→ 浏览器打开；③ 安全反例：页面里构造 `javascript:alert(1)` 链接，点击无反应且日志出现拒绝记录。

### A3. 壳菜单的键盘连续性与窗口加速键（S）

**为什么值得**：官方注入的 Windows 菜单栏把"打开菜单"做成不影响编辑的动作：先记住编辑器焦点/选区，菜单关闭时恢复；再配上设备级可配置加速键——这本身说明"点菜单打断编辑"是他们真实处理过的问题。我们的 chrome **完全没有等价逻辑**（菜单按钮是普通 DOM 按钮，`focusout` 后没有恢复；也没有窗口级加速键），所以补这段逻辑的收益方向明确，而实际中断程度要在 dev 壳里复现（见 §5.2 A-4）。`[已验证: apps/desktop/src/preload-menu.ts:31-51, 79-84; apps/desktop/src/keyboard.ts:63-125; 我方 src-tauri/resources/ui/shell-chrome.js:1781-1829]`

**具体改法（文件级）**
1. `src-tauri/resources/ui/shell-chrome.js`：
   - 移植官方的 `rememberEditor` 模式：`focusout` 捕获阶段记录 `input`/`textarea`/`contenteditable` 的 `selectionStart/End/Direction` 或 `Selection` ranges；在 `openMenu()` 前若 `document.activeElement` 是壳 host/菜单按钮，则在关闭菜单（Esc、外点、执行动作）后恢复焦点与选区；`isConnected` 守卫必须有；
   - 增加一个显式的 `SHELL_ACCELERATORS` 映射（单一真源）：`Ctrl+W` → `close`（隐藏到托盘）、`Ctrl+Q` → `quit`（走确认窗）、`Ctrl+Shift+I`/`F12` → 开发者工具、`Ctrl+R`/`F5` → 刷新。处理条件：`!e.defaultPrevented`、非组合输入、焦点不在 `input/textarea/contenteditable`（Ctrl+W/Q 除外）、不与 dsh 已注册快捷键冲突（先查 `event.defaultPrevented`，再查 `data-dsh-shortcut-*` 不存在时的保守策略）；
   - 菜单按钮加 `aria-keyshortcuts`，下拉项按动作展示加速键文本（纯展示，不新增持久化）。
2. 测试：`scripts/test-shell-chrome.mjs` 为"键盘映射纯函数"（输入 key/modifiers/focus 上下文 → 返回动作或 null）加正/负用例；负向对照：把 Ctrl+W 映射改成刷新 → 套件红。
3. 文档：技能 `dsh-desktop-shell-dev` 的壳菜单章节补"新增菜单动作时同步 `SHELL_ACCELERATORS`（若有）"。

**工作量**：S（chrome ~80 行 + 测试；无 Rust 改动）。

**风险与回滚**：与 dsh 自带快捷键冲突（dsh 在 Windows 上对 Ctrl+W/Ctrl+R 有优先规则，但需要 `dshDesktop` 运行时才生效；我们是 `web` 运行时，默认不抢）。回滚：删除 `SHELL_ACCELERATORS` 条目即可；焦点恢复可单独撤回。

**验证方式**：① 单测；② dev 壳（Linux Playwright 或 Windows 实机）：光标在输入框中间 → 打开壳菜单 → Esc → 光标仍在原位；Ctrl+W 隐藏到托盘而不是退出；Ctrl+Q 弹确认；③ dsh 自带快捷键（例如命令面板）逐条回归不误触。

### A4. 升级取证（JSONL）与失败分类（M）

**为什么值得**：官方把更新过程写成**白名单** JSONL（phase、version、percent、failedOperation、errorCode），错误码只从固定集合匹配，且每条 flush；用户看到的失败文案是分类结果，不是原始堆栈。我们的升级路径（manager 的 `check-update`/`update-dsh` 与壳更新检查）只有自由文本 `manager.log` 和横幅，出问题只能请用户翻日志，也无法自动判断"是网络、校验还是安装阶段失败"。`[已验证: apps/desktop/src/update-journal.ts:11-75, apps/desktop/src/update-presentation.ts:12-52; 我方 scripts/server-manager.mjs:8-18, 636-660]`

**具体改法（文件级）**
1. 新增 `scripts/update-journal.mjs`（纯 Node，无第三方依赖）：`createUpdateJournal(dir, version)` 写出 `<app_data>/evidence/update-<ISO>-<uuid>.jsonl`，提供 `action(name)` 与 `state({phase, version, percent, failedOperation, errorCode})`；只允许白名单字段与固定 errorCode 集合（`ETIMEDOUT`、`ENOSPC`、`ERR_INTERNET_DISCONNECTED`、`ERR_CONNECTION_RESET`、`ERR_NAME_NOT_RESOLVED`、`CHECKSUM_MISMATCH`），**绝不**写 URL、token、路径、原始错误文本；单文件上限与"保留最近 10 份"清理。
2. `scripts/server-manager.mjs`：在更新检查/下载/安装的三个边界打点（`check-requested`、`download-requested`、`install-confirmed`、`workspace-ready`/`workspace-failed`），把失败映射成 errorCode；journal 写入失败只记日志、不改变升级结果（观测不能变成新的失败源）。
3. `src-tauri/src/lib.rs`：横幅/托盘文案按 errorCode 分类（网络/磁盘/校验/安装），并在"打开证据目录"里包含最新 update journal；`README` 的"维护者：升级排障"补用法。
4. 测试：`scripts/test-update-journal.mjs` —— 断言白名单外字段被丢弃、token/URL 不落盘、保留数量正确、写入失败不影响返回；负向对照：把 `errorCode` 默认改成 `UNCLASSIFIED` 仍能写、把白名单删掉后必须出现泄漏断言变红。

**工作量**：M（新模块 + manager 打点 + Rust 文案映射 + 测试与文档）。

**风险与回滚**：磁盘写入量很小（每次升级一条文件），但要防"把用户路径写出去"；清理策略若写错会删错文件（只匹配固定文件名正则）。回滚：`DSH_DESKTOP_UPDATE_JOURNAL=0` 关闭，或移除调用点；journal 文件本身可保留不影响启动。

**验证方式**：① 单测 + 泄漏负向对照；② 模拟升级失败（把 registry 指向不可达地址）→ 生成 journal 且 errorCode 为网络类，横幅显示"网络"而非堆栈；③ 正常升级 → `workspace-ready` 出现、无敏感字段（fixture diff）。

### A5. 壳 UI 跟随 dsh 语言（M）

**为什么值得**：官方把语言解析集中在一个地方（`resolveDesktopLocale`/`resolveDesktopStartupLocale`），菜单、对话框、托盘、崩溃报告都取同一份 locale，并在 `html[lang]` 变化时**实时**重贴标签。我们的 chrome 菜单、确认窗、toast、错误横幅全是硬编码中文：用户把 dsh 切成 English 后，壳仍然是中文，且没有回退/未知语言策略。`[已验证: apps/desktop/src/locale.ts:349-370, apps/desktop/src/preload-app.ts:104-109, apps/desktop/src/preload-menu.ts:104-106; 我方 src-tauri/resources/ui/shell-chrome.js:93-131]`

**具体改法（文件级）**
1. `src-tauri/resources/ui/shell-chrome.js`：引入 `SHELL_STRINGS = { zh: {...}, en: {...} }` 与纯函数 `resolveShellLocale(htmlLang, navigatorLanguages)`（`zh*` → zh，`en*` → en，未知回退 zh）；把菜单 label、下拉项、确认窗标题/按钮、toast、错误横幅、关于框文案改为查表；用 `MutationObserver` 观察 `document.documentElement.lang` 变化并重贴（只改文本，不重挂 DOM）。
2. 原生窗口（确认窗、设置窗）不直接读页面：由 chrome 在语言变化时 `POST /shell/locale` 桥端点，Rust 持久化到 `<app_data>/shell-locale.json`，下次启动原生窗口用它；首启时 Rust 用系统语言兜底（`GetUserDefaultLocaleName` / `LANG`）。
3. 测试：`scripts/test-shell-chrome.mjs` 增加 `resolveShellLocale` 的正/负/未知用例与"英文字符串无中文残留"的静态断言；负向对照：把 en 表里塞一个中文字符串 → 断言红。
4. 文档：README 的「界面语言」小节；技能 `dsh-desktop-shell-dev` 的"加壳菜单"步骤补"同时补 zh/en 两份文案"。

**工作量**：M（字符串表是大头，约 80–120 条；桥端点与持久化小）。

**风险与回滚**：最大风险是"半套翻译"（原生窗口已经中文、页面已英文的中间态），所以必须先用开关 `shellLocale: 'zh' | 'en' | 'auto'` 落地、默认 `auto`，并在原生窗口拿不到持久化值时统一回退中文。回滚：`shellLocale=zh` 落盘即恢复现状。

**验证方式**：① 单测；② dev 壳：dsh 设置里切 English → 壳菜单/确认窗/toast 在 1 帧内变英文；切回中文 → 复原；刷新后仍保持；③ 未知语言（`fr`）→ 回退 zh；④ 英文最长标签在 900px 最小窗口下不溢出（截图对比）。

---

## 4. 明确不采用

| # | 看起来不错 | 为什么不适合我们 |
|---|---|---|
| N1 | 整体注入 `dshDesktop` / `dshOnboarding` 桌面标记族 | 副作用远大于收益：`dshDesktop` 会把快捷键运行时切成 `desktop`（没有 `keyboard` 桥直接抛错）、改聊天 transcript 默认模式、关掉 dsh 自己的模型凭据 onboarding、开启 product analytics 分支；要正确实现就得连 `browser` guest、`updates`、`shortcuts` 一起做，等于把官方 preload 全量搬到 Tauri。`[已验证: packages/client/shortcuts/src/client/dom.ts:19, index.ts:44-46, packages/client/ui-settings-models/src/client/index.ts:82, packages/client/ui-chat/src/client/apply.ts:167]` |
| N2 | `__DSH_BOOT_READY__` + `dshDesktopBoot.ready()` 启动握手 | 它要求 index 由壳自己提供、Host 通过 IPC 返回 `injections`/`streamBaseUrl`，并把 `__DSH_TRANSPORT__.ownsHost` 置 true——这是 in-process/托管 Host 的契约。我们跑外部 `dsh web` 子进程 + `?token=`，硬注入会劫持真实 Web 入口的启动路径，收益（少一次 `/alive` 轮询）远小于破坏面。`[已验证: apps/desktop/src/web-document.ts:10, apps/web/src/main.ts:6-38]` |
| N3 | 退出前任务巡检（`inspectQuit` / `updateTasks lock`） | 它跑在 `desktop-host` 进程内，直接读 `ctx.agents`/`ctx.jobs`，只通过 Electron 私有 IPC 暴露；`dsh` CLI 没有等价子命令，HTTP/RPC 也没有公开契约。没有上游契约就实现只能靠猜，属于禁区。`[已验证: apps/desktop-host/src/quit-inspection.ts:26-50, apps/desktop/src/host-process.ts:243-260]` |
| N4 | Electron 专属机制：原生 `titleBarOverlay`、WebContentsView 浏览器 guest、`dsh-app://` 自定义 scheme + `net.fetch` 转发、`electron-updater` + NSIS 差分 | 与 Tauri/WebView2 结构不兼容；照搬等于用 Electron 重写壳，放弃 Rust 侧已交付的 Job Object、MiniDump、manager guard、代理与安装器资产（2026-09-24 已论证）。`[已验证: apps/desktop/src/main.ts:213-229, apps/desktop/src/browser-guests.ts:1-40, apps/desktop/src/web-document.ts:73-110]` |
| N5 | 强制更新策略 + 飞书测试登录（`mandatory-update-policy` / `policy-test-auth`） | 依赖官方自己的更新 feed、签名链与账号体系；与"版本自由、用户决定、零 secret"三条产品约束直接冲突，且我们无法验证其线上行为。`[已验证: apps/desktop/src/mandatory-update-window.ts, apps/desktop/src/policy-test-auth.ts:1-40]` |
| N6 | 首启原生欢迎窗 / Platform 账号登录 | 我们是多 provider 产品（sub2api、第三方中转），dsh 自己的 onboarding 已经覆盖 API key/登录；再造一个原生欢迎窗会分裂凭据入口，并引入 Electron 的 account 后端与 cookie 合并逻辑。`[已验证: apps/desktop/src/welcome-window.ts:13-46, apps/desktop/src/welcome-backend.ts:60-120]` |
| N7 | 把 `dsh` CLI 命令安装到 PATH | 会改用户 PATH、可能与用户已有 `dsh` 冲突；我们的运行时是私有且可按版本漂移的，外部命令指向哪个版本会成为长期支持负担。官方能做是因为它把运行时物化到固定位置。`[已验证: apps/desktop/src/command-management.ts:1-40]` |
| N8 | 随包物化运行时 / in-process boot（`runProfile` + `resolvedProfile`） | 上一轮已定：会消灭"用户可停任意 dsh 版本"这一核心差异，并承担再分发、签名、体积、跨平台构建成本；本轮不重新论证。`[已验证: .agents/notes/implemented/architecture/2026-09-24-official-desktop-0-1-7-positioning-and-adoptions.md]` |
| N9 | `__DSH_HOST_PATHS__` 真实路径引用 | WebView2 没有 `webUtils.getPathForFile` 的等价物；拖放/粘贴的 `File` 拿不到真实路径。可以伪造路径字符串，但会把错误路径塞进 `@` 引用（比上传更糟）。A1 只恢复拖放，**不**承诺路径引用。`[已验证: apps/desktop/src/preload-app.ts:82-84, packages/client/ui-conversation/src/client/apply.ts:496-520]` |
| N10 | 产品分析/遥测与崩溃上送 | 与"零 secret、只写本机证据"冲突；我们保留本地证据目录与崩溃转储即可。官方 analytics 开关与 Platform 绑定，不适合外部壳。`[已验证: apps/desktop/src/main.ts:408-417]` |

---

## 5. 事实标注

### 5.1 `[已验证]`（本轮实际读到的源码/命令）

| 事实 | 证据坐标 |
|---|---|
| 官方 HEAD/版本 | `git -C /srv/deepseek-harness log --oneline -3` → `687f282e86`；`apps/desktop/package.json` version `0.2.1-rc.2` |
| 官方桌面栈 | `apps/desktop/package.json`：`electron ^44.7.0`、`electron-updater ^6.8.9`、`main: lib/main.js` |
| 窗口/标题栏 | `apps/desktop/src/main.ts:208-249`、`src/windows-layout.ts:4`、`src/preload-windows.ts:8-70`、`src/preload-platform.ts:10-37` |
| 页面契约消费方 | `packages/client/ui-layout/src/client/AppFrame.module.css:26-54`、`packages/client/ui-dockkit/src/components/FloatLayer.tsx:90-94`、`packages/client/ui-primitives/src/overlay-top-margin.ts:12`、`packages/client/ui-sidebar/src/client/SidebarRoot.module.css:89` |
| 菜单/快捷键 | `apps/desktop/src/preload-menu.ts:10-113`、`src/keyboard.ts:31-125`、`src/keybindings.ts:10-30`、`src/main.ts:950-985` |
| 启动握手 | `apps/desktop/src/web-document.ts:10,32`、`apps/web/src/main.ts:6-38`、`apps/desktop/src/main.ts:690-703` |
| 失败恢复 | `apps/desktop/src/fatal-recovery.ts:34-120`、`src/crash-report.ts:30-52`、`src/main.ts:1104-1117` |
| 更新 | `apps/desktop/src/update-coordinator.ts:24-31,60-92`、`src/update-schedule.ts:20-105`、`src/update-journal.ts:11-75`、`src/update-presentation.ts:12-52`、`src/update-attention.ts:25-70` |
| 原生能力 | `src/preload-app.ts:76-100`、`src/main.ts:241-249,269-300,684-688,1072-1102`、`src/tray.ts:10-60`、`src/background-notice.ts:22-70`、`src/quit-confirmation.ts:26-96`、`src/browser-guests.ts:15-40` |
| Web 侧拖放/路径 | `packages/client/ui-conversation/src/client/apply.ts:109-112,486-529`、`packages/client/ui-conversation/src/client/locales.ts:35-37` |
| Web 侧外链 | `packages/client/ui-primitives/src/markdown/render.tsx:552-568`、`packages/client/ui-chat/src/client/apply.ts:265-270`、`packages/client/ui-chat/src/chat-settings.ts:59,76` |
| Tauri 拖放默认 | `~/.cargo/registry/.../tauri-runtime-2.11.3/src/webview.rs:515,622-627`；`wry-0.55.1/src/webview2/mod.rs:150-155` |
| wry 新窗默认 | `~/.cargo/registry/.../wry-0.55.1/src/webview2/mod.rs:793-795` |
| 我方缺口 | `src-tauri/tauri.conf.json:12-31`（无 `dragDropEnabled`）、`src-tauri/src/lib.rs:4638-4645`（无导航拦截）、`src-tauri/resources/ui/shell-chrome.js:1781-1829`（无加速键） |
| 我方优势 | `src-tauri/src/lib.rs:507-540`（通知）、`README.md:63`（代理）、`plugins/preinstalled/`（预装）、`README.md:300-303`（私有 DSH_HOME） |
| 只读自证 | `git -C /srv/deepseek-harness status --porcelain` 输出为空；本轮未在官方目录执行构建/测试 |

### 5.2 `[假设]`（未验证，且**未**作为采用清单的依据）

| 假设 | 为什么没验证 | 影响 |
|---|---|---|
| A-1 Windows 实机上，`dragDropEnabled:false` 后 WebView2 的 HTML5 drop 行为与 Linux/文档一致 | 本机是 Linux，Windows GUI 需另一台机器；只能依据 Tauri 源码注释与 wry 实现推理 | A1 的**问题**已验证；修复效果需 Windows 设备验收（已写进验证方式），不改变"先修"的判断 |
| A-2 我们的壳在 Windows 上确实"吞掉"拖放，而非 WebView2 版本差异下的部分可用 | 同上 | 若实机不符，A1 仍应落地（默认值语义由 Tauri 保证），只是收益缩小 |
| A-3 `window.open` 在 WebView2 + wry 下确实被 deny（不是被 Tauri 另接） | 未跑 Windows 实机；wry 源码显示无 handler 时 `SetHandled(true)` | A2 的机制已验证；若实机另有默认放行，则 A2 变成"把新窗导到系统浏览器"的显式策略，仍值得做 |
| A-4 点击壳菜单在当前 WebView2 里会让页面编辑器失焦 | DOM 标准行为 + 我方无恢复逻辑；未在真实 dsh 编辑器上复现 | A3 的收益估计；不改变"补焦点恢复"的低风险性 |
| A-5 存在英文用户/需要英文壳 UI | 无用户数据 | 只影响 A5 的优先级排序，不影响正确性 |
| A-6 官方签名/强制更新/安装器在真实设备上的行为 | 未运行官方安装包（只读源码） | 本轮不采纳相关机制，无决策依赖 |

**纪律声明**：以上 `[假设]` 均未进入 §3 的"为什么值得"论证；§3 的每一条推理链都能落到 `[已验证]` 的文件行。

---

## 6. 与 2026-09-24 结论的差异（0.1.7-rc.2 → 0.2.1-rc.2）

上一份定位 note 的结论（独立产品面、不重写 Electron、不打包运行时、不做强更）仍然成立，但以下事实需要更新：

1. **官方桌面端不再只是"in-process boot + 三个宿主能力"**：0.2.1 增加了 `project-manager`、`update-coordinator/schedule/journal/presentation/attention`、`tray`、`keyboard/keybindings`、`welcome-window`、`browser-guests`、`platform-view`、`crash-report`、`fatal-recovery`。`[已验证: apps/desktop/src/ 66 个 ts 文件]`
2. **官方用 profile 名 `desktop` 启动**（`runProfile({profile:'desktop', resolvedProfile})`），但 profile bundles 取自 `PROFILE_TEMPLATES.web`；上一份 note 的"同一套 profile bundle"与"desktop 名门控"两条并不矛盾。`[已验证: apps/desktop-host/src/index.ts:27, apps/desktop/src/project-manager.ts:29-31]`
3. **"官方明确不做完成通知"在 0.2.1 仍成立**：全仓 `new Notification` 只出现在更新就绪提醒。`[已验证: apps/desktop/src/update-attention.ts:43]`
4. **`data-platform` 仍然只被 darwin 规则消费**：0.2.1 新增的是 `data-windows-titlebar` 与 `data-fullscreen` 消费方，注入 `data-platform='win32'` 依旧没有收益（上一轮的判断保持）。`[已验证: grep data-platform packages/client → 仅 darwin]`
5. **上一份 note 的 17 条不确定性**本轮只按需复核了与采用项相关的部分（拖放、外链、菜单/键位、更新取证、语言）；官方安装包签名/强制更新/安装器、Python/Office 载荷、NSIS 事务化等未重新验证，仍是覆盖缺口，不在本轮范围。

---

## 7. 后续（不在本轮范围）

- **Windows 实机验收**（A1/A2/A3）：拖放、外链、菜单焦点与加速键，需在装有 0.20.0 正式版的机器上跑一遍；验收清单写进 PR 描述与看板卡。
- **壳自更新/签名**（G6）：需要证书与发布链，仍是结构性缺口；本报告只确认官方路径，不提出实施。
- **任务感知退出**（G7）：等上游提供公开契约（CLI 子命令或 HTTP/RPC）后再评估；在那之前不做假的"任务感知"。
- **看板卡**：`调研官方 dsh 0.2.1-rc.2 桌面客户端并产出可执行采用清单`（in_progress → done），后续 5 条采用项各建一张 todo 卡（验收后再动代码）。

---

*本报告只读官方源码，未修改 `/srv/deepseek-harness`；我方仓库本轮只新增本文档、Index 登记一行与一篇 Agent Note。*
