# 待办卡片方案设计（2026-09-09）

> **状态：调研与方案设计，未实施。** 四张待办卡逐张给出：现状实测（含认知修正）→ 候选方案对比（含依据）→ 推荐方案 → 风险 → 验证方式 → 代码落点。
> 调研方式：四路独立只读调研（各自读代码/实测/查官方文档）+ 主线自审交叉验证；所有 Windows 侧数据均为本机只读实测。

## 0. 总览

| 卡 | 性质 | 现状认知修正（重要） | 推荐方案 | 优先级 |
|---|---|---|---|---|
| `card-7c04d1eb` 事故取证 | 取证能力缺口 | **卡里"L1 未落地"是错的**：L1 早已配好，但 WER 只抓崩溃、**抓不到 TerminateProcess 式静默杀**（第三次事故在 L1 配好之后，仍零 dump）；L3 已触发 6 次却**零 dump**（rundll32/comsvcs 本机 20s 挂死）且**误杀健康实例** | 方案 S（纯壳内：退出码 + 自动恢复 + 挂起 dump + Job Object）+ 方案 G（免管理员自启守护，覆盖"壳也死"） | P1 |
| `card-6c051fbe` 壳层守护 | 可用性缺口 | 壳只有 stdout EOF 一个信号、**全仓无 `try_wait`**；另发现两个真 bug：`hasServer` 死后恒 true、`stop_child` 对已退出 PID 仍 taskkill | `try_wait` 主信号 + 世代号状态机 + 先取证后退避重启 + 预算/放弃态 | P1 |
| `card-29b6f966` 桥鉴权 | 安全缺口 | **token 挡不住同源插件**（有证据）；桥对 Origin/Host/peer_addr 零校验（DNS rebinding 可实现）；38 端点中 9 个危险 | 阶段 0 Host/Origin 校验 → 阶段 1 危险动作改「壳内独立确认窗 + IPC 执行」→ 阶段 2 token（只宣称防外部） | P2 |
| `card-2506a383` 旧版接管加固 | 正确性/卫生 | ③ 经核实**无需改动**（发布版一律大写 + NTFS 大小写不敏感）；② 除边界外还有**大小写敏感漏删**（真实缺陷）；① 含**真实行为缺陷**（拒绝卸载旧版却删其快捷方式） | ②④ 纯 Rust 先做（10 行级 + 单测）→ ① 随后（NSIS + 真机）→ ③ 结论性关闭 | P2 |

**相互关系**：卡 1 与卡 2 是**同一事故链的两面**——卡 2 的守护机制（持有 `Child` 句柄、检测退出、重启前取证）正是卡 1 缺口的实现载体。建议合并为一个 PR / 一次发版。卡 3、卡 4 相互独立。

## 0.1 决策记录（用户 2026-09-09 拍板）

