# Agent Note: webview-passthrough-drag-drop-and-external-links

Status: implemented

## Problem

页面里两件事被桌面壳吞掉而**没有任何报错**：① Tauri 默认 `drag_drop_handler_enabled=true`，会挂原生拖放处理器并对 WebView 调 `SetAllowExternalDrop(false)`，于是 dsh 输入框的"把文件/图片拖到这里"在壳内静默失效；② wry 在没有 new-window handler 时对 `NewWindowRequested` 直接 `SetHandled(true)`（deny），页面里 `window.open` / `target=_blank` 的 http(s) 链接点了没有任何反应。两者都不会冒泡成可见错误，用户只会以为"这个功能本来就没有"，所以修复必须同时把"会变红"的门禁钉进 `npm test`，否则下一次配置/代码漂移无人察觉。上一轮的官方客户端对比调研（`.agents/notes/implemented/architecture/2026-10-22-official-client-adoption-review-0-2-1.md`、`docs/2026-10-23-official-client-adoption-review.md` 的 A1/A2）把这两条定性为 S 级缺口，本 note 记录实施后的现实。

## Decision

**A1（拖放）**：主窗口（`src-tauri/tauri.conf.json` 的 `app.windows[0]`，label `main`）设 `"dragDropEnabled": false`，把拖放交还 WebView2 / WebKitGTK 的 HTML5 实现。壳从未监听 `onDragDropEvent`（全仓 grep 过），关掉原生处理器零损失。**不**注入 `__DSH_HOST_PATHS__`、**不**伪造路径：拖入文件仍是上传附件，`@路径` 引用不支持（WebView2 没有 Electron 的 `webUtils.getPathForFile`）。

**A2（外链）**：chrome（`src-tauri/resources/ui/shell-chrome.js`）覆写 `window.open`，并把点击意图收敛到纯函数 `linkActivationIntent(kind, event, href, target, protocol)` 后以**冒泡阶段**监听 `click`/`auxclick`：命中 `a[href]` 且（`target=_blank` 左键 | 中键 | Ctrl/Meta+点击）时，**延后一拍**（`setTimeout(0)`）再看 `event.defaultPrevented` —— 页面自己接管了就不动，没接管才走壳。**右键不拦（2026-10-25 回归修复）**：`auxclick` 只认 `button===1`（中键），右键 `button===2` 在意图层直接被忽略，且 chrome 不在 `window`/`document` 上监听或改写 `contextmenu` —— 页面/WebView 自己的右键菜单原样出现，壳不抢"在新标签页打开/复制链接"这类菜单项。`window.open`：http(s) → 桥；`about:blank` 原样交回原生实现（OAuth 类"先开空窗再写 location"的形态，wry 无 handler 时本就开不出窗口，放行不增加能力面）；其余 scheme 拒绝并经 `POST /log` 留痕。新动作 `open-url` = IPC `open_url` + 桥 `POST /shell/open-url`，**不进**危险动作表、不经确认窗。同窗口内导航**不拦**（只处理"会开新窗口"的点击）：把同源/内网链接交给系统浏览器会打开带 token 的 dsh 页面本身。

**安全边界在 Rust**（页面只交出 URL 字符串，`shell` 执行能力永不下放）：唯一判定点 `validate_external_url` 只放行 `http:`/`https:`，拒绝控制字符与空白（换行可走私额外参数给系统处理程序）、userinfo、反斜杠、超长（>2048），并要求 `//authority`（`https:///path`、`http:host` 直接拒，不猜浏览器语义）；通过后**原样**返回 URL。`open_external_url`：Windows 用 `ShellExecuteW("open", url)`（新增 `Win32_UI_WindowsAndMessaging` feature 提供 `SW_SHOWNORMAL`；返回值 >32 才算成功），Linux `xdg-open`、macOS `open`，全程不经 `cmd`/shell 拼命令。会话日志只记 `scheme://host`（query 可能带一次性凭据，日志是长期文件），拒绝记 `<原因>`。

