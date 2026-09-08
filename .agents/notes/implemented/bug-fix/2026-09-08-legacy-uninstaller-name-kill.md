# Agent Note: legacy-uninstaller-name-kill

Status: implemented

## Problem

2026-09-09 静默安装 dev 版（`/S`）时，用户正在使用的正式版（dsh-desktop.exe，PID 39772）被静默终止——无提示、无 WER/崩溃事件、无退出日志，事后像"应用无故消失"（正式版在 00:48 又被 explorer 重新启动）。根因：NSIS 钩子 legacy-takeover.nsh 检测到 %LOCALAPPDATA%\dsh Desktop\uninstall.exe 残留后无条件 ExecWait 执行旧版（0.3.9）卸载器；旧版卸载器的 Section Uninstall 首句是 CheckIfAppIsRunning "${MAINBINARYNAME}.exe"，而旧版 MAINBINARYNAME = dsh-desktop，与正式版同名；静默模式（/S）下 utils.nsh 的宏走 IfSilent → KillProcessCurrentUser，nsis-tauri-utils 的 get_processes() 只比较 exe 名（不看路径）→ TerminateProcess。钩子原有的 wmic 探测只查旧版路径（结构上不可能发现正式版），且本机 Win11 24H2 已移除 WMIC（探测 exit=9009）→ fail-open 必然放行。

**物证（第三路独立审计，静态解压而非推断）**：直接解开 `%LOCALAPPDATA%\dsh Desktop\uninstall.exe` 的 NSIS 头块（LZMA，文件偏移 117,252）得到脚本字符串表，命中裸串 `dsh-desktop.exe`、`FindProcessCurrentUser`、`KillProcessCurrentUser`、`Click OK to kill it`、`\dsh-desktop.exe`、`...\Uninstall\DSH Desktop` —— 不依赖上游模板文本即证实"按名杀同名进程"。历史影响面：v0.1.0–v0.7.0 全部锁 `@tauri-apps/cli 2.11.4`（同一 NSIS 模板）；按名杀自 v0.1.0 起（Tauri 模板固有，正式版→正式版升级被杀属预期行为）；**跨版本危害窗口自 v0.5.0 起**（接管钩子 58611bf，2026-09-02 19:54）；`_?=` 未加引号 + 路径含空格（`dsh Desktop`）导致旧卸载器从不自删，孤儿 `uninstall.exe` 长期存在 → 复发前提一直在。10 条竞争假设全部排除（用户主动退出 / Windows 更新 / 单实例互斥 / OOM / 我们的自动化 / dev 安装器自身检查等），判别器是"硬杀壳会留下 manager+dsh web 孤儿、下次启动记 `stale service node <pid> killed`"——正式版全会话日志（08-20→09-09，1525 条）中该行仅本次 2 条。

**实机验证**：修复后构建 dev 包并在**正式版运行中**静默安装 → 正式版 PID 56040 / StartTime 00:48:15 完全不变（修复前同样操作必杀）；模拟目录三分支测试（孤儿→删 / 真旧版+同名进程在跑→不执行卸载器 / 无残留→无操作）全过；`makensis -INPUTCHARSET UTF8` 编译通过。注意 dev 版安装器因 `!if MAINBINARYNAME==dsh-desktop` 为假而**完全不接管**（含不做孤儿清理）——这是有意的 fail-safe；孤儿清理由正式版安装器执行。

## Decision