| # | 决定 | 对方案的影响 |
|---|---|---|
| **D1** | **不做自动重启**（"要确保复现"） | 卡 2 方案降级为「检测 + 取证 + 显著提示，用户手动重启」；卡 1 的 S2/S3 同步降级（不自动 kill/respawn）。代价：事故后不自愈、需手动点「重启服务」；收益：每次复现都留完整证据且用户亲眼可见 |
| **D2** | 取证增强：可接受装 **Sysmon**（极简配置） | 卡 1 方案 G 增补：只开 `ProcessCreate`(EID 1) + `ProcessTerminate`(EID 5)，下载包 4.6 MB、需管理员；能直接抓到"谁启动了 `taskkill.exe`、命令行、父进程"（[官方文档](https://learn.microsoft.com/en-us/sysinternals/downloads/sysmon)） |
| **D3** | **不做**"dsh web 自愈下沉到 manager" | 卡 2 rejected 记录。理由（按权重）：① 对主问题无效（三次事故 manager 同刻死，下沉前提"manager 活着"不成立）；② 本质是"自动重启 dsh web"，与 D1 冲突、会掩盖复现；③ 需改真源 + 副本两份（有漂移前科），增量收益仅"dsh web 异常退出"一条（挂起已被内置 watchdog 覆盖） |
| **D4** | 接受"**页面里的壳菜单退出/重启也走确认窗**" | 卡 3 阶段 1 的权衡落定：托盘入口免确认（真正的壳内入口），页面发起的一律确认；不采用"壳 chrome 标记"（插件可伪造，防护归零） |
| **D5** | 接受卡 4 ① 的取舍（旧版在跑时**不删**其快捷方式） | 卡 4 ① 落定 |
| **D6** | 03:04 退出 = 用户操作（排除）；00:47–00:48 **第 4 次复现未确认** | 卡 1 记录；"壳是否也会死"仍为开放前提 |

> 决定（D1–D6）**优先于**正文中的推荐表述；正文保留调研原貌（候选对比与依据不变）。

---

## 1. `card-7c04d1eb` 事故取证：让"下次复现"自动留下证据

### 1.1 现状实测（2026-09-09 03:10–03:20，非管理员只读）

| 层 | 卡里的说法 | 实测事实 |
|---|---|---|
| L1 WER LocalDumps | "未落地" | **已落地**：`HKLM\...\WER\LocalDumps` 下 `dsh-desktop.exe` / `node.exe` / `msedgewebview2.exe` 均已配，DumpFolder=`%LOCALAPPDATA%\CrashDumps\dsh`、DumpType=2(full)；该目录 **09-01 22:02 创建至今 0 个文件**（同根下别的程序有 .dmp → 机制本身工作）。缺口：`dsh-desktop-dev.exe` 未配；且 System 日志 03:03:32 报 SCM 7038/7009（WerSvc 无法以 SYSTEM 登录）→ 当前不健康 |
| L2 hang-guard | "未落地" | 确认未落地：两个启动文件夹、HKCU Run、`Get-ScheduledTask` 均无 |
| L3 内置 watchdog | "已落地" | 已落地且**真实触发过 6 次**（09-05 14:14:52Z→14:18:15Z 连续 6 轮 `UNRESPONSIVE → restarting`），但**零 dump**、且**每轮间隔恰好 ~20.0s** = `server-manager.mjs:1087` 的 `spawnSync(timeout:20000)` 超时被杀 → `rundll32 comsvcs.dll,MiniDump` **在本机被挂死/拦截**；同时 `server-manager.mjs:1192-1195` **无启动宽限期** → 3 分钟内 6 次重启风暴 |

### 1.2 物理边界（决定方案形态的一句话）

**进程被 `TerminateProcess` 终止后地址空间即销毁，事后不可能再 dump**；WER 也只在"崩溃→终止前"那一刻介入。因此：
- **dump 只对"挂起"（进程还活着）有意义**；
- "manager 被杀"场景的自动证据只能来自**持有句柄的一方在死亡瞬间拿到的东西**：退出码、时间戳、同刻还有谁死了、谁启动了 `taskkill`。

主线实测（本机）：被 `taskkill /F` 杀死的 node 进程，父进程拿到的**退出码 = 1**；正常退出 = 0。→ **壳持有 `Child` 句柄即可区分"被杀"与"正常退出"**，这是最廉价、最高价值的证据。

### 1.3 候选对比（依据已核）

| 候选 | 覆盖 manager 被杀 | 覆盖挂起 | 免管理员 | 依据/风险 | 推荐 |
|---|---|---|---|---|---|
| 壳记录退出码（`try_wait`/`GetExitCodeProcess`） | ✅ `1`=taskkill、`0xC0000005`=崩溃 | — | ✅ | 句柄已在手，~10 行 | ★★★★★ |
| 壳内 `MiniDumpWriteDump`（dbghelp） | ❌ 死后无效 | ✅ | ✅ | 需 `PROCESS_QUERY_INFORMATION`+`PROCESS_VM_READ`；实测非管理员可枚举 explorer(429 模块) → 同用户可得，**无需 SeDebugPrivilege** | ★★★★★ |
| comsvcs/rundll32 | ❌ | ⚠️ **实测 20s 挂死零产出** | 名义 ✅ | LOLBin 易被 AV 拦 | ★（应弃用） |
| HKCU 版 WER LocalDumps | ❌ | ❌ | 想免管理员 | [官方文档](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps)：只支持 HKLM 且需管理员 | 0 |
| 启动文件夹 / HKCU Run 守护 | ✅ | ✅ | ✅ | 守护父进程是 explorer，**不在 dsh 树内**，`taskkill /T` 打不到 | ★★★★ |
| `schtasks /ru %USERNAME%` | ✅ | ✅ | ⚠️ | [文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create)：总是提示密码 → 无人值守不可靠 | ★★ |
| Job Object + 完成端口 | ✅ 全树逐进程异常退出通知 + 退出码 | ⚠️ 需自行探活 | ✅ | `KILL_ON_JOB_CLOSE` 可灭孤儿；**切勿设 BREAKAWAY 限制**（dsh 自己的 `AssignProcessToJobObject` 会失败） | ★★★★★ |
| Sysmon EID5 / ETW-TI / Security 4689 | ⚠️ 有退出无凶手 | ❌ | ❌ 需管理员 | | ★ |
| 高频快照抓 `taskkill.exe` 命令行 | ✅ 唯一能指认凶手 | ❌ | ✅ | 200–500ms 采样有漏采 | ★★★ |

### 1.4 推荐方案

**方案 S（零用户操作，纯壳内，覆盖挂起 / manager 死 / dsh web 死）**
- **S1 退出码 + 死亡时刻**：stdout EOF 处 `child.wait()` 取码写 session.log（`manager exited code=0x… at …`）。
- **S2 取证 + 显著提示（不自动重启 —— D1）**：同处收集证据（退出码/时刻/快照）→ 写 session.log + `last_error` → errbanner 显示「服务异常退出（退出码 N），现场已保存」+ 一键「重启服务」由**用户手动触发**。**不做自动重启/退避/预算**——避免掩盖复现（"要确保复现"）。
- **S3 挂起 dump（只 dump，不 kill、不 respawn —— D1）**：每 3s 探 `LIVE_DSH_URL` → 连续 N 次失败 → CIM 定位 node PID → Rust 调 `MiniDumpWriteDump` 落 `<runtime>/reports/` + 提示；**不自动杀树/重启**（与 S2 同一原则）；只在进程仍存活时调用；`OpenProcess` 失败必须记错误码；**新 URL 后 30s 启动宽限期**（治 L3 风暴）。
- **S4 Job Object**：`CreateJobObject` + `KILL_ON_JOB_CLOSE` + 完成端口，manager 及其后代自动入 job → ①逐进程异常退出通知；②壳真死时自动清树（消灭孤儿）；③可加资源护栏。需实测与 dsh sandbox job 的嵌套兼容。

**方案 G（一次最小操作，覆盖"壳也死"）**
- **G1** 用启动文件夹快捷方式（或 HKCU Run）安装守护：免管理员、免密码、登录即起。
- **G2 守护脚本必须先改三处**（不改等于没装）：①**弃用 comsvcs dump**（本机已证伪），改为存活时调桥 `/restart` 并记录失败原因；②**加启动宽限期**；③每 500ms 采进程表，记录 node/dsh-desktop 消失时刻，并抓消失前 2s 内新出现的 `taskkill.exe`/`powershell.exe` **连同 CommandLine**（唯一免管理员指认凶手的机会）。
- **G3（可选，需管理员）** `HKLM\...\WER\Hangs` 开 hang dump（S3 已覆盖，优先级低）。
- **G4（可选，需管理员；D2 已接受）** 装 **Sysmon** 极简配置：只开 `ProcessCreate`(EID 1，含完整命令行 + 父进程) 与 `ProcessTerminate`(EID 5)；下载包 **4.6 MB**，默认不开网络/镜像加载 → 开销最小（[官方文档](https://learn.microsoft.com/en-us/sysinternals/downloads/sysmon)）。价值：**唯一能直接指认"谁启动了 `taskkill.exe`、命令行是什么、父进程是谁"** 的手段。注意：与火绒可能冲突；驱动级组件，需接受。

**明确做不到**：杀后 dump（物理不可能）；无管理员组件时拿到权威"凶手"记录；HKCU 配 WER；火绒若参与杀进程只读取证不了（需用户在火绒 UI 查日志/加白）。

### 1.5 验证方式（只读/无破坏）

1. `reg query "HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps" /s`；`Get-ChildItem "$env:LOCALAPPDATA\CrashDumps\dsh"`（空）；`Get-WinEvent -LogName System -Id 7038,7009`（WerSvc 健康度）。
2. L2 三项查询（两个启动文件夹 + HKCU Run + `Get-ScheduledTask`）。
3. `Select-String -Path "%APPDATA%\dsh.smoothly.desktop\runtime\manager.log" -Pattern watchdog`；比对 `UNRESPONSIVE`↔`restarting` 时间差（≈20s 即 spawnSync 超时）；列 `runtime\reports`。
4. 壳内 dump 可行性：非管理员 `(Get-Process explorer).Modules.Count` 成功即证明 VM_READ 可得。
5. 上线后验收：加只读自检日志 `dump-probe ok`；再用**一次受控人为挂起**验证 dump 落盘。**不要在正式会话跑全量测试套件**（正是卡片正题）。

### 1.6 未解问题（需要用户/管理员）

1. **09-09 00:47–00:48 是第 4 次复现还是手动关闭**——决定"壳是否也会死"这一前提（当前证据：dev manager 只记 1 次 miss 后断流，prod 壳 00:48:17 重启并清掉 2 个孤儿 node；另 03:04 有一次**正常退出**，`.window-state.json` 被写入、无异常日志）。
2. WerSvc 7038/7009 是否已恢复；是否愿意装 Sysmon（唯一能全量记录 ProcessTerminated + 完整命令行的免费组件）。
3. **火绒日志人工核对**三次事故时刻是否有拦截记录——命中则根因改写、方案加 AV 排除。
4. 上游 dsh：`dsh-win32-process` 的 kill-on-close job 只杀 job 内成员，而 manager 不在 job 里 → "manager 为何也死"仍无机制解释，需在 dsh 仓库继续查。
5. 需实测：非管理员能否订阅 `Win32_ProcessStopTrace`；壳内 `MiniDumpWriteDump` 对 node 的实际成功率（AV 拦截）。
6. ~~需拍板：自动重启的退避策略~~ → **已决 D1：不做自动重启**（改为"检测 + 取证 + 提示"，用户手动重启）。

---

## 2. `card-6c051fbe` 壳层守护：manager 退出检测 + 取证 + 提示（**不自动重启**，D1）

### 2.1 现状（含两个新发现的真 bug）

```
setup → boot 线程 → start_server
   ├ wait_for_startup_cleanup(≤20s)  ├ stop_child  ├ spawn node manager
   ├ stdout reader / stderr reader   └ child → ServerState.child
```
- 壳对 manager 的**唯一存活信号 = stdout EOF**（`lib.rs:2071-2097`）；**全仓无 `try_wait()`**，但 `Child` 句柄一直留在 `ServerState.child`（`:2130`）→ 判死能力其实已在手。
- manager 死后链路：`last_error` → `server-down` → 启动页红字「dsh 服务已退出。」+ 重试 → chrome errbanner 显示 ⚠ → 导航回 launcher → **恢复只能靠人**。
- **bug ①**：`hasServer`（`lib.rs:1757`/`2678`）在 manager 死后**恒 true**（Child 从不清空）→ UI 分不清死活。
- **bug ②**：`stop_child`（`:111-129`）对已退出 PID 仍无条件 `taskkill /PID`（PID 复用面 + 无意义）。
- **dsh web 异常退出时 manager 自己 `process.exit(2)`**（`server-manager.mjs` supervise → main）→ 这也是需要壳兜底的场景。

### 2.2 设计要点

- **主信号**：`Child::try_wait()`（权威、零误判、零依赖）+ EOF 提前唤醒。**dsh web URL 探测只准用于展示/取证，禁止触发重启**（与 manager watchdog 双杀）；心跳文件只做诊断。
- **状态机（简化为「检测 + 取证 + 提示」，不含自动重启 —— D1）**：`MgrPhase{Down,Starting,Running,Stopping}` + `generation`（每次 spawn +1，旧读线程/事件丢弃）+ `intentional_stop`（**只在 `stop_child` 置位**）。检测到"非意图退出"时：取证 → 写 `last_error` → errbanner + toast「服务异常退出（退出码 N），现场已保存」→ **等待用户手动「重启服务」**（`/restart` 或托盘）。
- **证据目录** `<runtime>/reports/manager-crash-<ts>-gen<N>/`：`summary.json`（gen/pid/退出码/时刻/壳 uptime/webview URL）、`manager.log.tail`(64KiB **从尾部读**，manager.log 无轮转)、`shell-session.log.tail`、`orphans.txt`、**对孤儿 dsh web 跑 `MiniDumpWriteDump`（唯一可 dump 的现场）**、`node-reports/`、`wer.txt`；保留 5 份。
- **明确不做**：自动重启 / 退避 / 重启预算 / 放弃态 —— D1"要确保复现"：自动重启会掩盖现场，且重启风暴本身会污染证据。
- **边界**：壳只管 manager，manager 只管 dsh web；壳是唯一 spawner。
- **UI**：复用现有链路（url→清 last_error→navigate→nav-fallback→/alive）；`/shell/status` 补 `managerAlive`（**修掉假 hasServer**）/`managerPid`/`lastManagerExit`（退出码 + 时刻）/`evidenceDir`；errbanner 常驻显示退出码与证据目录 + 「重启服务」按钮。

### 2.3 替代方案结论

A 壳内 `try_wait` 检测 + 取证 + 提示 ✅ **主方案（D1 后）**；B Job Object 🔶 互补（根治壳死后孤儿，其"逐进程异常退出通知"可与 A 叠加）；C 外部守护进程 ❌（与壳双杀、装/卸成本）；D Windows 服务 ❌（session 0 无 UI、需管理员）；E 计划任务 ❌（schtasks 已被拒）；F manager 心跳 🔶 仅诊断；**H dsh web 自愈下沉到 manager ❌（D3）**。

**H（下沉）为何否决**（D3）：① 对主问题无效——三次事故 manager 同刻死，"manager 活着"这一前提不成立；② 本质是"自动重启 dsh web"，与 D1"要确保复现"直接冲突；③ 需改 `scripts/server-manager.mjs` 真源 + `resources/manager/` 副本两份（有 0.5.0/0.6.0 打包旧 manager 的漂移前科），而增量收益只有"dsh web 异常退出"一条（"挂起"已被内置 watchdog 覆盖）。将来若根因清楚且确认 dsh web 崩溃是独立高频问题，再做成"先 dump/记录 → 上报壳 → 再重启"，而非静默 respawn。

### 2.4 风险

（D1 后"自动重启"类风险消失）仍须处理：与 `dsh-hang-guard.ps1` 双杀（须注明关闭其自动重启，否则外部守护会替我们重启、污染现场）；退出竞态（`SHUTTING_DOWN` + spawn 后再校验）；孤儿清理误杀新 manager（世代号 + 短临界区）；`stop_child` 必须先 `try_wait`（修 bug ② + 规避 PID 复用）；取证不得阻塞 UI；dump 体积需限额轮转；errbanner 常驻但不得遮挡页面（复用现有布局）。

### 2.5 落点与 MVP

**新增 ~8 处**（`SHUTTING_DOWN`、`ManagerGuard`/`MgrPhase`、`ServerState.guard`、`next_generation`/`manager_alive`、`start_manager_watchdog`、`collect_manager_crash_evidence`、`orphan_service_node_pids` 抽取、`dump_process`/`prune_evidence_dirs`）。
**改动 ~10 处**（`stop_child:111-129`、`start_server:1854-2150` + 两个读线程世代围栏 + 给 manager 注入 `NODE_OPTIONS=--report-*`、EOF `:2071-2097`、`restart_server:2153`、`quit_app:2445`、`run():3100` 改 `.build().run()`、`/shell/status:1754` + `get_shell_status:2675`、`cleanup:714-743` 抽取、`shell-chrome.js:560-587`、两个契约测试）。
**MVP** = 检测 + 退出码取证 + 提示 + 证据目录（含孤儿 dump）+ 修两个 bug；缓做：Job Object、Sysmon 联动、manager 心跳。
**测试**：Rust 纯逻辑 `cargo test --lib`（`decide`/`needs_kill`/证据轮转）；JS（`test-control-plane` 断言 manager 退出码契约、`test-shell-chrome` 断言新符号/字段）；Windows 实机（taskkill manager → **检测到 + 退出码 1 + 证据目录齐全 + 不自动重启**；退出零残留；dev/正式互不干扰；强杀壳孤儿清理不回归）。
**已决**：不做自动重启（D1）；不下沉 manager 自愈（D3）。

---

## 3. `card-29b6f966` 桥鉴权：端点是"半可信"的

### 3.1 关键结论：**token 挡不住同源插件**（证据链）

- 注入通道是**页面主世界**：`inject_shell_chrome` 用 `w.eval`（`lib.rs:2281`）→ wry 0.55.1 Windows 实现为 `ICoreWebView2::ExecuteScript`（主世界）；初始化脚本走 `AddScriptToExecuteOnDocumentCreated`（同为主世界）。
- **项目自己依赖"同世界"**：`server-manager.mjs:988-997` 把桥端口烘焙进预装插件 `client.js`，注释明说保留 `globalThis` 读取路径"给外部注入者"；插件侧读的正是 `globalThis.__DSH_BRIDGE_PORT__`（`plugins/*/client.js`）。
- 放 header 不改变泄露面：值仍必须来自某个全局才能被 `shell-chrome.js:120-133` 的 `bridge()` 读取；同世界插件还能直接 patch `fetch`。
- → **只要秘密交给页面，就属于页面**。与 dsh 现状一致：dsh web URL 自 0.1.2-rc.1 起就带 `?token=`，同源插件可读 `location.search` —— query token 在本项目定位本来就是"防外部不防同源"。

### 3.2 其他关键事实

- 桥**零校验**：请求解析（`lib.rs:1371-1389`）只看 `content-length`，**不看 Origin/Host/peer_addr**（grep 无命中）→ **DNS rebinding 当前可实现**。
- `OPTIONS` 已处理（`:1392` 返回 204），但 `Access-Control-Allow-Headers: content-type`（`:1772`）**不含自定义头** → 加 token 头必须同步改这一行，否则预检失败。
- 端点共 **38 个**，危险集 9 个：`/shell/quit`、`/restart`、`/shell/legacy-cleanup`、`/update-dsh`、`/plugins/install`、`/plugins/remove`、`/shell/open-data-dir`、`/shell/dev-mode-toggle`、`/shell/gpu-accel-toggle`。只读 6 个。已有门禁先例：`/devtools` 需 devMode（`:1522`）。
- **兼容性硬约束**：`/notify`、`/log`、`/pending-open`、`/alive` 的调用方是**预装通知插件**，它只有被烘焙的端口、**没有 token** → token 不能一刀切，否则通知链路失效；**绝不把 token 也烘焙进 client.js**（落盘）。
- "危险动作改 IPC-only"**不可行**：远程页无 `__TAURI__`，capabilities/remote-notifications.json 只授 event+notification、**无 core:default**，远程 invoke 被 ACL 拒；要放开就得把整个 `invoke_handler`（含 quit_app/cleanup_legacy_install）暴露给页面，比桥更糟。
- "壳内弹窗确认"当前**不够**：现有模态弹窗（`shell-chrome.js:693-760`）渲染在**页面 DOM**，同世界插件可伪造/点击 → 必须改成壳拥有的**独立 webview**（照 `open_plugins_window` 模式）。
- 端口随机化（127.0.0.1:0）已够但端口在日志与 manager 命令行可见 → 对同用户本机进程无效，不能当主防线。

### 3.3 推荐分阶段（含落点）

| 阶段 | 内容 | 挡谁 |
|---|---|---|
| **0（半天，零行为变更）** | `lib.rs:1772` 加 `x-dsh-bridge-token` 到 Allow-Headers；`handle_bridge_conn` 加 **Host 校验**（须 `127.0.0.1:<port>`/`localhost:<port>`）+ **Origin 白名单**（`tauri://localhost`、`http://127.0.0.1:*`、`http://localhost:*`），否则 403 | 外部网页、DNS rebinding |
| **1（对同源插件唯一有效）** | 9 个危险端点从"执行"改为"登记 Rust 侧一次性槽位 `PENDING_CONFIRM` + 打开壳拥有的 confirm 窗口"；真正执行移到新 IPC `resolve_pending_action(nonce)`，confirm 窗走 IPC（capabilities/launcher.json 的 windows 加 `"confirm"`）；**动作描述必须由 Rust 生成**（防"确认框写刷新、实际 quit"）；槽位一次一个 + 60s 过期；`shell-chrome.js:71-91` ACTIONS 给危险项加 `confirm:true` | 同源第三方插件 |
| **2（只宣称防外部）** | `BRIDGE_TOKEN` 每次页面加载轮换（`:2270-2280`），注入 `__DSH_BRIDGE_TOKEN__`，`bridge()` 加请求头；**豁免** `/alive` 与通知插件四端点；明确不承诺防同源插件 | 外部网页（纵深） |
| **3（可选）** | CORS 从 `*` 收窄为白名单回显 Origin / 加 `Sec-Fetch-Site` 检查 | 纵深 |

**阶段 1 的权衡（D4 已落定）**：壳菜单里的「退出/重启」在**远程 dsh 页**上也是走桥的（远程页无 `__TAURI__`），所以它**也会**触发确认窗——因为"请求是否来自壳 chrome"在页面主世界里无法区分（插件能读到一切）。**接受**：页面发起的危险动作一律确认；**托盘菜单**是免确认的壳内入口（用户真正的退出/重启通道）。**不采用**"壳 chrome 加标记"（插件可伪造，防护归零）。

**测试扩展**：`test-shell-chrome.mjs` 增断言（危险集必须 `confirm:true`；lib.rs 危险端点 match 臂内不再直接调执行函数；含 `__DSH_BRIDGE_TOKEN__` 且 `bridge()` 设头）；新增 `test-bridge-guards.mjs` 做源码级 Host/Origin 判定断言。**只读验证**：对 `GET /shell/state`、`/window/state` 验证无 token 403 / 有 token 200，**绝不 POST 危险端点**。

---

## 4. `card-2506a383` 旧版接管加固：四项逐项结论

### ① NSIS 钩子删 lnk 未校验 —— **含真实行为缺陷**，P2

- 现状：`legacy-takeover.nsh` 的共享尾标签里无条件删两条 lnk；**三个分支（孤儿 / 旧版在跑→拒绝卸载 / 无残留）全部**走到这里。
- 真实风险（第 2 条更实）：a) 误删用户自建同名 lnk（概率低，仅丢快捷方式）；b) **"旧版仍在跑、我们有意拒绝执行其卸载器"时，仍把它的快捷方式删了** → 旧版主程序与卸载器原封不动，但用户桌面/开始菜单入口消失，症状与本次事故同类的"应用凭空消失"。
- 修法（推荐）：**只在孤儿分支删**，并用模板自带 `IsShortcutTarget`（`utils.nsh:160-184`，纯 NSIS COM 调用，无外部进程；模板自己的卸载器 `installer.nsi:5723-5740` 就是这么做的）+ `!ifmacrodef IsShortcutTarget` 守卫（独立编译 harness 里没有该宏 → 自动跳过删除，不编译失败也不盲删）；has_app 分支**不动 lnk**。
- 否掉的方案：nsExec 调 PowerShell 读 target（引入外部进程 + 编码/执行策略失败面，与本次 wmic fail-open 同类）；NSIS 自解析 .lnk 二进制（~30 行 + 代码页边界，收益不如 A）。
- 测试：`verify-legacy-hook.nsi` 加 `Win\COM.nsh` + 复制 `IsShortcutTarget`；`verify-legacy-hook.ps1` 加两场景（lnk 指向模拟旧版 → 删；指向别处 → 保留）。

