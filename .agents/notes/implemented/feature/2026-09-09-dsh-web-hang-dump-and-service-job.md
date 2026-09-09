# Agent Note: dsh-web-hang-dump-and-service-job

Status: implemented

## Problem

挂起（事件循环卡死但进程还活着）是唯一还能拿到内存现场的 dsh web 故障：被杀进程地址空间已销毁（见 feature/2026-09-09-manager-exit-guard-forensics.md）。此前唯一的挂起 dump 手段是 manager 里的 `rundll32 comsvcs.dll,MiniDump`，本机实测 20s spawnSync 超时且零产出（09-05 连续 6 次），既没证据又把一次挂起拖成重启风暴；同时壳被强杀/崩溃后 manager 与 dsh web 会作为孤儿残留，与下次启动抢端口。

## Decision

新增 `src-tauri/src/web_dump.rs` 与 `src-tauri/src/job_object.rs`，并在壳内启动挂起看护。**S3**：壳每 3s 用裸 TcpStream 探 `LIVE_DSH_URL`（任何 HTTP 状态都算活着；连接失败/超时才算 miss），新 URL 后 30s 启动宽限，连续 3 次 miss 后由 `Get-NetTCPConnection -LocalPort <port> -State Listen` 定位 dsh web PID（失败回退到 runtime 路径 matcher 且排除 `server-manager.mjs`），再调 `MiniDumpWriteDump(MiniDumpWithFullMemory)` 写 `<runtime>/reports/dshweb-hang-<pid>-<unix>.dmp`，保留最近 3 份，并写 `last_error` + emit `web-hang`。壳**只 dump，不 kill、不重启**（D1）。**触发去重**：`HangDump{Idle,InProgress(url),Done(url)}` 状态机让壳内 watchdog 与 manager 的 `dump-web` 协议行收敛为一次，且**只有真正写盘完成的那条路径回 `dump-done`**——首版在去重命中时立刻回执，manager 抢先重启、被挂起进程在 dump 前消失（实测 OpenProcess 报 0x80070057、零 dump）。manager 侧：删除 comsvcs dump，挂起时改为「发 `dump-web` → 等 `dump-done`（上限 30s）→ 重启」，并加 30s 启动宽限；回执带时间戳，相位错开时不必空等。**S4a**：`job_object.rs` 建一个 `KILL_ON_JOB_CLOSE | BREAKAWAY_OK` 的 job（**不设** UI 限制，保证 dsh 自己的嵌套 job 仍可用），manager spawn 后立即 `AssignProcessToJobObject`；job 句柄由 `SERVICE_JOB` 静态持有到进程结束——壳一死，系统整树清理。创建/分配失败只记日志，启动期孤儿清理仍是兜底。**G2**：`scripts/dsh-hang-guard.ps1` 重写为外部守护：500ms 采样关注进程（node/dsh-desktop/taskkill/powershell/cmd/conhost/msedgewebview2），任一消失即把窗口内新出现的 suspect 连同 CommandLine 写进证据（排除自身与父进程），URL 探活与 30s 宽限同壳内逻辑，**默认 detect-only**，`-AutoRestart` 才调桥重启或拉起壳。**未做**：S4b（Job 完成端口逐进程退出通知）、G1（装登录启动项）、G4（Sysmon）——均留卡待确认。
## Alternatives considered

**继续用 rundll32 comsvcs**：本机实测 20s 超时零产出、LOLBin 易被 AV 拦，且 spawnSync 阻塞 manager 事件循环，是重启风暴的直接成因。**只在 manager 里抓 dump**：manager 自己也可能被杀（三次事故 manager 与 dsh web 同刻消失），且 dump 逻辑放在 JS 侧要跨两份文件（真源+副本）。**壳探测失败就自动 kill/重启**：与 D1「确保复现」冲突，且会和 manager 的 watchdog 双杀；改为只 dump + 提示。**两条触发路径各抓一份 dump**：全内存 dump 数百 MiB，重复抓写爆磁盘；用状态机收敛为一次。**去重命中就回执**：实测 manager 抢先重启导致现场归零，改为回执与写盘完成绑定。**给 job 设 UI 限制/不设 BREAKAWAY_OK**：会让 dsh 自己的 `AssignProcessToJobObject` 或带 `CREATE_BREAKAWAY_FROM_JOB` 的 spawn 失败，破坏 dsh 的进程管理。**把守护装进登录启动项（G1）**：属机器级持久改动，先交付脚本并征求用户同意，不擅自安装。**外部守护默认自动重启**：与 D1 冲突，改为开关 opt-in。
## Consequences

收获：挂起第一次有了可分析的现场（实测 313 MiB 全内存 dump，约 2s 写盘），manager 不再用一条被证伪的路径拖垮自己，壳进程死亡也不再留孤儿。代价与边界：dump 体积大（保留 3 份，同 URL 只抓一次；写盘期间进程不能被 kill，否则 dump 归零——回执机制保证了这一点，但 manager 的等待上限 30s 意味着超大进程可能被截断）；job 生效后壳一死整树立即消失（这是想要的），但若 dsh 有子进程显式 breakaway，那些进程仍会逃出 job；`Get-NetTCPConnection` 在同用户下可用，跨用户/无该 cmdlet 时回退到路径 matcher（可能选错 node，日志会记录 PID）。G2 的采样每 500ms 一次 `Get-Process`，只在 suspect 出现时才查 CIM，长期常驻的 CPU 开销可忽略但非零。外部守护尚未安装（G1 待用户同意）；Sysmon（G4）未装，因此「谁启动了 taskkill」仍只能靠 G2 的 500ms 采样窗口。

