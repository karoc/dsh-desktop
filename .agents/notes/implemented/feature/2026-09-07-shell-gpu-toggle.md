# Agent Note: shell-gpu-toggle

Status: implemented

## Problem

2026-09-07 用户报告 dsh 设置页（正式版+dev 版）滚动/切换极卡。定位：用户级环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu 让所有 WebView2 应用禁用 GPU 渲染，dsh 0.1.2-rc.1 的设置页是复杂 SPA，软件渲染下滚动/切换卡顿（正式版 dsh web 进程累计 CPU 192s 佐证）。但该变量是用户为排查"大模型执行中黑屏"而设（尚未解决），不能简单删除——需要把 GPU 开关收进壳：平时开（流畅），排查黑屏时一键关（软件渲染复现）。

## Decision

GPU 加速开关收进壳，替代用户级全局 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu。实现于 lib.rs（8fe9cbd + 46d09e7）：1) dsh.json 新增 webview.gpu 字段（默认 true），gpu_accel()/set_gpu_accel()/toggle_gpu_accel_impl() 与 devMode 同模式（preserve 其它字段）；2) run() 开头（Builder 构建窗口前）用 tauri::generate_context!() 取 identifier → APPDATA/<ident>/runtime/dsh.json 读 gpu → gpu=true 时 std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")（覆盖继承自用户级的环境变量），false 时 set_var("--disable-gpu")；3) 托盘菜单新增「GPU 加速」CheckMenuItem（id gpu-accel，与开发者模式并列），状态存 ServerState.gpu_item，切换写 dsh.json + toast 提示重启生效；4) toggle_gpu_accel command 注册 invoke_handler 供 IPC 复用；5) gpu 状态暴露到 /shell/state 与 get_shell_state。用户级全局变量已由用户在同意后移除（SetEnvironmentVariable null User）。验证（dev 46d09e7）：默认无配置→WebView2 不带 --disable-gpu（GPU 开）；webview.gpu=false→带 --disable-gpu（软件渲染）；true→不带。三轮往返全部通过，client-ready 正常。
## Alternatives considered

**直接删除用户级全局变量**：被拒绝——它当初是为排查"大模型执行中黑屏"而设（用户确认），简单删除会失去排查手段，且无法解释为什么设置页会突然卡。**按窗口 additional_browser_args 注入**：被拒绝——WebView2 的浏览器参数在创建 environment 时进程级生效，无法按窗口区分；且开关需要全局一致（所有壳窗口同开同关）。**配置放 tauri.conf.json 静态注入**：被拒绝——需要运行时按用户切换，静态配置做不到。
## Consequences

代价：dsh.json 新增 webview.gpu 字段（manager 的 writeShellManifest 保留未知字段，无冲突）；GPU 切换需重启应用生效（WebView2 environment 进程级创建，无法热切换）——托盘 toast 已明示。收益：日常 GPU 渲染流畅（设置页卡顿根治），排查黑屏时菜单一键关 GPU 复现，两者不再互相踩；用户级全局变量已移除，其他 WebView2 应用（微软电脑管家、Clash 代理界面）也恢复 GPU。边界：进程级 set_var/remove_var 只影响本进程及其子进程，不影响其它已运行进程（正式版壳需重启才生效，已告知用户）；黑屏排查线（GPU 关闭路径）仍是开放任务，需在 GPU 开关落地后继续。