### ② `should_delete_shortcut` 前缀匹配 —— **除边界外还有大小写漏删**，P2

- 现状：`lib.rs:768-773` 用 `starts_with`，`want` 来自常量小写 `dsh Desktop`。
- 两个独立缺陷：a) **无边界** → `dsh Desktop-dev`、`dsh Desktop2`、`dsh Desktop.bak` 均命中（对照同文件 `:713-722` 的 runtime 清理已用 `(?=[\\"'\s]|$)` 前瞻）；b) **大小写敏感漏删**：lnk 的 target 存创建时真实大小写（本机实测 `...\DSH Smoothly Desktop\...`），而 0.3.x 起所有 tag 的安装目录名是 `DSH Desktop` → `starts_with` 失败 → **漏删**（fail-safe 但留死链）。本机目录恰好小写才没暴露。
- 修法：抽 `win_path_key`（统一分隔符 + 去尾 `\` + `to_lowercase`）+ `path_under`（组件边界，非裸前缀），`should_delete_shortcut` 与 `legacy_process_running` 共用（后者现在会把 `dsh Desktop-dev\...` 算作"旧版在跑" → `canCleanup=false` 误报）。
- 测试：替换现有"把内联表达式抄一遍"的测试为 `path_under` 表格（相等/子文件/尾反斜杠/正斜杠/大小写/兄弟前缀/空 target/UNC）。

### ③ 快捷方式名不一致 —— **核实后无需改动**，P3（结论性关闭）

- git 核实：小写 `dsh Desktop` 只存在于 `a7f479e → da2e2ec` 之间，而 `da2e2ec` 是 **v0.1.0 的祖先** → **所有发布版一律大写**；本机 `%LOCALAPPDATA%\dsh Desktop` 创建于 2026-08-15 07:34（早于 da2e2ec）证实小写构建确实装过，但 **NTFS 大小写不敏感** → NSIS `Delete` 与 Rust `is_file()` 都命中同一文件，**两种拼写都不漏**。代码里早有此注释（`lib.rs:335-347`）。
- → **不加 `dsh Desktop.lnk` 候选**（Windows 上是死代码）；③ 的真实解在 ②（target 大小写归一化）。
- 顺带发现（卡外，建议另开 P3 卡）：`legacy_shortcut_candidates`（`lib.rs:649-661`）用 `user_home()/Desktop` 硬拼，忽略**桌面重定向**（OneDrive 接管很常见）→ 桌面 lnk 漏检。

### ④ `dataRecreated` 口径错误 —— **当前正在误报**，P2

- 现状：`lib.rs:855-860` 用 `app_data_dir().parent().join("dev.dsh.desktop")`，与身份无关；而 `:520-523` 已有 `LEGACY_IDENT_MIGRATIONS` 映射。
- 正确口径：dev 版应查 **`%APPDATA%\dev.dsh.desktop.dev`**（= 该表的 dev 项）。不是 `app_data_dir()` 本身（恒存在）、不是 `dsh.smoothly.desktop`（正式版当前目录，误报）、不是 `dev.dsh.desktop`（那是**正式版**的旧目录）。
- 后果（本机可复现）：`dev.dsh.desktop` 存在、`dev.dsh.desktop.dev` 不存在 → dev 版 `dataRecreated=true` **假警报**（横幅/设置页/壳菜单弹窗全触发）；反之 dev 旧壳真重建时**漏报**。另 `lib.rs:899` 同一硬编码 → dev 版清理会把**正式版旧目录**的 dsh-home 复制进备份（只复制不删，无数据损失但错误）。
- 修法：抽 `legacy_ident_for(ident)` 复用同一张表，`migrate_legacy_data`、`legacy_check_json`、`legacy_cleanup_json` 三处统一。
- 测试：单测 `legacy_ident_for`（正式/dev/未知 → None）；实现后 dev 包启动确认横幅消失。

### 综合建议

- **排序**：② = ④（P2，纯 Rust、10 行级、可单测，先做）> ①（P2 分支修正 + P3 校验，需 makensis + 真机）> ③（P3，结论性关闭）。
- **合并/拆分**：②④ 合成一个 Rust 提交；① 单独一个 NSIS 提交（可独立 revert）；同一 PR / 同一发版都行。
- ③ 不加候选名；另开 P3 卡跟进"桌面重定向导致 lnk 漏检"。

---

## 5. 实施顺序与决策状态

**建议顺序**（每项独立可验证，互不阻塞；**均未开始实施**）：
1. **卡 2（壳层守护）+ 卡 1 的 S1/S2**（同一处代码：EOF/`try_wait` 取退出码 + 取证 + 提示，**不自动重启**）—— 一举解决"无退出证据"与"UI 分不清死活"。
2. **卡 1 的 S3**（壳内 watchdog + `MiniDumpWriteDump`，**只 dump 不 kill**）—— 取代失效的 comsvcs 路径，治 L3 风暴。
3. **卡 4 的 ②④**（纯 Rust，低风险）→ **①**（NSIS）。
4. **卡 3 阶段 0**（Host/Origin 校验，半天）→ 阶段 1（确认窗 + IPC，工作量最大）。
5. 卡 1 的 S4（Job Object）、卡 3 阶段 2/3、G4（Sysmon）视情况。

**决策状态**（用户 2026-09-09）：
- ✅ **D1** 不做自动重启 → 改为「检测 + 取证 + 提示，用户手动重启」
- ✅ **D2** 可接受 Sysmon（极简配置 EID1 + EID5）
- ✅ **D3** 不下沉 dsh web 自愈到 manager
- ✅ **D4** 接受"页面壳菜单的退出/重启也走确认窗"（托盘免确认）
- ✅ **D5** 接受卡 4 ① 的取舍（旧版在跑时不删其快捷方式）
- ✅ **D6** 03:04 退出 = 用户操作；00:47–00:48 第 4 次复现**未确认**

**仍待确认（不阻塞实施）**：
1. 00:47–00:48 是否第 4 次复现（决定"壳是否也会死"）——用户表示不记得。
2. WerSvc 7038/7009 是否已恢复；**火绒日志**——用户反馈"正常/异常记录都看不到相关项" → **AV 拦截这条线索可基本排除**。
3. 上游 dsh 侧 `dsh-win32-process` 的 job 语义为何没能保护 manager（需在 dsh 仓库继续查）。

---

## 6. 实施记录（2026-09-09 晚）

分支 `fix/manager-watchdog-forensics`（`028b77a` → `a35c3b8`），已实施 **卡 2 全部 + 卡 1 的 S1/S2**：

- **新增** `src-tauri/src/manager_guard.rs`：`MgrPhase`/`ManagerGuard`（世代号 + 意图停止位 + `reported_generation` 幂等 + `last_exit`）、退出码语义化、证据目录写入与保留 5 份、孤儿 node 查询（与启动清理共用同一 matcher）。
- **检测**：stdout EOF（快路径）+ 2s `try_wait` 看护线程（权威路径）；`handle_manager_exit` 两阶段登记（先确认可上报 → 取退出码 → 仍存活则不占用槽位）。
- **取证**：`<runtime>/reports/manager-crash-<unix>-gen<N>/` = `summary.json` + `manager.log.tail`(64 KiB) + `shell-session.log.tail` + `orphans.txt` + `wer.txt` + `node-reports/`（复制 manager 已产出的 `report.*.json`）。
- **不自动重启**（D1）：退出处理区域不含 `start_server`/`restart_server`/`Command::new`（契约测试锁死）。
- **修 bug ①**：`hasServer` 改由 `try_wait` 判活；**修 bug ②**：`stop_child` 先 `try_wait`，已退出 PID 不再 `taskkill`。
- **UI**：`/shell/status` 补 `managerAlive`/`managerPid`/`managerPhase`/`lastManagerExit`；新增 `/shell/open-evidence` + `open_evidence_dir`；chrome 条幅常驻显示退出码与证据目录 + 「重启服务」「打开证据目录」；启动页加载后主动查壳状态。
- **顺带修复（实机验证发现）**：故障回退导航此前落到 `about:blank` 黑屏——`LAUNCHER_URL` 在 setup 时被采集为 `about:blank`；且 Windows 本地页是 `http://tauri.localhost/`（非 `tauri://`）。现抽 `is_shell_local_url` 三处统一。
- **实机验证**（dev 版，`scripts/verify-manager-guard.ps1`，全 PASS）：`taskkill /F` manager → 检测到 + 退出码 1（0x00000001）+ 证据目录齐全 + **8 秒内无自动重启** + `/shell/status` 如实；UI 条幅与启动页均显示退出码/证据路径；点「重启服务」恢复且不产生多余证据；`/shell/quit` 退出**不**产生崩溃记录。
- **未做**（留卡 1）：S3 挂起 dump（`MiniDumpWriteDump`）、S4 Job Object、G 外部守护、Sysmon（D2）；`node-reports/` 只复制 manager 自己产出的报告，壳不注入 `NODE_OPTIONS`（一枚不支持的 flag 会炸整棵树）。

