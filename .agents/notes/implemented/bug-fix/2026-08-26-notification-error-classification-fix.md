# Agent Note: notification-error-classification-fix

Status: implemented

## Problem

v0.3.8 修复（scan mutex）后用户仍报告通知「推送了两次」。WSL 直读 Windows 宿主日志确认根因：dsh 的 session running 在 turn/end（含 reason=error）时翻 false，插件把每个 running→false 都弹「任务完成」——provider network_error 被误报完成，且自动重试再次出错时 51-134s 内二次弹窗。

## Decision

根因（见 2026-08-26-notification-double-toast-root-cause.md）实施为 plugins/dsh-client-notifications/client.js 的转边分类：running→false 时经 ctx.get('connection').api.sessions.history({sessionId, maxMessages:40}) 读最近 turn/end 的 reason.kind（END_KINDS 映射），completed→「任务完成」、error→「任务出错：<message>」、aborted/blocked/max-tokens/interrupted→「任务已停止/被阻止/达上限/中断」、未知→「任务结束」；RPC 不可用/失败回退「任务完成」。仅 error toast 走每会话 ERROR_COOLDOWN_MS=3min 冷却（lastErrorToastAt Map，随 seen 清理），completed 永不冷却。inject 加 'connection'（ctx.connection ?? ctx.get?.('connection')）。分类为异步 fire-and-forget（void classifyAndNotify），seen 置位保持同步防重复。测试 scripts/test-client-notifications.mjs 扩至 23 场景：错误分类（含 provider message 断言与 historyCalls 探测断言）、重试冷却抑制、错误后完成不被冷却吞、冷却过期（Date.now mock +4min）恢复；因异步化，完成边断言前统一 await flush()（含 scenario 18 的 calls=[] 前置 flush 修复竞态）。sync-resources.mjs 已重跑同步 resources 拷贝（diff 验证 IDENTICAL）。
## Alternatives considered

仅改文案不做冷却——能修「错误报完成」但压不住重试二次弹窗，用户仍会看到两次推送，弃。仅冷却不分类——修得了次数但文案仍是误导的「已完成」，弃。对所有转边做冷却（含 completed）——会吞掉冷却窗口内合法的快速重跑完成通知，弃。settle 窗口（快照竞态假设）——实测双弹间隔 51-134s，任何秒级 settle 都覆盖不了，且根因不是快照竞态，弃。在 Rust 侧去重/分类——客户端已有 seen 去重且 Rust 无会话事件上下文，改动面更大，弃。
## Consequences

行为变化：a) 错误转边不再弹「任务完成」，改弹「任务出错：<provider message>」（消息截断 120 字符）；b) 同一会话 3 分钟内第二次错误 toast 被抑制（retry burst），错误后 3 分钟内真正的完成仍会弹「任务完成」；c) aborted/blocked/max-tokens/interrupted 弹「任务已停止/被阻止/达上限/中断」，不再误报完成；d) 每完成边多一次 sessions.history 尾页读（maxMessages=40，本地 host 只读，开销可忽略）；RPC 失败/connection 不可用回退「任务完成」旧行为。测试从 19 扩到 23 场景全绿，测试因分类异步化在完成边断言前 await flush()。需下次 dsh-desktop 发版随 resources 生效；Windows 真机回归建议造 network_error 转边场景复核文案与冷却。

