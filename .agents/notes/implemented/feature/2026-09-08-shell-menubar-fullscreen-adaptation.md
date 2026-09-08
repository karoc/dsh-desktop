# Agent Note: shell-menubar-fullscreen-adaptation

Status: implemented

## Problem

壳注入的 36px 固定菜单栏（z-index 2^31-1）遮挡第三方插件全屏页（position:fixed;inset:0，如预装 dsh-kanban 看板）：顶部信息不可见、右上角按钮被壳窗口三键盖住难点。壳原有的 html padding-top 推挤只作用于普通流布局，fixed 浮层相对视口定位、不受 padding 影响。逐插件改"让出 36px"不可行（第三方插件无法修改），必须壳侧通用适配。

## Decision

shell-chrome.js 新增「全屏浮层自适应」（FULLSCREEN_PROBE_MS=800ms 轮询）：在菜单栏下方 48px 的两条采样点用 document.elementFromPoint 探测，向上找 position:fixed 且覆盖视口 ≥90% 的祖先（壳自身不计；壳内 modal 打开或 document.hidden 时跳过）；命中即 host.classList.add('fullscreen-hidden') —— host pointer-events:none、.bar translateY(-100%)（0.18s transition），全屏页顶部完全露出可点；浮层关闭探测不命中即自动恢复。顶缘 4px .edge-strip 悬停条**常驻**（不按状态切 display/pointer-events，否则收起瞬间把手在静止鼠标下重新出现触发合成 mouseenter → 无限显示↔隐藏循环，Chromium 实测），mouseenter 唤出菜单栏，scheduleRehide 在无菜单/弹窗打开时 ~3s 自动收起（直接 add class，不能走 setFullscreenMode(true) —— 状态未变会短路）。CSS 只允许 :host(.cls) 函数式选择器（:host.cls 复合式在 Chromium 不匹配，实测不生效）。另向 dsh 远程页 :root 注入 --dsh-shell-menubar-h:36px（SHELL_BAR_H 常量），供「顶部悬浮但非全屏」UI 显式 padding-top 适配（纯 dsh 无壳回退 0）。插件零改动：预装 dsh-kanban 等 bundle 保持原样。回归：scripts/test-shell-chrome.mjs 加字符串断言；scripts/verify-fullscreen-adaptation.mjs（真实 Chromium 桩页 + 真实 chrome 源码，需 playwright，不进 npm test）覆盖收起/唤出/自动收起/无假阳性五组断言。本轮顺带：预装 kanban 同步至 npm latest 0.2.6（tarball 流，README 精简、技能资产随包）+ sync-resources 顺带把滞后的 resources/manager/server-manager.mjs 副本对齐真源（cmp 一致）。
## Alternatives considered

1) CSS 变量契约 + 逐插件改（--dsh-shell-menubar-h 让 .kb-overlay padding-top）：用户明确否决 —— 第三方插件改不动，不可扩展。2) documentElement transform: translateY(36px) 让所有 fixed 元素随文档下移：会改变 fixed 的 containing block，壳自身（host 在 body 内）也跟着下移，且 100vh/sticky/滚动区语义全变，风险过高。3) Webview 整体内嵌（webview bounds y=36 + 独立透明浮层窗画菜单栏）：Tauri 双窗口架构改动过大，Windows 侧视觉/聚焦/Aero 行为无法在本环境验证。4) 按状态切换悬停条 display：实测触发合成 mouseenter 无限循环，改为常驻。
## Consequences

代价：全屏浮层打开时壳菜单栏不可见（悬停顶缘 4px 唤出，3s 无操作自动收起；菜单/弹窗打开期间不收起），全屏页内部通常有自己的关闭按钮，语义上与浏览器 F11 隐藏菜单栏一致；探测为启发式（覆盖 ≥90% 视口），极少数不覆盖采样点的全屏浮层可能不触发（此时 --dsh-shell-menubar-h 契约仍是兜底）。收益：任何第三方插件全屏页零改动自动让位；顶缘常驻条保留了壳菜单与窗口三键的完整可达性；误判（false positive）最坏是菜单栏收起、仍有把手，fail-soft。遗留：真实 Windows WebView2 视觉/交互需用户在新构建上亲测（本环境仅 Linux Chromium 桩验证）；探测间隔 800ms 的收起延迟在慢机器上可感知；预装 0.2.6 同步后，桌面应用内 kanban 需随下次发版/控制台更新生效。

