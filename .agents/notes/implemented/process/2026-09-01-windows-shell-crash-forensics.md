# Agent Note: windows-shell-crash-forensics

Status: implemented

## Problem

用户报告宿主机（Windows）上使用 dsh 壳时出现一次崩溃，需要查证日志并定位原因。此前没有沉淀过 Windows 侧壳日志的位置与解读方法；初查发现崩溃时点附近 Windows 事件日志、WER、Crashpad 全部无 dsh 记录，必须系统性地枚举所有日志源并用排除法收敛结论。

## Decision

dsh-desktop 壳在 Windows 侧的排障入口已确立，日志清单如下（均为 Windows 用户 qqwto 的 AppData，WSL 侧无镜像）：① 壳会话日志 %APPDATA%\dev.dsh.desktop[.dev]\dsh-desktop-session.log（Rust 侧 append-only，epoch 秒）；② 内嵌服务日志 %APPDATA%\dev.dsh.desktop[.dev]\runtime\manager.log（UTC ISO 行，写于 node manager）；③ WebView2 崩溃转储 %LOCALAPPDATA%\dev.dsh.desktop[.dev]\EBWebView\Crashpad\reports（当前为空，WebView2 崩溃才会产出）；④ Windows 事件日志（Application/System，dsh 崩溃应有 Application Error/WER 1001，本日无）；⑤ 存活性探针 runtime\dsh-home\sessions\**\session.jsonl.zstd 的 mtime（dsh web 活跃写入）；⑥ 会话转录本体：session.jsonl.zstd 为多帧 zstd 拼接（每次落盘一帧），可用内嵌 node（node:zlib zstdDecompressSync + zstd 魔数 28 B5 2F FD 切帧）逐帧解压，转成可 grep 的 jsonl（本日已产出 C:\Users\qqwto\AppData\Local\Temp\dsh_s86_dec.jsonl / dsh_s5_dec.jsonl）。

2026-09-01 的结论（用户澄清后最终版）：崩溃的是**正式版**壳的内嵌 dsh web，不是开发版。铁证链：③⑤⑥ 联读——session-86c3f3d5（"项目问题排查与解决方案汇总"，D:\Dev\c-video-download）转录最后真实事件为 07:21:29.304（turn 12 step 7 的 pwsh 工具调用块生成完毕，随后应派发工具但永远没有 tool/call/tool/result）；紧接着的 turn/end reason=interrupted **并非引擎主动中断**，而是 dsh-session（lib/index.js:626 interruptedTurnClosers）在会话被重新打开时做的**崩溃恢复修补**：给未闭合回合补 step/end+turn/end 并**复用最后事件的时间戳**，同时把工具结果标为 outcome unknown；session/end-seed 于 07:23:29（重启后新 dsh web 写入）落盘。即：dsh web（node，dsh 0.1.1-rc.2 预发布）在 07:21:29 事件循环挂起——页面黑屏、刷新无响应（事件循环阻塞特征）、manager.log 无退出记录（进程没死，是挂）、Windows 无崩溃事件；用户 07:23:23 手动重启 dsh（taskkill /F 杀掉挂死进程树，07:23:25 新 web 上线）。挂起时刻的伴生压力：16 秒前（07:21:13）启动了后台 pwsh 作业"pwsh-1"（npm 全量测试 10 个脚本，含 test:engine 起 worker）、转录约 9MB 正处于落盘窗口、anyrouter provider 当日多次返回 502/503。另一会话 session-5c10778a（D:\Dev\test）同时段闲置未受波及，但无法提供对照。开发版壳 07:48:44 静默消失是另一独立事件（仍无 WER/AV/崩溃记录，维持"UI 冻结后被杀"推论，与开发仓库 07:58 提交 #8 在修同一批交互问题吻合）。当前不配置任何崩溃转储捕获，挂起类故障下次仍不可观测。

**第二次复现（2026-09-01 21:02:27，正式版未装补丁）**：同一会话 session-86c3f3d5 再现——turn 13（20:59:55 起）step 3 模型生成完"前台 pwsh npm 测试套件"工具调用（seq 16289 tool/call 已记录）后整树消失，转录止于 21:02:27（无 tool/result、无 end-seed）。与第一次差异：node 树（manager+dsh web）**全部消失**而非挂起；WER/Application/System 事件日志全空（仅 DCOM/hcmon 噪音），非异常崩溃。壳（PID 5684，19:50:43 起）与桥存活；21:07:41 通过桥 POST /restart 恢复（新 web 56065，HTTP 200，node 2 进程）。**两事件共同模式 = 同一会话在同一工具场景（pwsh 执行 npm 测试套件）的工具派发边界死亡，无任何崩溃记录 → 指向杀进程树（taskkill /T /F 类）误杀路径（dsh-subprocess-local 的 taskkillTree / koffi PID 判定，koffi 3.1.5），而非 node 自身异常**。test:engine 本身仅为 spawnSync 串行 node 子进程、无杀祖先逻辑（已读源码排除）。
## Alternatives considered

**Windows 事件日志/WER 作为主证据**：被排除——Application/System 日志在崩溃窗口无任何 dsh/msedgewebview2/node 事件，ProgramData 与用户级 WER 归档、队列全空，WER 未被禁用（LogiPluginService 同日有正常 WER 记录可对照），故 dsh 组件的死亡不走异常崩溃路径。**WebView2 Crashpad 转储**：EBWebView/Crashpad/reports 为空，排除 webview 硬崩。**安全软件拦截**：Defender/AppModel-Runtime 日志无 dsh 相关事件，排除被杀软杀掉。**睡眠/唤醒时序**：System 日志 04:30–07:20 无 Kernel-Power 42/107，排除挂起恢复导致。
## Consequences

开销：排障需跨 WSL→Windows 双域取证，PowerShell 输出编码需经 Out-File/EncodedCommand 处理；结论基于"中断=崩溃恢复修补"的间接证据链——dsh web 挂起的直接根因（同步 zstd flush / 原生模块死锁 / 后台作业挤压事件循环）无 heap/stack dump 无法锁定。后续义务（看板卡 card-b5011bd5 跟踪）：① 壳加 dsh web 存活 watchdog（HTTP 心跳，N 秒无响应则 kill+respawn 并落日志）——WER LocalDumps 对"挂起"不触发，只对硬崩溃有效，不能只靠它；② 顺带配置 LocalDumps 捕获 node.exe/dsh-desktop.exe/msedgewebview2.exe 硬崩溃；③ 关注 dsh 0.1.1-rc.2 后续版本。收获：Windows 侧壳日志位置、时间线对读法（manager.log UTC / session.log Unix 秒）、转录多帧 zstd 解码法（node:zlib）、interruptedTurnClosers 语义（崩溃恢复时会补写 interrupted 并复用时间戳）——这些本会话沉淀。

