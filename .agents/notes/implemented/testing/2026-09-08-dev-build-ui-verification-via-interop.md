# Agent Note: dev-build-ui-verification-via-interop

Status: implemented

## Problem

壳 UI 的遮挡/可点性这类"视觉现象"此前在技能里被定为 agent 无法远程确认（"最终视觉确认必须请用户亲测"），于是每次壳改动只能把验收整段推给用户，流程断在最后一环。用户明确要求：dev 版就是给 agent 做验证用的，agent 必须自己装、自己跑、自己验。

## Decision

建立了 WSL → PowerShell interop 的真实 WebView2 验证链，落地为 scripts/verify-dev-ui.ps1（-Action dump|shot|invoke|click|hover，Windows 侧执行、WSL 经 wslpath -File 调用）。实测成立的关键事实：① UIAutomation 能穿透 WebView2——DOM 按钮（新建会话/思磨力看板入口）与壳注入的菜单栏按钮、.edge-strip 悬停条（[Group] 显示菜单栏）都在 UIA 树里，BoundingRectangle 是物理像素，菜单栏收起时按钮 Y 为负（实测 -55），这就是"收起/恢复"的可断言判据；② PrintWindow(hwnd,hdc,2) 能在不抢焦点的情况下截 DWM 合成内容（WebView2 有效），截图写 D 盘后 WSL 侧 /mnt/d 只读可读、配 read_image 直接看；③ 真实可点性用 SetCursorPos + mouse_event 物理点击验证（脚本自动复位鼠标），同名控件用坐标区分——壳三键固定在右侧 x≈2495 起，取 x<2490 即页面自己的按钮。脚本保持纯 ASCII（中文用 [regex]::Unescape("\uXXXX") 构造），因为 PS 5.1 按 ANSI 解码无 BOM UTF-8 文件会把中文注释弄成 ParserError；[string]::Concat([char]...) 在 PS 5.1 抛 ArgumentNullException，改用 Unescape 或 +。本轮据此端到端验收了全屏浮层让位：看板打开→menubar Y=-55（收起）+ 看板标题可见(30,27)+关闭按钮(2417,18)；顶缘悬停→Y=0（唤出）；真实点击看板关闭按钮(2474,45)→页面关闭→Y=0（恢复）。流程固化为：dev 版 bundle:dev → 静默安装 /S → 启动 → verify-dev-ui.ps1 逐项断言。
## Alternatives considered

1) 继续把视觉验收交给用户亲测（原流程）：用户否决——dev 版就是给 agent 测试用的。2) 用 AppActivate/UIA SetFocus 把窗口置前后截全屏：实测失败（抛 InvalidOperationException，且截到的是遮挡在前的浏览器），放弃。3) Playwright 直连 WebView2 远程调试端口：dev 版未开 --remote-debugging-port，需要改壳加启动参数并承担端口暴露风险，成本高于 UIA 方案。4) 用 jsdom/Linux Chromium 桩页（scripts/verify-fullscreen-adaptation.mjs）：仍是合成环境，无法证明真实 WebView2 的 UIA/hit-test 行为——保留为快速回归，但不能替代真实窗口验收。
## Consequences

收益：壳 UI 改动可以自己闭环验收（本轮在真实 WebView2 上拿到了收起/唤出/真实点击三组硬证据），用户只需在最后做观感确认；技能里"必须用户亲测"那条已改写为"部分证伪"。代价与边界：验证依赖 Windows 侧已安装的 dev 版和真实桌面会话（无人登录/锁屏时 UIA 与截图不可用）；UIA 只暴露有 Name 的控件，纯图标按钮或 canvas 内容不可断言，需退回坐标点击；脚本会短暂移动鼠标（点击/悬停后自动复位），不适合在用户正在操作时高频跑；动效观感、多显示器/DPI 差异、真实拖拽手感仍必须用户亲测。

