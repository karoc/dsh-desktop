# Agent Note: manager-exit-guard-forensics

Status: implemented

## Problem

三次（2026-09-01/04/06）manager+dsh web 静默消失，事后零证据：WER LocalDumps 只对崩溃生效、对 TerminateProcess 无效；manager 内置 watchdog 与 manager 同死；壳只以 stdout EOF 判"服务下线"，既不取退出码也不留现场。UI 侧 hasServer 在 manager 死后恒 true（Child 从不清空），用户只看到黑屏/条幅却分不清死活。诊断结论（见 process/2026-09-01-windows-shell-crash-forensics.md）指出唯一可行的证据来源是"持有 Child 句柄的一方在死亡瞬间拿到的东西"。

## Decision

新增 `src-tauri/src/manager_guard.rs` 与壳内两条检测路径。`ManagerGuard{phase,generation,pid,intentional,reported_generation,last_exit}` 由 `ServerState.guard` 持有：每次 spawn 与每次 `stop_child` 都递增 generation 并置/清 intentional，检测方按世代号围栏、`reported_generation` 保证 EOF 与看护线程竞争时只有一条生效。看护线程每 2s `try_wait`（stdout EOF 仍是快路径；孙进程继承管道时 EOF 可能不到），退出码由 `wait_exit_code` 有界轮询 3s 取得；`handle_manager_exit` 两阶段——先确认可上报、再取码，若进程仍存活则只记日志、不占用上报槽位。取证落在 `<runtime>/reports/manager-crash-<unix>-gen<N>/`：`summary.json`（退出码/hex/ISO/pid/gen/壳 uptime/webview URL）、`manager.log.tail` 与 `shell-session.log.tail`（各 64 KiB 从尾部读，manager.log 无轮转）、`orphans.txt`（与启动清理共用同一个"路径组件边界"matcher）、`wer.txt`、`node-reports/`（复制 manager 已给 dsh web 产出的 `report.*.json`），保留 5 份。**不自动重启**（决定 D1）：退出处理区域不含 `start_server`/`restart_server`/`Command::new`，重启只能由用户在条幅/托盘/启动页手动触发。同时修 `hasServer`（改 `try_wait` 判活）与 `stop_child`（先 `try_wait`，已退出 PID 不再 taskkill，规避 PID 复用）。`/shell/status` 增 `managerAlive/managerPid/managerPhase/lastManagerExit`，新增 `/shell/open-evidence` + `open_evidence_dir`；chrome 条幅显示退出码与证据目录并给「重启服务」「打开证据目录」；启动页加载后主动查一次壳状态（`server-down` 事件早于回退导航，新页面收不到）。**明确不做**：杀后 dump（物理不可能）、壳注入 `NODE_OPTIONS`（一枚不支持的 flag 会炸整棵树）、Job Object、Sysmon、桥鉴权（各自留卡）。退出码语义写进 `describe_exit`：1 = taskkill 或启动期失败（两者不可区分，如实并列），2 = dsh web 异常退出，0 = 非壳请求的正常退出。
## Alternatives considered

**靠 WER LocalDumps 取证**：实测只对崩溃生效，第三次事故发生在配好之后仍零 dump；对 TerminateProcess 无解。**comsvcs/rundll32 事后 dump**：本机实测每轮恰好 20s 超时被杀、零产出（L3 的 6 次触发全空），且是 LOLBin，易被 AV 拦。**manager 自己自愈（下沉 dsh web 重启）**：对主问题无效——三次事故 manager 同刻死，前提"manager 活着"不成立；本质是自动重启，与 D1"要确保复现"冲突；且需改 `scripts/` 真源与 `resources/manager/` 副本两份（有漂移前科）。**自动重启 + 退避/预算**：用户明确否决（D1）——会掩盖复现并污染证据。**用 dsh web URL 探测当主信号**：会与 manager 内置 watchdog 双杀，只保留为诊断/展示。**壳注入 `NODE_OPTIONS=--report-*`**：收益只在 fatal error（被杀场景无报告），代价是任何一枚不支持的 flag 让整棵 node 树起不来——改为只复制 manager 已有的报告。**把退出码语义硬编码为"1=被杀"**：manager 自身 `process.exit(1)` 也是 1，故如实写"taskkill /F 或启动期失败"。
## Consequences

收获：manager 死亡第一次留下退出码 + 时间戳 + 同刻孤儿/日志/WER 现场，`hasServer` 不再撒谎，`stop_child` 不再对已死 PID 下手。代价与边界：退出码 1 的两种成因不可区分（如实并列，不臆断凶手）；证据目录每个最多约 130 KiB 日志尾，保留 5 份；每代 manager 多一个 2s 轮询线程（可忽略）；`orphans.txt` 可能合法地为空——实测 dev 版杀 manager 时 dsh web 一并消失（疑似上游 kill-on-close job），此时文件写明"无孤儿"，启动清理仍是孤儿兜底。实机验证还揪出一个独立的既有缺陷：故障回退导航落在 `about:blank` 黑屏，根因是 setup 阶段 `w.url()` 尚未导航（返回 about:blank）被当作启动页 URL，且 Windows 本地页是 `http://tauri.localhost/` 而非 `tauri://`——现由 `is_shell_local_url`（`tauri://` 或 `*.localhost`）三处统一判定，并在 `on_page_load` 用真实加载 URL 覆盖。**未覆盖**：挂起（进程仍活着）仍无 dump，S3/S4/G/Sysmon 留在"事故取证"卡；Job Object 未做，孤儿可能存活（证据会列出、启动清理会杀）；桥端点仍无鉴权（独立卡）。验证脚本 `scripts/verify-manager-guard.ps1` 与 UI 脚本 `scripts/verify-dev-ui.ps1`（新增 `restart`/`evidence` 标签）构成回归门禁；注意 PowerShell 5.1 的两个坑（CimInstance 标量无 `.Count`、`Get-Content -Raw` 按 ANSI 解码破坏 UTF-8 JSON）已在脚本内规避。

