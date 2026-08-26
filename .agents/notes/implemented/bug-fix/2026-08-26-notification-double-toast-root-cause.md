# Agent Note: notification-double-toast-root-cause

Status: implemented

## Problem

用户在 v0.3.8（scan mutex 去重修复）发布后仍报告通知「推送了两次」。需用 Windows 宿主日志确认修复是否生效、定位双弹真实机制，区分双页面实例/分离交付竞态/错误转边等候选。

## Decision

「v0.3.8 后仍双弹」根因已用 Windows 宿主日志确认（2026-08-26 核查）：**通知插件把每个 running→false 都当「任务完成」弹 toast，而 dsh 的 running 在 turn/end（含 error）时翻 false**。会话事件证实：turn4 11:43:39 因 Provider finish_reason: network_error 终止→弹「完成」（误报）→11:44:15 自动重试 turn5→11:44:30 再次 network_error→再弹；12:05 turn6 错误→弹、12:07 turn7 重试真正 completed→再弹。全会话 11 次 turn/end 中 3 次 error 全被误报「已完成」。已排除项：客户端决策重复（120=45+75 自洽）、desktop-notification 事件（无 producer 死代码）、Rust 双 toast（/notify 单请求单 toast）、双页面实例、settle 竞态（无 <15s 紧邻对）。运行时 client.js 与 v0.3.8 修复版逐字节一致（仅 CRLF+桥端口），修复已生效但未覆盖「错误转边」。「任务完成」文案对 error 转边是误导；错误后自动重试制造「一个任务两次 toast」的用户感知。SessionSummary（service.ts）无 error/结束原因字段，列表快照无法区分完成与出错。
## Alternatives considered

M1b「分离交付快照竞态 + settle 窗口」假设——被日志推翻：全日志无 <15s 紧邻双 toast（最近 51s），客户端决策自洽（120 决策 = 45 抑制 + 75 toast），双弹是同一会话 51-134s 内两次独立 running→false（错误转边 + 自动重试），非快照竞态；settle 窗口也覆盖不了 134s 间隔。仅冷却期去重——能压双弹但误伤合法快速重跑，且不修「错误报完成」的误导文案，弃。desktop-notification tauri 事件路径——全仓无 producer，死代码，排除。Rust 双路径（notify-rust+tauri-plugin 同时弹）——match 互斥 + 其余 show_toast 调用点（更新/开发模式）标题不同，排除。双页面实例——client-ready 多次但决策计数单实例自洽，排除。
## Consequences

本 Note 是根因定位记录，修复尚未实施（方案见下）。修复需在通知插件 client.js 的 running→false 分支读取 turn/end reason：经 ctx.get('connection').api.sessions.history 拉取该会话最近 turn/end 事件，reason.kind === 'error' 时改弹「任务出错：<摘要>」（或抑制），completed 才弹「任务完成」；SessionSummary 行无 error/结束原因字段，列表快照无法区分，必须走 history RPC（每转边一次轻量读）。实施后需 Windows 真机回归（造 network_error 转边场景）并随 dsh-desktop 下次发版；notification 插件的行为测试 scripts/test-client-notifications.mjs 需同步扩展。

