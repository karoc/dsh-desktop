# Agent Note: shell-tray-session-aggregate

Status: implemented

## Problem

壳的通知全是边沿驱动（会话开始/结束/等待交互时弹 toast）。用户把窗口藏到托盘后，除了"刚才有没有弹过"之外没有任何状态感知——不知道哪个会话在跑、哪个在等他。托盘 tooltip 自始至终是产品名。桌面壳相对浏览器版唯一不可替代的能力位就是常驻托盘，此前完全空着。Super-agent 文章第 4 节的判据（面向人的交互应由系统统一出口、只在需要人行动时说话）指向这里，但它只给原则，落点由壳自己选。

## Decision

**数据源与触发源是两件事，这是本功能的核心教训。**

`pendingInteraction` **不在** `sessions.list` 的快照行里：`SessionSummary`（`packages/api/session-controller/src/client/sessions/service.ts`）只有 `id/title/displayTitle/cwd/parentId/origin/running/blank/updatedAt/projectionValues`，没有 `pendingInteraction`，也没有 `completionUnread`。它们属于 `uiSession.sessionStatus`（`packages/client/ui-session/src/client/index.ts`，`SessionStatus { running, pendingInteraction, completionUnread }`），由 cordis service `uiSession` 公开暴露，其他内置插件正是这么读的。

因此插件 `inject: ['sessions', 'connection', 'uiSession']`，状态一律经 `statusOf(id)` 读。**更关键的是必须订阅它**：`scan()` 原先只挂在 `sessions.list.subscribe` 上，而会话进入"等待审批"**不改变列表的任何一行**——scan 从不被唤醒。表现就是橙点已出现、tooltip 不变、通知不发、日志里连 `suppressed` 都没有（`show()` 根本没被调用）。现在 `sessions.list` 与 `uiSession.sessionStatus` 两个 observable 都驱动 `scan()`，dispose 时一并取消。

完成态用 **`completionUnread`**（"结束后未被查看"），不用 `completed`（后者只表示"结束时未被选中"，选中的会话永远不翻）。用户打开会话后该状态自动清除，托盘行随之消失，这正是产品要求。

聚合条目为 `{ kind, title }`，按 `待处理 > 运行中 > 完成` 排序；文本**内容**变化时才 POST 桥的 `/state`（title 参与去重 key，改名会刷新）。壳侧 `build_tray_tooltip` 拼多行：第一行产品名，之后 `● 待处理 · 标题` / `▶ 标题` / `○ 标题`，`\r\n` 分隔；`apply_session_aggregate` 以文本为去重键写 `static SESSION_AGGREGATE: Mutex<Option<String>>`，再 `app.tray_by_id("dsh-tray").set_tooltip()`。全 0 时只回产品名，不留"0 个运行中"式文字。

三条负向保证：**subagent 行不产生工作/完成条目**（父回合已覆盖其生命周期，与 toast 抑制同源），**但 subagent 的待处理交互仍单独成条**（dsh 按发起方 session 键控审批/提问帧，人必须回答它），**blank 行一律不计**。

**Windows 焦点**：通知抑制依赖"用户是否真的在看 UI"，而三个看起来该用的信号全部不可靠——`document.hasFocus()` 在 WebView2 里窗口被推后仍返回 true；Tauri 的 `is_focused()` 恒为 false（连带到前台也不变）；`WindowEvent::Focused(false)` **不随窗口后置触发**。现在是 `GET /window/focused` 用 Win32 `GetForegroundWindow` + `GetWindowThreadProcessId` 与自身 pid 比较，页面每 5 秒轮询（事件推送保留但不可依赖）。焦点判定**只认壳的答案**；全局 `window.__DSH_SHELL_FOCUSED__` 缺失时才回退旧的 document 检查，避免静默静音全部通知。

**硬约束（源码级确认）**：`NOTIFYICONDATAW.szTip` 是 `[u16; 128]`，tray-icon 0.24.2 的 Windows 实现用 `min(128)` **静默截断**。壳侧按 127 字符预算逐行收敛，放不下时**整行丢弃**而非截半行。tooltip 是纯文本，**无法着色**——状态只能靠符号形状区分，做不到真正的橙点/绿点。`/state` 与 `/window/focused` 都登记为非危险端点，沿用既有桥准入（POST 必须带 `X-DSH-Shell`）。

## Alternatives considered

**只订阅 `sessions.list`（原实现）**：最省事，但待审批不改变任何列表行，scan 永不触发，功能等于不存在。这是本次排查最久的根因，也是"数据读得到 ≠ 代码会去读"的典型。

**React 探针组件读 `useSessionStatus`**：`sessionStatus` 的 root hooks 只通过 `slots` 暴露给 React 层，非 React 插件拿不到（`SlotRegistry` 的 root binding 是 private）。要写探针就得在纯 JS bundle 里引入 React 运行时，成本与维护面都不划算；`inject: ['uiSession']` 直接解决了同一问题。

**改窗口标题（`window.set_title`）**：窗口 `decorations:false`、顶栏自绘，系统标题栏不可见，改标题只影响 alt-tab 文字，感知太弱。

**顶栏角标**：语义上最贴近"标题栏状态"，但要新增壳→WebView 推送通道，而 `shell-chrome.js` 有过多次注入期阻断事故（顶栏整体消失、logo 不渲染），没有真机无法验收，推迟。

**固定间隔轮询上报聚合**：稳态时持续打桥（该插件曾因"每 3s 一次桥请求"被性能审计点过名），改为内容变化触发后稳态零流量。

**用 `updatedAt` 判停滞**：否定——`updatedAt` 是持久化消息时间（`list.ts` 的 `updatedAt()`，注释 "durable message time used for list ordering"），模型长 reasoning 期间不推进，当停滞判据必然误报。

**靠 `WindowEvent::Focused` 推送焦点**：实测不触发（见上），已降级为辅助。

## Consequences

托盘从"只有图标"变成可读会话列表，用户不打开窗口即可判断要不要回去处理；通知不再被误抑制。边界与代价：

① 页面被彻底卸载（而非隐藏到托盘）时不会主动清零，靠下一次加载的 baseline 上报自愈。

② 聚合依赖 `uiSession.sessionStatus` 与 `SessionSummary` 的字段语义；上游若改语义会**静默降级为不计入**而不是报错（`shapeOf` 的 `unrecognized` 兜底只覆盖形状变化，不覆盖语义变化）。

③ **焦点判定依赖 Win32 前景窗口**：多显示器/虚拟桌面下 `GetForegroundWindow` 返回最后一个前台顶层窗口，通常正确；但任何"比窗口更前"的弹出层（如本壳自己的确认窗）都会让主窗口判为失焦——这是有意的保守（宁可少打扰）。

④ **验证手法（可复用）**：UIA 读任务栏 `AutomationId=NotifyItemIcon` 按钮的 `Name` 即 tooltip 文本；必须在该 PowerShell 进程先 `SetProcessDPIAware()`，否则 `BoundingRectangle` 与坐标错位。另外**前台切换无法自动化**验证——Windows 前台锁定使 `SetForegroundWindow` 与最小化都不改变 `GetForegroundWindow`（实测前台 pid 恒等于 dev pid），焦点行为只能由人工切换窗口确认。

⑤ 顶栏角标仍未做（Phase 2），需要真机验证注入时序。
