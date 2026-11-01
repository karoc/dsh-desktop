# Agent Note: shell-tray-session-aggregate

Status: implemented

## Problem

壳的通知全是边沿驱动（会话开始/结束/等待交互时弹 toast）。用户把窗口藏到托盘后，除了"刚才有没有弹过"之外没有任何状态感知——不知道现在有几个会话在跑、几个在等他。托盘 tooltip 自始至终是产品名。桌面壳相对浏览器版唯一不可替代的能力位就是常驻托盘，此前完全空着。Super-agent 文章第 4 节的判据（面向人的交互应由系统统一出口、只在需要人行动时说话）正好指向这里，但它只给了原则，落点要由壳自己选。

## Decision

client 插件在每次快照扫描末尾计算聚合 `(running, pending, done)`，仅当数值**变化**时 POST 桥的新端点 `/state`；壳侧 `apply_session_aggregate` 写入 `static SESSION_AGGREGATE: Mutex<Option<(u32,u32,u32)>>` 并调用 `app.tray_by_id("dsh-tray").set_tooltip()`。计数规则有三条负向保证：**subagent 行不计入 running/done**（其父回合已覆盖该生命周期，与 toast 的抑制规则同源），**但 subagent 的 pendingInteraction 仍计入 pending**（dsh 按发起方 session 键控审批/提问帧，人必须回答它），**blank 行（新建未用）一律不计**。全 0 时 tooltip 回落到产品名，不让托盘常驻一条无信息量的文字；数值与上次相同则直接 return，因为 `set_tooltip` 每次都会让 Windows 重建 tooltip，快照级频率调用无意义。`/state` 登记为**非危险端点**（lib.rs 单元测试的放行列表），沿用既有桥准入：POST 必须带 `X-DSH-Shell` 头，CORS 只对允许的 Origin 回显。**顶栏角标本轮不做**：它要一条壳→页面的推送通道，而 chrome 有过多次事故史（顶栏整体消失、logo 不渲染），必须真机验证，登记为后续。
## Alternatives considered

**改窗口标题（`window.set_title`）**：窗口是 `decorations:false`、顶栏自绘，系统标题栏根本不可见，改标题只影响 alt-tab 里的文字，用户感知太弱，且会让任务栏标题随计数抖动。<br><br>**顶栏角标**：语义上最贴近"标题栏状态"，但要新增壳→WebView 的推送路径（现有注入只用于 nonce 与 chrome 脚本），并在 2011 行的 shell-chrome.js 里加渲染与降级；该文件历史上有过多起注入期阻断事故，没有 Windows 实机无法验收，因此本轮放弃。<br><br>**固定间隔轮询上报**：实现更简单，但稳态时持续打桥（通知插件此前已因"每 3s 一次桥请求"被性能审计点过名），改为变化触发后稳态零流量。<br><br>**用 `updatedAt` 做"最后活动时间"并据此判停滞**：查证后否定——`updatedAt` 是**持久化消息时间**（`packages/api/session-controller/src/list.ts` 的 `updatedAt()`，注释写明 "durable message time used for list ordering"），模型长 reasoning 期间根本不推进，拿它当停滞判据必然误报。候选 B 因此不能直接开工，只能先做零打扰取证。
## Consequences

托盘从"只有图标"变成一行可读状态，用户不打开窗口即可判断要不要回去处理。代价与边界：① 页面被彻底卸载（不是隐藏到托盘）时不会主动清零，靠下一次页面加载的 baseline 上报 `0/0/0` 自愈；② 聚合完全依赖 dsh `SessionSummary` 的 `running`/`pendingInteraction`/`completed`/`origin`/`blank` 字段，上游若改语义会**静默降级为计数 0** 而不是报错（`shapeOf` 已有的 `unrecognized` 兜底只覆盖快照形状变化，不覆盖字段语义变化）；③ **Rust 侧已完成实机验证**（2026-11-01，dev 版）：本机无 rustc/cargo，但 WSL2 interop 可用——`powershell.exe` 不在 PATH，须用绝对路径 `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`（`WSL_INTEROP` 未设置也能执行）。在宿主机 `D:\Dev\dsh-desktop-dev` 检出本分支构建出 `DSH Smoothly Desktop Dev_0.24.0_x64-setup.exe` 并 `/S` 静默安装（dev 与正式版 identifier 隔离，未触碰正在运行的正式版）。**验证手法可复用：用 UI Automation 读任务栏 `AutomationId=NotifyItemIcon` 按钮的 `Name`，它等于 tooltip 文本**（`Shell_TrayWnd` → Descendants 中按 AutomationId 筛，再按 Name 含 `Dev` 定位），不需要截图或 OCR；注意必须在该 PowerShell 进程先 `SetProcessDPIAware()`，否则 `BoundingRectangle` 与坐标会错位。六组输入全部符合预期：`{0,0,0}`→`DSH Smoothly Desktop Dev`（回落），`{2,1,0}`→`— 2 个运行中 · 1 个待处理`，`{0,3,0}`→`— 3 个待处理`，`{0,0,4}`→`— 4 个已完成`，`{1,1,1}`→`— 1 个运行中 · 1 个待处理 · 1 个已完成`，再回 `{0,0,0}` 回落。端到端链路亦确认：dev 壳启动后日志出现 `client/log aggregate 0/0/0` 紧跟 `client-ready (http)`。**遗留观察项**：UIA 读到的 Name 在非零时产品名出现两次（`DSH Smoothly Desktop Dev DSH Smoothly Desktop Dev — …`），全 0 时只出现一次；该图标位于 Windows 11 折叠区（`^`）内，悬停截图拍不到，真实悬停文本是否重复需人工展开确认——不影响功能，但若确为重复则是文案瑕疵；④ 顶栏角标仍未做，Phase 2 需要真机窗口验证注入时序。

