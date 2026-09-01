# dsh web 挂起：根因分析与完整取证方案（2026-09-01 事件）

## 一、事件结论（已确认的）

**正式版**壳的内嵌 dsh web（node、dsh `0.1.1-rc.2`）在 **07:21:29** 事件循环挂起，不是崩溃：

- 会话 `session-86c3f3d5`（"项目问题排查与解决方案汇总"，D:\Dev\c-video-download）转录最后真实事件 = 07:21:29.304 的 `block-end`（turn 12 / step 7 的工具调用刚生成完毕，**随即应派发 pwsh 工具 —— 永远没有 tool/call**）
- `turn/end reason: interrupted` 与 `session/end-seed`（07:23:29）为**重启后新 dsh web 的崩溃恢复修补**（`dsh-session/lib/index.js` 的 `interruptedTurnClosers`：补写未闭合回合、复用最后事件时间戳、工具结果标 `outcome unknown`），**不是**用户主动停止
- 挂起特征吻合：页面黑屏、刷新无响应（事件循环堵死，HTTP 不返回）、manager.log 无 `dsh exited` 记录（manager 仍存活等待）、Windows 事件日志/WER/Crashpad 全无记录
- 用户 07:23:23 手动"重启 dsh"（taskkill /F 杀挂死进程树），07:23:25 新 web 上线，恢复
- 挂起点伴生压力：16 秒前刚启动后台作业 pwsh-1（npm 全量测试 10 脚本，含 test:engine）、转录 ~9MB 处落盘窗口、anyrouter provider 当日多次 502/503

## 二、未确认的（需要 dump 才能钉死的）

dsh web 常规路径无同步阻塞（转录落盘为 fs promises + fsync 异步；工具走异步 spawn；无 Atomics.wait）。剩余嫌疑（按可能性）：

1. **原生模块**：koffi `3.1.5`、node-pty `1.2.0-beta.15`（beta）在 Windows 上的死锁/挂起（dsh-subprocess-local 使用二者）
2. **系统级 I/O 卡死**：写盘（转录 fsync / dump）挂在慢盘或驱动上
3. **后台测试套件挤压**：test:engine 等进程风暴挤占 CPU/句柄（可能性较低——Windows 抢占式调度不至于饿死 2 分钟）
4. dsh `0.1.1-rc.2`（预发布）自身 bug：观测到 anyrouter 通道 502/503，通道重试逻辑可能在某分支死等

验证方法见第四节"拿到证据后怎么定位"。

## 三、取证与自愈机制（四层，全部落地）

### L1 —— 硬崩溃转储（今天就能配，管理员 PowerShell 一次性）

```powershell
# 管理员 PowerShell 执行；为 dsh 壳 / node / webview 配置 WER LocalDumps（full dump）
$dumps = "$env:LOCALAPPDATA\CrashDumps\dsh"
New-Item -ItemType Directory -Path $dumps -Force | Out-Null
foreach ($app in 'dsh-desktop.exe','dsh-desktop-dev.exe','node.exe','msedgewebview2.exe') {
  $k = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\$app"
  New-Item -Path $k -Force | Out-Null
  New-ItemProperty -Path $k -Name DumpFolder -Value $dumps -PropertyType ExpandString -Force | Out-Null
  New-ItemProperty -Path $k -Name DumpType    -Value 2 -PropertyType DWord -Force | Out-Null
}
```

之后任何硬崩溃（exe / node / webview 异常退出）自动留下 `%LOCALAPPDATA%\CrashDumps\dsh\<exe>.<pid>.dmp`。

### L2 —— 挂起守护 + 现场取证脚本（今天就能跑，无需重打包）

`scripts/dsh-hang-guard.ps1`（本仓库；用法见文件头注释）：

```powershell
# 复制到 Windows 任意位置后：
powershell -ExecutionPolicy Bypass -File .\dsh-hang-guard.ps1 -App prod   # 正式版
powershell -ExecutionPolicy Bypass -File .\dsh-hang-guard.ps1 -App dev    # 开发版
# 可选：开机自启（管理员）
schtasks /create /tn "dsh-hang-guard" /tr "powershell -ExecutionPolicy Bypass -File C:\path\to\dsh-hang-guard.ps1 -App prod" /sc onstart /ru <你的用户名>
```