---

## 7. 实施记录（2026-09-09 深夜）：卡 1 的 S3 / S4a / G2

同一分支续做（`ade59f7` → 最新）。**已实施并实机验证：S3 挂起 dump、S4a Job Object、G2 外部守护脚本重写**；**待用户确认：G1（把守护装进登录启动项）、G4（Sysmon）**；**未做：S4b 完成端口通知**。

- **S3 挂起 dump**：新增 `src-tauri/src/web_dump.rs`（HTTP 探活 / `Get-NetTCPConnection` 按端口定位 dsh web PID + CIM 兜底 / `MiniDumpWriteDump` 全内存 dump / dump 保留 3 份）。壳内 watchdog：3s 探测、新 URL 后 30s 启动宽限、连续 3 次 miss → 抓 dump（`<runtime>/reports/dshweb-hang-<pid>-<ts>.dmp`）→ 条幅披露；**只 dump，不 kill、不重启**（D1）。两条触发路径（壳内 watchdog / manager 的 `dump-web` 协议行）由 `HangDump{Idle,InProgress,Done}` 状态机收敛为一次；**回执只在本轮 dump 写完后发**（`dump-done`），manager 收到才重启。
- **manager 侧**：删除本机实测 20s 超时零产出的 `rundll32 comsvcs` dump（L3 重启风暴根因），加 30s 启动宽限，挂起时改为「请壳抓现场 → 等 `dump-done`（上限 30s）→ 再重启」。
- **S4a Job Object**：新增 `src-tauri/src/job_object.rs`（`KILL_ON_JOB_CLOSE` + `BREAKAWAY_OK`，不设 UI 限制以兼容 dsh 自己的嵌套 job）；manager spawn 后立即入 job → 壳进程死亡时系统整树清理。失败只记日志（启动期孤儿清理兜底）。
- **G2 外部守护**：重写 `scripts/dsh-hang-guard.ps1`——身份改 `dsh.smoothly.desktop[.dev]`、删除 comsvcs、500ms 采样进程表（node/dsh-desktop/taskkill/powershell/cmd 消失即记录，并抓消失前 2s 内新出现的 suspect 及其 CommandLine，排除自身与父进程）、30s 启动宽限、**默认 detect-only（D1）**，`-AutoRestart` 才调桥 `/restart` / 重启壳。
- **实机验证（dev 包，全 PASS）**：
  - S3：`NtSuspendProcess` 冻结 dsh web → 3 次 miss → **313 MiB 全内存 dump 落盘**（`dshweb-hang-20176-1788966013.dmp`，写盘约 2s）→ manager 等回执 7.4s 后重启 → 服务恢复、壳存活。首次实测曾因「manager 抢先重启」导致 dump 归零（OpenProcess 0x80070057），已修（回执与 dump 完成绑定）。
  - S4a：`taskkill /F` 壳（不带 /T）→ 4 秒后该身份 node 进程 **0 个**（此前会残留孤儿，靠下次启动清理）。
  - 回归：崩溃检测（`verify-manager-guard.ps1`）仍全 PASS。
  - G2：实测抓到 manager 与 dsh web 的消失时刻及窗口内 powershell 命令行。
