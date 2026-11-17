# Agent Note: manager-bounded-auto-recovery

Status: implemented (#284, awaiting merge + Windows acceptance)

## Problem

原 D1 决定（2026-09-09）是「只检测 + 取证 + 提示，**绝不**自动重启」：重启会覆盖正在 hunt 的复现现场。代价是 manager 一崩，dsh 就停在启动页，必须由用户手动点「重启服务」/「重试」——对"打开电脑就想用"的场景，这是一个必须有人值守的失败态。

## Decision

**取证先于重启，然后做有界恢复。**

- 顺序是硬约束：`handle_manager_exit` 先跑完 `collect_evidence`（manager.log 尾 / 壳会话日志尾 / node report / WER / 孤儿进程 → `<runtime>/reports/manager-crash-<ts>-gen<N>/`），**之后**才决定是否重启。重启永远不早于取证。
- 策略是纯函数 `manager_guard::auto_restart_decision(now, prior_exits)`：同一壳会话内 `AUTO_RESTART_WINDOW_SECS = 600` 窗口里，**首次**意外退出 ⇒ `Restart`（自动重启一次）；同窗口内**第二次** ⇒ `Stop`（停止自动重启，交回用户）；窗口过去后再崩视为新事故 ⇒ `Restart`。时间戳 `>= now` 一律忽略，所以调用方把当前退出放进列表也不会把自己判成"窗口内已崩过"。
- 状态只活在壳进程内（`ManagerGuard.unexpected_exits`）：壳重启 = 新事故序列。`ManagerExit.auto_restart` 随 `manager-exit` 事件与 `/shell/status.lastManagerExit.autoRestart`（`restarted`/`stopped`）暴露给启动页。
- 文案规则：横幅只陈述做了什么，**不得承诺已修复**——`recovery_note()` 是唯一定义点，Rust 单测断言两种文案都不含「修复成功」「已修复。」「问题已解决」，Restart 必须含「不代表已修复」，Stop 必须含「停止自动重启」「人工」。证据目录入口沿用既有的「打开证据目录」按钮（`#opendata` 变成证据目录链接）。
- 自动重启走既有 `restart_server_from(app, "auto-recovery", "/auto-restart")`（延迟 2s，让启动页先画出横幅/证据入口；壳正在退出时不再重启），因此日志里始终能回答"这次重启是谁要求的"。

## Alternatives considered

**无条件自动重启**：会形成崩溃-重启循环并把现场全部覆盖，明确拒绝。

**把 10 分钟窗口持久化到磁盘**：新壳会话就是新事故序列；持久化只会让"用户手动重启壳之后"仍被旧窗口压制，弊大于利。

**用 manager 自己的 supervisor 做重启**：manager 崩溃时它自己的进程已经没了，唯一持有 `Child` 句柄、能拿到退出码与取出证的是壳，所以只能壳侧做。

**把横幅做成独立窗口/托盘气泡**：启动页本来就在这一时刻显示（`navigate_back_to_launcher`），复用它的 `showActionable` 成本最低且不新增 UI 通道；lead 只授权了 `applyShellStatus()` 附近的渲染分支。

## Consequences

- 代价：一次崩溃后会自动多一次重启（日志噪声 + 可能掩盖"每次启动都崩"的节奏），因此第二次必须停手；窗口内的崩溃计数不跨壳进程。
- 换来：常见单次崩溃从"必须人工点重启"变成"2 秒后自愈 + 横幅说明 + 证据入口"，同时保留第二次崩溃的人工介入点。
- 覆盖缺口：端到端用例（manager 启动即退出 ⇒ 第 1 次自动重启 + 横幅；10 分钟内再失败 ⇒ 不再重启）需要 Windows 真机，本轮只交策略单测（窗口边界/超窗/时钟偏移）、文案单测与 `scenario 39` 静态契约；真机配方写在 #284 描述里。