行为：每 3 秒探测 dsh web URL（从 manager.log 实时读）→ 连续 3 次失败 → **先取证后恢复**：

- 快照：进程表（PID/内存）、manager.log 与 session.log 尾部、会话转录 mtime → `%LOCALAPPDATA%\dsh-hang-prod-<时间戳>\`
- 内存转储：`rundll32 comsvcs.dll MiniDump` 抓 dsh web + manager 的 node 进程（**全量 dump，挂起现场最优证据**，无需额外工具）
- 恢复：优先 POST 桥 `/restart`（等价壳内"重启服务"，页面自动重连）；桥不通则 taskkill 树 + 提示去窗口点"重试"
- 应用整体退出时脚本自行退出；安装期（无 URL）不误报

### L3 —— 产品化补丁（进 dev 仓库，下次构建发版生效）

`docs/2026-09-01-dsh-web-hang-instrumentation.patch` —— 针对 `src-tauri/resources/manager/server-manager.mjs`（dev/prod 基线一致，已验证可干净应用）：

```bash
cd /mnt/d/Dev/dsh-desktop-dev
git apply /home/karoc/dsh-desktop/docs/2026-09-01-dsh-web-hang-instrumentation.patch
```

两处能力（全部写进 manager.log，持久可查）：

1. **node 崩溃报告**：启动 dsh web 子进程时注入 `NODE_OPTIONS=--report-on-fatalerror --report-uncaught-exception --report-compact --report-dir=<runtime>/reports` —— node OOM / fatal / 未捕获异常自动留 `.json` 报告（含 JS 栈），不再依赖 Windows WER
2. **内置 liveness watchdog**：每 3 秒 GET dsh web URL（fetch + AbortSignal.timeout），连续 3 次失败 → 先 rundll32 抓全量 dump 到 `<runtime>/reports/` → 杀树 + 自动重拉服务（与托盘"重启服务"同路径，壳在收到新 server-url 时自动导航恢复，**用户不再需要手动干预**）

### L4 —— 复现后最终定位（拿到 dump/report 后）

- **挂起（dump）**：用 WinDbg/cdb 打开 L2/L3 产出的 `.dmp`：`!analyze -v` 看主线程栈；node 主线程卡在哪（koffi 调用 / fs 同步 / 死循环）一目了然。无 WinDbg 时至少看 dump 的线程列表确认主线程状态
- **崩溃（report/dmp）**：`<runtime>/reports/*.json` 的 `javascriptStack` + `nativeStack` + `header`（OOM/致命错误原因）；或 L1 的 `.dmp` 同样 `!analyze -v`
- **拿到结果后**：对照第四节嫌疑清单，定位到具体模块/行，再决定上游（dsh npm 升级 / koffi 版本 / 壳侧规避）

## 四、嫌疑清单与验证路径

| 嫌疑 | 证据点 | 验证 |
|---|---|---|
| dsh 0.1.1-rc.2（预发布）bug | 挂起点处于回合落盘+工具派发边界；anyrouter 当日 502/503 | 看 rc.3+ 更新日志；若 dump 显示卡在 dsh 内部循环则实锤 |
| koffi 3.1.5 / node-pty 1.2.0-beta.15 | dsh-subprocess-local 依赖二者，Windows 原生层 | dump 主线程栈若在 koffi/napi 调用即实锤 |
| 后台作业挤压（test:engine 等） | 挂起前 16s 启动 10 脚本测试套件 | dump 中主线程若在正常 JS 但 CPU 饱和则弱相关 |
| 转录 fsync 卡死（磁盘） | 挂起点在落盘窗口 | dump 主线程栈在 fsync 且伴随磁盘异常则实锤 |

## 五、本次事件遗留物

- 解压后的会话转录：`C:\Users\qqwto\AppData\Local\Temp\dsh_s86_dec.jsonl`（s86，崩溃会话）、`dsh_s5_dec.jsonl`（对照）——可直接 grep 复查
- 解码方法：`session.jsonl.zstd` 是多帧 zstd 拼接，用内嵌 node 的 `node:zlib` `zstdDecompressSync` 按魔数 `28 B5 2F FD` 切帧逐帧解压（脚本已用后清理，方法见 `.agents/notes/implemented/process/2026-09-01-windows-shell-crash-forensics.md`）