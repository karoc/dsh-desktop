# Agent Note: windows-dev-shell-link-acceptance-cdp

Status: implemented

## Problem

看板卡「待 Windows 实机验收：外链右键只出菜单（不打开浏览器），中键恰好打开一次」要求真实 WebView2 行为验证，但 WSL 没有 WebView2、UIA 无法注入目标链接、dsh 用户消息按纯文本渲染（`[x](url)` 不会变成 `<a>`）、模型回复不确定，而 WebView2 的 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量被 wry 的程序化 additional args 覆盖（实测 dev 构建的 webview 命令行里没有 remote-debugging-port）。没有可点击的 `<a target=_blank>` 就无法触发 `linkActivationIntent`，验收会退化成"看代码"。

## Decision

2026-10-31 用「本地 instrumented dev 构建 + CDP 真实输入事件」完成验收，配方固化如下（下次照做）：
1. 更新并构建：`D:\Dev\dsh-desktop-dev` 用 PowerShell `git fetch origin; git checkout -f -B main origin/main`（WSL 对 /mnt/d 只读，写操作必须走 Windows 互操作）；`npm install; npm run bundle:dev`。
2. 打开调试口：**只在 dev 树的 `src-tauri/tauri.conf.json`** 的 `app.windows[0]` 临时加 `"additionalBrowserArgs": "--remote-debugging-port=9333"`（tauri-utils 的 WindowConfig 字段，Windows 生效；写回时必须 UTF-8 **无 BOM**，PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM → tauri build 报 `unable to parse JSON Tauri config`），重建。
3. 安装/覆盖：停止 dev 壳后把 `target\release\dsh-desktop-dev.exe` 直接复制到 `%LOCALAPPDATA%\DSH Smoothly Desktop Dev\`（静默安装器对同版本会跳过覆盖，实测安装后 exe 时间戳不变），启动；`http://127.0.0.1:9333/json/version` 出现即 CDP 就绪。
4. 驱动：Windows 侧 node 24（全局 `WebSocket`）连 `/json/list` 的 page target；`Runtime.evaluate` 往**当前 dsh 页面**注入 `<a target=_blank href="http://127.0.0.1:${PORT}/hit/...">`（**不要 Page.navigate** —— 导航守卫会把非 live origin 弹回 dsh），用 `Input.dispatchMouseEvent` 发真实 right/middle 按下/抬起。
5. 断言四路证据：① 本地 HTTP stub 命中文件（右键必须 0 命中、中键恰好 1 次）② session.log 的 `bridge: /shell/open-url -> <origin>` 行数（右键 0、中键 1）③ 页面里 `contextmenu`/`auxclick` 事件计数（右键 1 个 contextmenu）④ 顶层窗口枚举：fresh launch 后 WebView2 进程**没有**可见顶层窗口，右键期间出现一个 `Chrome_WidgetWin_1` 276x256（菜单弹窗）——这是"菜单真的出现"的代理证据。
6. 收尾：revert 配置、重建干净、停止 dev 壳与 stub；验收期间打开的浏览器标签指向已关闭的本地 stub，需告知用户可关。
**实测结果**：右键 → hits 0、open-url 0、contextmenu 1、菜单窗口 276x256 出现；中键 → hits 1（829ms 内）、open-url 恰好 1。两条验收判据均通过。
## Alternatives considered

**纯 UIA 点击**：UIA 只能 Invoke 左键，无法发右键/中键；**SendInput 打到 UIA 找到的链接**：需要先把目标链接弄进页面，而注入只能靠 CDP/DevTools；**让模型回复 Markdown 链接**（模型回复会渲染成 `<a>`）：不稳定且污染会话；**用用户消息里的 Markdown 链接**：dsh 用户消息按纯文本渲染，实测 `[acc](https://example.com)` 原样显示，无锚点；**Page.navigate 到本地测试页**：壳的导航守卫会把非 live origin 弹回 dsh，注入链接必须留在当前页；**`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量**：被 wry 的程序化 additional args 覆盖，webview 命令行无该端口；**注册表 WebView2 策略 / 改宿主 exe**：侵入性强且需管理员，未采用。
## Consequences

买到：右键"不打开浏览器"与中键"恰好打开一次"在真实 WebView2 151 + 真实鼠标事件下有了可重复的四路证据，不再依赖用户手动点击；配方可复用为后续壳内交互（外链、桥、顶栏按钮）的真机验收底座。代价与边界：① 验收用的是临时加了调试口的 dev 构建（行为代码与发布版一致，只多一个 localhost CDP 端口），收尾已 revert+重建干净；② "菜单项"本身（在新窗口中打开链接/复制链接/检查）的点击行为仍未验证 —— 本轮只证明菜单出现且右键不抢跑；③ 全程不应抢焦点：截图方案在这台正在被用户使用的桌面上会抓到前台别的窗口（实测抓到浏览器/微信），所以用窗口枚举做菜单证据、不截图；④ CDP 期间不要 `Page.navigate`（导航守卫），也不要对用户桌面做 SendKeys/前台切换。