**门禁**：新增 `scripts/test-shell-passthrough.mjs` 并进 `npm test` 链（README/CONTRIBUTING 的"全量 N 套"随之 25→26，`test-manifest-consistency` 校验链长与文档数字一致）。它断言 **43 条**：A1 三态（main 窗口 `dragDropEnabled===false`、dev 配置不得自带 `app.windows`——`--config` 数组整体替换会静默丢掉该标志、chrome/lib.rs 无 Tauri drag-drop 依赖）+ A2 判定值（http/https 放行且原样、file:/javascript:/data:/ms-*: 拒、`about:blank` passThrough、userinfo/换行/空 host 拒）+ **A2 激活意图**（新导出的 `linkActivationIntent`：`auxclick{button:1}` 必须走 open-url；`auxclick{button:2}` 无论 target 与 Ctrl/Meta 都必须忽略；`click` 只认主键且仅 `_blank`/Ctrl/Meta 触发；未知事件类型保守忽略；`window`/`document` 无 contextmenu 钩子）+ 接线（ACTIONS、chrome 锚点、lib.rs 桥分支/IPC 注册/`validate_external_url`/`ShellExecuteW` 与 `xdg-open`、`/shell/open-url` 不在危险表、两侧留痕）。自带 **3 个变异体**（只在 `mkdtemp` 里造副本，绝不改仓库）：`dragDropEnabled` 改回 true ⇒ `a1-dragdrop-disabled` 必须红；chrome 的 scheme 白名单加 `file:/javascript:` ⇒ `a2-reject-file-share` 必须红（`file:///…` 会被 empty-host 挡住，结构上看不见白名单放宽，所以负例必须带 authority）；把 `auxclick` 的 `button !== 1` 判断去掉 ⇒ `a2-auxclick-right-ignored`（及 `a2-auxclick-right-modifier-ignored`）必须红 —— 这条变异就是 2026-10-25 实机回归的负向对照。Rust 侧另有 `external_url_tests` 三个单测由 CI 的 `cargo test --lib` 执行（本机 WSL 的 host 目标编不了 `libdbus-1`，本地用"机械抽取 + `rustc --test`"跑过，并把白名单放宽注入 ⇒ `only_http_and_https_pass` 变红）。
## Alternatives considered

**capture 阶段抢先 `preventDefault()` 再走桥**（调研文档的原始写法，也是官方客户端思路）：capture 监听器先于页面自己的 handler 执行，而 dsh 默认把聊天链接导到**侧栏浏览器**（它自己会 `preventDefault`）——两边都动作就是"系统浏览器 + 侧栏面板"双开。改成冒泡阶段 + 延后一拍检查 `defaultPrevented` 后，页面接管了就不动；而 wry 本来就把新窗口拒成空操作，所以不需要靠 `preventDefault` 阻止导航。

**在 Rust 侧给 wry 装 `on_new_window`（或 Tauri 的 `on_new_window` builder）**：需要在窗口构建阶段接线、能力面更大，而且只能拿到"新窗口请求"这一个入口；我们只想要"交系统浏览器"一件事，放在已经注入所有页面的 chrome 里更小、且能被纯 Node 门禁测到判定函数。

**用 `cmd /c start <url>` 或 `rundll32 url.dll,FileProtocolHandler <url>` 打开**：前者把页面给的 URL 交给 shell 解析（命令行注入面），后者是未公开行为；`ShellExecuteW` 直接吃 URL 字符串，没有拼装面。代价是补一个 windows crate feature（`Win32_UI_WindowsAndMessaging`）。

**对非 http(s) 的 `window.open` 原样交回原函数**：`javascript:`/`file:` 会被当成页面动作尝试，且违背"其它 scheme 必须拒绝并留痕"的安全边界；只有 `about:blank` 作为唯一例外被放回原生实现。

**不覆盖 `window.open`、只监听 click**：dsh 与设置页/更新页用 `window.open` 开新窗口的路径仍会被 wry 静默 deny —— 那是 A2 的另一半受害面。

**用 Tauri 原生 `onDragDropEvent` 把文件塞回页面替代关掉处理器**：跨进程拿不到 `File` 对象，dsh 附件链路收的是 DOM `File`，伪造只会把"拖放坏了"换成"拖放看起来好了但附件是假的"。
## Consequences

收益：两处静默失效恢复可用（拖放回归 WebView HTML5、外链交默认浏览器），外链的 shell 能力边界被钉成"页面只给 URL + Rust 唯一判定点"，且两条门禁都在 `npm test` 里、各自带变异体自证会变红。代价与义务：① `/shell/open-url` 是新的桥 POST 端点（非危险动作）——若以后要求确认窗，必须三处同改（危险表 + 执行分支 + chrome 的 `confirm: true`，契约测试会双向核对）；② chrome 现在覆写 `window.open`，若将来 dsh 的 OAuth/支付类流程需要**应用内**窗口，会被导到系统浏览器（当前 dsh web 没有这种流程，属于显式取舍）；③ 同窗口内导航仍不拦，"整站留在系统浏览器"没做；④ 拖放修复依赖 WebView2 版本行为，`dragDropEnabled:false` 是 Tauri 文档口径，**Windows 实机效果未在本机验证**（WSL 无 WebView2/Linux GUI 会话）：需 Windows 实机把 1 张 PNG + 1 个 `.md` 拖到输入框（期望出现附件缩略图/上传附件，且页面不导航）、点设置页帮助链接与聊天外链（期望默认浏览器打开）、**对聊天里的 `target=_blank` 外链点右键（期望先出现右键菜单、浏览器不被打开；菜单里选"复制链接"可用）与中键（期望恰好打开一次）**，以及构造 `javascript:alert(1)` 链接点一下（期望无反应 + 会话日志出现 `open-url rejected`）。CI 覆盖：`npm test` 全量（本机已跑绿，`test-controls` 因脏树 SKIP）+ 本机 windows-target `cargo check`/`clippy -D warnings`；host 目标的 `cargo check`/`cargo test --lib` 因本机缺 `libdbus-1` 只能由 CI 的 ubuntu job 判定。

