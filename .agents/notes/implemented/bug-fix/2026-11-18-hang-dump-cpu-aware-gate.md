# Agent Note: hang-dump-cpu-aware-gate

Status: implemented

## Problem

壳内挂起看护（`start_hang_watchdog`）在 3 次 miss（≈9s）后给 dsh web 抓**全内存 dump**（单份实测 313–663MB）。
2026-11-17 宿主正式版插件页首开卡 22.5s 的现场里暴露出两个问题：

1. 那次是**忙卡顿**（上游 dsh `metaOf→dictionariesOf` 同步扫盘，CPU ~60%、会自行恢复），不是死锁；抓 dump 没有诊断价值，只留下 663MB 文件。
2. 更糟的交互：`MiniDumpWriteDump` 会**挂起目标进程**，而 manager（#290）的 CPU-aware 耐心每 5s 采样一次子进程 CPU —— 若采样窗口整段落在挂起里，会读成 idle 而走 dump+restart，把 manager 的耐心抵消掉。

## Decision

dump 前先区分忙/闲，**只有 idle 挂起才抓 dump**：

- `src-tauri/src/web_dump.rs` 新增纯函数 `decide_hang_action(&HangFacts) -> HangAction`（`Wait / SkipAlreadyDumped / Dump / SkipBusy`），输入：miss 数、阈值、是否已为该 URL 抓过、CPU 窗口（`CpuWindow { cpu_ms, wall_ms }`）、闸门开关。顺序即安全边界：
  已抓过 ⇒ 跳过；未到阈值 ⇒ 等；闸门关闭 ⇒ 抓（负向对照）；采样不可用 ⇒ 抓（fail-open）；忙（≥`BUSY_STALL_MIN_RATIO = 0.1` 单核）⇒ 跳过；空闲 ⇒ 抓。
- 采样器 `sample_cpu_window(pid, 2.5s)`：win32 用 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + 两次 `GetProcessTimes`（kernel+user，FILETIME/100ns→ms）；非 Windows 返回 `None`。失败/无权限/进程已退出 ⇒ `None` ⇒ 判定 fail-open 照抓（真挂起现场不因采样失败而丢）。
- `src-tauri/src/lib.rs`：只改 dump 触发点 —— 到阈值后组装 `HangFacts`（解析 pid + 采样 2.5s），按 `HangAction` 执行：`SkipBusy` 记 `dsh web hang: busy stall (cpu N%) — skip dump, keep watching` 并**清零 miss**、**不标记已 dump**（之后真死锁仍能抓）；`Dump` 保持原 `dump_dsh_web` 路径不变。
- **manager 的 `dump-web` 请求路径不变**：请求方明确要求时照抓（`dump_dsh_web` 的认领/回执语义未动）。壳只在自己的自动触发上加闸门。
- 负向对照开关：`DSH_HANG_BUSY_GATE=off|0|false` 关闭闸门（启动时记 `busy gate=off (verification mode)`），供 `verify-hang-dump.ps1 -Action busy-control` 证明忙路径断言可失败；生产不设置。
- 真机验收脚本：`scripts/verify-hang-dump.ps1` 新增 `-Action busy`（先等过 30s 启动宽限，用 shell 自带 node + inspector 注入 20s 忙循环；断言**无新 dump**、日志有 `probe miss 3/3` 与 `busy stall … skip dump`、URL/pid 未变）与 `-Action busy-control`（同样忙循环，**必须产生新 dump**）。

## Alternatives considered

**只把壳的 miss 阈值从 3 抬到 5/6**：否 —— 忙卡顿 22s+ 仍会越过任何固定阈值，而且会拖慢真死锁的取证时机。
**由 manager 告诉壳“我在等，别 dump”**：否 —— 新增跨进程协议、且 manager 自身就用 dump 作为现场证据；壳应自己判断，不依赖 manager 相位。
**只在 dump 前询问一次进程 CPU（单次采样）**：否 —— 单次 `GetProcessTimes` 只是累计值，无窗口无法算比例；必须两次求差。
**采样失败时也不抓（fail-closed）**：否 —— 进程已退出/无权限时恰恰是可能的真挂起，fail-closed 会永久丢失现场；按原逻辑抓。
**在 manager 侧检测“dump 进行中”来抑制 CPU 误判**：否 —— 写域是 manager（#290 已合并），且壳侧闸门从源头避免无意义 dump，双保险但没必要先做 manager 侧。

## Consequences

买到的：忙卡顿不再产生几百 MB dump，也不再因 dump 挂起而把 manager 的 CPU 采样带偏；真死锁（idle）的 dump 时机基本不变（3 次 miss + 2.5s 采样）。日志新增 `busy stall` / `busy gate=off` 两种可判读行。

代价与边界：① 每次自动触发多 2.5s 采样（只发生在 miss 达阈值时，不影响正常探活）；② 采样窗口内壳的探活循环暂停 2.5s（同一线程）——期间 manager 仍在自己探活，不影响恢复决策；③ 忙判定阈值 10% 单核与 manager 的 `STALL_MIN_BUSY_RATIO` 同口径，但两边各自实现（一处 Rust、一处 JS），改口径要同改；④ `DSH_HANG_BUSY_GATE` 是一个验证/取证用后门，生产不设置时行为不变；⑤ 非 Windows 平台无采样 ⇒ 永远走“抓”（与旧行为一致）。

与 manager 的分工（#290）：**manager 决定“要不要重启”，壳决定“要不要留现场”**。manager 的 CPU-aware 耐心负责把自恢复卡顿从重启里救回来；壳的忙闲闸门负责不在忙卡顿上浪费几百 MB 和挂起时间。两者都用「≥10% 单核 = 忙」同一口径，但独立实现、独立门禁。
