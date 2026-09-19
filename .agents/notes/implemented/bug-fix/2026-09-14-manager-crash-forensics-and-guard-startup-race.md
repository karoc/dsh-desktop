# Agent Note: manager-crash-forensics-and-guard-startup-race

Status: implemented

## Problem

第四次同类事故（2026-09-15 02:11:09，正式版 0.8.0）依旧零凶手证据：manager（gen2 pid 54060）退出码 1，manager→launcher→dsh web 三个 node 进程同秒消失，manager.log 停在死亡前 49 秒且无 fatal 行（log() 是 appendFileSync，说明没走 manager 自身的 catch 路径），WER/CrashDumps 无 node dump，事件日志与 Defender 干净。退出码 1 的两种成因——被外部 TerminateProcess（taskkill /F）或自身未捕获异常退出——在壳侧不可区分；未捕获异常只会把栈写 stderr，而 Windows 上 stderr 是管道（异步写），process.exit 一到栈即丢失。更糟的是专为抓凶手建的外部 guard（dsh-hang-guard.ps1 的 killer catcher）自 2026-09-10 00:25 起从未真正运行：登录启动项早于壳启动，"shell absent for 4 cycles" 分支在约 2 秒后直接退出，之后每次开机都重演。转录解码（.forensics/decode-session.mjs，多帧 zstd）显示死前最后事件是 02:09:48.740 的 tool/call pwsh `npm run test:fast`，81 秒后整树死亡、无 tool/result；%TEMP%\dsh-QxG3T2\node-compile-cache 在 02:11 仍在写，证明测试套件当时在跑并在生 node 子进程。四次事故（09-01 07:21 挂起 / 09-01 21:02 / 09-04 00:04 / 09-15 02:11）全部同一 workspace（D:\Dev\c-video-download）+ 同一动作（pwsh 跑 npm 测试套件）。

## Decision

两处改动落地，都只增加可观测性、不改变既有退出语义。① `scripts/dsh-hang-guard.ps1` 新增 `-WaitForAppSec`（默认 0＝无限等）：把"从未见过壳"与"壳曾在、现在消失"分开——前者按 `IntervalSec`（3s）慢轮询等待、不启动 500ms 采样器（没有树可采），后者保持原有 2 周期取证 + 4 周期退出。② `scripts/server-manager.mjs` 新增 fatal-exception forensics：`uncaughtException` / `unhandledRejection` 处理器同步落 `<runtime>/reports/manager-exception-<unix>.txt`（kind / ISO 时间 / pid / node 版本 / uptime / 完整栈）与程序化 node 诊断报告 `manager-report-<pid>-<unix>.json`（`process.report.writeReport(file)` 收的是文件名，传目录会 EISDIR），manager.log 记 `fatal(<kind>)` 行，最后仍 `process.exit(1)`。判定规则写进代码注释：有 `manager-exception-*.txt` ＝自身异常崩溃（栈可读），无标记而 code=1 ＝被外部强制结束。宿主机已部署：guard 由 `scripts/install-hang-guard.ps1` 重装到 `%LOCALAPPDATA%\dsh-hang-guard\`（同时重建登录快捷方式）并常驻（pid 13676，日志 armed）；manager 按字节热替换到安装目录 `resources\manager\server-manager.mjs`（sha256 与仓库一致、bundled node --check 通过，原文件备份 `.bak-20260915`），**未重启任何服务**——壳当前仍在服务 down 状态，恢复由用户点「重启服务」。仓库侧真源/副本一致（`npm run sync:resources`），`npm test` 8 套全绿。边界：guard 仍是 detect-only（D1，不自动重启）；manager 退出码语义、壳的 kill-on-close job、`stop_child` 路径、dsh 侧 subprocess Job/taskkill 全部未改；事故根因仍未定。
## Alternatives considered

**给 manager 注入 `NODE_OPTIONS=--report-*`**：被否——壳的既有决策是一枚不支持的 flag 会让整棵 node 树起不来，改为手写处理器 + 程序化 `writeReport`。**guard 用固定等待上限（如 15 分钟）后退出**：被否——用户开机后可能数小时才开壳，固定上限会重演"到点自尽"，本次事故正是这个形态。**把退出码 1 直接断言成"被 taskkill"**：被否——manager 自身 `process.exit(1)` 也是 1，壳的 `describe_exit` 已如实并列，取证方案要能区分而不是猜。**靠 WER/CrashDumps 取证**：再次被否——LocalDumps 对 TerminateProcess 无效，本次 node dump 为空；**comsvcs/rundll32 事后 dump** 上一轮实测 20s 超时零产出。**用 WSL 侧 HTTP 服务把补丁推给 Windows**：被否——`\\wsl.localhost\Ubuntu-24.04\...` UNC 直读经实测可用，直接 Copy-Item 更简单；**PowerShell `Get-Content -Raw` 读文件再转 CRLF 写回**：实测踩坑（PS 5.1 按 ANSI 解码 BOM-less UTF-8 → 中文乱码、node --check 报 `Unexpected token ']'`），已回滚为字节级 Copy-Item。
## Consequences

收获：下一次同类事故可自证——有 `manager-exception-*.txt` 即自身崩溃并可读栈，无标记即被外部强制结束；guard 恢复常驻后能记录死亡瞬间的进程表与 2s 内的可疑进程（taskkill/powershell/pwsh/cmd）。实测覆盖：注入 `setImmediate` throw 的 manager 探针产出两个证据文件且退出码 1；自建 dummy node + taskkill 触发 guard 记录 `VANISHED pid=... name=node`。代价与边界：guard 现在会常驻一个 PowerShell（从未见到壳时 3s 一次轻量轮询，见到后 500ms 采样）；宿主机 manager 是**热替换**，不在任何安装器/更新器记录里——重装或升级 0.8.0 会用回打包的旧 manager，需要一次正式发版把 `scripts/` 的改动带进安装包；`.forensics/`（解码脚本 + 本次会话转录 jsonl）留在工作区未跟踪，可随时删除；事故根因仍未定，四次共同触发场景（pwsh + npm 测试套件）与判定清单记在 KANBAN 跟进卡。