安装器钩子（src-tauri/resources/nsis/legacy-takeover.nsh 重写）：只用 NSIS_HOOK_PREINSTALL，且在 !if "${MAINBINARYNAME}" == "dsh-desktop" 内（正向匹配，改名后退化为"不接管"= fail-safe；dev 版 MAINBINARYNAME=dsh-desktop-dev 因此完全不接管）。分支：无 uninstall.exe → 什么都不做；旧版主程序 dsh-desktop.exe 不存在 → 删除孤儿 uninstall.exe（切断"每次安装重跑按名杀进程"的复发链）；主程序存在 → nsis_tauri_utils::FindProcessCurrentUser "dsh-desktop.exe"（与旧版卸载器 KillProcessCurrentUser 同谓词：同名 + 同用户 SID）返回 0 即绝不执行，仅在确认无同名进程时 ExecWait 旧版卸载器（并把 _?= 值加引号）。壳内清理（lib.rs legacy_cleanup_json）**永不执行**旧版卸载器：旧版主程序仍在 → 返回 {ok:false, reason:"legacy-app-present"} 并提示手动卸载；否则删除孤儿 uninstall.exe + 白名单快捷方式 + 空目录回收，返回值由 uninstallerExit 改为 removedUninstaller。legacy_process_running 保留但注释明确"绝不能用作执行卸载器的门禁"（危害按名字发生，路径前缀判定恒不成立；且壳自身就是 dsh-desktop.exe，正式版壳执行 = 自杀）。UI 文案同步（shell-chrome.js 弹窗、settings.js/html、app.js 横幅：按钮改「清理旧版残留」、结果改显示孤儿卸载器删除状态、legacy-app-present 给手动卸载指引）。防回归断言进 scripts/test-shell-chrome.mjs（wmic 探测消失、ExecWait 只在同名进程门禁之后、legacy-app-present 存在、lib.rs 不再 spawn 卸载器）。
## Alternatives considered

1) 保留无条件 ExecWait 但把检测换成 wmic/PowerShell 按任意路径查同名进程：仍 fail-open（WMIC 缺省、PowerShell 策略/权限/语言差异），且检测谓词与卸载器的 kill 谓词不同源，存在"检测不到却仍被杀"的窗口——否决。2) 壳内保留执行卸载器但先排除自身 PID：放行后卸载器仍按名杀掉壳自己（它只跳过自己的 pid）——否决。3) 只在 dev 版安装器跳过旧版接管（方案 C）：不修根因，正式版安装器仍会跑旧版卸载器（危害被"升级本来就要关自己"掩盖，但静默先杀、该弹的提示永不出现）——仅作为纵深防御保留（正向匹配形式）。4) 把"旧版在跑"改成弹窗 Abort：静默模式下无 /SD 的 MessageBox 不显示且返回 0 → 直接 Abort 使静默安装以退出码 2 失败且无可见原因；被动模式还会弹窗打断无人值守——否决。
## Consequences

修复后：安装任意版本都不会再因旧版卸载器杀掉同名进程（钩子场景 2 实测：旧版主程序在 + 正式版运行 → 卸载器未执行）；本机残留的孤儿 uninstall.exe 会在下次安装时被删除，%LOCALAPPDATA%\dsh Desktop 目录因仍有 resources 残留（server-manager.mjs.bak-20260901）不会被 RMDir 删除（安全，非递归）。代价与边界：壳内「旧版清理」不再能卸载真旧版（0.3.x 主程序仍在时返回 legacy-app-present，需用户从「设置 → 应用」手动卸载）——这是有意的能力取舍，因为正式版壳执行旧版卸载器必然自杀；旧版 ARP 键与 HKCU\Software\dsh\DSH Desktop 键不再由壳清理（本机 ARP 键已不存在，manufacturer 键残留无害）；真旧版场景下仍有毫秒级 TOCTOU（检测后到 CreateProcess 前用户启动正式版）——窗口极小且已无更优解。验证：makensis -INPUTCHARSET UTF8 编译通过；模拟目录三分支实测（孤儿→删除、旧版在+同名进程在跑→不执行、无残留→无操作）；scripts/test-shell-chrome.mjs 断言全绿。已知遗留（未在本次修）：桥端点 POST /shell/legacy-cleanup 无鉴权且 CORS-open，页内第三方插件可触发（修复后破坏面已从"spawn 卸载器"降到"删孤儿卸载器+已校验 lnk"）；钩子 Delete lnk 未校验 target；Rust 侧 should_delete_shortcut 前缀匹配无边界。