- **未做**：S4b（Job 完成端口逐进程退出通知——manager 已在日志记录 dsh web 退出码，增量价值有限）；G1/G4 待确认。

---

## 8. 实施记录（2026-09-10 凌晨）：S4b + G1

用户拍板：**装 G1（登录启动项，detect-only）、做 S4b；不装 G4（Sysmon）**。

- **S4b 完成端口**：`job_object::watch_job` 用 `CreateIoCompletionPort` + `JobObjectAssociateCompletionPortInformation` 关联 job，独立线程 `GetQueuedCompletionStatus(INFINITE)` 解析 `JOB_OBJECT_MSG_*`（4/6/7/8）→ 每个 job 成员的启动/退出/异常退出写 session.log（`job: process exited pid=…`）。**manager 自己被杀时壳仍留有 dsh web 的退出记录**（实测：杀 manager → job 依次记录 manager、dsh web 等进程退出，随后 manager_guard 记录退出码 1 + 证据目录）。`HANDLE` 非 Send → 传原始 `usize` 到线程内重建；`CompletionKey` 用 `null_mut()`（未使用）。
- **G1 安装**：新增 `scripts/install-hang-guard.ps1`——把守护拷到 `%LOCALAPPDATA%\dsh-hang-guard\` 并在当前用户启动文件夹建 `dsh-hang-guard-prod.lnk`（隐藏窗口，免管理员，`-Uninstall` 可卸，`-AutoRestart` 可选）。已按用户确认安装（prod 身份，detect-only），实测启动后 `armed on http://127.0.0.1:55404`。
- **安装后实测又抓出两个守护脚本 bug（已修）**：
  1. `Test-WebAlive` 用 `Invoke-WebRequest`，PS 5.1 对 4xx/5xx **抛异常** → manager.log 的无 token URL 恒 401 → 守护永远不 arm。改为从异常读状态码，2xx–4xx 都算活着（与 manager watchdog 同一判据）。
  2. suspect 窗口用 `[DateTime]::UtcNow` 与 `Get-Process.StartTime`（本地时）相减 → 恒为负 → **所有** powershell/cmd 都被当成嫌疑进程（证据被自己的构建命令行淹没）。改为本地时间比较；并把 conhost 从 suspect 名单移除（构建期每秒起落）。
  3. 顺带：守护日志 2MB 轮转；`manager.log` 尚未生成时不再退出（登录先于壳启动）；只对 node/dsh-desktop/msedgewebview2 触发消失取证（conhost/cmd 仅作上下文）。

**当前状态**：G1 已安装并在跑（prod，detect-only）；G4 未装（用户选择不装）；卡 1 仅剩「是否装 Sysmon」这一个可选决策。

**S3 的使用提示**：dump 是**全内存**（实测 313 MiB，重进程可达 GB 级），保留最近 3 份；同一 URL 只抓一次（避免反复写大文件）。
